import { describe, expect, it } from 'vitest'
import { IT_ACT_2025_FROM, mappingFor, normaliseSectionCode, SECTION_MAPPINGS, sectionForDate, spansActChange, tableRef } from './itAct2025'

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
    expect(s).toEqual({ code: '194C', act: 1961, unverified: false, confidence: null, warning: null })
  })

  it('does not turn an old quarter into a 2025 Act certificate because it was printed late', () => {
    // The number belongs to the payment, not to the day the paper came out of the printer.
    expect(sectionForDate(master, '2025-12-01').act).toBe(1961)
  })

  it('prefers the user’s own 2025 reference over anything this file guesses', () => {
    const s = sectionForDate({ code: '194C', code2025: '393(1) Table S.No. 6' }, '2026-04-01')
    expect(s).toEqual({ code: '393(1) Table S.No. 6', act: 2025, unverified: false, confidence: null, warning: null })
  })

  it('falls back to the proposed mapping, which now names the Table serial', () => {
    // Income-tax Act 2025 (Act 30 of 2025), s.393(1) Table FOR PAYMENTS TO RESIDENT, Sl. No. 6(i):
    // "Any sum for carrying out any work (including supply of labour ...) in pursuance of a
    // contract between the contractor and a designated person." That is 194C.
    const s = sectionForDate(master, IT_ACT_2025_FROM)
    expect(s.act).toBe(2025)
    expect(s.code).toBe('393(1) [Table: Sl. No. 6(i)]')
    expect(s.confidence).toBe('confirmed')
    // Still flagged: what is open is the FORM, not the serial. See the module header.
    expect(s.unverified).toBe(true)
    expect(s.warning).toContain('has not been checked against the forms')
  })

  it('puts salary and provident fund under section 392, not under 393', () => {
    // s.392(1) is "any income chargeable under the head 'Salaries'"; s.392(7) is the EPF trustees
    // deducting 10% on an accumulated balance of Rs 50,000 or more. Neither is in the 393 Table.
    expect(sectionForDate({ code: '192', code2025: null }, '2026-04-01').code).toBe('392(1)')
    expect(sectionForDate({ code: '192A', code2025: null }, '2026-04-01').code).toBe('392(7)')
  })

  it('maps 206AA to section 397(2), which used to have no mapping at all', () => {
    const s = sectionForDate({ code: '206AA', code2025: null }, '2026-04-01')
    expect(s.code).toBe('397(2)')
    expect(s.act).toBe(2025)
  })

  it('prints the old number with a warning when there is no mapping at all', () => {
    // A certificate with an empty section box is useless; one that says what it is unsure of is
    // at least checkable.
    const s = sectionForDate({ code: '194LBA', code2025: null }, '2026-04-01')
    expect(s.code).toBe('194LBA')
    expect(s.unverified).toBe(true)
    expect(s.confidence).toBe('unknown')
    expect(s.warning).toContain('no 2025 Act reference')
  })

  it('handles a hand-typed master code that is not exactly normalised', () => {
    expect(sectionForDate({ code: 'sec 194J', code2025: null }, '2026-04-01').code).toBe('393(1) [Table: Sl. No. 6(iii)]')
  })

  it('treats a blank override as absent', () => {
    expect(sectionForDate({ code: '194C', code2025: '   ' }, '2026-04-01').unverified).toBe(true)
  })
})

describe('SECTION_MAPPINGS', () => {
  it('has every entry read in the bare Act, and every entry citing its source', () => {
    expect(SECTION_MAPPINGS.every((m) => m.confidence === 'confirmed')).toBe(true)
    expect(SECTION_MAPPINGS.every((m) => m.act2025 !== null)).toBe(true)
  })

  it('carries the note about the form on every mapping', () => {
    expect(mappingFor('194J')!.note).toContain('Act 30 of 2025')
    expect(mappingFor('194J')!.note).toContain('has not been checked against the forms')
  })

  it('never proposes a bare "393" — a serial-less citation names the whole provision', () => {
    for (const m of SECTION_MAPPINGS) {
      expect(m.act2025).not.toBe('393')
    }
  })

  it('writes Table references in the form the Act uses for itself', () => {
    expect(tableRef('8(ii)')).toBe('393(1) [Table: Sl. No. 8(ii)]')
    expect(mappingFor('194Q')!.act2025).toBe('393(1) [Table: Sl. No. 8(ii)]')
  })
})

describe('spansActChange', () => {
  it('flags a financial year that straddles 1 April 2026', () => {
    expect(spansActChange('2025-04-01', '2026-03-31')).toBe(false)
    expect(spansActChange('2026-01-01', '2026-12-31')).toBe(true)
    expect(spansActChange('2026-04-01', '2027-03-31')).toBe(false)
  })
})
