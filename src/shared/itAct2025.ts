/**
 * The Income-tax Act, 2025, and the section number a certificate has to carry (roadmap #359).
 *
 * The Income-tax Act 1961 is replaced by the Income-tax Act 2025 with effect from 1 April 2026.
 * The tax it collects is broadly the same tax; the SECTION NUMBERS are not. Everything this app
 * stores about TDS — `tds_sections.code`, the label on a voucher, the head on a Form 16A, the
 * section column in a 26Q — is a 1961 Act number, and from 1 April 2026 a certificate carrying a
 * 1961 number for a payment made under the 2025 Act is wrong on its face.
 *
 * The awkward part is that both are correct, at different times. A Form 16A issued in July 2026
 * for the quarter ended June 2026 belongs to the 2025 Act. A revised certificate issued in the
 * same week for the quarter ended December 2025 belongs to the 1961 Act. So the number is not a
 * property of the section master — it is a function of the section master AND the date of the
 * payment, which is what `sectionForDate` is.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT IS KNOWN, AND WHAT IS NOT. Read this before trusting a number out of this file.
 *
 *   - The Income-tax Act 2025 received assent on 21 August 2025 and comes into force on
 *     1 April 2026. That date is what `IT_ACT_2025_FROM` encodes and it is the part this author
 *     is confident about.
 *   - The deduction-at-source provisions of the 1961 Act (sections 192 to 196D) are consolidated
 *     in the 2025 Act rather than carried across one-for-one: the operative provision is a single
 *     section with a table, and each kind of payment is a serial in that table rather than a
 *     section of its own. The consolidated section is understood to be SECTION 393.
 *   - ** THE SERIAL NUMBERS IN THAT TABLE HAVE NOT BEEN VERIFIED BY THIS AUTHOR, AND NEITHER HAS
 *        THE SECTION NUMBER ITSELF. ** Every entry below is therefore marked `unverified`, the UI
 *        shows that mark, and nothing prints a 2025 Act reference without the user having either
 *        confirmed it or typed their own.
 *
 * Which is the whole design: the MECHANISM is complete and correct — dual numbers, keyed off the
 * voucher date, overridable per section, printed on the certificate. The DATA is a starting point
 * that says so. Guessing serial numbers into a statutory certificate is exactly the kind of
 * confident wrongness a user only finds out about from a notice.
 */

/** The 2025 Act applies to payments made on or after this date. */
export const IT_ACT_2025_FROM = '2026-04-01'

/** The consolidated deduction-at-source provision of the 2025 Act. See the header — unverified. */
export const TDS_SECTION_2025 = '393'

export type MappingConfidence =
  /** Checked against the bare Act text and believed right. */
  | 'confirmed'
  /** A reasonable reading that nobody has verified. Shown with a warning wherever it appears. */
  | 'unverified'
  /** No mapping proposed. The user has to supply one. */
  | 'unknown'

export interface SectionMapping {
  /** 1961 Act section, as `tds_sections.code` holds it: '194C', '194J', '192'. */
  legacy: string
  /** What this deduction is for — matched against the section's description as a fallback. */
  label: string
  /** 2025 Act reference, or null when none is proposed. */
  act2025: string | null
  confidence: MappingConfidence
  note: string
}

const UNVERIFIED_NOTE =
  'Deduction at source is consolidated in section 393 of the Income-tax Act 2025, with each kind of payment a ' +
  'serial in its table. The serial for this payment has not been verified — confirm it, or type the reference ' +
  'your certificates should carry, before issuing anything for a period on or after 1 April 2026.'

/**
 * The sections a small business actually deducts under.
 *
 * Deliberately short. A list that reached for every section from 192 to 196D would look
 * authoritative and be no better checked than this one; the sections here are the ones that will
 * appear on a Form 16A this year, and every one of them is marked for what it is.
 */
export const SECTION_MAPPINGS: SectionMapping[] = [
  { legacy: '192', label: 'Salary', act2025: TDS_SECTION_2025, confidence: 'unverified', note: UNVERIFIED_NOTE },
  { legacy: '192A', label: 'Accumulated provident fund balance', act2025: TDS_SECTION_2025, confidence: 'unverified', note: UNVERIFIED_NOTE },
  { legacy: '193', label: 'Interest on securities', act2025: TDS_SECTION_2025, confidence: 'unverified', note: UNVERIFIED_NOTE },
  { legacy: '194', label: 'Dividend', act2025: TDS_SECTION_2025, confidence: 'unverified', note: UNVERIFIED_NOTE },
  { legacy: '194A', label: 'Interest other than on securities', act2025: TDS_SECTION_2025, confidence: 'unverified', note: UNVERIFIED_NOTE },
  { legacy: '194C', label: 'Payments to contractors', act2025: TDS_SECTION_2025, confidence: 'unverified', note: UNVERIFIED_NOTE },
  { legacy: '194H', label: 'Commission or brokerage', act2025: TDS_SECTION_2025, confidence: 'unverified', note: UNVERIFIED_NOTE },
  { legacy: '194I', label: 'Rent', act2025: TDS_SECTION_2025, confidence: 'unverified', note: UNVERIFIED_NOTE },
  { legacy: '194IA', label: 'Transfer of immovable property', act2025: TDS_SECTION_2025, confidence: 'unverified', note: UNVERIFIED_NOTE },
  { legacy: '194J', label: 'Professional or technical services', act2025: TDS_SECTION_2025, confidence: 'unverified', note: UNVERIFIED_NOTE },
  { legacy: '194Q', label: 'Purchase of goods', act2025: TDS_SECTION_2025, confidence: 'unverified', note: UNVERIFIED_NOTE },
  { legacy: '206AA', label: 'Higher rate where no PAN is furnished', act2025: null, confidence: 'unknown', note: 'No mapping proposed. 206AA is a machinery provision rather than a deducting section and its 2025 Act equivalent has not been established.' }
]

/** Normalises '194 C', '194c', 'Sec 194C' to '194C' so a hand-typed master still matches. */
export function normaliseSectionCode(code: string): string {
  return code.toUpperCase().replace(/^SEC(TION)?\.?\s*/, '').replace(/[^0-9A-Z]/g, '')
}

/** The proposed 2025 Act mapping for a 1961 Act code, or null when there is none. */
export function mappingFor(legacyCode: string): SectionMapping | null {
  const key = normaliseSectionCode(legacyCode)
  return SECTION_MAPPINGS.find((m) => m.legacy === key) ?? null
}

export interface DatedSection {
  /** What to print. */
  code: string
  /** Which Act it belongs to. */
  act: 1961 | 2025
  /** True when the number printed has not been verified against the Act. */
  unverified: boolean
  /** The sentence to show alongside it, or null when there is nothing to warn about. */
  warning: string | null
}

export interface SectionMasterLike {
  /** 1961 Act code, from `tds_sections.code`. */
  code: string
  /** The user's own 2025 Act reference, from `tds_sections.code_2025`. Wins over any mapping. */
  code2025: string | null
}

/**
 * The section reference a document for a payment on `date` should carry.
 *
 * Before 1 April 2026 the answer is always the 1961 Act code — a certificate for an old quarter
 * does not become a 2025 Act certificate because it was printed late. On or after that date the
 * user's own override wins, then the proposed mapping (with its warning), and where neither
 * exists the 1961 code is printed with a warning rather than a blank: a certificate with an empty
 * section box is useless, and one that says which Act it is unsure about is at least checkable.
 */
export function sectionForDate(master: SectionMasterLike, date: string): DatedSection {
  if (date < IT_ACT_2025_FROM) {
    return { code: master.code, act: 1961, unverified: false, warning: null }
  }
  if (master.code2025 && master.code2025.trim()) {
    return { code: master.code2025.trim(), act: 2025, unverified: false, warning: null }
  }
  const mapping = mappingFor(master.code)
  if (mapping?.act2025) {
    return { code: mapping.act2025, act: 2025, unverified: true, warning: mapping.note }
  }
  return {
    code: master.code,
    act: 1961,
    unverified: true,
    warning:
      `This payment falls under the Income-tax Act 2025 (in force from ${IT_ACT_2025_FROM}) but no 2025 Act ` +
      `reference is recorded for section ${master.code}. The 1961 Act number is shown. Set the 2025 reference on ` +
      'the TDS section master before issuing certificates.'
  }
}

/** Whether any part of a period falls under the 2025 Act — what makes the banner worth showing. */
export function spansActChange(from: string, to: string): boolean {
  return from < IT_ACT_2025_FROM && to >= IT_ACT_2025_FROM
}
