import { describe, expect, it } from 'vitest'
import { computeGst } from './gst/calc'
import {
  bestScheme, evaluateScheme, inclusiveLine, lineGross, pickLevelRow, resolvePrice, solveTaxable,
  type DiscountScheme, type LevelRateRow, type PriceContext
} from './pricing'
import { computeInvoice, emptyInvoiceState, type InvoiceContext } from './voucherEdit/invoice'

const RETAIL = { id: 1, name: 'Retail', inclusiveOfTax: false }
const WHOLESALE = { id: 2, name: 'Wholesale', inclusiveOfTax: false }
const SHOP = { id: 3, name: 'Shop MRP', inclusiveOfTax: true }

const row = (o: Partial<LevelRateRow> & { priceLevelId: number; ratePaise: number }): LevelRateRow => ({
  effectiveFrom: '2025-04-01', effectiveTo: null, minQtyMilli: 0, discountBp: 0, currency: 'INR', ...o
})

const scheme = (o: Partial<DiscountScheme> & { id: number; name: string }): DiscountScheme => ({
  kind: 'qty_slab', appliesTo: 'all', targetId: null, fromDate: null, toDate: null, priority: 0, active: true, slabs: [], ...o
})

function ctx(o: Partial<PriceContext> = {}): PriceContext {
  return {
    date: '2025-10-01',
    qtyMilli: 1000,
    supply: 'intra',
    item: { id: 7, groupIds: [40, 4], gstRate: 18, cessRate: 0, mrpPaise: null, lastPurchaseRatePaise: null },
    partyRates: [],
    partyLevel: null,
    defaultLevel: RETAIL,
    levelRates: [row({ priceLevelId: 1, ratePaise: 10000 })],
    schemes: [],
    ...o
  }
}

describe('resolvePrice — precedence', () => {
  it('a negotiated party-wise rate beats everything (and its discount applies)', () => {
    const r = resolvePrice(ctx({
      partyRates: [{ ratePaise: 9000, discountBp: 500, effectiveFrom: '2025-01-01', effectiveTo: null, source: 'manual', lastSoldAt: null }],
      partyLevel: WHOLESALE,
      levelRates: [row({ priceLevelId: 1, ratePaise: 10000 }), row({ priceLevelId: 2, ratePaise: 9500 })],
      schemes: [scheme({ id: 1, name: 'Everything 20%', kind: 'flat', slabs: [{ minQtyMilli: 0, minValuePaise: null, discountBp: 2000, freeQtyMilli: null }] })],
      qtyMilli: 2000
    }))
    expect(r.source).toBe('party_rate')
    expect(r.label).toBe('Party rate')
    expect(r.ratePaise).toBe(9000)
    expect(r.discountBp).toBe(500)
    expect(r.discountPaise).toBe(900) // 5% of 2 × 90
    expect(r.schemeId).toBeUndefined()
  })

  it('the latest effective negotiated rate wins; an expired one is skipped', () => {
    const r = resolvePrice(ctx({
      partyRates: [
        { ratePaise: 8000, discountBp: 0, effectiveFrom: '2025-01-01', effectiveTo: '2025-06-30', source: 'manual', lastSoldAt: null },
        { ratePaise: 8500, discountBp: 0, effectiveFrom: '2025-07-01', effectiveTo: null, source: 'manual', lastSoldAt: null },
        { ratePaise: 8800, discountBp: 0, effectiveFrom: '2025-11-01', effectiveTo: null, source: 'manual', lastSoldAt: null }
      ]
    }))
    expect(r.ratePaise).toBe(8500)
  })

  it('the remembered last price applies only without a negotiated rate', () => {
    const last = { ratePaise: 9700, discountBp: 0, effectiveFrom: null, effectiveTo: null, source: 'last_sale' as const, lastSoldAt: '2025-09-12' }
    const r = resolvePrice(ctx({ partyRates: [last] }))
    expect(r.source).toBe('last_price')
    expect(r.ratePaise).toBe(9700)
    expect(r.explanation.join(' ')).toContain('2025-09-12')
    const withManual = resolvePrice(ctx({ partyRates: [last, { ...last, ratePaise: 9100, source: 'manual' }] }))
    expect(withManual.source).toBe('party_rate')
  })

  it("an out-of-date party rate falls through to the party's level (with its qty slab)", () => {
    const c = ctx({
      partyRates: [{ ratePaise: 8000, discountBp: 0, effectiveFrom: '2025-01-01', effectiveTo: '2025-03-31', source: 'manual', lastSoldAt: null }],
      partyLevel: WHOLESALE,
      levelRates: [
        row({ priceLevelId: 1, ratePaise: 10000 }),
        row({ priceLevelId: 2, ratePaise: 9500 }),
        row({ priceLevelId: 2, ratePaise: 9000, minQtyMilli: 10000, discountBp: 200 })
      ]
    })
    const small = resolvePrice({ ...c, qtyMilli: 9999 })
    expect(small.source).toBe('party_level')
    expect(small.label).toBe('Level: Wholesale')
    expect(small.ratePaise).toBe(9500)
    expect(small.discountBp).toBe(0)
    expect(small.explanation[0]).toContain('none is in force')
    // Crossing the slab boundary re-prices the whole line.
    const big = resolvePrice({ ...c, qtyMilli: 10000 })
    expect(big.ratePaise).toBe(9000)
    expect(big.discountBp).toBe(200)
    expect(big.discountPaise).toBe(1800) // 2% of 10 × 90
  })

  it('party level beats a scheme; the scheme applies when the level has no row for the item', () => {
    const schemes = [scheme({ id: 3, name: 'Diwali 10%', kind: 'flat', slabs: [{ minQtyMilli: 0, minValuePaise: null, discountBp: 1000, freeQtyMilli: null }] })]
    const withRow = resolvePrice(ctx({ partyLevel: WHOLESALE, levelRates: [row({ priceLevelId: 1, ratePaise: 10000 }), row({ priceLevelId: 2, ratePaise: 9500 })], schemes }))
    expect(withRow.source).toBe('party_level')
    const noRow = resolvePrice(ctx({ partyLevel: WHOLESALE, schemes }))
    expect(noRow.source).toBe('scheme')
    expect(noRow.label).toBe('Scheme: Diwali 10%')
    expect(noRow.ratePaise).toBe(10000) // base from the default level
    expect(noRow.discountPaise).toBe(1000)
    expect(noRow.explanation[0]).toContain("Party's level Wholesale has no rate")
  })

  it('a scheme replaces (never stacks on) the default level slab discount', () => {
    const r = resolvePrice(ctx({
      levelRates: [row({ priceLevelId: 1, ratePaise: 10000, discountBp: 300 })],
      schemes: [scheme({ id: 1, name: 'Flat 5', kind: 'flat', slabs: [{ minQtyMilli: 0, minValuePaise: null, discountBp: 500, freeQtyMilli: null }] })]
    }))
    expect(r.discountBp).toBe(500)
    expect(r.discountPaise).toBe(500)
    expect(r.explanation.join(' ')).toContain("replaces the level's 3%")
  })

  it('default level when nothing party-specific or scheme applies', () => {
    const r = resolvePrice(ctx())
    expect(r).toMatchObject({ source: 'default_level', label: 'Level: Retail', ratePaise: 10000, discountPaise: 0, levelId: 1 })
  })

  it('MRP (tax-inclusive) when no level row, then the last purchase rate, then nothing', () => {
    const mrp = resolvePrice(ctx({ levelRates: [], item: { id: 7, groupIds: [], gstRate: 18, cessRate: 0, mrpPaise: 11800, lastPurchaseRatePaise: 7000 } }))
    expect(mrp.source).toBe('mrp')
    expect(mrp.ratePaise).toBe(10000)
    expect(mrp.inclusive).toMatchObject({ targetPaise: 11800, taxablePaise: 10000, taxPaise: 1800, residualPaise: 0 })
    const purchase = resolvePrice(ctx({ levelRates: [], item: { id: 7, groupIds: [], gstRate: 18, cessRate: 0, mrpPaise: null, lastPurchaseRatePaise: 7000 } }))
    expect(purchase).toMatchObject({ source: 'last_purchase', ratePaise: 7000, inclusive: null })
    const none = resolvePrice(ctx({ levelRates: [], defaultLevel: null }))
    expect(none).toMatchObject({ source: 'none', ratePaise: null, discountPaise: 0 })
  })

  it('a foreign invoice currency only uses price-list rows in that currency', () => {
    const c = ctx({
      currency: 'USD',
      partyRates: [{ ratePaise: 9000, discountBp: 0, effectiveFrom: null, effectiveTo: null, source: 'manual', lastSoldAt: null }],
      levelRates: [row({ priceLevelId: 1, ratePaise: 10000 }), row({ priceLevelId: 1, ratePaise: 120, currency: 'USD' })],
      item: { id: 7, groupIds: [], gstRate: 0, cessRate: 0, mrpPaise: 11800, lastPurchaseRatePaise: null }
    })
    expect(resolvePrice(c)).toMatchObject({ source: 'default_level', ratePaise: 120 })
    expect(resolvePrice({ ...c, levelRates: [row({ priceLevelId: 1, ratePaise: 10000 })] }).source).toBe('none')
  })
})

describe('price-list rows — effective dates and slabs', () => {
  const rows = [
    row({ priceLevelId: 1, ratePaise: 10000, effectiveFrom: '2025-04-01', effectiveTo: '2025-09-30' }),
    row({ priceLevelId: 1, ratePaise: 10500, effectiveFrom: '2025-10-01' }),
    row({ priceLevelId: 1, ratePaise: 9800, effectiveFrom: '2025-10-01', minQtyMilli: 5000 }),
    row({ priceLevelId: 1, ratePaise: 9900, effectiveFrom: '2025-04-01', effectiveTo: '2025-09-30', minQtyMilli: 5000 })
  ]
  it('effective_from and effective_to are inclusive', () => {
    expect(pickLevelRow(rows, 1, '2025-09-30', 1000, 'INR')?.ratePaise).toBe(10000)
    expect(pickLevelRow(rows, 1, '2025-10-01', 1000, 'INR')?.ratePaise).toBe(10500)
    expect(pickLevelRow(rows, 1, '2025-03-31', 1000, 'INR')).toBeNull()
  })
  it('the highest slab the quantity reaches, on the date', () => {
    expect(pickLevelRow(rows, 1, '2025-10-02', 4999, 'INR')?.ratePaise).toBe(10500)
    expect(pickLevelRow(rows, 1, '2025-10-02', 5000, 'INR')?.ratePaise).toBe(9800)
    expect(pickLevelRow(rows, 1, '2025-09-02', 6000, 'INR')?.ratePaise).toBe(9900)
  })
  it('qty 0 (not typed yet) still finds the base slab', () => {
    expect(pickLevelRow(rows, 1, '2025-10-02', 0, 'INR')?.ratePaise).toBe(10500)
  })
})

describe('discount schemes', () => {
  const qtySlab = scheme({
    id: 1, name: 'Bulk', kind: 'qty_slab', priority: 1,
    slabs: [
      { minQtyMilli: 10000, minValuePaise: null, discountBp: 500, freeQtyMilli: null },
      { minQtyMilli: 50000, minValuePaise: null, discountBp: 1000, freeQtyMilli: null }
    ]
  })
  it('qty slab: nothing below the first slab, then the highest reached', () => {
    expect(evaluateScheme(qtySlab, 9000, 10000)).toBeNull()
    expect(evaluateScheme(qtySlab, 10000, 10000)?.discountBp).toBe(500)
    expect(evaluateScheme(qtySlab, 49000, 10000)?.discountBp).toBe(500)
    expect(evaluateScheme(qtySlab, 50000, 10000)?.discountBp).toBe(1000)
  })
  it('value slab on the line value', () => {
    const v = scheme({ id: 2, name: 'Spend 5k', kind: 'value_slab', slabs: [{ minQtyMilli: null, minValuePaise: 500000, discountBp: 700, freeQtyMilli: null }] })
    expect(evaluateScheme(v, 49000, 10000)).toBeNull() // ₹4,900
    expect(evaluateScheme(v, 50000, 10000)).toMatchObject({ discountBp: 700, discountPaise: 35000 })
  })
  it('buy 2 get 1: of every 3 units one is free', () => {
    const b = scheme({ id: 3, name: 'B2G1', kind: 'buy_x_get_y', slabs: [{ minQtyMilli: 2000, minValuePaise: null, discountBp: null, freeQtyMilli: 1000 }] })
    expect(evaluateScheme(b, 2000, 10000)).toBeNull()
    expect(evaluateScheme(b, 3000, 10000)).toMatchObject({ freeQtyMilli: 1000, discountPaise: 10000 })
    expect(evaluateScheme(b, 7000, 10000)).toMatchObject({ freeQtyMilli: 2000, discountPaise: 20000 })
    const r = resolvePrice(ctx({ qtyMilli: 6000, schemes: [b] }))
    expect(r).toMatchObject({ source: 'scheme', ratePaise: 10000, freeQtyMilli: 2000, discountPaise: 20000 })
  })
  it('targets: item, stock group (incl. ancestors), all; dates; inactive', () => {
    const flat = (o: Partial<DiscountScheme>): DiscountScheme =>
      scheme({ id: 9, name: 'F', kind: 'flat', slabs: [{ minQtyMilli: 0, minValuePaise: null, discountBp: 100, freeQtyMilli: null }], ...o })
    const c = ctx()
    const applies = (s: DiscountScheme): boolean => resolvePrice({ ...c, schemes: [s] }).source === 'scheme'
    expect(applies(flat({ appliesTo: 'item', targetId: 7 }))).toBe(true)
    expect(applies(flat({ appliesTo: 'item', targetId: 8 }))).toBe(false)
    expect(applies(flat({ appliesTo: 'group', targetId: 4 }))).toBe(true) // ancestor group
    expect(applies(flat({ appliesTo: 'group', targetId: 5 }))).toBe(false)
    expect(applies(flat({ fromDate: '2025-10-01', toDate: '2025-10-01' }))).toBe(true)
    expect(applies(flat({ fromDate: '2025-10-02' }))).toBe(false)
    expect(applies(flat({ toDate: '2025-09-30' }))).toBe(false)
    expect(applies(flat({ active: false }))).toBe(false)
  })
  it('several matching schemes: priority wins, then the larger discount, then the lower id', () => {
    const f = (id: number, priority: number, bp: number): DiscountScheme =>
      scheme({ id, name: `S${id}`, kind: 'flat', priority, slabs: [{ minQtyMilli: 0, minValuePaise: null, discountBp: bp, freeQtyMilli: null }] })
    const base = { date: '2025-10-01', qtyMilli: 1000, item: ctx().item }
    expect(bestScheme([f(1, 1, 2000), f(2, 5, 500)], base, 10000).hit?.scheme.id).toBe(2)
    expect(bestScheme([f(1, 5, 500), f(2, 5, 900)], base, 10000).hit?.scheme.id).toBe(2)
    expect(bestScheme([f(2, 5, 500), f(1, 5, 500)], base, 10000).hit?.scheme.id).toBe(1)
    const r = resolvePrice(ctx({ schemes: [f(1, 1, 2000), f(2, 5, 500)] }))
    expect(r.schemeId).toBe(2)
    expect(r.explanation.some((e) => e.includes('Also matched S1'))).toBe(true)
  })
})

describe('tax-inclusive prices', () => {
  const ratesWithCess: [number, number][] = [[5, 0], [12, 0], [18, 0], [28, 0], [28, 12], [28, 22]]
  const prices = [100, 999, 1000, 4999, 11800, 12345, 99900, 250000]
  const qtys = [1000, 2000, 3000, 7000, 1500]

  it('solveTaxable: the largest taxable value whose inclusive total fits', () => {
    for (const [g, c] of ratesWithCess) {
      for (const supply of ['intra', 'inter'] as const) {
        for (const target of [1, 99, 100, 11800, 12345, 100001]) {
          const s = solveTaxable(target, g, c, supply)
          expect(computeGst(s.taxablePaise, g, supply, c).total).toBeLessThanOrEqual(target)
          expect(computeGst(s.taxablePaise + 1, g, supply, c).total).toBeGreaterThan(target)
          expect(s.exact).toBe(computeGst(s.taxablePaise, g, supply, c).total === target)
        }
      }
    }
  })

  it('a line priced inclusive totals the quoted price (5/12/18/28%, with cess), intra and inter', () => {
    for (const [g, c] of ratesWithCess) {
      for (const supply of ['intra', 'inter'] as const) {
        for (const p of prices) {
          for (const q of qtys) {
            const line = inclusiveLine(p, q, 0, g, c, supply)
            const gross = lineGross(q, line.ratePaise)
            expect(line.discountPaise).toBeGreaterThanOrEqual(0)
            const taxable = gross - line.discountPaise
            expect(taxable).toBe(line.breakdown.taxablePaise)
            const total = computeGst(taxable, g, supply, c).total
            expect(total + line.breakdown.residualPaise).toBe(lineGross(q, p))
            // Unreachable values are rare and tiny.
            expect(line.breakdown.residualPaise).toBeGreaterThanOrEqual(0)
            expect(line.breakdown.residualPaise).toBeLessThanOrEqual(2)
          }
        }
      }
    }
  })

  it('the invoice (computeInvoice) of a one-line inclusive sale totals the inclusive price', () => {
    const invCtx = (g: number, c: number): InvoiceContext => ({
      kind: 'sales', companyStateCode: '27', items: new Map([[7, { gstRate: g, cessRate: c }]]),
      ledgers: new Map([[1, { stateCode: '27', gstRate: null }], [2, { stateCode: null, gstRate: null }]])
    })
    for (const [g, c] of ratesWithCess) {
      for (const p of [11800, 22400, 12345]) {
        const r = resolvePrice(ctx({
          qtyMilli: 3000, partyLevel: SHOP, levelRates: [row({ priceLevelId: 3, ratePaise: p })],
          item: { id: 7, groupIds: [], gstRate: g, cessRate: c, mrpPaise: null, lastPurchaseRatePaise: null }
        }))
        const state = { ...emptyInvoiceState('2025-10-01'), partyId: 1, accountId: 2, rows: [{ itemId: 7, qtyText: '3', rate: r.ratePaise, discount: r.discountPaise || null, godownId: null, batchId: null }] }
        const comp = computeInvoice(state, invCtx(g, c))
        expect(comp.gst.total + r.inclusive!.residualPaise).toBe(3 * p)
      }
    }
  })

  it('an inclusive level with a slab discount: the discount comes off the inclusive price', () => {
    const r = resolvePrice(ctx({
      qtyMilli: 10000, partyLevel: SHOP,
      levelRates: [row({ priceLevelId: 3, ratePaise: 11800, minQtyMilli: 10000, discountBp: 1000 })]
    }))
    // 10 × ₹118 = ₹1,180 less 10% = ₹1,062 inclusive → taxable ₹900 + 18% ₹162.
    expect(r.inclusive).toMatchObject({ targetPaise: 106200, taxablePaise: 90000, taxPaise: 16200, residualPaise: 0 })
    expect(lineGross(10000, r.ratePaise!) - r.discountPaise).toBe(90000)
  })

  it('an inclusive base under a scheme', () => {
    const r = resolvePrice(ctx({
      qtyMilli: 2000, levelRates: [], item: { id: 7, groupIds: [], gstRate: 12, cessRate: 0, mrpPaise: 5600, lastPurchaseRatePaise: null },
      schemes: [scheme({ id: 1, name: 'Half', kind: 'flat', slabs: [{ minQtyMilli: 0, minValuePaise: null, discountBp: 5000, freeQtyMilli: null }] })]
    }))
    // 2 × ₹56 = ₹112 less 50% = ₹56 incl. → ₹50 + 12%.
    expect(r.source).toBe('scheme')
    expect(r.inclusive).toMatchObject({ targetPaise: 5600, taxablePaise: 5000, taxPaise: 600 })
  })

  it('qty 0: the taxable rate only, no line discount', () => {
    const r = resolvePrice(ctx({ qtyMilli: 0, partyLevel: SHOP, levelRates: [row({ priceLevelId: 3, ratePaise: 11800 })] }))
    expect(r.ratePaise).toBe(10000)
    expect(r.discountPaise).toBe(0)
  })
})
