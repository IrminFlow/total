import { describe, expect, it } from 'vitest'
import { addDays, addMonths, daysBetween, toDisplayDate } from './dates'
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

describe('toDisplayDate is total', () => {
  // It used to throw on anything that was not a full ISO date, and a formatter that throws is a
  // formatter that can end a render. It did: a job-work row whose due date was null rendered
  // `toDisplayDate(x ?? '')` — meaning to be careful — and the whole screen became "Something
  // went wrong" instead of one dash in one cell.
  it('gives a dash for the shapes a null date arrives as', () => {
    for (const bad of ['', '   ', 'not a date', '2026', '2026-04', '2026-13-01', '--']) {
      expect(toDisplayDate(bad)).toBe('–')
    }
  })

  it('still formats a real date', () => {
    expect(toDisplayDate('2026-04-01')).toBe('01-Apr-26')
    expect(toDisplayDate('2026-12-31')).toBe('31-Dec-26')
  })

  it('does not throw for anything a caller might pass', () => {
    // Including the two the type system says cannot happen and that reach it anyway through an
    // `as string` cast, which is how this bug arrived.
    for (const bad of [undefined, null]) {
      expect(() => toDisplayDate(bad as unknown as string)).not.toThrow()
    }
  })
})

describe('addMonths', () => {
  it('adds whole calendar months', () => {
    expect(addMonths('2024-01-15', 1)).toBe('2024-02-15')
    expect(addMonths('2024-01-15', 12)).toBe('2025-01-15')
    expect(addMonths('2024-01-15', -1)).toBe('2023-12-15')
  })

  it('clamps to the end of a shorter month instead of overflowing into the next one', () => {
    // The bug this exists to prevent: setUTCMonth alone turns 31 January into 2 March.
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29')
    expect(addMonths('2023-01-31', 1)).toBe('2023-02-28')
    expect(addMonths('2024-03-31', 1)).toBe('2024-04-30')
  })

  it('a year from 29 February lands on 28 February', () => {
    expect(addMonths('2024-02-29', 12)).toBe('2025-02-28')
  })
})
