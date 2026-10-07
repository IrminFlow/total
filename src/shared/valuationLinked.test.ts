// WP 2.5a (design §3): the 'linked' costing rule — GRN re-pricing (`billed`) and return costing
// (`returnOf`). 'linked' only CHOOSES inward amounts; the state machine still moves all value,
// so a linked pass equals a 'stored' pass with those amounts substituted.
import { describe, it, expect } from 'vitest'
import {
  bookedInwardValues, costSourcesOf, linkedInwardValue, needsPass, runInventoryPass,
  type InventoryItem, type InventoryMovement, type InventoryPassInput, type LinkedLineCosting, type VoucherCosting
} from './valuation'

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
const mv = (voucherId: number, date: string, itemId: number, direction: 'in' | 'out', qtyMilli: number, amount = 0, isAbsolute = false): InventoryMovement => ({
  voucherId, date, itemId, direction, qtyMilli, amount, isAbsolute, lineId: nextLine++
})

describe('linkedInwardValue (§3.1)', () => {
  const grn = { qtyMilli: 10000, amount: 100000 }
  it('unbilled = stored; partial = billed + unbilled share; full = Σ billed', () => {
    expect(linkedInwardValue(grn, [])).toBe(100000)
    expect(linkedInwardValue(grn, [{ qtyMilli: 6000, amount: 66000 }])).toBe(106000)
    expect(linkedInwardValue(grn, [{ qtyMilli: 6000, amount: 66000 }, { qtyMilli: 4000, amount: 46000 }])).toBe(112000)
    expect(linkedInwardValue(grn, [{ qtyMilli: 2000, amount: 0 }])).toBe(80000)
  })

  it('rounds exactly in integer paise (thirds of ₹1,000)', () => {
    const g = { qtyMilli: 3000, amount: 100000 }
    const third = { qtyMilli: 1000, amount: 33333 }
    expect(linkedInwardValue(g, [third])).toBe(33333 + (100000 - 33333))
    expect(linkedInwardValue(g, [third, third])).toBe(66666 + (100000 - 66667))
    expect(linkedInwardValue(g, [third, third, { qtyMilli: 1000, amount: 33334 }])).toBe(100000)
    // Huge values stay exact (paise × thousandths beyond 2^53).
    expect(linkedInwardValue({ qtyMilli: 999_999_999, amount: 9_000_000_000_000 }, [{ qtyMilli: 333_333_333, amount: 1 }])).toBe(
      1 + 9_000_000_000_000 - 3_000_000_000_000
    )
  })

  it('throws when billed beyond the line', () => {
    expect(() => linkedInwardValue(grn, [{ qtyMilli: 10001, amount: 1 }])).toThrow(/exceeds/)
  })
})

/** Random book plus random linked costing (billed GRN lines, returns of earlier outward lines). */
function linkedBook(seed: number): { input: InventoryPassInput; returns: { lineId: number; source: number; q: number; srcQ: number }[] } {
  const rand = prng(seed)
  const int = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1))
  const items: InventoryItem[] = [1, 2, 3].map((i) => ({
    itemId: i, method: rand() < 0.5 ? 'fifo' : 'weighted_avg', openingQtyMilli: int(0, 40) * 1000, openingValue: int(0, 400000)
  }))
  const movements: InventoryMovement[] = []
  const costing = new Map<number, VoucherCosting>()
  const outs: InventoryMovement[] = []
  const returns: { lineId: number; source: number; q: number; srcQ: number }[] = []
  for (let v = 1; v <= 70; v++) {
    const date = `2025-05-${String(Math.ceil(v / 3)).padStart(2, '0')}`
    const it = int(1, 3)
    const q = int(1, 20) * 1000
    const r = rand()
    if (r < 0.3) {
      const m = mv(v, date, it, 'in', q, int(0, 300000))
      movements.push(m)
      const billed = rand() < 0.5 ? [{ qtyMilli: int(0, q / 1000) * 1000, amount: int(0, 400000) }] : []
      if (billed.length) costing.set(v, { rule: 'linked', linked: new Map<number, LinkedLineCosting>([[m.lineId!, { billed }]]) })
    } else if (r < 0.6) {
      const m = mv(v, date, it, 'out', q)
      movements.push(m)
      outs.push(m)
    } else if (r < 0.75 && outs.length > 0) {
      const src = outs[int(0, outs.length - 1)]!
      const back = int(1, src.qtyMilli / 1000) * 1000
      const m = mv(v, date, src.itemId, 'in', back, int(0, 99999))
      movements.push(m)
      costing.set(v, { rule: 'linked', linked: new Map([[m.lineId!, { returnOf: { sourceLineId: src.lineId!, sourceQtyMilli: src.qtyMilli } }]]) })
      returns.push({ lineId: m.lineId!, source: src.lineId!, q: back, srcQ: src.qtyMilli })
    } else {
      movements.push(mv(v, date, it, 'in', rand() < 0.3 ? 0 : q, 0, true))
    }
  }
  return { input: { items, movements, costing }, returns }
}

describe("runInventoryPass — 'linked' rule", () => {
  it('equals a stored pass with the booked inward amounts substituted (value conserved) — 200 random books', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const { input, returns } = linkedBook(seed * 7919)
      const charged = new Map<number, number>()
      const r = runInventoryPass(input, [], { onLine: (e) => e.movement.direction === 'out' && !e.movement.isAbsolute && charged.set(e.movement.lineId!, 0 - e.valueDelta) })
      // Each return entered at its share of the source's engine cost (sources come first here).
      for (const ret of returns) {
        const cost = charged.get(ret.source)!
        expect(r.inwardValueByLine.get(ret.lineId)).toBe(Math.round((cost * ret.q) / ret.srcQ))
      }
      expect(r.linkedFallbacks).toEqual([])
      const stored: InventoryPassInput = {
        items: input.items,
        movements: input.movements.map((m) => (r.inwardValueByLine.has(m.lineId!) ? { ...m, amount: r.inwardValueByLine.get(m.lineId!)! } : m))
      }
      expect(runInventoryPass(stored).closing).toEqual(r.closing)
    }
  })

  it("with no linked entries it is the 'stored' pass exactly (legacy books untouched)", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const { input } = linkedBook(seed * 131)
      const plain = { items: input.items, movements: input.movements }
      const empty = new Map([...input.costing!.keys()].map((v) => [v, { rule: 'linked', linked: new Map() } as VoucherCosting]))
      expect(runInventoryPass({ ...plain, costing: empty }).closing).toEqual(runInventoryPass(plain).closing)
    }
  })

  it('a return dated before its source falls back to the stored amount and is reported', () => {
    const items: InventoryItem[] = [{ itemId: 1, method: 'weighted_avg', openingQtyMilli: 10000, openingValue: 100000 }]
    const ret = mv(1, '2025-05-01', 1, 'in', 1000, 5555)
    const sale = mv(2, '2025-05-05', 1, 'out', 4000)
    const costing = new Map<number, VoucherCosting>([[1, { rule: 'linked', linked: new Map([[ret.lineId!, { returnOf: { sourceLineId: sale.lineId!, sourceQtyMilli: 4000 } }]]) }]])
    const r = runInventoryPass({ items, movements: [ret, sale], costing })
    expect(r.linkedFallbacks).toEqual([ret.lineId])
    expect(r.inwardValueByLine.get(ret.lineId!)).toBe(5555)
  })

  it('re-pricing is positional at the GRN: consumption after it is re-costed (WA and FIFO)', () => {
    for (const method of ['weighted_avg', 'fifo'] as const) {
      const items: InventoryItem[] = [{ itemId: 1, method, openingQtyMilli: 10000, openingValue: 50000 }]
      const g = mv(1, '2025-05-01', 1, 'in', 10000, 100000)
      const s = mv(2, '2025-05-03', 1, 'out', 15000)
      const costing = new Map<number, VoucherCosting>([[1, { rule: 'linked', linked: new Map([[g.lineId!, { billed: [{ qtyMilli: 10000, amount: 130000 }] }]]) }]])
      const r = runInventoryPass({ items, movements: [g, s], costing }).closing.get(1)!
      expect(r.consumedValue).toBe(method === 'fifo' ? 115000 : 135000)
      expect(r.closingValue + r.consumedValue).toBe(50000 + 130000)
    }
  })

  it('bookedInwardValues needs no pass for billed-only costing and matches the pass', () => {
    const items: InventoryItem[] = [{ itemId: 1, method: 'fifo', openingQtyMilli: 0, openingValue: 0 }]
    const g = mv(1, '2025-05-01', 1, 'in', 10000, 100000)
    const costing = new Map<number, VoucherCosting>([[1, { rule: 'linked', linked: new Map([[g.lineId!, { billed: [{ qtyMilli: 5000, amount: 70000 }] }]]) }]])
    expect(needsPass(costing.get(1)!)).toBe(false)
    expect(bookedInwardValues({ items: [], movements: [g], costing }).get(g.lineId!)).toBe(120000)
    expect(runInventoryPass({ items, movements: [g], costing }).inwardValueByLine.get(g.lineId!)).toBe(120000)
    const ret = { rule: 'linked', linked: new Map([[9, { returnOf: { sourceLineId: 3, sourceQtyMilli: 1 } }]]) } as VoucherCosting
    expect(needsPass(ret)).toBe(true)
    expect([...costSourcesOf(new Map([[5, ret]]))]).toEqual([3])
  })
})
