/**
 * Plain-English explanations for GST validation issues.
 *
 * The validator already says what is wrong, in the register of someone who knows GST: "12 lines
 * across 3 vouchers missing an HSN/SAC — Table 12 will not tie to the invoice tables." That is
 * the right message for the person who wrote it and the wrong one for the person filing their
 * first return.
 *
 * The temptation is to hand the issue list to a model and ask it to explain. The reason not to
 * is that the explanation of a statutory rule is exactly the text that must not be improvised: a
 * model that invents a section number, a threshold or a due date produces something the user
 * will act on and cannot check. So the explanations are WRITTEN HERE, keyed by issue code, cited
 * to the provision, and the assistant's job is reduced to quoting them and applying them to the
 * particular vouchers in front of it.
 *
 * That is what "grounded on the validation output" means: the model gets the issue list and this
 * table, and every claim it can make about GST law is one of these sentences.
 */

import type { GstIssue } from '../gst/validate'

export interface GstIssueExplanation {
  /** One sentence a non-specialist understands. */
  what: string
  /** Why the portal or the law cares — with the provision, where there is one. */
  why: string
  /** The concrete next action, naming the screen. */
  fix: string
  /** Checked against the source when this entry was written. */
  checked: string
}

/**
 * Keyed by GstIssue['code']. Exhaustive by construction: the Record type below fails to compile
 * when a new validation code is added without an explanation, which is the point — a new check
 * with no plain-English text is a new check the assistant will improvise about.
 */
export const GST_ISSUE_EXPLANATIONS: Record<GstIssue['code'], GstIssueExplanation> = {
  composition: {
    what: 'This company is registered under the composition scheme, so GSTR-1 is not its return.',
    why: 'A composition dealer files CMP-08 quarterly and GSTR-4 annually (rule 62 of the CGST Rules). The portal will not accept a GSTR-1 from this GSTIN.',
    fix: 'Open CMP-08 & GSTR-4 from the sidebar. If the registration type is wrong, correct it in Company info.',
    checked: '2026-08'
  },
  missing_hsn: {
    what: 'Some invoice lines have no HSN or SAC code.',
    why: 'Table 12 of GSTR-1 summarises the return by HSN. With lines missing a code, Table 12 cannot add up to the invoice tables, and rule 46 requires the code on the invoice itself.',
    fix: 'Set the HSN/SAC on the stock item, or on the ledger for a service. The affected vouchers are listed beside this issue.',
    checked: '2026-08'
  },
  missing_gstin: {
    what: 'An SEZ or deemed-export document has no buyer GSTIN.',
    why: 'Those tables are B2B by definition — the portal keys the document to the recipient GSTIN and rejects it without one.',
    fix: 'Add the buyer GSTIN on the party ledger, then reopen the return.',
    checked: '2026-08'
  },
  invalid_gstin: {
    what: 'A buyer GSTIN fails its format or check-digit test.',
    why: 'A GSTIN is 15 characters: 2 state code, 10 PAN, 1 entity number, Z, and 1 check character computed from the rest. A typo almost always breaks the check character, and the portal rejects the document.',
    fix: 'Correct the GSTIN on the party ledger. Total re-validates as you type.',
    checked: '2026-08'
  },
  invalid_uqc: {
    what: 'A unit of measure is not one of the portal codes.',
    why: 'Table 12 accepts only the published UQC list (NOS, KGS, MTR and so on). A unit named "pieces" is not one of them.',
    fix: 'Set the UQC on the unit in Masters → Units. The item keeps its own name; only the reported code changes.',
    checked: '2026-08'
  },
  val_mismatch: {
    what: 'A document total does not equal taxable value plus tax.',
    why: 'The portal recomputes tax from the taxable value and rate. Where the booked total disagrees by more than a rupee, the usual cause is a hand-edited tax line, and the return will not tie to the books.',
    fix: 'Open the voucher and let the tax lines recompute rather than typing them.',
    checked: '2026-08'
  },
  duplicate_number: {
    what: 'Two sales documents share an invoice number in this period.',
    why: 'An invoice number must be unique in a financial year for a series (rule 46(b)). The portal rejects a repeated document number outright.',
    fix: 'Renumber one of the vouchers. If they are the same invoice entered twice, delete the duplicate — it goes to the bin, not away.',
    checked: '2026-08'
  },
  zero_rated_intra_tax: {
    what: 'An SEZ or export document carries CGST and SGST.',
    why: 'A supply to an SEZ or outside India is always inter-state under section 7(5)(b) of the IGST Act, so it can only bear IGST. The portal rejects the invoice, and GSTR-3B would silently drop the tax.',
    fix: 'Re-enter the document with IGST, or fix the place of supply on the party.',
    checked: '2026-08'
  },
  rate_zero_untyped: {
    what: 'Some lines are taxed at 0%, and Total is reporting them as nil-rated.',
    why: 'Nil-rated, exempt and non-GST supplies go to different columns of Table 8, and a 0% line does not say which it is.',
    fix: 'If these are exempt or non-GST supplies, check Table 8 before filing rather than accepting the default.',
    checked: '2026-08'
  },
  b2cl_edge: {
    what: 'An inter-state sale to an unregistered buyer sits within ₹1,000 of the B2CL threshold.',
    why: 'Above ₹1,00,000 the invoice is reported document-by-document in B2CL; below it, only as a state total in B2CS. A small valuation change moves it between tables.',
    fix: 'Check the invoice value. If it belongs in B2CL, the reclassification happens automatically once the value is right.',
    checked: '2026-08'
  },
  hsn_too_short: {
    what: 'An HSN code is shorter than this turnover requires.',
    why: 'Rule 46 requires 6 digits above ₹5 crore aggregate turnover and 4 digits below. Total only raises this once the turnover band has been declared.',
    fix: 'Lengthen the HSN on the stock item or ledger, or correct the turnover band in Company info if it is wrong.',
    checked: '2026-08'
  },
  missing_irn: {
    what: 'A B2B invoice has no IRN, and e-invoicing applies at this turnover.',
    why: 'Above the e-invoicing threshold an invoice without an IRN is not a valid tax invoice, and the buyer\'s input tax credit can be denied on it.',
    fix: 'Generate the IRN from e-Docs before issuing the invoice. Filing is not blocked, but the buyer may come back.',
    checked: '2026-08'
  }
}

export interface ExplainedIssue extends GstIssue {
  explanation: GstIssueExplanation
}

/** Attach the written explanation to each issue, newest severity first. */
export function explainIssues(issues: GstIssue[]): ExplainedIssue[] {
  return [...issues]
    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'blocking' ? -1 : 1))
    .map((issue) => ({ ...issue, explanation: GST_ISSUE_EXPLANATIONS[issue.code] }))
}

/**
 * A one-paragraph summary of where a period stands.
 *
 * Computed, not narrated: the counts come from the issue list, so an assistant answer that
 * disagrees with this sentence is visibly disagreeing with the screen.
 */
export function summariseIssues(issues: GstIssue[]): string {
  const blocking = issues.filter((i) => i.severity === 'blocking').length
  const warnings = issues.length - blocking
  if (issues.length === 0) return 'Nothing is blocking this return, and there are no warnings.'
  const parts: string[] = []
  if (blocking > 0) parts.push(`${blocking} issue${blocking === 1 ? '' : 's'} blocking the export`)
  if (warnings > 0) parts.push(`${warnings} warning${warnings === 1 ? '' : 's'}`)
  return `${parts.join(' and ')}. Blocking issues must be cleared before the return can be exported.`
}
