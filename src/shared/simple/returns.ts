// Returns (WP 9.5, plan 2026-10-13 §3 "Sale / purchase return"): the PURE half of the simple
// "Return a sale" / "Return a purchase" screens — what the form's answers become as a
// `return_sale` / `return_purchase` intent (shared/simple/intents.ts), the live totals from the
// editor's own calculation (computeInvoice over the very rows mapReturn builds — `returnRow`; for
// a bill without item lines computeGst + the rupee round-off, as `ledgerLines`), the split of the
// return between the bill and the party's credit, and the checks the form makes before asking main.
//
// No money arithmetic of its own: the rows are intents.ts `returnRow`, quantities intents.ts
// `readQty`, totals computeInvoice / computeGst / roundToRupee.

import type { MessageKey, Translate } from '../i18n'
import { roundToRupee } from '../money'
import { addBreakups, computeGst, supplyTypeFor } from '../gst/calc'
import { chargesGstOn } from '../gst/registration'
import { computeInvoice, emptyInvoiceState, type InvoiceContext } from '../voucherEdit'
import { intentSentences, readQty, returnRow, returnTaxedOriginal, type IntentFacts, type IntentOriginalLine, type MoneyHow, type SimpleIntentInput } from './intents'

/** Which side a return screen is for. */
export type ReturnSide = 'sale' | 'purchase'

/** One bill in the "Which bill?" list. */
export interface ReturnBillRow {
  voucherId: number
  number: string
  /** Purchases: the supplier's bill number (null = none typed). */
  billNo: string | null
  date: string
  partyId: number | null
  partyName: string
  walkIn: boolean
  /** The bill as the party sees it (billAmount). */
  total: number
  /** Item lines, or "just an amount". */
  mode: 'items' | 'amount'
  /** Earlier returns against it (in the books): how many, and their total. */
  returns: number
  returned: number
  /** What is still returnable: everything, part of it, nothing. */
  left: 'all' | 'part' | 'none'
}

/** A line of the bill with what is still returnable. */
export interface ReturnBillLine extends IntentOriginalLine {
  name: string
  unit: string
  /** The line's value on the bill (before GST). */
  amount: number
}

/** The bill a return is being made against (simple:returns:bill — loadOriginal + names). */
export interface ReturnBill {
  voucherId: number
  side: ReturnSide
  number: string
  billNo: string | null
  date: string
  partyId: number
  partyName: string
  partyStateCode: string | null
  walkIn: boolean
  total: number
  tax: number
  /** Its bill-wise name and what is still pending on it, as on the asked date. */
  billName: string
  pending: number
  carriesGst: boolean
  /** The GST rates as the bill posted them (null = can't be told: a rate changed since). */
  rates: number[] | null
  /** The sales / purchase account it posts to (null = more than one). */
  accountId: number | null
  mode: 'items' | 'amount'
  lines: ReturnBillLine[]
  /** A bill without item lines: its value before GST, and what is still returnable of it. */
  amountTaxable: number
  amountLeft: number | null
  /** Earlier returns against it. */
  earlier: { voucherId: number; number: string; date: string; total: number }[]
}

export interface ReturnForm {
  /** The return's own date (9.1 checks THIS date — the bill's may be in a closed year). */
  date: string
  /** Per bill line (lineUid): the quantity coming back, as typed. */
  qty: Record<string, string>
  /** A bill without item lines: the value before GST coming back (paise). */
  amount: number | null
  /** Asked only when 9.1 would ask (a bill with several GST rates). */
  gstRate: number | null
  reason: string
  /** What happens to the part that doesn't come off the bill. */
  settle: 'refund' | 'credit'
  how: MoneyHow
  /** The cash / bank account (null = the default for `how`). */
  accountId: number | null
}

export const emptyReturnForm = (date: string, opts: { walkIn?: boolean } = {}): ReturnForm => ({
  date, qty: {}, amount: null, gstRate: null, reason: '', settle: opts.walkIn ? 'refund' : 'credit', how: 'cash', accountId: null
})

/** What the calculation needs: the editor's invoice context (registration facts, company state,
 *  items' and ledgers' GST). */
export interface ReturnContext {
  invoice: Omit<InvoiceContext, 'kind'>
}

const noteKind = (side: ReturnSide): 'credit_note' | 'debit_note' => (side === 'sale' ? 'credit_note' : 'debit_note')

/** Quantity thousandths, or null when the text isn't a quantity (intents.ts readQty); '' / '0' = 0. */
export function returnQtyOf(text: string | undefined): number | null {
  const s = (text ?? '').trim()
  if (s === '' || /^0+(\.0*)?$/.test(s)) return 0
  try {
    return readQty(s, 'qty')
  } catch {
    return null
  }
}

/** Does the return's date charge GST (its own date, or a GST-charging original — s.34)? */
export function returnCharges(form: ReturnForm, bill: ReturnBill, ctx: ReturnContext): boolean {
  return chargesGstOn(ctx.invoice, form.date) || returnTaxedOriginal(ctx.invoice, form.date, bill)
}

/** 9.1 asks the GST rate of "just an amount" coming back only when the bill carries GST at more
 *  than one rate (or one that can't be told); an item bill whose rates changed since is refused. */
export function returnAsks(form: ReturnForm, bill: ReturnBill, ctx: ReturnContext): { rate: boolean; blocked: boolean } {
  const charges = returnCharges(form, bill, ctx)
  if (!charges || !bill.carriesGst) return { rate: false, blocked: false }
  if (bill.mode === 'items') return { rate: false, blocked: bill.rates == null }
  return { rate: bill.rates == null || bill.rates.length !== 1, blocked: false }
}

export interface ReturnTotals {
  taxable: number
  tax: number
  /** The return, rounded to the rupee (what the note is for). */
  total: number
  rounding: number
  /** Per bill line (lineUid): the value coming back before GST (null = nothing / not a quantity). */
  lineAmounts: Record<string, number | null>
  charges: boolean
}

/** Live totals — the editor's own calculation over the rows mapReturn will post. */
export function returnTotals(form: ReturnForm, bill: ReturnBill, ctx: ReturnContext): ReturnTotals {
  const charges = returnCharges(form, bill, ctx)
  const lineAmounts: Record<string, number | null> = {}
  if (bill.mode === 'amount') {
    if (form.amount == null || form.amount <= 0) return { taxable: 0, tax: 0, total: 0, rounding: 0, lineAmounts, charges }
    // The rate the intent will carry when 9.1 asks, else the bill's own (mapReturn's choice).
    const rate = !charges ? 0 : returnAsks(form, bill, ctx).rate ? (form.gstRate ?? 0) : bill.carriesGst && bill.rates?.length === 1 ? bill.rates[0]! : 0
    const supply = supplyTypeFor(ctx.invoice.companyStateCode, bill.partyStateCode ?? ctx.invoice.companyStateCode)
    const gst = addBreakups([computeGst(form.amount, rate, supply)])
    const total = roundToRupee(gst.total)
    return { taxable: gst.taxable, tax: gst.total - gst.taxable, total, rounding: total - gst.total, lineAmounts, charges }
  }
  const picked = bill.lines.flatMap((l) => {
    const q = returnQtyOf(form.qty[l.lineUid])
    return q != null && q > 0 ? [{ line: l, q }] : []
  })
  const taxedOriginal = returnTaxedOriginal(ctx.invoice, form.date, bill)
  const c = computeInvoice(
    {
      ...emptyInvoiceState(form.date),
      partyId: bill.partyId,
      accountId: bill.accountId,
      rows: picked.map((p) => returnRow(p.line, p.q)),
      ...(taxedOriginal ? { taxedOriginal: true } : {})
    },
    { ...ctx.invoice, kind: noteKind(bill.side) }
  )
  for (const l of bill.lines) lineAmounts[l.lineUid] = null
  picked.forEach((p, i) => (lineAmounts[p.line.lineUid] = c.detail[i]?.amount ?? null))
  return { taxable: c.gst.taxable, tax: c.gst.total - c.gst.taxable, total: picked.length ? c.rounded : 0, rounding: picked.length ? c.roundDiff : 0, lineAmounts, charges }
}

/** How a return of `total` settles (mapReturn's rule): what is still pending comes off the bill,
 *  the rest is the party's credit — refunded now, or kept. */
export function returnSplit(total: number, pending: number): { offBill: number; credit: number } {
  const offBill = Math.min(Math.max(pending, 0), total)
  return { offBill, credit: total - offBill }
}

export type ReturnField = 'date' | 'items' | 'amount' | 'gstRate' | 'refund'

/** Checks before main is asked (each message under its question). */
export function returnFormErrors(form: ReturnForm, bill: ReturnBill, ctx: ReturnContext, opts: { refundAccount?: boolean } = {}): Partial<Record<ReturnField, MessageKey>> {
  const out: Partial<Record<ReturnField, MessageKey>> = {}
  const asks = returnAsks(form, bill, ctx)
  if (form.date < bill.date) out.date = 'simple.returns.err.beforeBill'
  if (bill.mode === 'items') {
    if (asks.blocked) out.items = 'simple.returns.err.ratesChanged'
    else {
      const qs = bill.lines.map((l) => ({ l, q: returnQtyOf(form.qty[l.lineUid]) }))
      if (qs.some((x) => x.q == null)) out.items = 'simple.returns.err.qty'
      else if (qs.some((x) => x.q! > x.l.leftMilli)) out.items = 'simple.returns.err.tooMany'
      else if (!qs.some((x) => x.q! > 0)) out.items = 'simple.returns.err.nothing'
    }
  } else {
    if (form.amount == null || form.amount <= 0) out.amount = 'simple.returns.err.amount'
    else if (bill.amountLeft != null && form.amount > bill.amountLeft) out.amount = 'simple.returns.err.amountTooMuch'
    if (asks.rate && form.gstRate == null) out.gstRate = 'simple.returns.err.gstRate'
  }
  if (!out.items && !out.amount && form.settle === 'refund' && returnSplit(returnTotals(form, bill, ctx).total, bill.pending).credit > 0 && opts.refundAccount === false) {
    out.refund = 'simple.returns.err.noAccount'
  }
  return out
}

/** The default cash / bank account for each way of paying (the Sell screens' defaults). */
export type RefundDefaults = Record<MoneyHow, number | null>

/** The form's answers as the intent (without its clientId — useSimplePost adds it). The refund is
 *  sent only when the return creates a credit (what is still pending simply comes off the bill). */
export function returnIntentFrom(form: ReturnForm, bill: ReturnBill, ctx: ReturnContext, defaults: RefundDefaults): Omit<Extract<SimpleIntentInput, { kind: 'return_sale' }>, 'clientId'> | Omit<Extract<SimpleIntentInput, { kind: 'return_purchase' }>, 'clientId'> {
  const kind = bill.side === 'sale' ? ('return_sale' as const) : ('return_purchase' as const)
  const { credit } = returnSplit(returnTotals(form, bill, ctx).total, bill.pending)
  const accountId = form.accountId ?? defaults[form.how] ?? undefined
  const refund = form.settle === 'refund' && credit > 0 ? { refund: { how: form.how, ...(accountId != null ? { accountId } : {}) } } : {}
  const base = { kind, date: form.date, billId: bill.voucherId, ...(form.reason.trim() ? { narration: form.reason.trim() } : {}), ...refund }
  if (bill.mode === 'amount') {
    return { ...base, amount: { amount: form.amount ?? 0, ...(returnAsks(form, bill, ctx).rate && form.gstRate != null ? { gstRate: form.gstRate } : {}) } }
  }
  const items = bill.lines.flatMap((l) => {
    const q = returnQtyOf(form.qty[l.lineUid])
    return q != null && q > 0 ? [{ lineUid: l.lineUid, qty: q }] : []
  })
  return { ...base, items }
}

/** The plain sentences before Save, from simple:preview's facts (computed by main): intents.ts
 *  intentSentences, with a walk-in said as "a cash customer" (no balance for the counter's party). */
export function returnPreviewLines(f: IntentFacts, t: Translate, opts: { walkIn: boolean }): string[] {
  return intentSentences(opts.walkIn ? { ...f, walkIn: true, partyName: t('simple.returns.cashCustomer') } : f, t)
}

/** The list's "can still be returned" chip. */
export const LEFT_TEXT: Record<ReturnBillRow['left'], MessageKey> = {
  all: 'simple.returns.left.all',
  part: 'simple.returns.left.part',
  none: 'simple.returns.left.none'
}
