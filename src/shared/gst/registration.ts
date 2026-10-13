/**
 * WP 8.0 — what a company's GST registration allows on its own bills. One rule, used by the
 * invoice editor's computation (shared/voucherEdit/invoice.ts), the save guard in
 * services/vouchers.ts, the GST returns (services/gst.ts), counter billing, AI drafting /
 * capture, the item dialogs and the print:
 *
 *   only a REGULAR registration charges GST on a bill. A composition dealer and an unregistered
 *   business issue bills without tax; a new sales / purchase / note that posts CGST / SGST / IGST /
 *   cess in such a company is refused. A purchase there records the GST the supplier charged as
 *   part of the cost (it can't be claimed) — never on an input-tax ledger.
 *
 * The registration is EFFECTIVE-DATED: `gstRegistrationSince` is the date the current type took
 * effect and `gstPreviousRegistrationType` the type before it (null / absent = the current type
 * has always applied). Every rule tests the VOUCHER'S date (registrationOn), so a company that
 * moves from regular to composition still books a late bill or a credit note (s.34) for its
 * regular months with GST, and its past returns don't change. A note set against a bill raised
 * while the company charged GST follows that bill. A voucher that already carries tax (saved
 * before the rule) keeps it exactly (it round-trips; the editor shows a warning).
 *
 * Sources (accessed 2026-10-13; anything not read in an official text is listed in
 * GST_REGISTRATION_UNVERIFIED):
 *  - s.32(1) CGST Act 2017 — "A person who is not a registered person shall not collect in
 *    respect of any supply of goods or services or both any amount by way of tax under this
 *    Act." (lawx.in / knowyourgst.com copies of the Act; https://lawx.in/acts/section/73/644/6119)
 *  - s.10(4) CGST Act 2017 — a composition taxable person "shall not collect any tax from the
 *    recipient on supplies made by him nor shall he be entitled to any credit of input tax".
 *    UNVERIFIED (wording not re-read in an official copy for this WP).
 *  - s.31(3)(c) CGST Act + rule 49 CGST Rules 2017 — a REGISTERED person supplying exempt
 *    goods / services or paying tax under s.10 issues, instead of a tax invoice, a BILL OF
 *    SUPPLY (rule 49 lists its particulars). https://gstzen.in/a/bill-of-supply-cgst-rule-49.html,
 *    https://www.cggst.com/uploads/document/1754035228-rule-49.pdf (State GST copy). Rule 49
 *    applies to registered persons, so an unregistered business prints a plain "INVOICE".
 *  - rule 5(1)(f) CGST Rules — "he shall mention the words "composition taxable person, not
 *    eligible to collect tax on supplies" at the top of the bill of supply issued by him"; (g) is
 *    the signboard. Read in the CBIC consolidated rules:
 *    https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/rules/cgst_rules/active/chapter2/rule5_v1.00.html
 *  - s.34 CGST Act — a credit / debit note follows the tax invoice it adjusts (why a note
 *    against a bill of the regular period keeps that bill's GST). UNVERIFIED wording.
 */

export type GstRegistrationType = 'regular' | 'composition' | 'unregistered'

/** The registration facts a rule needs (a CompanyInfo, or an invoice context, carries them). */
export interface GstRegistrationFacts {
  gstRegistrationType: GstRegistrationType
  /** ISO date the current type took effect; null / absent = it has always applied. */
  gstRegistrationSince?: string | null
  /** The type before `gstRegistrationSince` (null / absent = the current type). */
  gstPreviousRegistrationType?: GstRegistrationType | null
}

/** Only a regular registration charges GST on its bills (s.32(1), s.10(4) — see above). */
export function chargesGst(type: GstRegistrationType | null | undefined): boolean {
  return type === 'regular'
}

/** The registration in force on `date`. */
export function registrationOn(c: GstRegistrationFacts, date: string): GstRegistrationType {
  if (c.gstRegistrationSince && date < c.gstRegistrationSince) return c.gstPreviousRegistrationType ?? c.gstRegistrationType
  return c.gstRegistrationType
}

/** Does a bill dated `date` charge GST? */
export const chargesGstOn = (c: GstRegistrationFacts, date: string): boolean => chargesGst(registrationOn(c, date))

/** Just the registration facts of a company (to spread into an invoice context). */
export function gstRegistrationOf(c: GstRegistrationFacts): GstRegistrationFacts {
  return {
    gstRegistrationType: c.gstRegistrationType,
    gstRegistrationSince: c.gstRegistrationSince ?? null,
    gstPreviousRegistrationType: c.gstPreviousRegistrationType ?? null
  }
}

/** Company details save: a CHANGED type takes effect from `since` (default today) and records
 *  the type it replaces; an unchanged type keeps the stored history. One step of history is kept
 *  (a second change replaces it — the earlier periods then read as the previous type). */
export function nextRegistrationFacts(
  before: GstRegistrationFacts,
  type: GstRegistrationType,
  since: string | null | undefined,
  today: string
): GstRegistrationFacts {
  if (type === before.gstRegistrationType) {
    return { gstRegistrationType: type, gstRegistrationSince: before.gstRegistrationSince ?? null, gstPreviousRegistrationType: before.gstPreviousRegistrationType ?? null }
  }
  return { gstRegistrationType: type, gstRegistrationSince: since || today, gstPreviousRegistrationType: before.gstRegistrationType }
}

/** s.31(3)(c) + rule 49: a composition dealer issues a bill of supply. */
export const BILL_OF_SUPPLY_TITLE = 'BILL OF SUPPLY'
/** An unregistered business issues no GST document (rule 49 is for registered persons). */
export const UNREGISTERED_INVOICE_TITLE = 'INVOICE'

/** The sales print title for a registration that may not issue a tax invoice (null = keep). */
export function nonTaxInvoiceTitle(type: GstRegistrationType): string | null {
  return type === 'composition' ? BILL_OF_SUPPLY_TITLE : type === 'unregistered' ? UNREGISTERED_INVOICE_TITLE : null
}

/** Rule 5(1)(f) CGST Rules — printed at the top of a composition dealer's bill of supply. */
export const COMPOSITION_DECLARATION = 'Composition taxable person, not eligible to collect tax on supplies'

/** The plain message a refused save shows — what happened, why, and where to change it. */
export function gstNotChargedMessage(type: GstRegistrationType): string {
  return type === 'composition'
    ? 'This company pays GST under the composition scheme, so its bills can’t charge GST (CGST Act s.10(4)). Remove the CGST / SGST / IGST / cess lines — on a purchase the GST you paid is part of the cost — or, if the registration has changed, update it in Company details.'
    : 'This company is not registered for GST, so its bills can’t charge GST (CGST Act s.32(1)). Remove the CGST / SGST / IGST / cess lines — on a purchase the GST you paid is part of the cost — or, if the business is now registered, add the GSTIN in Company details.'
}

/** The accountant-view warning on a voucher saved before WP 8.0 that already carries tax. */
export function legacyTaxWarning(type: GstRegistrationType): string {
  return `This entry charges GST, but the company is ${type === 'composition' ? 'under the composition scheme' : 'not registered for GST'} on its date (Company details). It is kept exactly as it was saved; new bills can’t charge GST.`
}

/** The purchase-side hint when the company can't claim GST. */
export const NON_CLAIMABLE_RATE_HINT = 'Rates include the GST the supplier charged — it can’t be claimed, so it is part of the cost.'

export const GST_REGISTRATION_UNVERIFIED: readonly string[] = [
  's.10(4) CGST Act wording (composition: no tax collected, no input credit) — not re-read in an official copy',
  's.34 CGST Act wording (notes follow the invoice they adjust) — not re-read in an official copy',
  'Reverse-charge (RCM) supplies received by a composition dealer are not modelled — such a purchase with tax lines is refused too',
  'Only one change of registration is kept (the previous type and the date the current one took effect)'
]
