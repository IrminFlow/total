import { describe, it, expect } from 'vitest'
import {
  valueStock,
  allocateAdditionalCost,
  allocateExact,
  runInventoryPass,
  bookedInwardValues,
  stockCostPositionsAsOf,
  averageCostAsOf,
  costConsumption,
  type InventoryItem,
  type InventoryMovement,
  type InventoryPassInput,
  type ValuationMethod,
  type ValuationResult,
  type VoucherCosting,
  type StockMovement
} from './valuation'
import { legacyValueStock } from './valuationLegacyOracle.testutil'

// ---------- helpers ----------

function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

let nextLine = 1
const line = (
  voucherId: number,
  date: string,
  itemId: number,
  direction: 'in' | 'out',
  qtyMilli: number,
  amount = 0,
  isAbsolute = false
): InventoryMovement => ({ voucherId, date, itemId, direction, qtyMilli, amount, isAbsolute, lineId: nextLine++ })

const item = (itemId: number, method: ValuationMethod, openingQtyMilli = 0, openingValue = 0): InventoryItem => ({
  itemId, method, openingQtyMilli, openingValue
})

const derived = (additionalCostPaise = 0): VoucherCosting => ({ rule: 'derived', additionalCostPaise })

interface RandomBook {
  input: InventoryPassInput
  /** Voucher ids that are mixed (outward + inward) journals. */
  journals: number[]
}

/** A random multi-item book in voucher order: purchases, sales, mixed journals, physical
 *  counts, overdraws, same-date collisions and in-before-out journals. */
function randomBook(seed: number, opts: { items?: number; vouchers?: number } = {}): RandomBook {
  const rand = prng(seed)
  const int = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1))
  const nItems = opts.items ?? 6
  const items: InventoryItem[] = []
  for (let i = 1; i <= nItems; i++) {
    const q = rand() < 0.6 ? int(0, 50) * 1000 : 0
    items.push(item(i, rand() < 0.5 ? 'fifo' : 'weighted_avg', q, q > 0 ? q * int(5, 90) + int(0, 99) : 0))
  }
  const movements: InventoryMovement[] = []
  const journals: number[] = []
  const nV = opts.vouchers ?? 60
  for (let v = 1; v <= nV; v++) {
    const date = `2025-05-${String(int(1, 20)).padStart(2, '0')}`
    const r = rand()
    const it = (): number => int(1, nItems)
    const q = (): number => int(1, 30) * 1000 + (rand() < 0.3 ? int(1, 999) : 0)
    const lines: InventoryMovement[] = []
    if (r < 0.3) lines.push(line(v, date, it(), 'in', q(), int(0, 500000)))
    else if (r < 0.6) lines.push(line(v, date, it(), 'out', q()))
    else if (r < 0.68) lines.push(line(v, date, it(), 'in', rand() < 0.2 ? 0 : q(), 0, true))
    else {
      journals.push(v)
      const outs = int(1, 3)
      for (let k = 0; k < outs; k++) lines.push(line(v, date, it(), 'out', q()))
      const ins = int(1, 2)
      for (let k = 0; k < ins; k++) lines.push(line(v, date, it(), 'in', q(), rand() < 0.2 ? 0 : int(0, 400000)))
      if (rand() < 0.3) lines.reverse()
    }
    movements.push(...lines)
  }
  // Voucher order (date, voucherId) as the DB query returns it.
  movements.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.voucherId - b.voucherId))
  return { input: { items, movements }, journals }
}

/** The pre-WP 2.1 DB layer, reproduced: per item, legacy walk over that item's lines with
 *  additional cost pre-loaded into stored amounts via allocateAdditionalCost. */
function legacyPerItem(input: InventoryPassInput): Map<number, ValuationResult> {
  const amount = new Map<InventoryMovement, number>()
  for (const [voucherId, c] of input.costing ?? new Map<number, VoucherCosting>()) {
    const extra = c.additionalCostPaise ?? 0
    if (extra <= 0) continue
    const ins = input.movements.filter((m) => m.voucherId === voucherId && m.direction === 'in' && !m.isAbsolute)
    if (ins.length === 0) continue
    const shares = allocateAdditionalCost(ins.map((m) => m.amount), extra)
    ins.forEach((m, i) => amount.set(m, m.amount + shares[i]!))
  }
  const out = new Map<number, ValuationResult>()
  for (const it of input.items) {
    const moves: StockMovement[] = input.movements
      .filter((m) => m.itemId === it.itemId)
      .map((m) => ({ direction: m.direction, qtyMilli: m.qtyMilli, amount: amount.get(m) ?? m.amount, isAbsolute: m.isAbsolute }))
    out.set(it.itemId, legacyValueStock(it.method, it.openingQtyMilli, it.openingValue, moves))
  }
  return out
}

// ---------- legacy equivalence under 'stored' ----------

describe("runInventoryPass — 'stored' rule reproduces the legacy per-item walk exactly", () => {
  it('valueStock (now on the shared state machine) equals the frozen legacy walk on random sequences', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const rand = prng(seed)
      const int = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1))
      const moves: StockMovement[] = []
      for (let k = 0; k < 40; k++) {
        const r = rand()
        if (r < 0.4) moves.push({ direction: 'in', qtyMilli: int(0, 20000), amount: int(-100, 300000) })
        else if (r < 0.85) moves.push({ direction: 'out', qtyMilli: int(0, 25000), amount: int(0, 99) })
        else moves.push({ direction: 'in', qtyMilli: int(0, 30000), amount: 0, isAbsolute: true })
      }
      for (const method of ['fifo', 'weighted_avg'] as const) {
        const oq = rand() < 0.2 ? -int(0, 5000) : int(0, 20000)
        const ov = int(-5000, 200000)
        expect(valueStock(method, oq, ov, moves)).toEqual(legacyValueStock(method, oq, ov, moves))
      }
    }
  })

  it('multi-item books with additional cost: global pass === legacy per-item walk (200 random books)', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const { input, journals } = randomBook(seed)
      const costing = new Map<number, VoucherCosting>()
      journals.forEach((v, i) => { if (i % 2 === 0) costing.set(v, { rule: 'stored', additionalCostPaise: 1 + ((v * 7919) % 50000) }) })
      const withCost = { ...input, costing }
      expect(runInventoryPass(withCost).closing).toEqual(legacyPerItem(withCost))
      expect(runInventoryPass(input).closing).toEqual(legacyPerItem(input))
    }
  })

  it('checkpoint snapshots equal a pass over just the movements up to them', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const { input } = randomBook(seed)
      const points = [{ date: '2025-05-07' }, { date: '2025-05-12', voucherId: 0 }, { date: '2025-05-15', voucherId: 30 }]
      const { at } = runInventoryPass(input, points)
      points.forEach((p, i) => {
        const prefix = input.movements.filter(
          (m) => m.date < p.date || (m.date === p.date && (p.voucherId === undefined || m.voucherId < p.voucherId))
        )
        expect(at[i]).toEqual(runInventoryPass({ ...input, movements: prefix }).closing)
      })
    }
  })

  it('bookedInwardValues without a derived voucher needs only the costed lines and matches the pass', () => {
    const { input, journals } = randomBook(11)
    const costing = new Map<number, VoucherCosting>(journals.map((v) => [v, { rule: 'stored', additionalCostPaise: 999 }]))
    const full = runInventoryPass({ ...input, costing }).inwardValueByLine
    const onlyJournals = input.movements.filter((m) => costing.has(m.voucherId))
    expect(bookedInwardValues({ items: [], movements: onlyJournals, costing })).toEqual(full)
  })
})

// ---------- ordering ----------

describe('runInventoryPass — ordering', () => {
  it('orders by (date, voucher id) whatever the input order, keeping line order within a voucher', () => {
    const { input } = randomBook(5)
    const shuffled = [...input.movements].reverse()
    // Restore each voucher's own line order (the contract is "line order within a voucher").
    const byVoucher = new Map<number, InventoryMovement[]>()
    for (const m of input.movements) byVoucher.set(m.voucherId, [...(byVoucher.get(m.voucherId) ?? []), m])
    const reordered = [...new Set(shuffled.map((m) => m.voucherId))].flatMap((v) => byVoucher.get(v)!)
    expect(runInventoryPass({ ...input, movements: reordered }).closing).toEqual(runInventoryPass(input).closing)
  })

  it('same date, several vouchers: the lower voucher id goes first', () => {
    const items = [item(1, 'weighted_avg', 10000, 100000)]
    // v2 (sale) and v1 (purchase at ₹40) on the same day: v1 first → sale at avg (100000+400000)/20.
    const moves = [line(2, '2025-05-01', 1, 'out', 10000), line(1, '2025-05-01', 1, 'in', 10000, 400000)]
    const r = runInventoryPass({ items, movements: moves }).closing.get(1)!
    expect(r.consumedValue).toBe(250000)
    expect(r.closingValue).toBe(250000)
  })

  it("a 'stored' voucher keeps its line order (in-before-out of one item stays in-before-out)", () => {
    const items = [item(1, 'weighted_avg', 10000, 100000)]
    // Journal lists the item inward (10 @ ₹30) before outward (10). Legacy: in first → avg ₹20.
    const moves = [line(1, '2025-05-01', 1, 'in', 10000, 300000), line(1, '2025-05-01', 1, 'out', 10000)]
    expect(runInventoryPass({ items, movements: moves }).closing.get(1)!.consumedValue).toBe(200000)
  })

  it("a 'derived' voucher costs its outward lines before its inward lines, whatever the line order", () => {
    const items = [item(1, 'weighted_avg', 10000, 100000), item(2, 'weighted_avg')]
    // Finished good listed first; raw material consumed at the pre-voucher avg ₹10.
    const moves = [line(1, '2025-05-01', 2, 'in', 1000, 777), line(1, '2025-05-01', 1, 'out', 4000)]
    const res = runInventoryPass({ items, movements: moves, costing: new Map([[1, derived()]]) })
    expect(res.derived.get(1)).toEqual({ consumedValue: 40000, additionalCostPaise: 0, inwardValue: 40000 })
    expect(res.closing.get(2)!.closingValue).toBe(40000)
  })

  it('mixed in/out across same-date vouchers feeds a later derived voucher the right position', () => {
    const items = [item(1, 'fifo', 5000, 50000), item(2, 'fifo')]
    const moves = [
      line(1, '2025-05-01', 1, 'in', 5000, 100000), // layer 2: 5 @ ₹20
      line(2, '2025-05-01', 1, 'out', 6000), // takes 5@10 + 1@20 → 70000
      line(3, '2025-05-01', 1, 'out', 2000), // derived: takes 2@20 → 40000
      line(3, '2025-05-01', 2, 'in', 1000, 0),
      line(4, '2025-05-01', 1, 'in', 3000, 90000)
    ]
    const res = runInventoryPass({ items, movements: moves, costing: new Map([[3, derived(500)]]) })
    expect(res.derived.get(3)!.inwardValue).toBe(40500)
    expect(res.closing.get(2)!.closingValue).toBe(40500)
    expect(res.closing.get(1)!).toMatchObject({ closingQtyMilli: 5000, closingValue: 2 * 20000 + 90000 })
  })
})

// ---------- value conservation ----------

function assertConserved(input: InventoryPassInput): void {
  const res = runInventoryPass(input)
  for (const [voucherId, c] of input.costing ?? []) {
    if (c.rule !== 'derived') continue
    const d = res.derived.get(voucherId)!
    const ins = input.movements.filter((m) => m.voucherId === voucherId && m.direction === 'in' && !m.isAbsolute)
    // Σ consumed cost + additional = finished inward value, booked to the paisa.
    expect(d.inwardValue).toBe(d.consumedValue + d.additionalCostPaise)
    expect(ins.reduce((s, m) => s + res.inwardValueByLine.get(m.lineId!)!, 0)).toBe(d.inwardValue)
    // The consumed cost is exactly what costConsumption prices for those lines at that position.
    const outs = input.movements.filter((m) => m.voucherId === voucherId && m.direction === 'out' && !m.isAbsolute)
    const date = outs[0]?.date ?? ins[0]!.date
    const priced = costConsumption(input, outs.map((m) => ({ itemId: m.itemId, qtyMilli: m.qtyMilli })), { date, voucherId })
    // (Absolute lines in the same voucher would shift the position; random books have none.)
    expect(priced.totalPaise).toBe(d.consumedValue)
  }
  // Global conservation per item: opening + booked inward value = consumed + closing.
  for (const it of input.items) {
    const r = res.closing.get(it.itemId)!
    let inValue = it.openingValue
    let hasAbsolute = false
    for (const m of input.movements) {
      if (m.itemId !== it.itemId) continue
      if (m.isAbsolute) hasAbsolute = true
      else if (m.direction === 'in') inValue += res.inwardValueByLine.get(m.lineId!) ?? m.amount
    }
    if (!hasAbsolute) expect(r.consumedValue + r.closingValue).toBe(inValue)
  }
}

describe("runInventoryPass — 'derived' rule conserves value", () => {
  for (const method of ['weighted_avg', 'fifo'] as const) {
    it(`random books (${method}): Σ consumed + additional = finished inward value, every derived voucher`, () => {
      for (let seed = 1; seed <= 150; seed++) {
        const { input, journals } = randomBook(seed * 31)
        const items = input.items.map((i) => ({ ...i, method }))
        const costing = new Map<number, VoucherCosting>(journals.map((v, i) => [v, derived(i % 3 === 0 ? 0 : 100 + v * 13)]))
        assertConserved({ items, movements: input.movements, costing })
      }
    })
  }

  it('a backdated purchase re-prices a later manufacture and everything downstream consistently', () => {
    for (const method of ['weighted_avg', 'fifo'] as const) {
      const items = [item(1, method, 10000, 100000), item(2, method)] // RM: 10 @ ₹10
      const mfg = [line(10, '2025-05-10', 1, 'out', 10000), line(10, '2025-05-10', 2, 'in', 2000, 0)]
      const sale = line(11, '2025-05-20', 2, 'out', 1000)
      const costing = new Map([[10, derived(5000)]])
      const before = runInventoryPass({ items, movements: [...mfg, sale], costing })
      expect(before.derived.get(10)!.inwardValue).toBe(100000 + 5000)

      // Backdated: May 1 purchase of 10 RM @ ₹30 posted after the fact (higher voucher id).
      const backdated = line(50, '2025-05-01', 1, 'in', 10000, 300000)
      const after = runInventoryPass({ items, movements: [backdated, ...mfg, sale], costing })
      const consumed = method === 'fifo' ? 100000 /* oldest 10 @ ₹10 */ : 200000 /* avg ₹20 */
      expect(after.derived.get(10)).toEqual({ consumedValue: consumed, additionalCostPaise: 5000, inwardValue: consumed + 5000 })
      // The finished good carries exactly that cost; its sale takes half of it.
      expect(after.closing.get(2)!.consumedValue).toBe(Math.round((consumed + 5000) / 2))
      expect(after.closing.get(2)!.closingValue + after.closing.get(2)!.consumedValue).toBe(consumed + 5000)
      assertConserved({ items, movements: [backdated, ...mfg, sale], costing })
    }
  })

  it('multi-level chain: a finished good consumed by another derived voucher in the same pass', () => {
    for (const method of ['weighted_avg', 'fifo'] as const) {
      const items = [item(1, method, 20000, 200000), item(2, method), item(3, method), item(4, method, 5000, 25000)]
      const movements = [
        // V1: 10 RM → 5 sub-assemblies, labour 3000.
        line(1, '2025-06-01', 1, 'out', 10000),
        line(1, '2025-06-01', 2, 'in', 5000, 0),
        // V2 (same date, later id): 4 sub-assemblies + 5 packaging → 2 finished goods, labour 700.
        line(2, '2025-06-01', 3, 'in', 2000, 0),
        line(2, '2025-06-01', 2, 'out', 4000),
        line(2, '2025-06-01', 4, 'out', 5000)
      ]
      const costing = new Map([[1, derived(3000)], [2, derived(700)]])
      const res = runInventoryPass({ items, movements, costing })
      expect(res.derived.get(1)!.inwardValue).toBe(100000 + 3000)
      const sub = Math.round((103000 * 4000) / 5000) // 4 of 5 sub-assemblies
      expect(res.derived.get(2)).toEqual({ consumedValue: sub + 25000, additionalCostPaise: 700, inwardValue: sub + 25000 + 700 })
      expect(res.closing.get(3)!.closingValue).toBe(sub + 25700)
      expect(res.closing.get(2)!.closingValue).toBe(103000 - sub)
      assertConserved({ items, movements, costing })
    }
  })

  it('multi-level chain where the consumer is ordered first: it sees no sub-assembly yet, still conserves', () => {
    const items = [item(1, 'weighted_avg', 20000, 200000), item(2, 'weighted_avg'), item(3, 'weighted_avg')]
    const movements = [
      line(1, '2025-06-01', 2, 'out', 4000), // consumer first: sub-assembly not made yet → cost 0
      line(1, '2025-06-01', 3, 'in', 2000, 0),
      line(2, '2025-06-01', 1, 'out', 10000),
      line(2, '2025-06-01', 2, 'in', 5000, 0)
    ]
    const costing = new Map([[1, derived(0)], [2, derived(0)]])
    const res = runInventoryPass({ items, movements, costing })
    expect(res.derived.get(1)!.inwardValue).toBe(0)
    expect(res.closing.get(2)).toMatchObject({ closingQtyMilli: 1000, closingValue: 100000 })
    assertConserved({ items, movements, costing })
  })

  it('splits the conserved total by stored amount, else by quantity, else equally', () => {
    const items = [item(1, 'weighted_avg', 10000, 100001), item(2, 'weighted_avg'), item(3, 'weighted_avg')]
    const run = (a2: number, a3: number, q2: number, q3: number): number[] => {
      const ms = [line(1, '2025-05-01', 1, 'out', 10000), line(1, '2025-05-01', 2, 'in', q2, a2), line(1, '2025-05-01', 3, 'in', q3, a3)]
      const res = runInventoryPass({ items, movements: ms, costing: new Map([[1, derived(0)]]) })
      return [res.closing.get(2)!.closingValue, res.closing.get(3)!.closingValue]
    }
    expect(run(100, 300, 5000, 5000)).toEqual([25000, 75001]) // by amount 1:3 (remainder to the larger fraction)
    expect(run(0, 0, 1000, 3000)).toEqual([25000, 75001]) // by quantity 1:3
    expect(run(0, 0, 0, 0)).toEqual([50001, 50000]) // equally, tie → earlier line
  })

  it("FIFO deficit under a derived voucher: only on-hand cost flows in; the backfill stays the raw material's consumption", () => {
    const items = [item(1, 'fifo', 2000, 20000), item(2, 'fifo')]
    const movements = [
      line(1, '2025-05-01', 1, 'out', 5000), // 2 on hand @ ₹10 → 20000 now, 3 in deficit
      line(1, '2025-05-01', 2, 'in', 1000, 0),
      line(2, '2025-05-02', 1, 'in', 10000, 300000) // backfills the deficit at ₹30 → 90000
    ]
    const res = runInventoryPass({ items, movements, costing: new Map([[1, derived(0)]]) })
    expect(res.derived.get(1)!.inwardValue).toBe(20000)
    expect(res.closing.get(1)).toMatchObject({ closingQtyMilli: 7000, closingValue: 210000, consumedValue: 110000 })
    // Same raw-material figures as a plain (stored) consumption — deficit semantics unchanged.
    const stored = runInventoryPass({ items, movements })
    expect(res.closing.get(1)).toEqual(stored.closing.get(1))
  })
})

// ---------- cost as of ----------

describe('stockCostPositionsAsOf / averageCostAsOf / costConsumption', () => {
  const items = [item(1, 'weighted_avg', 3000, 10000), item(2, 'fifo', 2000, 5000)]
  const movements = [
    line(1, '2025-05-01', 1, 'in', 3000, 20000),
    line(1, '2025-05-01', 2, 'in', 4000, 40000),
    line(2, '2025-05-05', 1, 'out', 1000),
    line(3, '2025-05-05', 2, 'out', 3000),
    line(4, '2025-05-09', 1, 'in', 6000, 90000)
  ]
  const input: InventoryPassInput = { items, movements }

  it('reports exact running average, unit cost and FIFO next layer as of a date', () => {
    const [avg, fifo] = stockCostPositionsAsOf(input, { date: '2025-05-05' }, [1, 2])
    // Item 1: 6 for 30000, minus round(30000/6) = 5000 → 5 for 25000.
    expect(avg).toEqual({
      itemId: 1, method: 'weighted_avg', qtyMilli: 5000, value: 25000,
      averageCostPerUnitPaise: 5000, unitCostPaise: 5000, nextLayer: null
    })
    // Item 2: layers 2@5000, 4@40000; out 3 → 2@5000 + 1 of layer 2 (10000) → left 3@30000.
    expect(fifo).toEqual({
      itemId: 2, method: 'fifo', qtyMilli: 3000, value: 30000,
      averageCostPerUnitPaise: 10000, unitCostPaise: 10000, nextLayer: { qtyMilli: 3000, value: 30000, perUnitPaise: 10000 }
    })
    expect(averageCostAsOf(input, 1, { date: '2025-05-09' })).toBe(Math.round((115000 * 1000) / 11000))
  })

  it('positions an edited voucher among its own date and leaves its saved lines out', () => {
    // Pricing voucher 3 (edit): after v2 on 05-05, without v3's own outward.
    const [, fifo] = stockCostPositionsAsOf(input, { date: '2025-05-05', voucherId: 3 }, [1, 2])
    expect(fifo).toMatchObject({ qtyMilli: 6000, value: 45000, nextLayer: { qtyMilli: 2000, value: 5000 } })
    // Moving voucher 1 to a later date: its own purchases vanish from the earlier position.
    const [avg] = stockCostPositionsAsOf(input, { date: '2025-05-06', voucherId: 1 }, [1])
    expect(avg).toMatchObject({ qtyMilli: 2000, value: Math.round(10000 - 10000 / 3) })
  })

  it('prices proposed outward lines exactly, consuming the same item sequentially, without mutating', () => {
    const c = costConsumption(input, [{ itemId: 2, qtyMilli: 2500 }, { itemId: 2, qtyMilli: 1000 }, { itemId: 1, qtyMilli: 0 }], { date: '2025-05-01' })
    // FIFO item 2 as of 05-01: 2@5000, 4@40000. 2.5 → 5000 + round(40000*0.5/4)=5000; 1 → 10000.
    expect(c.lines.map((l) => l.costPaise)).toEqual([10000, 10000, 0])
    expect(c.totalPaise).toBe(20000)
    // Saving those as a derived voucher books exactly that value.
    const mfg = [line(9, '2025-05-01', 2, 'out', 2500), line(9, '2025-05-01', 2, 'out', 1000), line(9, '2025-05-01', 1, 'in', 1000, 0)]
    const res = runInventoryPass({ items, movements: [...movements, ...mfg], costing: new Map([[9, derived(0)]]) })
    expect(res.derived.get(9)!.inwardValue).toBe(20000)
    // Pricing never touched the input.
    expect(runInventoryPass(input).closing).toEqual(runInventoryPass({ items, movements: [...movements] }).closing)
  })
})

describe('allocateExact', () => {
  it('conserves every paisa with exact integer arithmetic, also for huge and negative totals', () => {
    expect(allocateExact([1, 1, 1], 100)).toEqual([34, 33, 33])
    expect(allocateExact([1, 1, 1], -100)).toEqual([-34, -33, -33])
    const big = allocateExact([9_000_000_000_000, 1, 7], 9_007_199_254_740)
    expect(big.reduce((s, x) => s + x, 0)).toBe(9_007_199_254_740)
    expect(allocateExact([], 5)).toEqual([])
    expect(allocateExact([0, 0], 3)).toEqual([2, 1])
  })
})

// ---------- per-line observer (WP 2.3 movement register) ----------

describe('runInventoryPass — observer', () => {
  it("one item's line effects chain from its opening to its closing (200 random books, mixed costing rules)", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const { input, journals } = randomBook(seed)
      const costing = new Map<number, VoucherCosting>()
      journals.forEach((v, i) => costing.set(v, i % 2 === 0 ? derived(i * 37) : { rule: 'stored', additionalCostPaise: i * 11 }))
      const full = { ...input, costing }
      const watched = 1 + (seed % input.items.length)
      const effects: { qtyDelta: number; valueDelta: number; qtyAfter: number; valueAfter: number }[] = []
      const { closing } = runInventoryPass(full, [], { itemId: watched, onLine: (e) => effects.push(e) })
      const it = input.items.find((i) => i.itemId === watched)!
      let q = it.openingQtyMilli
      let v = it.openingValue
      for (const e of effects) {
        q += e.qtyDelta
        v += e.valueDelta
        expect(e.qtyAfter).toBe(q)
        expect(e.valueAfter).toBe(v)
      }
      const c = closing.get(watched)!
      expect(q).toBe(c.closingQtyMilli)
      expect(v).toBe(c.closingValue)
      expect(effects).toHaveLength(full.movements.filter((m) => m.itemId === watched).length)
    }
  })

  it('without itemId it sees every line once, in pass order; observing changes nothing', () => {
    const { input } = randomBook(7)
    const seen: number[] = []
    const watched = runInventoryPass(input, [], { onLine: (e) => seen.push(e.movement.lineId!) })
    expect(seen).toEqual(input.movements.map((m) => m.lineId))
    expect(watched.closing).toEqual(runInventoryPass(input).closing)
  })
})
