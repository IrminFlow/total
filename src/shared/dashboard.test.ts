import { describe, expect, it } from 'vitest'
import { addMonths, dashboardWindow, monthEnd, monthRange, monthSpan, weekStart } from './dashboard'

describe('dashboard month math', () => {
  it('addMonths / monthRange cross year boundaries', () => {
    expect(addMonths('2026-01', -1)).toBe('2025-12')
    expect(addMonths('2025-12', 1)).toBe('2026-01')
    expect(monthRange('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02'])
    expect(monthRange('2026-03', '2026-02')).toEqual([])
  })

  it('monthEnd handles leap years', () => {
    expect(monthEnd('2028-02')).toBe('2028-02-29')
    expect(monthEnd('2027-02')).toBe('2027-02-28')
    expect(monthEnd('2026-04')).toBe('2026-04-30')
  })

  it('weekStart is the Monday on or before the date', () => {
    expect(weekStart('2026-10-07')).toBe('2026-10-05') // Wednesday
    expect(weekStart('2026-10-05')).toBe('2026-10-05') // Monday
    expect(weekStart('2026-10-11')).toBe('2026-10-05') // Sunday
  })
})

describe('dashboardWindow', () => {
  it('today inside the FY: this month is today’s, balances as on today', () => {
    const w = dashboardWindow('2026-10-07', '2026-04-01', '2027-03-31')
    expect(w.asOn).toBe('2026-10-07')
    expect(w.focusMonth).toBe('2026-10')
    expect(w.periodMonths).toHaveLength(12)
    expect(w.sparkMonths).toEqual(['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'])
  })

  it('a past period: its last month, closing position at period end', () => {
    const w = dashboardWindow('2026-10-07', '2025-04-01', '2026-03-31')
    expect(w.asOn).toBe('2026-03-31')
    expect(w.focusMonth).toBe('2026-03')
  })

  it('a sub-range not containing today uses the sub-range’s last month', () => {
    const w = dashboardWindow('2026-10-07', '2026-04-01', '2026-06-30')
    expect(w.focusMonth).toBe('2026-06')
    expect(w.periodMonths).toEqual(['2026-04', '2026-05', '2026-06'])
  })

  it('early in the FY the spark months reach into the previous year', () => {
    const w = dashboardWindow('2026-05-10', '2026-04-01', '2027-03-31')
    expect(w.sparkMonths[0]).toBe('2025-12')
  })
})

describe('monthSpan', () => {
  const w = { from: '2026-04-15', asOn: '2026-10-07' }
  it('clips the first period month to the period start and the current month to asOn', () => {
    expect(monthSpan('2026-04', w)).toEqual({ from: '2026-04-15', to: '2026-04-30' })
    expect(monthSpan('2026-10', w)).toEqual({ from: '2026-10-01', to: '2026-10-07' })
    expect(monthSpan('2026-03', w)).toEqual({ from: '2026-03-01', to: '2026-03-31' })
  })
  it('a month wholly after asOn has no span', () => {
    expect(monthSpan('2026-11', w)).toBeNull()
  })
})
