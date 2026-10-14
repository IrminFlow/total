// Make a bill (WP 9.2, plan 2026-10-13 §3 "Make a bill"): the PURE half of the simple Sell form —
// what the form's answers become as a `sale` intent (shared/simple/intents.ts), the live totals
// from the editor's own calculation (computeInvoice for item lines, computeGst + the rupee
// round-off for "just an amount" — exactly what mapIntent will post), the checks the form makes
// before it asks main, the plain preview line and the sales list's status.
//
// No arithmetic of its own on money: a GST-inclusive price is turned into the editor's exclusive
// rate + discount by pricing.ts `inclusiveLine` (an amount by `solveTaxable`), quantities are read
// by intents.ts `readQty`, totals come from computeInvoice / computeGst / roundToRupee.

import type { MessageKey, Translate } from '../i18n'
import { formatPaise, roundToRupee } from '../money'
import { toPlainDate } from '../dates'
import { addBreakups, computeGst, supplyTypeFor, type SupplyType } from '../gst/calc'
import { chargesGstOn, registrationOn, type GstRegistrationFacts, type GstRegistrationType } from '../gst/registration'
import { inclusiveLine, solveTaxable } from '../pricing'
import { computeInvoice, emptyInvoiceState, type InvoiceContext } from '../voucherEdit'
import { qtyText } from '../voucherEdit/payload'
import { readQty, type IntentFacts, type MoneyHow, type SimpleIntentInput } from './intents'

/** "Paid how?" — the five ways of the intent plus "Partly paid" (an amount now, the rest on credit). */
export const PAID_CHOICES = ['cash', 'upi', 'card', 'bank', 'credit', 'part'] as const
export type PaidChoice = (typeof PAID_CHOICES)[number]
export const PART_HOWS: readonly MoneyHow[] = ['cash', 'upi', 'card', 'bank']

/** The choices a bill offers: a walk-in ("Cash customer") pays in full, so On credit / Partly paid
 *  need a named customer. */
export function paidChoicesFor(walkIn: boolean): { value: PaidChoice; disabled: boolean }[] {
  return PAID_CHOICES.map((value) => ({ value, disabled: walkIn && (value === 'credit' || value === 'part') }))
}

export interface SellLine {
  key: number
  itemId: number | null
  /** As typed ("2", "2.5", "1,000"). */
  qtyText: string
  /** Per unit, paise, in the form's basis (GST-inclusive when `ratesIncludeGst`). */
  rate: number | null
  /** Off the line, paise, in the same basis. */
  discount: number | null
  /** UI state: the price still comes from the price list (typing one makes it the user's). */
  auto?: boolean
}

export interface SellForm {
  date: string
  /** null = the walk-in "Cash customer". */
  customerId: number | null
  mode: 'items' | 'amount'
  lines: SellLine[]
  /** "Just an amount", paise, in the form's basis. */
  amount: number | null
  /** GST % for "just an amount" (regular registration only). */
  gstRate: number | null
  ratesIncludeGst: boolean
  paid: PaidChoice
  /** Partly paid: how and how much now. */
  partHow: MoneyHow
  partAmount: number | null
  /** The cash / bank account the money goes into (null = the default for the way it was paid). */
  accountId: number | null
  /** "What for" — the bill's note. */
  note: string
}

export const emptySellForm = (date: string, opts: { mode: SellForm['mode']; ratesIncludeGst: boolean }): SellForm => ({
  date,
  customerId: null,
  mode: opts.mode,
  lines: [],
  amount: null,
  gstRate: null,
  ratesIncludeGst: opts.ratesIncludeGst,
  paid: 'cash',
  partHow: 'cash',
  partAmount: null,
  accountId: null,
  note: ''
})

/** What the calculation needs: the editor's invoice context (registration facts, company state,
 *  items' and ledgers' GST) and the customer's state (null = the company's — walk-in). */
export interface SellContext {
  invoice: Omit<InvoiceContext, 'kind'>
  /** The sales account the bill posts to (its GST rate is the editor's fallback for an item
   *  without one); null = not known yet. */
  salesAccountId: number | null
}

/** The bill's registration on its date (WP 8.0): only a regular one charges GST. */
export const billRegistration = (facts: GstRegistrationFacts, date: string): GstRegistrationType => registrationOn(facts, date)

/** The print title per WP 8.0 — Tax invoice (regular), Bill of supply (composition), Invoice. */
export function billTitleKey(facts: GstRegistrationFacts, date: string): MessageKey {
  const r = billRegistration(facts, date)
  return r === 'regular' ? 'simple.sell.title.tax' : r === 'composition' ? 'simple.sell.title.supply' : 'simple.sell.title.invoice'
}

/** Quantity thousandths, or null when the text isn't a quantity (intents.ts readQty). */
export function qtyMilliOf(text: string): number | null {
  if (!text.trim()) return null
  try {
    return readQty(text, 'qty')
  } catch {
    return null
  }
}

function supplyFor(form: SellForm, ctx: SellContext): SupplyType {
  const state = form.customerId != null ? ctx.invoice.ledgers.get(form.customerId)?.stateCode : null
  return supplyTypeFor(ctx.invoice.companyStateCode, state ?? ctx.invoice.companyStateCode)
}

/** The GST % an item line is charged at on the bill's date (computeInvoice's rule). */
function itemRate(ctx: SellContext, itemId: number, charges: boolean): { rate: number; cess: number } {
  if (!charges) return { rate: 0, cess: 0 }
  const item = ctx.invoice.items.get(itemId)
  const account = ctx.salesAccountId != null ? ctx.invoice.ledgers.get(ctx.salesAccountId) : undefined
  return { rate: item?.gstRate ?? account?.gstRate ?? 0, cess: item?.cessRate ?? 0 }
}

export interface ExclusiveLine {
  itemId: number
  qtyMilli: number
  /** The editor's tax-exclusive rate and discount (paise). */
  rate: number
  discount: number
}

/** The lines as the editor holds them (exclusive rate + discount); lines that are not complete yet
 *  (no item, quantity or price) are left out and listed in `incomplete`. */
export function exclusiveLines(form: SellForm, ctx: SellContext): { lines: ExclusiveLine[]; incomplete: number[] } {
  const charges = chargesGstOn(ctx.invoice, form.date)
  const supply = supplyFor(form, ctx)
  const lines: ExclusiveLine[] = []
  const incomplete: number[] = []
  form.lines.forEach((l, i) => {
    const qtyMilli = qtyMilliOf(l.qtyText)
    if (l.itemId == null || qtyMilli == null || l.rate == null) {
      if (l.itemId != null || l.qtyText.trim() || l.rate != null) incomplete.push(i)
      return
    }
    const { rate, cess } = itemRate(ctx, l.itemId, charges)
    if (form.ratesIncludeGst && charges && rate + cess > 0) {
      const x = inclusiveLine(l.rate, qtyMilli, l.discount ?? 0, rate, cess, supply)
      lines.push({ itemId: l.itemId, qtyMilli, rate: x.ratePaise, discount: x.discountPaise })
    } else {
      lines.push({ itemId: l.itemId, qtyMilli, rate: l.rate, discount: l.discount ?? 0 })
    }
  })
  return { lines, incomplete }
}

/** The GST % "just an amount" is charged at (0 when the bill's date doesn't charge GST). */
const amountRate = (form: SellForm, ctx: SellContext): number => {
  if (!chargesGstOn(ctx.invoice, form.date)) return 0
  const account = ctx.salesAccountId != null ? ctx.invoice.ledgers.get(ctx.salesAccountId) : undefined
  return form.gstRate ?? account?.gstRate ?? 0
}

/** "Just an amount" before GST (paise), from what was typed. */
function amountTaxable(form: SellForm, ctx: SellContext): number | null {
  if (form.amount == null || form.amount <= 0) return null
  const rate = amountRate(form, ctx)
  if (form.ratesIncludeGst && rate > 0) return solveTaxable(form.amount, rate, 0, supplyFor(form, ctx)).taxablePaise
  return form.amount
}

export interface SellTotals {
  /** Before GST. */
  taxable: number
  tax: number
  /** The bill, rounded to the rupee (what the customer pays). */
  total: number
  /** total − (taxable + tax): the rupee round-off (+ up, − down), shown as its own line. */
  rounding: number
  /** Each form line's value (null = not complete) in the basis its price is typed in: before GST,
   *  or WITH the line's GST when prices include GST (so qty × price − discount is what it shows). */
  lineAmounts: (number | null)[]
  charges: boolean
}

/** Live totals — the editor's own calculation, the same numbers simple:post will save. */
export function sellTotals(form: SellForm, ctx: SellContext): SellTotals {
  const charges = chargesGstOn(ctx.invoice, form.date)
  if (form.mode === 'amount') {
    const taxable = amountTaxable(form, ctx)
    if (taxable == null) return { taxable: 0, tax: 0, total: 0, rounding: 0, lineAmounts: [], charges }
    const gst = addBreakups([computeGst(taxable, amountRate(form, ctx), supplyFor(form, ctx))])
    const total = roundToRupee(gst.total)
    return { taxable: gst.taxable, tax: gst.total - gst.taxable, total, rounding: total - gst.total, lineAmounts: [], charges }
  }
  const { lines } = exclusiveLines(form, ctx)
  const c = computeInvoice(
    {
      ...emptyInvoiceState(form.date),
      partyId: form.customerId ?? -1,
      accountId: ctx.salesAccountId ?? -2,
      rows: lines.map((l) => ({ itemId: l.itemId, qtyText: qtyText(l.qtyMilli), rate: l.rate, discount: l.discount || null, godownId: null, batchId: null }))
    },
    { ...ctx.invoice, kind: 'sales' }
  )
  // Map each computed line back to its form line (incomplete lines are not in `lines`).
  const lineAmounts: (number | null)[] = form.lines.map(() => null)
  const withGst = form.ratesIncludeGst && charges
  let k = 0
  form.lines.forEach((l, i) => {
    if (l.itemId == null || qtyMilliOf(l.qtyText) == null || l.rate == null) return
    const d = c.detail[k]
    lineAmounts[i] = d == null ? null : withGst ? computeGst(d.amount, d.rate, c.supply, d.cessRate).total : d.amount
    k++
  })
  return { taxable: c.gst.taxable, tax: c.gst.total - c.gst.taxable, total: c.rounded, rounding: c.roundDiff, lineAmounts, charges }
}

/** The default cash / bank account for each way of being paid (main: WP 5.6 memory, else the
 *  counter's accounts / the first bank). */
export type MoneyDefaults = Record<MoneyHow, number | null>

/** The form's answers as the `sale` intent (without its clientId — useSimplePost adds it). */
export function saleIntentFrom(form: SellForm, ctx: SellContext, defaults: MoneyDefaults): Omit<Extract<SimpleIntentInput, { kind: 'sale' }>, 'clientId'> {
  const how: MoneyHow | null = form.paid === 'credit' ? null : form.paid === 'part' ? form.partHow : form.paid
  const accountId = how ? (form.accountId ?? defaults[how] ?? undefined) : undefined
  const payment =
    how == null
      ? { how: 'credit' as const }
      : { how, ...(form.paid === 'part' && form.partAmount != null ? { amount: form.partAmount } : {}), ...(accountId != null ? { accountId } : {}) }
  const base = {
    kind: 'sale' as const,
    date: form.date,
    ...(form.customerId != null ? { customerId: form.customerId } : {}),
    ...(form.note.trim() ? { narration: form.note.trim() } : {}),
    payment
  }
  if (form.mode === 'amount') {
    const taxable = amountTaxable(form, ctx) ?? 0
    const charges = chargesGstOn(ctx.invoice, form.date)
    return { ...base, amount: { amount: taxable, ...(charges ? { gstRate: amountRate(form, ctx) } : {}) } }
  }
  const { lines } = exclusiveLines(form, ctx)
  return { ...base, items: lines.map((l) => ({ itemId: l.itemId, qty: l.qtyMilli, rate: l.rate, ...(l.discount > 0 ? { discount: l.discount } : {}) })) }
}

export type SellField = 'date' | 'party' | 'items' | 'amount' | 'gstRate' | 'payment'

/** Checks before main is asked (each message under its question). `onHold` = the customer is on
 *  credit hold (no bill can be made for them here — the owner decides). */
export function sellFormErrors(form: SellForm, ctx: SellContext, opts: { onHold?: boolean; regular: boolean }): Partial<Record<SellField, MessageKey>> {
  const out: Partial<Record<SellField, MessageKey>> = {}
  if (opts.onHold) out.party = 'simple.sell.err.onHold'
  if (form.mode === 'items') {
    const { lines, incomplete } = exclusiveLines(form, ctx)
    const bad = incomplete.map((i) => form.lines[i]!)
    if (bad.some((l) => l.itemId == null)) out.items = 'simple.sell.err.pickProduct'
    else if (bad.some((l) => qtyMilliOf(l.qtyText) == null)) out.items = 'simple.sell.err.qty'
    else if (bad.some((l) => l.rate == null)) out.items = 'errors.intent.noPrice'
    else if (lines.length === 0) out.items = 'simple.sell.err.noItems'
  } else {
    if (form.amount == null || form.amount <= 0) out.amount = 'simple.sell.err.amount'
    if (opts.regular && chargesGstOn(ctx.invoice, form.date) && form.gstRate == null) out.gstRate = 'simple.sell.err.gstRate'
  }
  const walkIn = form.customerId == null
  if (walkIn && (form.paid === 'credit' || form.paid === 'part')) out.payment = 'errors.intent.walkInUnpaid'
  else if (form.paid === 'part') {
    const total = sellTotals(form, ctx).total
    if (form.partAmount == null || form.partAmount <= 0) out.payment = 'simple.sell.err.partAmount'
    else if (total > 0 && form.partAmount >= total) out.payment = 'simple.sell.err.partTooMuch'
  }
  return out
}

const money = (p: number): string => formatPaise(p, { symbol: true })

/** The plain line shown before Save — "Bill ₹1,180.00 to Ramesh. ₹500.00 by UPI now, ₹680.00 due
 *  by 20 Nov 2026." — from simple:preview's facts (computed by main, never typed). */
export function salePreviewLine(f: IntentFacts, t: Translate): string {
  const head = f.walkIn ? t('simple.sell.preview.walkIn', { amount: money(f.total) }) : t('simple.sell.preview.bill', { amount: money(f.total), name: f.partyName ?? '' })
  const how = f.how ?? 'cash'
  const due = f.dueDate ? toPlainDate(f.dueDate) : ''
  if (f.paid > 0 && f.due > 0) return `${head} ${t('simple.sell.preview.part', { paid: money(f.paid), how, due: money(f.due), date: due })}`
  if (f.paid > 0) return `${head} ${t('simple.sell.preview.paid', { amount: money(f.paid), how })}`
  if (f.due > 0) return `${head} ${t(due ? 'simple.sell.preview.dueBy' : 'simple.sell.preview.due', { amount: money(f.due), date: due })}`
  return head
}

/** A sales list row's status chip. */
export type SaleStatus = 'paid' | 'part' | 'due' | 'overdue'
export function saleStatus(total: number, due: number, overdueDays: number): SaleStatus {
  if (due <= 0) return 'paid'
  if (overdueDays > 0) return 'overdue'
  return due < total ? 'part' : 'due'
}

// ---------------------------------------------------------------- read shapes (services/simpleSell.ts)

export interface SellCustomer {
  id: number
  name: string
  stateCode: string | null
  phone: string | null
  creditHold: boolean
}

export interface SellSetup {
  /** The walk-in customer (created on the first walk-in sale; null until then). */
  walkInId: number | null
  customers: SellCustomer[]
  moneyAccounts: { id: number; name: string; kind: 'cash' | 'bank' }[]
  defaults: Record<MoneyHow, number | null>
  /** The WP 5.6 memory the UPI / card / bank default came from (cited in the form), if any. */
  memoryId: number | null
  /** The account a bill posts to by default ("Sales", or "Service income" for services). */
  salesAccountId: number | null
}

export interface SaleRow {
  voucherId: number
  number: string
  date: string
  partyId: number | null
  partyName: string
  walkIn: boolean
  total: number
  tax: number
  /** Total − what is still due on the bill (Outstandings allocation as on today). */
  paid: number
  due: number
  dueDate: string | null
  overdueDays: number
}

export interface SaleView {
  voucherId: number
  number: string
  date: string
  partyId: number | null
  partyName: string
  walkIn: boolean
  /** Item lines (stock bills) — as saved. */
  items: { name: string; qtyMilli: number; unit: string; ratePaise: number; discountPaise: number; amount: number }[]
  /** Ledger-line bills ("just an amount"): the income account lines. */
  amounts: { name: string; amount: number }[]
  note: string | null
  /** What the customer owes for the bill (its party amount — the rounded total). */
  total: number
  tax: number
  /** The rupee round-off on the bill (paise, + = rounded up, − = down; 0 = none). */
  rounding: number
  paid: number
  due: number
  dueDate: string | null
  overdueDays: number
}

/** A price-list rate (tax-exclusive, resolvePrice) as the form shows it: GST-inclusive per unit
 *  when prices are typed with GST (computeGst on one unit — the editor's calculation). */
export function shownRate(exclusiveRate: number, itemId: number, form: SellForm, ctx: SellContext): number {
  const charges = chargesGstOn(ctx.invoice, form.date)
  if (!form.ratesIncludeGst || !charges) return exclusiveRate
  const { rate, cess } = itemRate(ctx, itemId, charges)
  return rate + cess > 0 ? computeGst(exclusiveRate, rate, supplyFor(form, ctx), cess).total : exclusiveRate
}

/** The GST % an item line is shown with (null = the bill charges no GST). */
export function lineGstRate(itemId: number, form: SellForm, ctx: SellContext): number | null {
  const charges = chargesGstOn(ctx.invoice, form.date)
  return charges ? itemRate(ctx, itemId, charges).rate : null
}
