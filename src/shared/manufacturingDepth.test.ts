// WP 2.4 — engine unit tests: BOM explosion (multi-level, versions, scrap rounding, cycles), the
// derived rule's by-product split, the 'transfer' costing rule, material-variance maths, the
// shared manufacture rules with by-products / job work, report aggregation and lot ageing.
import { describe, expect, it } from 'vitest'
import {
  bookedInwardValues, runInventoryPass, splitDerivedInward,
  type InventoryItem, type InventoryMovement, type ValuationMethod, type VoucherCosting
} from './valuation'
import { componentQtyMilli, explodeBom, materialVariance, pickBomVersion, validateBomVersion, versionWouldCycle, type BomVersion } from './bom'
import { buildManufactureVoucher, manufactureTotals, validateManufacture, type ManufactureInput } from './manufacture'
import { averageCostSheet, marginRows, productionRegister, type CostSheet, type ManufactureFact } from './manufactureReports'
import { ageLots, daysBetween } from './jobWork'

let nextLine = 1
const line = (voucherId: number, date: string, itemId: number, direction: 'in' | 'out', qtyMilli: number, amount = 0): InventoryMovement => ({
  voucherId, date, itemId, direction, qtyMilli, amount, lineId: nextLine++
})
const item = (itemId: number, method: ValuationMethod = 'weighted_avg', q = 0, v = 0): InventoryItem => ({ itemId, method, openingQtyMilli: q, openingValue: v })

// ---------- derived rule with by-products ----------

describe('splitDerivedInward', () => {
  it('books fixed lines at their assigned value and gives the remainder to the main line', () => {
    expect(splitDerivedInward(100_000, [20_000, 5_000])).toEqual({ fixed: [20_000, 5_000], remainder: 75_000 })
  })
  it('exactly equal → zero remainder', () => {
    expect(splitDerivedInward(25_000, [20_000, 5_000])).toEqual({ fixed: [20_000, 5_000], remainder: 0 })
  })
  it('total below Σ fixed: fixed lines share the total pro-rata, main gets 0 (conserved, never negative)', () => {
    const r = splitDerivedInward(10_001, [20_000, 5_000])
    expect(r.remainder).toBe(0)
    expect(r.fixed.reduce((s, x) => s + x, 0)).toBe(10_001)
    expect(r.fixed).toEqual([8001, 2000])
  })
  it('no main line: fixed lines share the whole total', () => {
    expect(splitDerivedInward(9000, [1000, 2000], false).fixed).toEqual([3000, 6000])
  })
  it('no fixed lines: everything is remainder (the WP 2.2 behaviour)', () => {
    expect(splitDerivedInward(-500, [])).toEqual({ fixed: [], remainder: -500 })
  })
})

describe("runInventoryPass — 'derived' with by-products", () => {
  // 1 = steel (10 @ ₹100 opening), 2 = chair (finished), 3 = offcuts (by-product).
  const setup = (purchaseFirst?: { qty: number; amount: number }) => {
    const raw = line(10, '2025-06-10', 1, 'out', 4000, 40000)
    const fin = line(10, '2025-06-10', 2, 'in', 2000, 41000)
    const bp = line(10, '2025-06-10', 3, 'in', 1000, 5000)
    const moves: InventoryMovement[] = [raw, fin, bp]
    if (purchaseFirst) moves.unshift(line(5, '2025-06-01', 1, 'in', purchaseFirst.qty, purchaseFirst.amount))
    const costing = new Map<number, VoucherCosting>([
      [10, { rule: 'derived', additionalCostPaise: 6000, fixedInwardByLine: new Map([[bp.lineId!, 5000]]) }]
    ])
    return { res: runInventoryPass({ items: [item(1, 'weighted_avg', 10000, 100_000), item(2), item(3)], movements: moves, costing }), fin, bp }
  }

  it('Σ consumption + labour = finished value + Σ by-product values', () => {
    const { res, fin, bp } = setup()
    // 4 steel @ ₹100 = ₹400 (40000) + labour 6000 = 46000; by-product 5000; chair 41000.
    expect(res.derived.get(10)).toEqual({ consumedValue: 40000, additionalCostPaise: 6000, inwardValue: 46000, fixedValue: 5000, mainValue: 41000 })
    expect(res.inwardValueByLine.get(fin.lineId!)).toBe(41000)
    expect(res.inwardValueByLine.get(bp.lineId!)).toBe(5000)
    expect(res.closing.get(2)!.closingValue).toBe(41000)
    expect(res.closing.get(3)!.closingValue).toBe(5000)
  })

  it('a backdated purchase re-prices only the main item; the by-product keeps its assigned value', () => {
    // +10 steel @ ₹200 before → average ₹150 → 4 steel = 60000.
    const { res } = setup({ qty: 10000, amount: 200_000 })
    expect(res.derived.get(10)).toMatchObject({ consumedValue: 60000, fixedValue: 5000, mainValue: 61000 })
    expect(res.closing.get(3)!.closingValue).toBe(5000)
  })
})

// ---------- transfer rule ----------

describe("runInventoryPass — 'transfer' rule", () => {
  const transferBook = (rule: 'stored' | 'transfer', method: ValuationMethod, backdated: boolean) => {
    const out = line(20, '2025-06-15', 1, 'out', 4000, 40000)
    const into = line(20, '2025-06-15', 1, 'in', 4000, 40000) // saved at ₹100 (the save-time cost)
    const moves: InventoryMovement[] = [out, into, line(30, '2025-06-20', 1, 'out', 2000)]
    if (backdated) moves.unshift(line(5, '2025-06-01', 1, 'in', 10000, 200_000))
    const costing = new Map<number, VoucherCosting>(rule === 'transfer' ? [[20, { rule: 'transfer' }]] : [])
    return { res: runInventoryPass({ items: [item(1, method, 10000, 100_000)], movements: moves, costing }), into }
  }

  it.each(['weighted_avg', 'fifo'] as const)('%s: the inward leg equals the outward leg’s engine cost after a backdated purchase', (method) => {
    const { res, into } = transferBook('transfer', method, true)
    const booked = res.inwardValueByLine.get(into.lineId!)!
    // WA: average ₹150 → 60000. FIFO: oldest layer ₹100 → 40000.
    expect(booked).toBe(method === 'weighted_avg' ? 60000 : 40000)
    // The transfer itself never changes the item's value: opening 10 L + purchase 20 L − one sale.
    const withoutTransfer = runInventoryPass({
      items: [item(1, method, 10000, 100_000)],
      movements: [line(5, '2025-06-01', 1, 'in', 10000, 200_000), line(30, '2025-06-20', 1, 'out', 2000)]
    })
    if (method === 'weighted_avg') expect(res.closing.get(1)!.closingValue).toBe(withoutTransfer.closing.get(1)!.closingValue)
    expect(res.closing.get(1)!.closingQtyMilli).toBe(18000)
  })

  it('stored rule drifts (the WP 2.3 known limit): the inward leg stays at its save-time ₹100', () => {
    const { res } = transferBook('stored', 'weighted_avg', true)
    const transfer = transferBook('transfer', 'weighted_avg', true).res
    expect(res.closing.get(1)!.closingValue).not.toBe(transfer.closing.get(1)!.closingValue)
    // stored: value 300,000 − 60000 + 40000 = 280,000 before the sale.
    expect(res.closing.get(1)!.closingValue).toBeLessThan(transfer.closing.get(1)!.closingValue)
  })

  it('no backdated change: transfer and stored agree to the paisa', () => {
    const a = transferBook('transfer', 'weighted_avg', false).res
    const b = transferBook('stored', 'weighted_avg', false).res
    expect(a.closing.get(1)).toEqual(b.closing.get(1))
  })

  it('an inward line without an outward partner keeps its stored amount', () => {
    const lone = line(40, '2025-06-01', 2, 'in', 1000, 777)
    const res = runInventoryPass({ items: [item(2)], movements: [lone], costing: new Map([[40, { rule: 'transfer' }]]) })
    expect(res.inwardValueByLine.get(lone.lineId!)).toBe(777)
  })

  it('pairs several rows of the same item by quantity, in order', () => {
    const o1 = line(50, '2025-06-01', 1, 'out', 1000)
    const i1 = line(50, '2025-06-01', 1, 'in', 1000, 1)
    const o2 = line(50, '2025-06-01', 1, 'out', 3000)
    const i2 = line(50, '2025-06-01', 1, 'in', 3000, 1)
    const res = runInventoryPass({ items: [item(1, 'fifo', 10000, 100_000)], movements: [o1, i1, o2, i2], costing: new Map([[50, { rule: 'transfer' }]]) })
    expect(res.inwardValueByLine.get(i1.lineId!)).toBe(10000)
    expect(res.inwardValueByLine.get(i2.lineId!)).toBe(30000)
    expect(res.closing.get(1)!.closingValue).toBe(100_000)
  })

  it('bookedInwardValues runs the full pass when any voucher is a transfer', () => {
    const out = line(60, '2025-06-01', 1, 'out', 1000)
    const into = line(60, '2025-06-01', 1, 'in', 1000, 0)
    const booked = bookedInwardValues({ items: [item(1, 'weighted_avg', 10000, 100_000)], movements: [out, into], costing: new Map([[60, { rule: 'transfer' }]]) })
    expect(booked.get(into.lineId!)).toBe(10000)
  })
})

// ---------- BOM explosion ----------

const ver = (id: number, itemId: number, lines: [number, number, number?][], o: Partial<BomVersion> = {}): BomVersion => ({
  id, itemId, name: `v${id}`, effectiveFrom: null, effectiveTo: null, isDefault: true,
  lines: lines.map(([componentId, qtyMilliPerUnit, scrapPctBp]) => ({ componentId, qtyMilliPerUnit, scrapPctBp: scrapPctBp ?? null })), ...o
})

describe('componentQtyMilli — rounding rule', () => {
  it('scales per unit and rounds half up to the thousandth', () => {
    expect(componentQtyMilli(2000, 1500)).toBe(3000)
    expect(componentQtyMilli(1, 500)).toBe(1) // 0.5 thousandth → 1
    expect(componentQtyMilli(1, 499)).toBe(0)
  })
  it('applies scrap in basis points', () => {
    expect(componentQtyMilli(1000, 1000, 500)).toBe(1050) // +5 %
    expect(componentQtyMilli(3000, 333, 1000)).toBe(1099) // 999 × 1.1 = 1098.9 → 1099
  })
  it('stays exact for very large quantities (BigInt)', () => {
    expect(componentQtyMilli(1e12, 1e6, 0)).toBe(1e15)
  })
})

describe('pickBomVersion', () => {
  const versions = [
    ver(1, 9, [[2, 1000]], { name: 'v1', isDefault: true }),
    ver(2, 9, [[2, 900]], { name: 'v2', isDefault: false, effectiveFrom: '2025-07-01' }),
    ver(3, 9, [[2, 800]], { name: 'promo', isDefault: false, effectiveFrom: '2025-08-01', effectiveTo: '2025-08-31' })
  ]
  it('takes the latest-starting version in force on the date', () => {
    expect(pickBomVersion(versions, 9, '2025-06-30')!.id).toBe(1)
    expect(pickBomVersion(versions, 9, '2025-07-15')!.id).toBe(2)
    expect(pickBomVersion(versions, 9, '2025-08-15')!.id).toBe(3)
    expect(pickBomVersion(versions, 9, '2025-09-01')!.id).toBe(2)
  })
  it('falls back to the default when nothing is in force, else null', () => {
    const only = [ver(4, 9, [[2, 1]], { effectiveFrom: '2026-01-01', isDefault: true })]
    expect(pickBomVersion(only, 9, '2025-01-01')!.id).toBe(4)
    expect(pickBomVersion(only, 8, '2025-01-01')).toBeNull()
  })
})

describe('explodeBom', () => {
  // Table(1) = 4 Legs(2) + 1 Top(3); Leg(2) = 0.5 Wood(4) + 2 Screws(5) with 10 % scrap on wood;
  // Top(3) = 2 Wood(4) + 8 Screws(5).
  const versions = [ver(10, 1, [[2, 4000], [3, 1000]]), ver(20, 2, [[4, 500, 1000], [5, 2000]]), ver(30, 3, [[4, 2000], [5, 8000]])]

  it("'single' returns the direct components and names the sub-assemblies", () => {
    const r = explodeBom(1, 3000, versions, '2025-06-01', { levels: 'single' })
    expect(r.ok && r.rows).toEqual([{ componentId: 2, qtyMilli: 12000 }, { componentId: 3, qtyMilli: 3000 }])
    expect(r.ok && r.subAssemblies.map((s) => [s.itemId, s.qtyMilli])).toEqual([[2, 12000], [3, 3000]])
    expect(r.ok && r.versionId).toBe(10)
  })

  it("'full' returns the leaves summed across paths (rounded per edge)", () => {
    const r = explodeBom(1, 3000, versions, '2025-06-01', { levels: 'full' })
    if (!r.ok) throw new Error('cycle')
    // Legs 12 → wood 12 × 0.5 × 1.1 = 6.6, screws 24; Top 3 → wood 6, screws 24.
    expect(r.rows).toEqual([{ componentId: 4, qtyMilli: 12600 }, { componentId: 5, qtyMilli: 48000 }])
    expect(r.tree.children.map((c) => [c.itemId, c.qtyMilli, c.children.length])).toEqual([[2, 12000, 2], [3, 3000, 2]])
    expect(r.subAssemblies.map((s) => s.itemId)).toEqual([2, 3])
  })

  it('rounds each edge before deriving the next level', () => {
    // A(1) = 0.333 B(2); B = 0.333 C(3). For 1 A: B = 0.333, C = round(0.333 × 0.333 = 0.110889) = 0.111.
    const r = explodeBom(1, 1000, [ver(1, 1, [[2, 333]]), ver(2, 2, [[3, 333]])], '2025-06-01', { levels: 'full' })
    expect(r.ok && r.rows).toEqual([{ componentId: 3, qtyMilli: 111 }])
  })

  it('pins the top-level version when asked', () => {
    const vs = [...versions, ver(11, 1, [[3, 2000]], { isDefault: false, name: 'heavy' })]
    const r = explodeBom(1, 1000, vs, '2025-06-01', { levels: 'single', versionId: 11 })
    expect(r.ok && r.rows).toEqual([{ componentId: 3, qtyMilli: 2000 }])
  })

  it('is cycle-safe: a loop in stored data returns an error instead of recursing', () => {
    const cyclic = [ver(1, 1, [[2, 1000]]), ver(2, 2, [[3, 1000]]), ver(3, 3, [[1, 1000]])]
    const r = explodeBom(1, 1000, cyclic, '2025-06-01', { levels: 'full' })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.path).toEqual([1, 2, 3, 1])
    // single level never recurses, so it still works on the same data
    expect(explodeBom(1, 1000, cyclic, '2025-06-01', { levels: 'single' }).ok).toBe(true)
  })

  it('an item without a BOM explodes to nothing', () => {
    const r = explodeBom(7, 1000, versions, '2025-06-01', { levels: 'full' })
    expect(r.ok && r.versionId).toBeNull()
    expect(r.ok && r.rows).toEqual([])
  })

  it('versionWouldCycle reuses wouldCreateBomCycle across every version', () => {
    expect(versionWouldCycle(4, [1], versions)).toBe(true) // wood ← table → … → wood
    expect(versionWouldCycle(1, [5], versions)).toBe(false)
  })

  it('validateBomVersion catches the basics', () => {
    expect(validateBomVersion({ itemId: 1, name: ' ', effectiveFrom: '2025-02-01', effectiveTo: '2025-01-01', lines: [{ componentId: 1, qtyMilliPerUnit: 0, scrapPctBp: -1 }, { componentId: 1, qtyMilliPerUnit: 1, scrapPctBp: null }] }))
      .toHaveLength(7)
  })
})

// ---------- variance maths ----------

describe('materialVariance', () => {
  it('equal quantities → zero value variance exactly (standard valued at the actual ratio)', () => {
    const [r] = materialVariance([{ componentId: 1, qtyMilli: 3000 }], [{ componentId: 1, qtyMilli: 3000, valuePaise: 10001 }])
    expect(r).toMatchObject({ qtyVarianceMilli: 0, standardValuePaise: 10001, valueVariancePaise: 0 })
  })
  it('over-consumption is adverse in quantity and value', () => {
    const [r] = materialVariance([{ componentId: 1, qtyMilli: 4000 }], [{ componentId: 1, qtyMilli: 5000, valuePaise: 75000 }])
    expect(r).toMatchObject({ standardQtyMilli: 4000, actualQtyMilli: 5000, qtyVarianceMilli: 1000, standardValuePaise: 60000, valueVariancePaise: 15000 })
  })
  it('an unplanned component and an unconsumed standard one (valued at the fallback average)', () => {
    const rows = materialVariance(
      [{ componentId: 1, qtyMilli: 2000 }],
      [{ componentId: 2, qtyMilli: 1000, valuePaise: 500 }],
      (id) => (id === 1 ? 15000 : 0)
    )
    expect(rows).toEqual([
      { componentId: 1, standardQtyMilli: 2000, actualQtyMilli: 0, actualValuePaise: 0, standardValuePaise: 30000, qtyVarianceMilli: -2000, valueVariancePaise: -30000 },
      { componentId: 2, standardQtyMilli: 0, actualQtyMilli: 1000, actualValuePaise: 500, standardValuePaise: 0, qtyVarianceMilli: 1000, valueVariancePaise: 500 }
    ])
  })
})

// ---------- manufacture rules with by-products / job work ----------

const mfg = (o: Partial<ManufactureInput> = {}): ManufactureInput => ({
  date: '2025-06-10', finishedItemId: 1, qtyMilli: 2000, saleRatePaise: 100000,
  raw: [{ stockItemId: 2, qtyMilli: 4000 }], labourPaise: 30000, labourPosted: true, profitPaise: 0, ...o
})

describe('manufacture with by-products', () => {
  it('production cost is net of by-products and profit follows it', () => {
    const t = manufactureTotals({ qtyMilli: 2000, saleRatePaise: 100000, materialPaise: 60000, labourPaise: 30000, byProductPaise: 10000 })
    expect(t).toMatchObject({ grossCost: 90000, byProductPaise: 10000, productionCost: 80000, profit: 120000, rightTotal: 200000, saleAmount: 200000 })
  })

  it('rejects by-products worth more than materials + labour', () => {
    const input = mfg({ byProducts: [{ stockItemId: 3, qtyMilli: 1000, valuePaise: 100000, kind: 'scrap' }], profitPaise: 200000 - (60000 + 30000 - 100000) })
    expect(validateManufacture(input, 60000).map((i) => i.code)).toContain('byproducts_exceed_cost')
  })

  it('rejects incomplete / duplicate / self by-product rows with their row index', () => {
    const issues = validateManufacture(
      mfg({
        byProducts: [
          { stockItemId: 3, qtyMilli: 0, valuePaise: 0, kind: 'by_product' },
          { stockItemId: 1, qtyMilli: 1000, valuePaise: 0, kind: 'by_product' },
          { stockItemId: 4, qtyMilli: 1000, valuePaise: 0, kind: 'scrap' },
          { stockItemId: 4, qtyMilli: 1000, valuePaise: 0, kind: 'scrap' }
        ]
      })
    )
    expect(issues.map((i) => [i.code, i.byProductRow])).toEqual([
      ['incomplete_byproduct', 0], ['byproduct_is_finished', 1], ['duplicate_byproduct', 3]
    ])
  })

  it('posts by-products as inward lines after the finished line; the finished line carries the net cost', () => {
    const p = buildManufactureVoucher(mfg({ godownId: 7, byProducts: [{ stockItemId: 3, qtyMilli: 500, valuePaise: 10000, kind: 'by_product' }] }), {
      voucherTypeId: 9, rawCosts: [60000], finishedName: 'Chair', labourExpenseLedgerId: 1, labourCreditLedgerId: 2
    })
    expect(p.inventory.map((l) => [l.stockItemId, l.direction, l.qtyMilli, l.amount, l.godownId])).toEqual([
      [2, 'out', 4000, 60000, 7], [1, 'in', 2000, 80000, 7], [3, 'in', 500, 10000, 7]
    ])
  })

  it('job work: raw rows default to the job worker’s godown; loss must not exceed the quantity', () => {
    const p = buildManufactureVoucher(mfg({ godownId: 7, jobWork: { godownId: 8 } }), {
      voucherTypeId: 9, rawCosts: [60000], finishedName: 'Chair', labourExpenseLedgerId: 1, labourCreditLedgerId: 2
    })
    expect(p.inventory.map((l) => l.godownId)).toEqual([8, 7])
    const bad = validateManufacture(mfg({ jobWork: { godownId: 8 }, raw: [{ stockItemId: 2, qtyMilli: 4000, lossQtyMilli: 5000 }] }))
    expect(bad.map((i) => [i.code, i.row])).toEqual([['bad_loss', 0]])
    expect(validateManufacture(mfg({ jobWork: { godownId: 0 } })).map((i) => i.code)).toContain('no_job_worker')
  })
})

// ---------- report aggregation ----------

const fact = (o: Partial<ManufactureFact>): ManufactureFact => ({
  voucherId: 1, date: '2025-06-01', number: '1', finishedItemId: 1, itemName: 'Chair', unitSymbol: 'nos', decimals: 0, qtyMilli: 1000,
  materialPaise: 0, labourPaise: 0, byProductPaise: 0, productionCost: 0, saleAmount: 0, ...o
})

describe('manufacturing report maths', () => {
  it('production register sums per item with net cost, unit cost and margin %', () => {
    const rows = productionRegister([
      fact({ qtyMilli: 2000, materialPaise: 60000, labourPaise: 30000, byProductPaise: 10000, productionCost: 80000, saleAmount: 200000 }),
      fact({ voucherId: 2, qtyMilli: 1000, materialPaise: 30000, labourPaise: 10000, productionCost: 40000, saleAmount: 100000 }),
      fact({ voucherId: 3, finishedItemId: 2, itemName: 'Bench', qtyMilli: 1000, productionCost: 5000, saleAmount: 0 })
    ])
    expect(rows.map((r) => r.itemName)).toEqual(['Bench', 'Chair'])
    expect(rows[1]).toMatchObject({ manufactures: 2, qtyMilli: 3000, grossCost: 130000, byProductPaise: 10000, productionCost: 120000, unitCostPaise: 40000, marginPaise: 180000, marginPct: 60 })
    expect(rows[0]!.marginPct).toBeNull()
  })

  it('averageCostSheet merges lines and computes per-unit figures over Σ quantity', () => {
    const sheet = (qty: number, steel: number, amount: number): CostSheet => ({
      voucherId: 1, date: null, number: null, qtyMilli: qty, productionCost: amount, unitCostPaise: 0, saleAmount: 0,
      lines: [{ kind: 'material', itemId: 2, name: 'Steel', unitSymbol: 'kg', decimals: 3, qtyMilli: steel, ratePaise: 0, amountPaise: amount, qtyPerUnitMilli: 0, amountPerUnitPaise: 0 }]
    })
    const avg = averageCostSheet([sheet(1000, 2000, 30000), sheet(3000, 6000, 120000)])
    expect(avg).toMatchObject({ qtyMilli: 4000, productionCost: 150000, unitCostPaise: 37500 })
    expect(avg.lines[0]).toMatchObject({ qtyMilli: 8000, amountPaise: 150000, ratePaise: 18750, qtyPerUnitMilli: 2000, amountPerUnitPaise: 37500 })
  })

  it('marginRows compares expected (manufacture) with realised (sales at COGS)', () => {
    const made = productionRegister([fact({ qtyMilli: 2000, productionCost: 80000, saleAmount: 200000 })])
    const [r] = marginRows(made, new Map([[1, { outQtyMilli: 1000, salesValue: 90000, cogs: 40000 }]]))
    expect(r).toMatchObject({ expectedMarginPaise: 120000, expectedMarginPct: 60, realisedMarginPaise: 50000, realisedMarginPct: 55.56, marginGapPct: -4.44 })
    const [none] = marginRows(made, new Map())
    expect(none!.realisedMarginPct).toBeNull()
    expect(none!.marginGapPct).toBeNull()
  })
})

describe('job-work ageing', () => {
  it('ageLots consumes oldest first and keeps partial remainders', () => {
    const lots = [{ date: '2025-01-01', qtyMilli: 5000 }, { date: '2025-03-01', qtyMilli: 5000 }, { date: '2025-05-01', qtyMilli: 5000 }]
    expect(ageLots(lots, 7000)).toEqual([{ date: '2025-03-01', qtyMilli: 3000 }, { date: '2025-05-01', qtyMilli: 5000 }])
    expect(ageLots(lots, 0)).toEqual(lots)
    expect(ageLots(lots, 99000)).toEqual([])
  })
  it('daysBetween counts whole days', () => {
    expect(daysBetween('2025-01-01', '2025-12-31')).toBe(364)
    expect(daysBetween('2025-03-01', '2025-02-28')).toBe(-1)
  })
})
