import { describe, expect, it } from 'vitest'
import { addDays, daysBetween } from './dates'
describe('addDays / daysBetween', () => {
  it('crosses a month and a year end', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
  })

  it('handles a leap day', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(daysBetween('2028-02-01', '2028-03-01')).toBe(29)
  })

  it('is a no-op at zero, and signed the way it reads', () => {
    expect(addDays('2026-06-15', 0)).toBe('2026-06-15')
    expect(daysBetween('2026-06-15', '2026-06-15')).toBe(0)
    expect(daysBetween('2026-06-15', '2026-06-10')).toBe(-5)
  })

  it('is unaffected by the DST changes local arithmetic would trip over', () => {
    // 30 days across a northern-hemisphere spring forward and an autumn fall back.
    expect(addDays('2026-03-20', 30)).toBe('2026-04-19')
    expect(addDays('2026-10-20', 30)).toBe('2026-11-19')
  })
})
