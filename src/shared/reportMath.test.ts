import { describe, it, expect } from 'vitest'
import { activityFor, ageStock, buildCashFlow, computeRatios } from './reportMath'

describe('buildCashFlow (indirect)', () => {
  const period = { from: '2025-04-01', to: '2026-03-31' }

  it('classifies group deltas by activity and reconciles to the cash movement', () => {
    // Books: profit 1000, debtors up 300 (uses cash), creditors up 200 (frees cash),
    // stock up 400, machine bought 500, loan taken 250, capital introduced 150.
    const cf = buildCashFlow({
      period,
      netProfit: 100000,
      stockDelta: 40000,
      groupDeltas: [
        { name: 'Current Assets', delta: 30000 }, // debtors up
        { name: 'Current Liabilities', delta: -20000 }, // creditors up (cr = negative dr+)
        { name: 'Fixed Assets', delta: 50000 },
        { name: 'Loans (Liability)', delta: -25000 },
        { name: 'Capital Account', delta: -15000 }
      ],
      openingCash: 10000,
      closingCash: 50000
    })

    expect(cf.operating.map((r) => r.name)).toEqual(['Current Assets', 'Current Liabilities', 'Increase in stock'])
    expect(cf.operatingTotal).toBe(100000 - 40000 - 30000 + 20000)
    expect(cf.investing).toEqual([{ name: 'Fixed Assets', amount: -50000 }])
    expect(cf.financingTotal).toBe(25000 + 15000)
    expect(cf.netChange).toBe(cf.operatingTotal + cf.investingTotal + cf.financingTotal)
    expect(cf.netChange).toBe(cf.closingCash - cf.openingCash)
  })

  it('omits zero rows and negative stock delta reads as a decrease (cash freed)', () => {
    const cf = buildCashFlow({
      period,
      netProfit: 0,
      stockDelta: -5000,
      groupDeltas: [{ name: 'Current Assets', delta: 0 }],
      openingCash: 0,
      closingCash: 5000
    })
    expect(cf.operating).toEqual([{ name: 'Decrease in stock', amount: 5000 }])
    expect(cf.investing).toEqual([])
    expect(cf.netChange).toBe(5000)
  })

  it('maps every top-level Tally group to a sane activity', () => {
    expect(activityFor('Fixed Assets')).toBe('investing')
    expect(activityFor('Investments')).toBe('investing')
    expect(activityFor('Capital Account')).toBe('financing')
    expect(activityFor('Loans (Liability)')).toBe('financing')
    expect(activityFor('Current Assets')).toBe('operating')
    expect(activityFor('Current Liabilities')).toBe('operating')
    expect(activityFor('Some Custom Group')).toBe('operating')
  })
})

describe('computeRatios', () => {
  it('computes the standard panel', () => {
    const r = computeRatios({
      currentAssets: 200000,
      currentLiabilities: 100000,
      stock: 50000,
      receivables: 60000,
      payables: 40000,
      sales: 365000,
      purchases: 182500,
      openingStock: 40000,
      closingStock: 50000,
      grossProfit: 91250,
      netProfit: 36500,
      periodDays: 365
    })
    expect(r.currentRatio).toBe(2)
    expect(r.quickRatio).toBe(1.5)
    expect(r.debtorDays).toBe(60)
    expect(r.creditorDays).toBe(80)
    // cogs = 40000 + 182500 - 50000 = 172500; avg stock = 45000
    expect(r.inventoryTurnover).toBe(3.83)
    expect(r.grossMarginPct).toBe(25)
    expect(r.netMarginPct).toBe(10)
  })

  it('returns null on zero denominators instead of Infinity', () => {
    const r = computeRatios({
      currentAssets: 0, currentLiabilities: 0, stock: 0, receivables: 0, payables: 0,
      sales: 0, purchases: 0, openingStock: 0, closingStock: 0, grossProfit: 0, netProfit: 0, periodDays: 30
    })
    expect(r).toEqual({
      currentRatio: null, quickRatio: null, debtEquity: null, debtorDays: null, creditorDays: null,
      inventoryTurnover: null, grossMarginPct: null, netMarginPct: null
    })
  })

  it('gears borrowings against owners funds', () => {
    const r = computeRatios({
      currentAssets: 0, currentLiabilities: 0, stock: 0, receivables: 0, payables: 0,
      borrowings: 300000, equity: 200000,
      sales: 0, purchases: 0, openingStock: 0, closingStock: 0, grossProfit: 0, netProfit: 0, periodDays: 30
    })
    expect(r.debtEquity).toBe(1.5)
  })

  it('will not report gearing for a company with no equity to gear against', () => {
    // Not Infinity, and not zero: a nil capital account makes the ratio unmeasurable, and a
    // confident number here is the kind that ends up quoted to a bank.
    const r = computeRatios({
      currentAssets: 0, currentLiabilities: 0, stock: 0, receivables: 0, payables: 0,
      borrowings: 300000, equity: 0,
      sales: 0, purchases: 0, openingStock: 0, closingStock: 0, grossProfit: 0, netProfit: 0, periodDays: 30
    })
    expect(r.debtEquity).toBeNull()
  })

  it('reports negative gearing rather than hiding accumulated losses', () => {
    const r = computeRatios({
      currentAssets: 0, currentLiabilities: 0, stock: 0, receivables: 0, payables: 0,
      borrowings: 100000, equity: -50000,
      sales: 0, purchases: 0, openingStock: 0, closingStock: 0, grossProfit: 0, netProfit: 0, periodDays: 30
    })
    expect(r.debtEquity).toBe(-2)
  })
})

describe('ageStock', () => {
  it('attributes closing qty to the newest inwards first', () => {
    const buckets = ageStock(
      5000,
      [
        { date: '2025-06-25', qtyMilli: 2000 }, // 5 days old
        { date: '2025-05-15', qtyMilli: 2000 }, // 46 days old
        { date: '2025-03-01', qtyMilli: 4000 } // 121 days old
      ],
      '2025-06-30'
    )
    expect(buckets).toEqual([2000, 2000, 0, 1000])
  })

  it('puts qty beyond all dated inwards (opening stock) in the 90+ bucket', () => {
    expect(ageStock(3000, [{ date: '2025-06-20', qtyMilli: 1000 }], '2025-06-30')).toEqual([1000, 0, 0, 2000])
  })

  it('returns zeros for zero/negative closing qty', () => {
    expect(ageStock(0, [{ date: '2025-06-20', qtyMilli: 1000 }], '2025-06-30')).toEqual([0, 0, 0, 0])
    expect(ageStock(-500, [], '2025-06-30')).toEqual([0, 0, 0, 0])
  })

  it('bucket edges: 30/60/90 days inclusive', () => {
    expect(ageStock(1000, [{ date: '2025-05-31', qtyMilli: 1000 }], '2025-06-30')).toEqual([1000, 0, 0, 0])
    expect(ageStock(1000, [{ date: '2025-05-30', qtyMilli: 1000 }], '2025-06-30')).toEqual([0, 1000, 0, 0])
  })
})
