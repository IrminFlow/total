import { describe, expect, it } from 'vitest'
import {
  billHistory, buildForecast, collectionProfile, DEFAULT_BUCKET_BP, forecastPeriods, itemFlows, itemOccurrences, payableFlows,
  receivableFlows, scenarioProbability, SCENARIO_PRESETS, type ForecastFlow, type HistoryBill
} from './cashForecast'

const ASON = '2026-10-07'
const flow = (p: Partial<ForecastFlow> & Pick<ForecastFlow, 'date' | 'amount'>): ForecastFlow => ({
  source: 'item', direction: 'in', probabilityBp: 10_000, label: 'x', ...p
})

describe('periods', () => {
  it('13 weeks from today, 7 days each', () => {
    const p = forecastPeriods(ASON, 'week', 13)
    expect(p).toHaveLength(13)
    expect(p[0]).toMatchObject({ key: 'w1', from: '2026-10-07', to: '2026-10-13', label: 'Wk 1 · 7 Oct' })
    expect(p[12]!.to).toBe('2027-01-05')
  })
  it('months: the first runs to its month end', () => {
    const p = forecastPeriods(ASON, 'month', 3)
    expect(p.map((x) => [x.from, x.to])).toEqual([['2026-10-07', '2026-10-31'], ['2026-11-01', '2026-11-30'], ['2026-12-01', '2026-12-31']])
  })
})

describe('probability weighting', () => {
  it('weights each flow by its probability (round half up) and rolls the balance forward', () => {
    const r = buildForecast({
      asOn: ASON, unit: 'week', count: 2, openingCash: 1_000_00, scenario: SCENARIO_PRESETS.expected,
      flows: [
        flow({ source: 'receivable', date: '2026-10-08', amount: 1_000_00, probabilityBp: 8_000 }), // 800.00
        flow({ source: 'payable', direction: 'out', date: '2026-10-15', amount: 2_500_00 }),
        flow({ source: 'sales_order', date: '2026-10-16', amount: 1_000_00 }) // 60 % expected → 600.00
      ]
    })
    expect(r.periods[0]).toMatchObject({ opening: 1_000_00, inflow: 800_00, outflow: 0, closing: 1_800_00, shortfall: false })
    expect(r.periods[1]).toMatchObject({ opening: 1_800_00, inflow: 600_00, outflow: 2_500_00, closing: -100_00, shortfall: true })
    expect(r.firstShortfall).toBe('w2')
    expect(r.lowest).toEqual({ closing: -100_00, periodKey: 'w2' })
    expect(r.periods[1]!.bySource.sales_order).toBe(600_00)
  })
  it('overdue flows land in the first period; flows past the horizon are "beyond"', () => {
    const r = buildForecast({
      asOn: ASON, unit: 'week', count: 1, openingCash: 0, scenario: SCENARIO_PRESETS.expected,
      flows: [flow({ date: '2026-09-01', amount: 100_00 }), flow({ date: '2027-01-01', amount: 50_00, direction: 'out' })]
    })
    expect(r.periods[0]!.inflow).toBe(100_00)
    expect(r.contributions.find((c) => c.amount === 100_00)!.effectiveDate).toBe(ASON)
    expect(r.beyond).toEqual({ inflow: 0, outflow: 50_00 })
  })
  it('scenarios scale collections (capped at 100 %), set order conversion and delay receipts', () => {
    const rec = { source: 'receivable' as const, probabilityBp: 9_500 }
    expect(scenarioProbability(rec, SCENARIO_PRESETS.best)).toBe(10_000)
    expect(scenarioProbability(rec, SCENARIO_PRESETS.worst)).toBe(6_650)
    expect(scenarioProbability({ source: 'purchase_order', probabilityBp: 10_000 }, SCENARIO_PRESETS.worst)).toBe(3_000)
    expect(scenarioProbability({ source: 'emi', probabilityBp: 10_000 }, SCENARIO_PRESETS.worst)).toBe(10_000)
    const r = buildForecast({
      asOn: ASON, unit: 'week', count: 3, openingCash: 0, scenario: SCENARIO_PRESETS.worst,
      flows: [flow({ source: 'receivable', date: '2026-10-08', amount: 100_00, probabilityBp: 10_000 })]
    })
    expect(r.contributions[0]!.effectiveDate).toBe('2026-10-23') // +15 days
    expect(r.periods[2]!.inflow).toBe(70_00)
  })
  it('excluded sources and the minimum balance', () => {
    const r = buildForecast({
      asOn: ASON, unit: 'week', count: 1, openingCash: 500_00, minBalance: 1_000_00, scenario: SCENARIO_PRESETS.expected,
      exclude: ['emi'], flows: [flow({ source: 'emi', direction: 'out', date: ASON, amount: 400_00 })]
    })
    expect(r.periods[0]!.outflow).toBe(0)
    expect(r.periods[0]!.shortfall).toBe(true)
  })
})

describe('collection history', () => {
  it('records when each bill was settled (FIFO and named refs)', () => {
    const h = billHistory([
      { voucherId: 1, date: '2026-01-01', number: 'S1', amount: 100_00, refs: [] },
      { voucherId: 2, date: '2026-01-05', number: 'S2', amount: 50_00, refs: [] },
      { voucherId: 3, date: '2026-02-10', number: 'R1', amount: -120_00, refs: [] },
      { voucherId: 4, date: '2026-03-01', number: 'R2', amount: -30_00, refs: [] }
    ], 30)
    expect(h).toEqual([
      { dueBasis: '2026-01-31', settledOn: '2026-02-10', amount: 100_00 },
      { dueBasis: '2026-02-04', settledOn: '2026-03-01', amount: 50_00 }
    ])
  })
  it('named refs settle that bill', () => {
    const h = billHistory([
      { voucherId: 1, date: '2026-01-01', number: 'S1', amount: 100_00, refs: [{ kind: 'new', name: 'A', amount: 100_00, dueDate: '2026-01-15' }] },
      { voucherId: 2, date: '2026-01-02', number: 'S2', amount: 100_00, refs: [{ kind: 'new', name: 'B', amount: 100_00, dueDate: null }] },
      { voucherId: 3, date: '2026-01-20', number: 'R', amount: -100_00, refs: [{ kind: 'against', name: 'B', amount: 100_00, dueDate: null }] }
    ], null)
    expect(h[0]!.settledOn).toBeNull()
    expect(h[1]).toEqual({ dueBasis: '2026-01-02', settledOn: '2026-01-20', amount: 100_00 })
  })
  it('learns paid-within shares and bucket probabilities from observed bills', () => {
    const bills: HistoryBill[] = [
      // five bills paid on time, two 45 days late, one 120 days late, two never (all due ≥ 200 days ago)
      ...Array.from({ length: 5 }, () => ({ dueBasis: '2026-01-01', settledOn: '2026-01-01', amount: 100_00 })),
      ...Array.from({ length: 2 }, () => ({ dueBasis: '2026-01-01', settledOn: '2026-02-15', amount: 100_00 })),
      { dueBasis: '2026-01-01', settledOn: '2026-05-01', amount: 100_00 },
      ...Array.from({ length: 2 }, () => ({ dueBasis: '2026-01-01', settledOn: null, amount: 100_00 }))
    ]
    const p = collectionProfile(bills, ASON)
    expect(p.sampleSize).toBe(10)
    expect(p.fromHistory).toBe(true)
    expect(p.paidWithinBp).toEqual([5_000, 5_000, 7_000, 7_000])
    // bucket 0: all 10 reached; paid within 90 days: 7 → 70 %
    expect(p.bucketProbabilityBp[0]).toBe(7_000)
    // bucket 1 (31+ days): 5 bills were still unpaid at 31 days; 3 paid within 121 days → 60 %
    expect(p.bucketProbabilityBp[1]).toBe(6_000)
    // buckets 2–3: fewer than 5 bills reached them → the default assumption
    expect(p.bucketProbabilityBp.slice(2)).toEqual(DEFAULT_BUCKET_BP.slice(2))
    expect(p.medianDelayDays).toBe(0)
  })
  it('falls back to the default assumption with thin history', () => {
    const p = collectionProfile([], ASON)
    expect(p.fromHistory).toBe(false)
    expect(p.bucketProbabilityBp).toEqual(DEFAULT_BUCKET_BP)
  })
})

describe('flow builders', () => {
  const profile = { sampleSize: 0, paidWithinBp: [0, 0, 0, 0] as [number, number, number, number], bucketProbabilityBp: DEFAULT_BUCKET_BP, medianDelayDays: 5, fromHistory: false }
  it('receivables: due date + median delay, probability by bucket', () => {
    const [a, b] = receivableFlows([
      { ledgerId: 1, partyName: 'A', voucherId: 1, number: 'S1', date: '2026-10-01', dueDate: '2026-10-31', pending: 100_00, overdueDays: 0 },
      { ledgerId: 2, partyName: 'B', voucherId: 2, number: 'S2', date: '2026-06-01', dueDate: '2026-07-01', pending: 50_00, overdueDays: 98 }
    ], profile)
    expect(a).toMatchObject({ date: '2026-11-05', probabilityBp: 9_500, bucket: 0, direction: 'in' })
    expect(b).toMatchObject({ probabilityBp: 3_000, bucket: 3 })
  })
  it('payables: on the due date at 100 %', () => {
    expect(payableFlows([{ ledgerId: 1, partyName: 'S', voucherId: 1, number: 'P1', date: '2026-10-01', dueDate: null, pending: 10_00, overdueDays: 6 }])[0])
      .toMatchObject({ direction: 'out', date: '2026-10-01', probabilityBp: 10_000 })
  })
  it('item cadences expand inside the window and stop at the end date', () => {
    expect(itemOccurrences({ cadence: 'monthly', startDate: '2026-01-31', endDate: null }, '2026-10-07', '2026-12-31')).toEqual(['2026-10-31', '2026-11-30', '2026-12-31'])
    expect(itemOccurrences({ cadence: 'weekly', startDate: '2026-10-01', endDate: '2026-10-20' }, '2026-10-07', '2026-12-31')).toEqual(['2026-10-08', '2026-10-15'])
    expect(itemOccurrences({ cadence: 'quarterly', startDate: '2026-04-15', endDate: null }, '2026-10-07', '2027-04-30')).toEqual(['2026-10-15', '2027-01-15', '2027-04-15'])
    expect(itemOccurrences({ cadence: 'once', startDate: '2026-09-01', endDate: null }, '2026-10-07', '2026-12-31')).toEqual([])
  })
  it('adjustments carry their sign as the direction', () => {
    const f = itemFlows([
      { id: 1, name: 'Loan top-up', amount: -5_000_00, cadence: 'once', startDate: '2026-10-10', endDate: null, kind: 'adjustment', active: true },
      { id: 2, name: 'Rent', amount: 20_000_00, cadence: 'monthly', startDate: '2026-10-05', endDate: null, kind: 'outflow', active: true },
      { id: 3, name: 'Off', amount: 1, cadence: 'monthly', startDate: '2026-10-05', endDate: null, kind: 'inflow', active: false }
    ], ASON, '2026-11-30')
    expect(f.map((x) => [x.source, x.direction, x.date, x.amount])).toEqual([
      ['adjustment', 'out', '2026-10-10', 5_000_00],
      ['item', 'out', '2026-11-05', 20_000_00]
    ])
  })
})
