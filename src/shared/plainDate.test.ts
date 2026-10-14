// WP 10.4: the plain date / month formatters take the reader's language.
import { describe, expect, it } from 'vitest'
import { plainMonthNames, toMonthLabel, toPlainDate } from './dates'

describe('toPlainDate', () => {
  it('English and Hinglish keep the Latin short months', () => {
    expect(toPlainDate('2026-04-01')).toBe('1 Apr 2026')
    expect(toPlainDate('2026-04-01', 'en')).toBe('1 Apr 2026')
    expect(toPlainDate('2026-02-14', 'hinglish')).toBe('14 Feb 2026')
  })

  it('Hindi uses Devanagari month names', () => {
    expect(toPlainDate('2026-01-05', 'hi')).toBe('5 जन 2026')
    expect(toPlainDate('2026-02-14', 'hi')).toBe('14 फ़र 2026')
    expect(toPlainDate('2025-10-31', 'hi')).toBe('31 अक्तू 2025')
    expect(toPlainDate('2025-12-01', 'hi')).toBe('1 दिस 2025')
  })

  it('an unknown language reads as English', () => {
    expect(toPlainDate('2026-04-01', 'fr')).toBe('1 Apr 2026')
  })
})

describe('toMonthLabel / month names', () => {
  it('short and long labels follow the language', () => {
    expect(toMonthLabel('2026-03')).toBe('Mar')
    expect(toMonthLabel('2026-03', 'long')).toBe('Mar 2026')
    expect(toMonthLabel('2026-03', 'long', 'hi')).toBe('मार्च 2026')
    expect(toMonthLabel('2026-08', 'short', 'hi')).toBe('अग')
    expect(toMonthLabel('2026-08', 'long', 'hinglish')).toBe('Aug 2026')
  })

  it('twelve distinct months per language', () => {
    for (const lang of ['en', 'hi', 'hinglish']) expect(new Set(plainMonthNames(lang)).size).toBe(12)
  })
})
