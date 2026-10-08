/**
 * GSTR-2B mismatch resolution (WP 5.5) — pure, on top of the WP 3.4 reconciliation
 * (recon2b.ts reconcile2b). The reconciliation pairs portal documents with the books for ONE
 * period; this module explains what is left over and why, in five categories:
 *
 *   missing_in_books  the supplier reported it (it is in 2B) but the books have nothing like it;
 *   missing_in_2b     the books have it but the supplier has not reported it (no ITC yet —
 *                     s.16(2)(aa), rule 36(4)); it may still come in a later month's 2B;
 *   amount_differs    found on both sides, but the value or a tax head differs beyond tolerance;
 *   period_differs    in this 2B, but the books have it in ANOTHER month (rule 60(7): a 2B holds
 *                     what suppliers furnished between two GSTR-1 due dates, whatever the date);
 *   gstin_differs     the same invoice number and amount, but under another GSTIN in the books
 *                     (a wrong or missing GSTIN on the supplier ledger).
 *
 * Each mismatch carries suggested ACTIONS. The ones that change the books are drafts only — the
 * plan of a purchase or a debit note (amounts in paise from the documents themselves, never
 * computed by the model); main turns a plan into an ai_drafts row the user reviews and saves.
 */
import {
  invoiceNumberCore, normalizeGstin, normalizeInvoiceNumber, toleranceFor,
  type PortalInvoice, type PurchaseDoc, type Recon2bOptions, type Recon2bResult
} from './recon2b'
import type { AssistantSourceId } from '../assistantSources'

export type MismatchCategory = 'missing_in_books' | 'missing_in_2b' | 'amount_differs' | 'period_differs' | 'gstin_differs'

export const MISMATCH_LABELS: Record<MismatchCategory, string> = {
  missing_in_books: 'Missing in books',
  missing_in_2b: 'Missing in 2B',
  amount_differs: 'Amount differs',
  period_differs: 'Period differs',
  gstin_differs: 'GSTIN differs'
}

export interface TaxSplit {
  taxable: number
  igst: number
  cgst: number
  sgst: number
  cess: number
}

/** What a draft would hold (paise). `kind` purchase: Dr purchase + taxes, Cr party; debit_note:
 *  Dr party, Cr purchase + taxes. */
export interface DraftPlan {
  kind: 'purchase' | 'debit_note'
  date: string
  partyLedgerId: number
  reference: string
  narration: string
  split: TaxSplit
}

export type MismatchAction =
  | { kind: 'draft'; label: string; plan: DraftPlan }
  | { kind: 'open_voucher'; label: string; voucherId: number }
  | { kind: 'open_ledger'; label: string; ledgerId: number }
  | { kind: 'create_ledger'; label: string; gstin: string }
  | { kind: 'follow_up'; label: string }

export interface Mismatch {
  key: string
  category: MismatchCategory
  portal: PortalInvoice | null
  book: PurchaseDoc | null
  /** Paise: portal − books (value), when both sides exist. */
  valueDiff: number | null
  taxDiff: TaxSplit | null
  /** The month the books have it in (period_differs). */
  bookMonth: string | null
  supplier: string | null
  ledgerId: number | null
  suggestion: string
  actions: MismatchAction[]
  sources: AssistantSourceId[]
  resolved: { status: 'resolved' | 'dismissed'; note: string | null; by: string | null; at: string } | null
}

export interface MismatchSummary {
  category: MismatchCategory
  label: string
  count: number
  /** Tax (IGST + CGST + SGST + cess) on the documents in the category, paise. */
  tax: number
}

export interface SupplierLedger {
  ledgerId: number
  name: string
  gstin: string | null
}

const taxOf = (t: { igst: number; cgst: number; sgst: number; cess: number }): number => t.igst + t.cgst + t.sgst + t.cess
const split = (t: TaxSplit): TaxSplit => ({ taxable: t.taxable, igst: t.igst, cgst: t.cgst, sgst: t.sgst, cess: t.cess })
const diff = (a: TaxSplit, b: TaxSplit): TaxSplit => ({ taxable: a.taxable - b.taxable, igst: a.igst - b.igst, cgst: a.cgst - b.cgst, sgst: a.sgst - b.sgst, cess: a.cess - b.cess })
const total = (t: TaxSplit): number => t.taxable + taxOf(t)
const nonNegative = (t: TaxSplit): boolean => t.taxable >= 0 && t.igst >= 0 && t.cgst >= 0 && t.sgst >= 0 && t.cess >= 0
const rupees = (paise: number): string => {
  const abs = Math.abs(paise)
  const r = String(Math.floor(abs / 100))
  const last3 = r.slice(-3)
  const rest = r.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')
  return `${paise < 0 ? '-' : ''}₹${rest ? `${rest},${last3}` : last3}.${String(abs % 100).padStart(2, '0')}`
}

/** The supplier ledger carrying this GSTIN, when exactly one does. */
export function supplierFor(gstin: string, ledgers: readonly SupplierLedger[]): SupplierLedger | null {
  const g = normalizeGstin(gstin)
  const hits = ledgers.filter((l) => l.gstin && normalizeGstin(l.gstin) === g)
  return hits.length === 1 ? hits[0]! : null
}

export function portalKey(p: PortalInvoice): string {
  return `${p.kind}:${normalizeGstin(p.gstin)}:${normalizeInvoiceNumber(p.number)}`
}

function missingInBooks(p: PortalInvoice, ledgers: readonly SupplierLedger[]): Mismatch {
  const sup = supplierFor(p.gstin, ledgers)
  const actions: MismatchAction[] = []
  if (p.kind === 'b2b') {
    if (sup) {
      actions.push({
        kind: 'draft',
        label: 'Draft the purchase',
        plan: { kind: 'purchase', date: p.date, partyLedgerId: sup.ledgerId, reference: p.number, narration: `As in GSTR-2B: ${p.number} dated ${p.date} from ${p.gstin}`, split: split(p) }
      })
    } else actions.push({ kind: 'create_ledger', label: 'Create the supplier ledger with this GSTIN first', gstin: p.gstin })
  } else {
    actions.push({ kind: 'follow_up', label: p.noteType === 'C' ? 'Record the supplier’s credit note (a debit note in the books)' : 'Record the supplier’s debit note as a purchase' })
  }
  return {
    key: `missing_in_books:${portalKey(p)}`,
    category: 'missing_in_books',
    portal: p,
    book: null,
    valueDiff: null,
    taxDiff: null,
    bookMonth: null,
    supplier: sup?.name ?? null,
    ledgerId: sup?.ledgerId ?? null,
    suggestion: p.kind === 'b2b'
      ? `The supplier reported invoice ${p.number} of ${rupees(p.value)} (tax ${rupees(taxOf(p))}). If the goods or services were received, record the purchase; if not, ask the supplier — it should not be claimed.`
      : `The supplier reported note ${p.number} of ${rupees(p.value)}; it is not in the books.`,
    actions,
    sources: ['s16_2aa', 'rule36_4'],
    resolved: null
  }
}

function missingIn2b(b: PurchaseDoc): Mismatch {
  return {
    key: `missing_in_2b:${b.voucherId}`,
    category: 'missing_in_2b',
    portal: null,
    book: b,
    valueDiff: null,
    taxDiff: null,
    bookMonth: b.date.slice(0, 7),
    supplier: b.partyName,
    ledgerId: b.partyLedgerId ?? null,
    suggestion: `${b.partyName ?? 'The supplier'} has not reported ${b.supplierRef ?? b.number} (${rupees(b.invoiceValue)}, tax ${rupees(taxOf(b))}). Its ITC is not available until it appears in a GSTR-2B — follow up the supplier; it may still come in a later month’s 2B.`,
    actions: [
      { kind: 'follow_up', label: 'Ask the supplier to report it in GSTR-1' },
      { kind: 'open_voucher', label: 'Open the purchase', voucherId: b.voucherId }
    ],
    sources: ['s16_2aa', 'rule36_4', 'rule60_7'],
    resolved: null
  }
}

function amountDiffers(p: PortalInvoice, b: PurchaseDoc): Mismatch {
  const d = diff(split(b), split(p)) // books − portal
  const actions: MismatchAction[] = [{ kind: 'open_voucher', label: 'Open the purchase to correct it', voucherId: b.voucherId }]
  if (b.partyLedgerId && p.kind === 'b2b' && nonNegative(d) && total(d) > 0) {
    actions.push({
      kind: 'draft',
      label: 'Draft a debit note for the excess',
      plan: { kind: 'debit_note', date: b.date, partyLedgerId: b.partyLedgerId, reference: b.supplierRef ?? b.number, narration: `Excess over GSTR-2B on ${b.supplierRef ?? b.number}`, split: d }
    })
  }
  const taxGap = taxOf(b) - taxOf(p)
  return {
    key: `amount_differs:${b.voucherId}`,
    category: 'amount_differs',
    portal: p,
    book: b,
    valueDiff: p.value - b.invoiceValue,
    taxDiff: diff(split(p), split(b)),
    bookMonth: b.date.slice(0, 7),
    supplier: b.partyName,
    ledgerId: b.partyLedgerId ?? null,
    suggestion:
      taxGap > 0
        ? `The books carry ${rupees(taxGap)} more tax than the supplier reported (books ${rupees(taxOf(b))}, 2B ${rupees(taxOf(p))}). Only what is in 2B can be claimed: correct the entry if it is wrong, or raise a debit note for the excess.`
        : taxGap < 0
          ? `The supplier reported ${rupees(-taxGap)} more tax than the books (2B ${rupees(taxOf(p))}, books ${rupees(taxOf(b))}). Check the bill: correct the entry, or ask the supplier to amend their return.`
          : `The values differ (2B ${rupees(p.value)}, books ${rupees(b.invoiceValue)}) though the tax agrees — check the bill.`,
    actions,
    sources: ['s16_2aa', 'rule36_4'],
    resolved: null
  }
}

/**
 * Categorise a reconciliation. `otherBooks` are purchase documents OUTSIDE the period (the months
 * around it) — used to tell "period differs" from "missing in books".
 */
export function categoriseMismatches(
  result: Recon2bResult,
  otherBooks: readonly PurchaseDoc[],
  ledgers: readonly SupplierLedger[],
  opts: Pick<Recon2bOptions, 'amountTolerancePaise' | 'amountTolerancePct'>
): Mismatch[] {
  const tol = (amt: number): number => toleranceFor(amt, opts.amountTolerancePaise, opts.amountTolerancePct ?? 0)
  const out: Mismatch[] = []
  const portalLeft: PortalInvoice[] = []
  const booksLeft: PurchaseDoc[] = []
  for (const pair of result.pairs) {
    if (pair.bucket === 'missingInBooks' && pair.portal) portalLeft.push(pair.portal)
    else if (pair.bucket === 'missingInPortal' && pair.book) booksLeft.push(pair.book)
    else if ((pair.bucket === 'amountMismatch' || pair.bucket === 'taxMismatch') && pair.portal && pair.book) out.push(amountDiffers(pair.portal, pair.book))
  }
  const kindOk = (p: PortalInvoice, b: PurchaseDoc): boolean => (p.kind === 'b2b' ? b.kind === 'purchase' : b.kind === 'debit_note')
  const sameNo = (p: PortalInvoice, b: PurchaseDoc): boolean => invoiceNumberCore(p.number) === invoiceNumberCore(b.supplierRef ?? b.number)

  // GSTIN differs: an unmatched book document of the period with the same number and value
  // under another (or no) GSTIN.
  const usedBooks = new Set<PurchaseDoc>()
  const stillPortal: PortalInvoice[] = []
  for (const p of portalLeft) {
    const b = booksLeft.find((x) => !usedBooks.has(x) && kindOk(p, x) && sameNo(p, x) && normalizeGstin(x.partyGstin) !== normalizeGstin(p.gstin) && Math.abs(p.value - x.invoiceValue) <= tol(p.value))
    if (!b) {
      stillPortal.push(p)
      continue
    }
    usedBooks.add(b)
    const actions: MismatchAction[] = [{ kind: 'open_voucher', label: 'Open the purchase', voucherId: b.voucherId }]
    if (b.partyLedgerId) actions.unshift({ kind: 'open_ledger', label: b.partyGstin ? 'Correct the supplier’s GSTIN' : 'Add the supplier’s GSTIN', ledgerId: b.partyLedgerId })
    out.push({
      key: `gstin_differs:${b.voucherId}`,
      category: 'gstin_differs',
      portal: p,
      book: b,
      valueDiff: p.value - b.invoiceValue,
      taxDiff: diff(split(p), split(b)),
      bookMonth: b.date.slice(0, 7),
      supplier: b.partyName,
      ledgerId: b.partyLedgerId ?? null,
      suggestion: `2B has ${p.number} under GSTIN ${p.gstin}; the books have it under ${b.partyGstin ? `GSTIN ${b.partyGstin}` : 'a ledger with no GSTIN'} (${b.partyName ?? 'no party'}). Fix the supplier ledger — or, if it really is another supplier, the supplier must amend their return.`,
      actions,
      sources: ['s16_2aa'],
      resolved: null
    })
  }

  // Period differs: the same supplier + number in the books, in another month.
  const usedOther = new Set<PurchaseDoc>()
  for (const p of stillPortal) {
    const b = otherBooks.find((x) => !usedOther.has(x) && kindOk(p, x) && normalizeGstin(x.partyGstin) === normalizeGstin(p.gstin) && sameNo(p, x))
    if (!b) {
      out.push(missingInBooks(p, ledgers))
      continue
    }
    usedOther.add(b)
    const amountsAgree = Math.abs(p.value - b.invoiceValue) <= tol(p.value)
    out.push({
      key: `period_differs:${portalKey(p)}`,
      category: 'period_differs',
      portal: p,
      book: b,
      valueDiff: p.value - b.invoiceValue,
      taxDiff: diff(split(p), split(b)),
      bookMonth: b.date.slice(0, 7),
      supplier: b.partyName,
      ledgerId: b.partyLedgerId ?? null,
      suggestion: `The books have ${p.number} on ${b.date} (${b.date.slice(0, 7)}); the supplier reported it in this 2B. Credit is available when it appears in 2B, so nothing needs posting${amountsAgree ? '' : ' — but the amounts differ too, check the bill'}; correct the voucher date only if it was entered wrongly.`,
      actions: [{ kind: 'open_voucher', label: 'Open the purchase', voucherId: b.voucherId }],
      sources: ['rule60_7', 'rule36_4'],
      resolved: null
    })
  }

  for (const b of booksLeft) if (!usedBooks.has(b)) out.push(missingIn2b(b))
  const order: Record<MismatchCategory, number> = { missing_in_books: 0, amount_differs: 1, gstin_differs: 2, period_differs: 3, missing_in_2b: 4 }
  return out.sort((a, b) => order[a.category] - order[b.category] || (a.portal?.date ?? a.book?.date ?? '').localeCompare(b.portal?.date ?? b.book?.date ?? '') || a.key.localeCompare(b.key))
}

export function summariseMismatches(list: readonly Mismatch[]): MismatchSummary[] {
  return (Object.keys(MISMATCH_LABELS) as MismatchCategory[]).map((category) => {
    const rows = list.filter((m) => m.category === category)
    return { category, label: MISMATCH_LABELS[category], count: rows.length, tax: rows.reduce((s, m) => s + taxOf((m.portal ?? m.book)!), 0) }
  })
}

/** The voucher lines of a draft plan (paise; zero lines dropped). Returns null when the plan
 *  needs a tax ledger the company does not have. */
export function planLines(
  plan: DraftPlan,
  ledgers: { purchase: number; igst: number | null; cgst: number | null; sgst: number | null; cess: number | null }
): { ledgerId: number; drCr: 'dr' | 'cr'; amount: number }[] | { missing: string[] } {
  const side: 'dr' | 'cr' = plan.kind === 'purchase' ? 'dr' : 'cr'
  const other: 'dr' | 'cr' = side === 'dr' ? 'cr' : 'dr'
  const missing: string[] = []
  const lines: { ledgerId: number; drCr: 'dr' | 'cr'; amount: number }[] = []
  if (plan.split.taxable > 0) lines.push({ ledgerId: ledgers.purchase, drCr: side, amount: plan.split.taxable })
  for (const head of ['igst', 'cgst', 'sgst', 'cess'] as const) {
    const amt = plan.split[head]
    if (amt <= 0) continue
    const id = ledgers[head]
    if (id == null) missing.push(head.toUpperCase())
    else lines.push({ ledgerId: id, drCr: side, amount: amt })
  }
  if (missing.length) return { missing }
  const t = lines.reduce((s, l) => s + l.amount, 0)
  lines.push({ ledgerId: plan.partyLedgerId, drCr: other, amount: t })
  return lines
}
