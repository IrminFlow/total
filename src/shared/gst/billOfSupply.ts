/**
 * Which document a supply actually is: a tax invoice, or a bill of supply.
 *
 * The app printed "TAX INVOICE" on everything, driven by one editable config string. That is
 * wrong for two whole classes of supplier:
 *
 *  - A **composition dealer** may not collect tax and may not issue a tax invoice. Section
 *    31(3)(c) and rule 49 require a bill of supply, and rule 5(1)(f) of the Composition Rules
 *    requires a specific sentence at the top of it. Printing a tax invoice with nil CGST/SGST
 *    lines is not a cosmetic slip: it is the dealer holding out a document they are barred from
 *    issuing.
 *  - A **regular dealer supplying only exempt or nil-rated goods** on a document owes a bill of
 *    supply too, for the same section.
 *
 * The distinction is *not* simply "no tax on the document". Three cases carry no tax and are
 * still tax invoices, because the tax exists and someone else or some later event pays it:
 *
 *  - Exports and SEZ supplies made without payment of integrated tax. These need the statutory
 *    endorsement instead, which this module also supplies.
 *  - Supplies where the recipient pays under reverse charge.
 *  - A wholly-discounted or zero-value line on an otherwise taxed invoice — handled because the
 *    test is the document's total tax, not any single line's.
 *
 * Getting this backwards in either direction is a defect a buyer's own accountant will find, so
 * the rules are stated here once, in one pure function, rather than inferred at each print site.
 */

export type GstRegistrationType = 'regular' | 'composition' | 'unregistered'

export type SupplyDocumentKind =
  /** Rule 46. Tax is charged on the face of it, or is payable by the recipient. */
  | 'tax-invoice'
  /** Section 31(3)(c) and rule 49. Exempt supplies, and every supply by a composition dealer. */
  | 'bill-of-supply'
  /** Not a GST document at all: an unregistered business has no authority to issue either. */
  | 'invoice'

export interface SupplyDocumentInput {
  gstRegistrationType: GstRegistrationType
  /** Total tax on the document in paise — CGST + SGST + IGST + cess. */
  taxPaise: number
  /** Export or SEZ supply type, if any. EXPWOP/SEZWOP carry no tax and are still tax invoices. */
  supTyp?: 'B2B' | 'SEZWP' | 'SEZWOP' | 'EXPWP' | 'EXPWOP'
  /** The recipient pays the tax under reverse charge, so the supplier charges none. */
  reverseCharge?: boolean
}

/** Rule 5(1)(f) of the Composition Rules — required at the top of the document, verbatim. */
export const COMPOSITION_DECLARATION =
  'Composition taxable person, not eligible to collect tax on supplies'

/** Rule 46(o) — required on an export or SEZ supply made without payment of integrated tax. */
export const EXPORT_WITHOUT_TAX_ENDORSEMENT =
  'Supply meant for export/supply to SEZ unit or SEZ developer for authorised operations on payment of integrated tax'
export const EXPORT_WITHOUT_TAX_ENDORSEMENT_WOP =
  'Supply meant for export/supply to SEZ unit or SEZ developer for authorised operations without payment of integrated tax'

/** Rule 46(p) — required when the recipient pays the tax. */
export const REVERSE_CHARGE_ENDORSEMENT = 'Tax payable on reverse charge basis'

const ZERO_RATED_WITHOUT_TAX = new Set(['EXPWOP', 'SEZWOP'])
const ZERO_RATED = new Set(['EXPWP', 'EXPWOP', 'SEZWP', 'SEZWOP'])

/**
 * Which document this supply is.
 *
 * Order matters. Registration type decides first — a composition dealer's document is a bill of
 * supply whatever is on it, and an unregistered business's document is neither GST form. Only
 * then does the absence of tax mean "exempt", and only for supplies that are not zero-rated and
 * not reverse-charge.
 */
export function supplyDocumentKind(input: SupplyDocumentInput): SupplyDocumentKind {
  if (input.gstRegistrationType === 'unregistered') return 'invoice'
  if (input.gstRegistrationType === 'composition') return 'bill-of-supply'
  if (input.taxPaise > 0) return 'tax-invoice'
  if (input.supTyp && ZERO_RATED.has(input.supTyp)) return 'tax-invoice'
  if (input.reverseCharge) return 'tax-invoice'
  return 'bill-of-supply'
}

/** The heading to print. Statutory titles are fixed; only a plain invoice takes the config's. */
export function supplyDocumentTitle(kind: SupplyDocumentKind, configuredTitle: string): string {
  if (kind === 'tax-invoice') return configuredTitle
  if (kind === 'bill-of-supply') return 'BILL OF SUPPLY'
  return 'INVOICE'
}

/**
 * Whether tax may appear on the face of the document.
 *
 * A bill of supply showing a tax column -- even at nil -- reads as tax collected, which is the
 * exact thing a composition dealer is barred from doing.
 */
export function showsTax(kind: SupplyDocumentKind): boolean {
  return kind === 'tax-invoice'
}

/** Endorsements the document must carry, in print order. Empty for an ordinary tax invoice. */
export function supplyEndorsements(input: SupplyDocumentInput): string[] {
  const out: string[] = []
  if (input.gstRegistrationType === 'composition') out.push(COMPOSITION_DECLARATION)
  if (input.supTyp && ZERO_RATED.has(input.supTyp)) {
    out.push(
      ZERO_RATED_WITHOUT_TAX.has(input.supTyp)
        ? EXPORT_WITHOUT_TAX_ENDORSEMENT_WOP
        : EXPORT_WITHOUT_TAX_ENDORSEMENT
    )
  }
  if (input.reverseCharge) out.push(REVERSE_CHARGE_ENDORSEMENT)
  return out
}
