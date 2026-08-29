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
 * THE TABLE SERIALS BELOW ARE NOW READ IN THE BARE ACT. They were guesses before — every entry
 * pointed at a bare "393" — and every one of them was wrong in the sense that mattered: a
 * certificate carrying "393" and no serial names the whole deduction-at-source provision rather
 * than the payment it was deducted on.
 *
 * Source: the Income-tax Act, 2025 (Act No. 30 of 2025), as published in the Gazette of India
 * Extraordinary, Part II — Section 1, No. 35, New Delhi, Thursday, August 21, 2025
 * (egazette.gov.in/WriteReadData/2025/265620.pdf). Sections 392, 393 and 397 were read there
 * directly. The Act comes into force on 1 April 2026, which is what `IT_ACT_2025_FROM` encodes.
 *
 * The structure the 1961 Act's sections 192-196D collapse into:
 *   - Section 392 — salary, and the provident-fund cases. 392(1) is the deduction on "any income
 *     chargeable under the head 'Salaries'"; 392(7) is the trustees of the EPF Scheme deducting at
 *     10% on an accumulated balance of ₹50,000 or more.
 *   - Section 393(1) — one Table headed FOR PAYMENTS TO RESIDENT, with columns A (Sl. No.),
 *     B (nature of income or sum), C (payer) and D (rate and threshold limit). Eight serials, most
 *     with roman-numeral sub-items — 1 commission or brokerage, 2 rent, 3 transfer of certain
 *     immovable property, 4 income from capital market, 5 interest income, 6 payments to contractors
 *     and fees for professional and technical services, 7 dividend, 8 other cases. The citation form
 *     the Act itself uses in cross-references is
 *     "section 393(1) [Table: Sl. No. 8(iii)]" and "section 393(1) (Table: Sl. No. 7)", which is the
 *     form reproduced below.
 *   - Section 393(2) — a second Table, FOR PAYMENTS TO NON-RESIDENT. Not modelled here: these books
 *     do not carry non-resident deductions.
 *   - Section 393(3) — a THIRD Table, FOR PAYMENTS TO ANY PERSON: winnings, online games, horse
 *     racing, lottery commission, cash withdrawals, and remuneration to a partner of a firm. Also
 *     not modelled: none of the twelve sections below falls in it. It is named here so the next
 *     person does not go looking for 194G or 194T in the 393(1) Table, where they are not.
 *   - Section 397(2) — the 206AA case. "every person, entitled to receive any amount on which tax is
 *     deductible ... shall furnish his valid Permanent Account Number", and on failure "tax shall be
 *     deducted at the higher of the following rates: (A) at the rate specified in the relevant
 *     provision of this Act; or (B) at the rate or rates in force; or (C) at the rate of 5% where
 *     tax is required to be deducted under section 393(1) [Table: Sl. No. 8(ii) or 8(v)]; or 20% in
 *     any other case".
 *
 * WHAT IS STILL NOT ESTABLISHED, and it is the part that decides what gets printed:
 *   - WHICH CITATION FORM A CERTIFICATE OR A STATEMENT MUST CARRY. The Act cites itself as
 *     "section 393(1) [Table: Sl. No. 6(i)]", and that is what this file proposes. Whether the
 *     prescribed certificate (the 2025 Act renumbers Forms 16/16A and their siblings as Forms 130 to
 *     133) and the quarterly statement want that string, or a short code of their own the way the
 *     e-TDS file wants "94C" rather than "194C",
 *     is a question about the FORMS and the file format, not about the Act, and the forms for tax
 *     year 2026-27 were not read. So every mapping below is `confirmed` as a reading of the Act and
 *     the app still says, on the certificate and on the screen, that the reference should be
 *     checked against the form before it is issued.
 *   - The Income Tax Department publishes an official 1961-to-2025 "Navigator" mapping at
 *     incometaxindia.gov.in/documents/20117/43138/new-income-tax-bill-2025-navigator.pdf. It could
 *     not be fetched (the site returns 403 to anything that is not a browser) as at 25 August 2026.
 *     It is the right thing to reconcile this table against when somebody can open it.
 *
 * The MECHANISM is unchanged and was always the point — dual numbers, keyed off the voucher date,
 * overridable per section, printed on the certificate. What changed is that the DATA is now read
 * rather than guessed, and the user's own override still wins over anything this file proposes.
 */

/** The 2025 Act applies to payments made on or after this date. */
export const IT_ACT_2025_FROM = '2026-04-01'

/**
 * The consolidated deduction-at-source provision for payments to a resident.
 *
 * Kept as a constant because every serial below is a reference INTO its Table, and because a
 * caller that wants to know "is this a 2025 Act reference at all" asks about this, not about a
 * serial. Salary and provident fund are NOT here — they are section 392.
 */
export const TDS_SECTION_2025 = '393'

/** How the Act cites its own Table entries: `section 393(1) [Table: Sl. No. 6(i)]`. */
export function tableRef(serial: string): string {
  return `393(1) [Table: Sl. No. ${serial}]`
}

export type MappingConfidence =
  /** Read in the bare Act. */
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

/**
 * The note every `confirmed` mapping carries.
 *
 * It says the one thing that is still open — see the header. The serial is read in the Act; whether
 * the prescribed form wants it written this way is a question about the form.
 */
const FORM_NOTE =
  'This reference is read in the Income-tax Act 2025 as published (Act 30 of 2025, gazetted 21 August 2025) and is ' +
  'written in the citation form the Act uses for itself. Whether the prescribed certificate and quarterly statement ' +
  'want it in exactly this form, or in a short code of their own, has not been checked against the forms for tax ' +
  'year 2026-27. Confirm it, or type your own reference, before issuing certificates.'

/**
 * The sections a small business actually deducts under.
 *
 * Deliberately short. A list that reached for every section from 192 to 196D would look
 * authoritative and be no better checked than this one; the sections here are the ones that will
 * appear on a Form 16A this year, and every one of them names where it was read.
 *
 * The two cases worth pausing on:
 *   - 194I splits in the 2025 Act by WHO PAYS, not by what is rented. Serial 2(i) is rent paid by a
 *     person other than a specified person (the 1961 Act's 194IB); serial 2(ii) is rent paid by a
 *     specified person, which is 194I, and the plant-and-machinery/land-and-building split that was
 *     194I(a) and 194I(b) is now sub-clauses (a) and (b) of the RATE column within 2(ii). So there
 *     is one serial where the 1961 Act had two sections, and the rate still decides which limb.
 *   - 194J is serial 6(iii), whose rate column carries the same 2%/10% split that was 194J(a) and
 *     194J(b).
 */
export const SECTION_MAPPINGS: SectionMapping[] = [
  { legacy: '192', label: 'Salary', act2025: '392(1)', confidence: 'confirmed', note: FORM_NOTE },
  { legacy: '192A', label: 'Accumulated provident fund balance', act2025: '392(7)', confidence: 'confirmed', note: FORM_NOTE },
  { legacy: '193', label: 'Interest on securities', act2025: tableRef('5(i)'), confidence: 'confirmed', note: FORM_NOTE },
  { legacy: '194', label: 'Dividend', act2025: tableRef('7'), confidence: 'confirmed', note: FORM_NOTE },
  { legacy: '194A', label: 'Interest other than on securities', act2025: tableRef('5(iii)'), confidence: 'confirmed', note: `${FORM_NOTE} Serial 5(ii) covers the same income where the payer is a bank, a co-operative society carrying on banking, or a post office; 5(iii) covers every other specified person.` },
  { legacy: '194C', label: 'Payments to contractors', act2025: tableRef('6(i)'), confidence: 'confirmed', note: FORM_NOTE },
  { legacy: '194H', label: 'Commission or brokerage', act2025: tableRef('1(ii)'), confidence: 'confirmed', note: `${FORM_NOTE} Serial 1(i) is insurance commission (the 1961 Act's 194D); 1(ii) is commission or brokerage that is not insurance commission.` },
  { legacy: '194I', label: 'Rent', act2025: tableRef('2(ii)'), confidence: 'confirmed', note: `${FORM_NOTE} The 2% on plant, machinery or equipment and the 10% on land, building, furniture or fittings are limbs (a) and (b) of the rate in serial 2(ii), not serials of their own.` },
  { legacy: '194IA', label: 'Transfer of immovable property', act2025: tableRef('3(i)'), confidence: 'confirmed', note: FORM_NOTE },
  { legacy: '194J', label: 'Professional or technical services', act2025: tableRef('6(iii)'), confidence: 'confirmed', note: `${FORM_NOTE} The 2% on technical services, cinematograph royalty and call centres and the 10% on everything else are limbs (a) and (b) of the rate in serial 6(iii).` },
  { legacy: '194Q', label: 'Purchase of goods', act2025: tableRef('8(ii)'), confidence: 'confirmed', note: FORM_NOTE },
  { legacy: '206AA', label: 'Higher rate where no PAN is furnished', act2025: '397(2)', confidence: 'confirmed', note: `${FORM_NOTE} 397(2) is a machinery provision, not a deducting section: it forces the higher of the section rate, the rates in force, and 5% for serials 8(ii) and 8(v) or 20% otherwise. It is not a reference a certificate carries as its section.` }
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
  /**
   * True when the reference should not go onto a certificate without a person looking at it.
   *
   * This is NOT "the number is a guess" any more — the serials are read in the Act. It is set for
   * any 2025 Act reference the APP proposed, because what remains unchecked is whether the
   * prescribed form wants the Act's own citation form (see the header). A reference the user typed
   * themselves is never flagged: they have already looked at it.
   */
  unverified: boolean
  /** How the proposed reference was arrived at. Null where the app proposed nothing. */
  confidence: MappingConfidence | null
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
    return { code: master.code, act: 1961, unverified: false, confidence: null, warning: null }
  }
  if (master.code2025 && master.code2025.trim()) {
    return { code: master.code2025.trim(), act: 2025, unverified: false, confidence: null, warning: null }
  }
  const mapping = mappingFor(master.code)
  if (mapping?.act2025) {
    return { code: mapping.act2025, act: 2025, unverified: true, confidence: mapping.confidence, warning: mapping.note }
  }
  return {
    code: master.code,
    act: 1961,
    unverified: true,
    confidence: 'unknown',
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
