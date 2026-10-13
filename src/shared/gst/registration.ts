/**
 * WP 8.0 — what a company's GST registration allows on its own bills. One rule, used by the
 * invoice editor's computation (shared/voucherEdit/invoice.ts), the save guard in
 * services/vouchers.ts, counter billing, AI drafting / capture, the item dialogs and the print
 * title:
 *
 *   only a REGULAR registration charges GST on a bill. A composition dealer and an unregistered
 *   business issue bills without tax; a new sales / purchase / note that posts CGST / SGST / IGST /
 *   cess in such a company is refused. A voucher saved before this rule that already carries
 *   tax is kept exactly as saved (it round-trips; the editor shows a warning).
 *
 * Sources (accessed 2026-10-13; nothing here is from memory without being listed in
 * GST_REGISTRATION_UNVERIFIED):
 *  - s.32(1) CGST Act 2017 — "A person who is not a registered person shall not collect in
 *    respect of any supply of goods or services or both any amount by way of tax under this
 *    Act." (lawx.in / knowyourgst.com copies of the Act; https://lawx.in/acts/section/73/644/6119)
 *  - s.10(4) CGST Act 2017 — a composition taxable person "shall not collect any tax from the
 *    recipient on supplies made by him nor shall he be entitled to any credit of input tax".
 *    UNVERIFIED (wording not re-read in an official copy for this WP).
 *  - s.31(3)(c) CGST Act + rule 49 CGST Rules 2017 — a registered person supplying exempt
 *    goods / services or paying tax under s.10 issues, instead of a tax invoice, a BILL OF
 *    SUPPLY (rule 49 lists its particulars). https://gstzen.in/a/bill-of-supply-cgst-rule-49.html,
 *    https://www.cggst.com/uploads/document/1754035228-rule-49.pdf (State GST copy).
 *  - rule 5(1)(f) CGST Rules — a composition person mentions "composition taxable person, not
 *    eligible to collect tax on supplies" at the top of the bill of supply.
 *    https://cbic-gst.gov.in/composition-rules.html. The clause letter is UNVERIFIED against the
 *    current consolidated rules (secondary copies letter it (g)).
 */

export type GstRegistrationType = 'regular' | 'composition' | 'unregistered'

/** Only a regular registration charges GST on its bills (s.32(1), s.10(4) — see above). */
export function chargesGst(type: GstRegistrationType | null | undefined): boolean {
  return type === 'regular'
}

/** The print title replacing "Tax invoice" for a company that may not issue one (s.31(3)(c) +
 *  rule 49 for composition; an unregistered business issues no GST document at all, and the same
 *  title keeps "tax invoice" off its bills). */
export const BILL_OF_SUPPLY_TITLE = 'BILL OF SUPPLY'

/** Rule 5(1)(f) CGST Rules (letter UNVERIFIED) — printed at the top of a composition dealer's bill. */
export const COMPOSITION_DECLARATION = 'Composition taxable person, not eligible to collect tax on supplies'

/** The plain message a refused save shows — what happened, why, and where to change it. */
export function gstNotChargedMessage(type: GstRegistrationType): string {
  return type === 'composition'
    ? 'This company pays GST under the composition scheme, so its bills can’t charge GST (CGST Act s.10(4)). Remove the CGST / SGST / IGST / cess lines — or, if the registration has changed, update it in Company details.'
    : 'This company is not registered for GST, so its bills can’t charge GST (CGST Act s.32(1)). Remove the CGST / SGST / IGST / cess lines — or, if the business is now registered, add the GSTIN in Company details.'
}

/** The accountant-view warning on a voucher saved before WP 8.0 that already carries tax. */
export function legacyTaxWarning(type: GstRegistrationType): string {
  return `This entry charges GST, but the company is ${type === 'composition' ? 'under the composition scheme' : 'not registered for GST'} (Company details). It is kept exactly as it was saved; new bills can’t charge GST.`
}

export const GST_REGISTRATION_UNVERIFIED: readonly string[] = [
  's.10(4) CGST Act wording (composition: no tax collected, no input credit) — not re-read in an official copy',
  'rule 5(1)(f) vs (g) CGST Rules — the clause letter of the composition declaration',
  'Reverse-charge (RCM) supplies received by a composition dealer are not modelled — such a purchase with tax lines is refused too'
]
