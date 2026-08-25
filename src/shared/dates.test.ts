import { describe, expect, it } from 'vitest'
import { financialQuarterOf, parsePeriodExpression, parseSmartDate } from './dates'

describe('financialQuarterOf', () => {
  it.each([
    ['2025-04-01', '2025-26-Q1', '2025-04-01', '2025-06-30'],
    ['2025-09-30', '2025-26-Q2', '2025-07-01', '2025-09-30'],
    ['2025-12-15', '2025-26-Q3', '2025-10-01', '2025-12-31'],
    ['2026-01-01', '2025-26-Q4', '2026-01-01', '2026-03-31'],
    ['2026-03-31', '2025-26-Q4', '2026-01-01', '2026-03-31']
  ])('maps %s to the Indian FY quarter', (date, key, from, to) => {
    expect(financialQuarterOf(date)).toMatchObject({ key, from, to })
  })
})

describe('natural date and period language', () => {
  it('understands full relative date words and strict previous weekdays', () => {
    expect(parseSmartDate('today', '2026-08-24')).toBe('2026-08-24')
    expect(parseSmartDate('yesterday', '2026-08-24')).toBe('2026-08-23')
    expect(parseSmartDate('last Friday', '2026-08-24')).toBe('2026-08-21')
    expect(parseSmartDate('last Monday', '2026-08-24')).toBe('2026-08-17')
  })

  it('resolves Indian financial quarters and financial years', () => {
    expect(parsePeriodExpression('Q2', '2026-08-24')).toMatchObject({ from: '2026-07-01', to: '2026-09-30', label: 'Q2 2026-27' })
    expect(parsePeriodExpression('last FY', '2026-08-24')).toMatchObject({ from: '2025-04-01', to: '2026-03-31', label: 'FY 2025-26' })
    expect(parsePeriodExpression('last month', '2026-01-05')).toMatchObject({ from: '2025-12-01', to: '2025-12-31' })
  })
})
