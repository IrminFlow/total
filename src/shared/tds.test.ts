import { describe, it, expect } from 'vitest'
import { computeTds, thresholdCrossed, tdsQuarterOf } from './tds'

describe('computeTds', () => {
  it('deducts the plain section rate when a PAN is on file', () => {
    expect(computeTds(2, 10000000, true)).toBe(200000) // 2% of ₹1,00,000
  })

  it('falls back to 20% when the deductee has no PAN', () => {
    expect(computeTds(2, 10000000, false)).toBe(2000000) // 20% of ₹1,00,000
  })

  it('keeps the section rate when it is already higher than 20% with no PAN', () => {
    expect(computeTds(25, 10000000, false)).toBe(2500000) // 25%, not clamped down to 20%
  })

  it('rounds the deduction to the nearest whole rupee', () => {
    // 10% of ₹3,333.50 = ₹333.35 -> rounds to ₹333.00 (33300 paise)
    expect(computeTds(10, 333350, true)).toBe(33300)
  })
})

describe('thresholdCrossed', () => {
  it('is always applicable when both thresholds are unset (0)', () => {
    expect(thresholdCrossed({ thresholdSingle: 0, thresholdAnnual: 0 }, 100, 0)).toBe(true)
  })

  it('crosses on a single transaction at or above the single threshold', () => {
    const t = { thresholdSingle: 3000000, thresholdAnnual: 10000000 }
    expect(thresholdCrossed(t, 3000000, 0)).toBe(true)
    expect(thresholdCrossed(t, 2999999, 0)).toBe(false)
  })

  it('crosses when the FY-to-date base plus this transaction reaches the annual threshold', () => {
    const t = { thresholdSingle: 3000000, thresholdAnnual: 10000000 }
    expect(thresholdCrossed(t, 1000000, 9000000)).toBe(true) // exactly at the annual line
    expect(thresholdCrossed(t, 1000000, 8999999)).toBe(false)
  })

  it('honors only the annual threshold when the single threshold is 0 (e.g. rent, 194I)', () => {
    const t = { thresholdSingle: 0, thresholdAnnual: 24000000 }
    expect(thresholdCrossed(t, 24000000, 0)).toBe(true)
    expect(thresholdCrossed(t, 100, 0)).toBe(false)
  })
})

describe('tdsQuarterOf', () => {
  it('places FY-start months into Q1', () => {
    expect(tdsQuarterOf('2025-04-01')).toMatchObject({ q: 1, fyStartYear: 2025, from: '2025-04-01', to: '2025-06-30' })
    expect(tdsQuarterOf('2025-06-30')).toMatchObject({ q: 1, fyStartYear: 2025 })
  })

  it('places Jul-Sep into Q2 and Oct-Dec into Q3', () => {
    expect(tdsQuarterOf('2025-09-15')).toMatchObject({ q: 2, from: '2025-07-01', to: '2025-09-30' })
    expect(tdsQuarterOf('2025-10-01')).toMatchObject({ q: 3, from: '2025-10-01', to: '2025-12-31' })
  })

  it('wraps Jan-Mar into Q4 of the PREVIOUS calendar year\'s FY', () => {
    const q = tdsQuarterOf('2026-01-15')
    expect(q).toMatchObject({ q: 4, fyStartYear: 2025, from: '2026-01-01', to: '2026-03-31' })
    expect(q.label).toBe('Q4 FY2025-26')
  })

  it('labels quarters with the FY string', () => {
    expect(tdsQuarterOf('2025-05-01').label).toBe('Q1 FY2025-26')
  })
})
