/**
 * Invoice Management System actions (roadmap #352).
 *
 * IMS sits between what a supplier filed and what the buyer may claim. Every inward document
 * lands in the buyer's IMS dashboard and has to be ACCEPTED, REJECTED or kept PENDING, and only
 * accepted documents flow into GSTR-2B and therefore into the credit. A document nobody touches
 * is treated as deemed accepted when 2B is generated — which sounds forgiving and is the trap: a
 * supplier's mistaken invoice, left alone, becomes credit the buyer has claimed and cannot
 * support.
 *
 * `recon2b` already computes the comparison. What it does not produce is the action list, and the
 * action list is the part that has to happen every single month.
 *
 * ---------------------------------------------------------------------------------------------
 * CHECKED AGAINST (August 2026):
 *   - IMS was introduced on the GST portal from 1 October 2024 and given statutory backing by the
 *     amendments to section 38 and rule 60 (Finance (No. 2) Act 2024 / Notification No.
 *     12/2024-Central Tax). The three actions and the deemed-acceptance default are as described
 *     in the GSTN advisories of September–November 2024.
 *   - ** THIS APP CANNOT TAKE THE ACTION. ** IMS actions are taken on the portal; there is no
 *     offline route, and there is no API this app has credentials for. What is built here is the
 *     decision list and the record of what was decided, so the person doing it on the portal has
 *     a worked sheet instead of a screen of six hundred invoices. The screen says so.
 *   - The "pending" action is NOT available on every document type — credit notes in particular
 *     have had restrictions, and those restrictions have changed more than once.
 *     ** NOT VERIFIED against the current portal behaviour. `allowedActions` states what this
 *        author understands and marks it; the UI offers all three and records the choice. **
 *
 * Nothing here posts and nothing here claims a credit. It turns a reconciliation into a worklist.
 */

import type { Recon2bBucket, Recon2bPair } from './recon2b'

export type ImsAction = 'accept' | 'reject' | 'pending'

export const IMS_ACTIONS: ImsAction[] = ['accept', 'reject', 'pending']

export const IMS_ACTION_LABELS: Record<ImsAction, string> = {
  accept: 'Accept',
  reject: 'Reject',
  pending: 'Keep pending'
}

/**
 * What the reconciliation suggests, and why.
 *
 * Only ever a suggestion. Accepting an invoice is a claim to input credit and rejecting one tells
 * a supplier they billed you for something you did not buy; neither is a decision an offline
 * matching algorithm gets to make on a user's behalf.
 */
export interface ImsSuggestion {
  action: ImsAction
  /** The sentence shown under the suggestion. */
  reason: string
  /**
   * How much the suggestion is worth acting on unread.
   *
   * 'clear' — the two sides agree and there is nothing to think about.
   * 'check' — they disagree, or one side is missing. A person has to look.
   */
  confidence: 'clear' | 'check'
}

/**
 * The default action for a reconciliation bucket.
 *
 * The buckets that matter most are the two that look harmless. `missingInBooks` is a document the
 * supplier filed that the buyer never recorded — usually a bill that never arrived, occasionally
 * a supplier billing the wrong GSTIN, and deemed acceptance turns it into credit either way. And
 * `gstinMismatch` is credit claimed against the wrong registration, which is exactly the finding
 * IMS exists to surface.
 */
export function suggestAction(bucket: Recon2bBucket): ImsSuggestion {
  switch (bucket) {
    case 'matched':
      return { action: 'accept', reason: 'The portal and the books agree on value and tax.', confidence: 'clear' }
    case 'amountMismatch':
      return {
        action: 'pending',
        reason: 'The invoice value differs from the books. Settle it with the supplier before the credit is claimed.',
        confidence: 'check'
      }
    case 'taxMismatch':
      return {
        action: 'pending',
        reason: 'The tax heads differ from the books — often a place-of-supply disagreement rather than an error in either.',
        confidence: 'check'
      }
    case 'gstinMismatch':
      return {
        action: 'pending',
        reason:
          'The GSTIN on the purchase voucher is not the one the portal published. Accepting this claims the credit ' +
          'against the wrong registration.',
        confidence: 'check'
      }
    case 'missingInBooks':
      return {
        action: 'pending',
        reason:
          'Filed by the supplier and not recorded in the books. Left alone it is deemed accepted when 2B generates, ' +
          'so the credit is claimed for a bill nobody has.',
        confidence: 'check'
      }
    case 'missingInPortal':
      return {
        action: 'pending',
        reason:
          'In the books but not filed by the supplier — there is no IMS record to act on. Chase the supplier; the ' +
          'credit is not available until they file.',
        confidence: 'check'
      }
  }
}

/**
 * Actions the portal offers for a document.
 *
 * See the header: the restrictions on 'pending' have moved. This returns all three and the caller
 * shows the caveat, which is honest about what is known rather than silently removing an option
 * the portal may well offer.
 */
export function allowedActions(_pair: ImsRow): ImsAction[] {
  return IMS_ACTIONS
}

export interface ImsRow {
  /**
   * Stable identity of the document across months.
   *
   * Supplier GSTIN plus document number, both normalised. Not the voucher id: the row exists for
   * documents that have no voucher at all (`missingInBooks`), which is the bucket most in need of
   * an action.
   */
  key: string
  bucket: Recon2bBucket
  supplierGstin: string | null
  supplierName: string | null
  number: string
  date: string
  /** Portal value where there is one, else the book value. Paise. */
  value: number
  taxable: number
  igst: number
  cgst: number
  sgst: number
  cess: number
  /** Book voucher, when the document is in the books. */
  voucherId: number | null
  suggestion: ImsSuggestion
  /** What the user recorded, or null while undecided. */
  action: ImsAction | null
  actionNote: string | null
  actionAt: string | null
}

export interface ImsWorklist {
  period: string
  rows: ImsRow[]
  /** Rows with no recorded action. The number that matters — these are the deemed acceptances. */
  undecided: number
  counts: Record<ImsAction, number>
  /** Tax on rows suggested for anything other than 'accept'. What is at stake in the worklist. */
  atRisk: { igst: number; cgst: number; sgst: number; cess: number }
}

function normalise(s: string): string {
  return s.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/** Identity of an IMS document — see `ImsRow.key`. */
export function imsKey(supplierGstin: string | null, number: string): string {
  return `${(supplierGstin ?? 'NOGSTIN').toUpperCase()}|${normalise(number)}`
}

/**
 * Turn a 2B reconciliation into a worklist, folding in whatever was already decided.
 *
 * `decided` is keyed by `imsKey`, so a decision survives re-importing the 2B JSON: the user
 * downloads a fresh 2B, the reconciliation runs again, and the twelve invoices they already
 * worked through do not come back as undecided.
 */
export function buildWorklist(
  pairs: Recon2bPair[],
  period: string,
  decided: Map<string, { action: ImsAction; note: string | null; at: string }>
): ImsWorklist {
  const rows: ImsRow[] = []
  for (const p of pairs) {
    const gstin = p.portal?.gstin ?? p.book?.partyGstin ?? null
    const number = p.portal?.number ?? p.book?.supplierRef ?? p.book?.number ?? ''
    const key = imsKey(gstin, number)
    const prior = decided.get(key)
    rows.push({
      key,
      bucket: p.bucket,
      supplierGstin: gstin,
      supplierName: p.portal?.supplierName ?? p.book?.partyName ?? null,
      number,
      date: p.portal?.date ?? p.book?.date ?? '',
      value: p.portal?.value ?? p.book?.invoiceValue ?? 0,
      taxable: p.portal?.taxable ?? p.book?.taxable ?? 0,
      igst: p.portal?.igst ?? p.book?.igst ?? 0,
      cgst: p.portal?.cgst ?? p.book?.cgst ?? 0,
      sgst: p.portal?.sgst ?? p.book?.sgst ?? 0,
      cess: p.portal?.cess ?? p.book?.cess ?? 0,
      voucherId: p.book?.voucherId ?? null,
      suggestion: suggestAction(p.bucket),
      action: prior?.action ?? null,
      actionNote: prior?.note ?? null,
      actionAt: prior?.at ?? null
    })
  }

  const counts: Record<ImsAction, number> = { accept: 0, reject: 0, pending: 0 }
  const atRisk = { igst: 0, cgst: 0, sgst: 0, cess: 0 }
  let undecided = 0
  for (const r of rows) {
    if (r.action) counts[r.action] += 1
    else undecided += 1
    if (r.suggestion.action !== 'accept') {
      atRisk.igst += r.igst
      atRisk.cgst += r.cgst
      atRisk.sgst += r.sgst
      atRisk.cess += r.cess
    }
  }

  rows.sort((a, b) => {
    // Undecided first, then the ones a person has to think about, then by date. The point of the
    // list is the work still to do, and sorting by date puts that at the bottom.
    const aDone = a.action ? 1 : 0
    const bDone = b.action ? 1 : 0
    if (aDone !== bDone) return aDone - bDone
    const aCheck = a.suggestion.confidence === 'check' ? 0 : 1
    const bCheck = b.suggestion.confidence === 'check' ? 0 : 1
    if (aCheck !== bCheck) return aCheck - bCheck
    return a.date.localeCompare(b.date) || a.number.localeCompare(b.number)
  })

  return { period, rows, undecided, counts, atRisk }
}
