import { describe, expect, it } from 'vitest'
import { IT_ACT_2025_FROM, mappingFor, normaliseSectionCode, SECTION_MAPPINGS, sectionForDate, spansActChange } from './itAct2025'

describe('normaliseSectionCode', () => {
  it('accepts the ways a person actually types a section', () => {
    for (const typed of ['194C', '194 c', 'sec 194C', 'Section 194-C', '194c']) {
      expect(normaliseSectionCode(typed)).toBe('194C')
    }
  })
})

describe('sectionForDate', () => {
  const master = { code: '194C', code2025: null }

  it('prints the 1961 Act number for a payment before the Act changes', () => {
    const s = sectionForDate(master, '2026-03-31')
    expect(s).toEqual({ code: '194C', act: 1961, unverified: false, warning: null })
  })

  it('does not turn an old quarter into a 2025 Act certificate because it was printed late', () => {
    // The number belongs to the payment, not to the day the paper came out of the printer.
    expect(sectionForDate(master, '2025-12-01').act).toBe(1961)
  })

  it('prefers the user’s own 2025 reference over anything this file guesses', () => {
    const s = sectionForDate({ code: '194C', code2025: '393(1) Table S.No. 6' }, '2026-04-01')
    expect(s).toEqual({ code: '393(1) Table S.No. 6', act: 2025, unverified: false, warning: null })
  })

  it('falls back to the proposed mapping, and says it is unverified', () => {
    const s = sectionForDate(master, IT_ACT_2025_FROM)
    expect(s.act).toBe(2025)
    expect(s.unverified).toBe(true)
    expect(s.warning).toContain('393')
  })

  it('prints the old number with a warning when there is no mapping at all', () => {
    // A certificate with an empty section box is useless; one that says what it is unsure of is
    // at least checkable.
    const s = sectionForDate({ code: '206AA', code2025: null }, '2026-04-01')
    expect(s.code).toBe('206AA')
    expect(s.unverified).toBe(true)
    expect(s.warning).toContain('no 2025 Act reference')
  })

  it('handles a hand-typed master code that is not exactly normalised', () => {
    expect(sectionForDate({ code: 'sec 194J', code2025: null }, '2026-04-01').code).toBe('393')
  })

  it('treats a blank override as absent', () => {
    expect(sectionForDate({ code: '194C', code2025: '   ' }, '2026-04-01').unverified).toBe(true)
  })
})

describe('SECTION_MAPPINGS', () => {
  it('never claims a mapping is confirmed, because none of them have been', () => {
    expect(SECTION_MAPPINGS.every((m) => m.confidence !== 'confirmed')).toBe(true)
  })

  it('carries the note that explains itself on every proposed mapping', () => {
    expect(mappingFor('194J')!.note).toContain('has not been verified')
  })
})

describe('spansActChange', () => {
  it('flags a financial year that straddles 1 April 2026', () => {
    expect(spansActChange('2025-04-01', '2026-03-31')).toBe(false)
    expect(spansActChange('2026-01-01', '2026-12-31')).toBe(true)
    expect(spansActChange('2026-04-01', '2027-03-31')).toBe(false)
  })
})
