import { describe, expect, it } from 'vitest'
import { addMonths, fyQuarterOf, periodKey, periodKeysBetween, periodLabel, previousPeriod, previousYear, relativePeriod } from './reportPeriod'
import { questionPeriod } from './questionPeriod'
import { variance } from './ratios'

describe('period arithmetic', () => {
  it('relative periods', () => {
    expect(relativePeriod('lastMonth', '2026-01-15')).toEqual({ from: '2025-12-01', to: '2025-12-31' })
    expect(relativePeriod('thisQuarter', '2026-02-10')).toEqual({ from: '2026-01-01', to: '2026-03-31' })
    expect(relativePeriod('lastQuarter', '2026-05-10')).toEqual({ from: '2026-01-01', to: '2026-03-31' })
    expect(relativePeriod('lastQuarter', '2026-08-10')).toEqual({ from: '2026-04-01', to: '2026-06-30' })
    expect(relativePeriod('fyToDate', '2026-02-10')).toEqual({ from: '2025-04-01', to: '2026-02-10' })
    expect(relativePeriod('lastFy', '2026-02-10')).toEqual({ from: '2024-04-01', to: '2025-03-31' })
  })

  it('previous period and previous year', () => {
    expect(previousPeriod('2025-04-01', '2025-06-30')).toEqual({ from: '2025-01-01', to: '2025-03-31' })
    expect(previousPeriod('2025-03-01', '2025-03-31')).toEqual({ from: '2025-02-01', to: '2025-02-28' })
    expect(previousPeriod('2025-04-10', '2025-04-19')).toEqual({ from: '2025-03-31', to: '2025-04-09' })
    expect(previousYear('2024-03-01', '2024-03-31')).toEqual({ from: '2023-03-01', to: '2023-03-31' })
    expect(previousYear('2024-02-01', '2024-02-29')).toEqual({ from: '2023-02-01', to: '2023-02-28' })
    expect(previousYear('2025-02-01', '2025-02-28')).toEqual({ from: '2024-02-01', to: '2024-02-29' })
    expect(addMonths('2025-01-31', 1)).toBe('2025-02-28')
  })

  it('bucket keys (FY quarters, FY start year)', () => {
    expect(periodKey('2025-04-01', 'quarter')).toBe('2025-Q1')
    expect(periodKey('2026-03-31', 'quarter')).toBe('2025-Q4')
    expect(periodKey('2026-01-05', 'fy')).toBe('2025')
    expect(periodLabel('2025-Q4', 'quarter')).toBe('Q4 2025-26')
    expect(periodLabel('2025', 'fy')).toBe('FY 2025-26')
    expect(periodLabel('2025-05', 'month')).toBe('May 2025')
    expect(fyQuarterOf('2025-12-01')).toMatchObject({ q: 3, from: '2025-10-01', to: '2025-12-31' })
    expect(periodKeysBetween('2025-02-15', '2025-05-02', 'month')).toEqual(['2025-02', '2025-03', '2025-04', '2025-05'])
    expect(periodKeysBetween('2025-02-15', '2025-07-02', 'quarter')).toEqual(['2024-Q4', '2025-Q1', '2025-Q2'])
    expect(periodKeysBetween('2024-04-01', '2026-03-31', 'fy')).toEqual(['2024', '2025'])
  })

  it('variance: absolute and percent of the comparative magnitude', () => {
    expect(variance(1500, 1000)).toEqual({ abs: 500, pct: 50 })
    expect(variance(-500, -1000)).toEqual({ abs: 500, pct: 50 })
    expect(variance(100, 0)).toEqual({ abs: 100, pct: null })
    expect(variance(100, null)).toEqual({ abs: null, pct: null })
    expect(variance(1, 3).pct).toBe(-66.7)
  })
})

describe('questionPeriod (the period a plain question names)', () => {
  const W = { from: '2025-04-01', to: '2026-03-31' }
  it('relative phrases', () => {
    expect(questionPeriod('sales this month', W)).toEqual({ kind: 'relative', rule: 'thisMonth' })
    expect(questionPeriod('expenses last quarter', W)).toEqual({ kind: 'relative', rule: 'lastQuarter' })
    expect(questionPeriod('profit this financial year', W)).toEqual({ kind: 'relative', rule: 'fyToDate' })
    expect(questionPeriod('profit last financial year', W)).toEqual({ kind: 'relative', rule: 'lastFy' })
    expect(questionPeriod('profit ytd', W)).toEqual({ kind: 'relative', rule: 'fyToDate' })
  })
  it('"in <month>" is that month of the working FY (Jan–Mar = the later year)', () => {
    expect(questionPeriod('sales in July', W)).toEqual({ kind: 'range', from: '2025-07-01', to: '2025-07-31' })
    expect(questionPeriod('sales for feb', W)).toEqual({ kind: 'range', from: '2026-02-01', to: '2026-02-28' })
    expect(questionPeriod('sales in July')).toBeNull()
  })
  it('nothing said = null', () => {
    expect(questionPeriod('profit', W)).toBeNull()
  })
})
