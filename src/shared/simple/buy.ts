// Record a purchase (WP 9.3, plan 2026-10-13 §3 "Record a purchase"): the PURE half of the simple
// Buy form — what the form's answers become as a `purchase` intent (shared/simple/intents.ts), the
// live totals from the editor's own calculation (computeInvoice for product lines, computeGst + the
// rupee round-off for an expense / "just an amount" — exactly what mapIntent will post), the checks
// the form makes before it asks main, the plain preview line and the purchase list's status.
//
// GST on a purchase, by the registration on the BILL's date (WP 8.0):
// - regular: "Does the bill show GST?" — yes = input-tax lines at the products' rates (or the rate
//   picked for an amount), no = none (an amount only: the purchase editor's product lines always
//   carry their GST, so a product bill without GST is refused — `simple_items_no_gst`);
// - composition / unregistered (can't claim): the GST is part of the cost. Prices typed WITH GST
//   (what was paid) are the cost as they are (`gstOnBill: false`, the editor's GST-inclusive
//   rates); prices typed BEFORE GST get the bill's GST folded in by intents.ts `foldGstIntoLine` /
//   `foldGstIntoAmount` (capture's nonClaimableCosts) — the same function main posts with.
//
// No arithmetic of its own on money: a GST-inclusive price becomes the editor's exclusive rate +
// discount by pricing.ts `inclusiveLine` (an amount by `solveTaxable`), quantities are read by
// intents.ts `readQty`, totals come from computeInvoice / computeGst / roundToRupee.

import type { MessageKey, Translate } from '../i18n'
import { formatPaise, roundToRupee } from '../money'
import { toPlainDate } from '../dates'
import { addBreakups, computeGst, supplyTypeFor, type SupplyType } from '../gst/calc'
import { chargesGstOn } from '../gst/registration'
import { inclusiveLine, solveTaxable } from '../pricing'
import { computeInvoice, emptyInvoiceState, type InvoiceContext } from '../voucherEdit'
import { qtyText } from '../voucherEdit/payload'
import { foldGstIntoAmount, foldGstIntoLine, readQty, type IntentFacts, type MoneyHow, type SimpleIntentInput } from './intents'

/** "Paid now?" — Cash / UPI / Card / Bank transfer / Not yet (`credit`) / Partly. */
export const BUY_PAID_CHOICES = ['cash', 'upi', 'card', 'bank', 'credit', 'part'] as const
export type BuyPaidChoice = (typeof BUY_PAID_CHOICES)[number]
export const BUY_PART_HOWS: readonly MoneyHow[] = ['cash', 'upi', 'card', 'bank']

/** What was bought: products (stock on), an expense (a category), or just an amount (goods
 *  without products — the Purchases account). */
export const BUY_MODES = ['items', 'expense', 'amount'] as const
export type BuyMode = (typeof BUY_MODES)[number]

export interface BuyLine {
  key: number
  itemId: number | null
  /** As typed ("2", "2.5", "1,000"). */
  qtyText: string
  /** Per unit, paise, in the form's basis (with GST when `ratesIncludeGst`). */
  rate: number | null
  /** Off the line, paise, same basis. */
  discount: number | null
}

export interface BuyForm {
  /** The bill's date (the purchase is dated the bill date). */
  date: string
  supplierId: number | null
  /** The supplier's bill number as printed ('' = none). */
  billNo: string
  mode: BuyMode
  lines: BuyLine[]
  /** Expense / just an amount, paise, in the form's basis. */
  amount: number | null
  /** Expense: the category's account. */
  categoryId: number | null
  /** GST % of an expense / amount (asked when the bill's GST is added on top). */
  gstRate: number | null
  /** "Does the bill show GST?" — asked only for a regular registration on the bill's date. */
  gstOnBill: boolean
  /** Prices / the amount typed with GST (true) or before GST. */
  ratesIncludeGst: boolean
  paid: BuyPaidChoice
  partHow: MoneyHow
  partAmount: number | null
  /** The cash / bank account the money came from (null = the default for the way it was paid). */
  accountId: number | null
  note: string
}

export const emptyBuyForm = (date: string, opts: { mode: BuyMode; ratesIncludeGst: boolean }): BuyForm => ({
  date,
  supplierId: null,
  billNo: '',
  mode: opts.mode,
  lines: [],
  amount: null,
  categoryId: null,
  gstRate: null,
  gstOnBill: true,
  ratesIncludeGst: opts.ratesIncludeGst,
  paid: 'credit',
  partHow: 'cash',
  partAmount: null,
  accountId: null,
  note: ''
})

/** What the calculation needs: the editor's invoice context and the default purchase account. */
export interface BuyContext {
  invoice: Omit<InvoiceContext, 'kind'>
  /** "Purchases" (its category, else the first purchase account) — the account a product /
   *  amount bill posts to; null = none yet. */
  purchaseAccountId: number | null
}

/** How the bill's GST is booked on its date. */
export type BuyGst =
  /** Regular, the bill shows GST: input-tax lines (what GSTR-3B counts as claimable). */
  | 'claim'
  /** Regular, no GST on the bill. */
  | 'none'
  /** Can't claim, prices typed with GST: what was paid is the cost. */
  | 'paid'
  /** Can't claim, prices typed before GST: the GST is folded into the cost. */
  | 'fold'

export function buyGst(form: Pick<BuyForm, 'date' | 'gstOnBill' | 'ratesIncludeGst'>, ctx: BuyContext): BuyGst {
  if (chargesGstOn(ctx.invoice, form.date)) return form.gstOnBill ? 'claim' : 'none'
  return form.ratesIncludeGst ? 'paid' : 'fold'
}

/** Is the "with GST / before GST" choice meaningful? (claim: yes; can't claim: yes — the folded
 *  GST needs the before-GST price; a bill without GST: no.) */
export const showsPriceBasis = (g: BuyGst): boolean => g !== 'none'

/** Quantity thousandths, or null when the text isn't a quantity (intents.ts readQty). */
export function buyQtyMilli(text: string): number | null {
  if (!text.trim()) return null
  try {
    return readQty(text, 'qty')
  } catch {
    return null
  }
}

function supplyFor(form: BuyForm, ctx: BuyContext): SupplyType {
  const state = form.supplierId != null ? ctx.invoice.ledgers.get(form.supplierId)?.stateCode : null
  return supplyTypeFor(ctx.invoice.companyStateCode, state ?? ctx.invoice.companyStateCode)
}

/** The rate an item line is taxed at on a claimed bill (computeInvoice's rule). */
function claimRate(ctx: BuyContext, itemId: number): { rate: number; cess: number } {
  const item = ctx.invoice.items.get(itemId)
  const account = ctx.purchaseAccountId != null ? ctx.invoice.ledgers.get(ctx.purchaseAccountId) : undefined
  return { rate: item?.gstRate ?? account?.gstRate ?? 0, cess: item?.cessRate ?? 0 }
}

/** The GST % a product line shows (null = none applies): the claimed rate, or — when it is folded
 *  into the cost — the product's own rate (what mapIntent folds at). */
export function buyLineGstRate(itemId: number, form: BuyForm, ctx: BuyContext): number | null {
  const g = buyGst(form, ctx)
  if (g === 'claim') return claimRate(ctx, itemId).rate
  if (g === 'fold') {
    const r = ctx.invoice.items.get(itemId)?.gstRate ?? null
    return r != null && r > 0 ? r : null
  }
  return null
}

export interface BuyExclusiveLine {
  itemId: number
  qtyMilli: number
  /** What the intent sends: the editor's tax-exclusive rate + discount on a claimed bill, the
   *  typed price otherwise (main folds it when `fold`). */
  rate: number
  discount: number
}

/** The complete lines as the intent sends them; incomplete ones listed in `incomplete`. */
export function buyIntentLines(form: BuyForm, ctx: BuyContext): { lines: BuyExclusiveLine[]; incomplete: number[] } {
  const g = buyGst(form, ctx)
  const supply = supplyFor(form, ctx)
  const lines: BuyExclusiveLine[] = []
  const incomplete: number[] = []
  form.lines.forEach((l, i) => {
    const qtyMilli = buyQtyMilli(l.qtyText)
    if (l.itemId == null || qtyMilli == null || l.rate == null) {
      if (l.itemId != null || l.qtyText.trim() || l.rate != null) incomplete.push(i)
      return
    }
    if (g === 'claim' && form.ratesIncludeGst) {
      const { rate, cess } = claimRate(ctx, l.itemId)
      if (rate + cess > 0) {
        const x = inclusiveLine(l.rate, qtyMilli, l.discount ?? 0, rate, cess, supply)
        lines.push({ itemId: l.itemId, qtyMilli, rate: x.ratePaise, discount: x.discountPaise })
        return
      }
    }
    lines.push({ itemId: l.itemId, qtyMilli, rate: l.rate, discount: l.discount ?? 0 })
  })
  return { lines, incomplete }
}

/** The account an expense / amount bill posts to. */
const amountAccountId = (form: BuyForm, ctx: BuyContext): number | null => (form.mode === 'expense' ? form.categoryId : ctx.purchaseAccountId)

/** The GST % of an expense / amount: picked, else the account's own (mapIntent's rule). */
function amountRate(form: BuyForm, ctx: BuyContext): number | null {
  const id = amountAccountId(form, ctx)
  const account = id != null ? ctx.invoice.ledgers.get(id) : undefined
  return form.gstRate ?? account?.gstRate ?? null
}

/** Does the expense / amount need its GST rate asked? (claimed, or folded before GST.) */
export const asksAmountRate = (form: BuyForm, ctx: BuyContext): boolean => {
  const g = buyGst(form, ctx)
  return form.mode !== 'items' && (g === 'claim' || g === 'fold')
}

/** The expense / amount as the intent sends it: before GST on a claimed bill. */
function amountTaxable(form: BuyForm, ctx: BuyContext): number | null {
  if (form.amount == null || form.amount <= 0) return null
  const g = buyGst(form, ctx)
  const rate = amountRate(form, ctx) ?? 0
  if (g === 'claim' && form.ratesIncludeGst && rate > 0) return solveTaxable(form.amount, rate, 0, supplyFor(form, ctx)).taxablePaise
  return form.amount
}

export interface BuyTotals {
  /** Before GST (on a claimed bill), else the cost. */
  taxable: number
  /** Input tax (claimed bills only). */
  tax: number
  /** GST folded into the cost (a company that can't claim, prices before GST). */
  folded: number
  /** The bill, rounded to the rupee (what is owed to the supplier). */
  total: number
  /** Each form line's value (before GST when claimed, the cost otherwise); null = not complete. */
  lineAmounts: (number | null)[]
  gst: BuyGst
}

/** Live totals — the editor's own calculation, the same numbers simple:post will save. */
export function buyTotals(form: BuyForm, ctx: BuyContext): BuyTotals {
  const g = buyGst(form, ctx)
  const supply = supplyFor(form, ctx)
  if (form.mode !== 'items') {
    const taxable = amountTaxable(form, ctx)
    if (taxable == null) return { taxable: 0, tax: 0, folded: 0, total: 0, lineAmounts: [], gst: g }
    if (g === 'claim') {
      const gst = addBreakups([computeGst(taxable, amountRate(form, ctx) ?? 0, supply)])
      return { taxable: gst.taxable, tax: gst.total - gst.taxable, folded: 0, total: roundToRupee(gst.total), lineAmounts: [], gst: g }
    }
    const cost = g === 'fold' ? foldGstIntoAmount(taxable, amountRate(form, ctx)) : taxable
    const gst = addBreakups([computeGst(cost, 0, supply)])
    return { taxable: gst.taxable, tax: 0, folded: cost - taxable, total: roundToRupee(gst.total), lineAmounts: [], gst: g }
  }
  const { lines } = buyIntentLines(form, ctx)
  // A bill without GST in a regular company can't hold products (refused); its preview total is
  // the lines at no tax, computed as the editor would for a company that doesn't charge GST.
  const invCtx: InvoiceContext = g === 'none' ? { ...ctx.invoice, items: new Map([...ctx.invoice.items].map(([id, i]) => [id, { ...i, gstRate: 0, cessRate: 0 }])), kind: 'purchase' } : { ...ctx.invoice, kind: 'purchase' }
  const rows = lines.map((l) => {
    const base = { itemId: l.itemId, qtyText: qtyText(l.qtyMilli), rate: l.rate, discount: l.discount || null, godownId: null, batchId: null }
    return g === 'fold' ? { ...base, ...foldGstIntoLine(l.qtyMilli, l.rate, l.discount || null, ctx.invoice.items.get(l.itemId)?.gstRate ?? null) } : base
  })
  const c = computeInvoice({ ...emptyInvoiceState(form.date), partyId: form.supplierId ?? -1, accountId: ctx.purchaseAccountId ?? -2, rows }, invCtx)
  const lineAmounts: (number | null)[] = form.lines.map(() => null)
  let k = 0
  form.lines.forEach((l, i) => {
    if (l.itemId == null || buyQtyMilli(l.qtyText) == null || l.rate == null) return
    lineAmounts[i] = c.detail[k]?.amount ?? null
    k++
  })
  // What was folded = the cost − the lines as typed (each line's gross − discount, computeInvoice).
  let folded = 0
  if (g === 'fold') {
    const plain = computeInvoice({ ...emptyInvoiceState(form.date), partyId: form.supplierId ?? -1, accountId: ctx.purchaseAccountId ?? -2, rows: lines.map((l) => ({ itemId: l.itemId, qtyText: qtyText(l.qtyMilli), rate: l.rate, discount: l.discount || null, godownId: null, batchId: null })) }, invCtx)
    folded = c.gst.taxable - plain.gst.taxable
  }
  return { taxable: c.gst.taxable, tax: c.gst.total - c.gst.taxable, folded, total: c.rounded, lineAmounts, gst: g }
}

/** The default cash / bank account for each way of paying. */
export type BuyMoneyDefaults = Record<MoneyHow, number | null>

/** The intent's `gstOnBill`: a regular company's answer; for one that can't claim, "add the GST
 *  to the cost" exactly when the prices were typed before GST. */
const intentGstOnBill = (g: BuyGst): boolean => g === 'claim' || g === 'fold'

/** The form's answers as the `purchase` intent (without its clientId — useSimplePost adds it).
 *  Only call with a supplier picked (buyFormErrors checks it). */
export function purchaseIntentFrom(form: BuyForm, ctx: BuyContext, defaults: BuyMoneyDefaults): Omit<Extract<SimpleIntentInput, { kind: 'purchase' }>, 'clientId'> {
  const g = buyGst(form, ctx)
  const how: MoneyHow | null = form.paid === 'credit' ? null : form.paid === 'part' ? form.partHow : form.paid
  const accountId = how ? (form.accountId ?? defaults[how] ?? undefined) : undefined
  const payment =
    how == null
      ? { how: 'credit' as const }
      : { how, ...(form.paid === 'part' && form.partAmount != null ? { amount: form.partAmount } : {}), ...(accountId != null ? { accountId } : {}) }
  const base = {
    kind: 'purchase' as const,
    date: form.date,
    supplierId: form.supplierId ?? 0,
    ...(form.billNo.trim() ? { billNo: form.billNo.trim() } : {}),
    ...(form.note.trim() ? { narration: form.note.trim() } : {}),
    gstOnBill: intentGstOnBill(g),
    payment
  }
  if (form.mode !== 'items') {
    const acct = amountAccountId(form, ctx)
    const rate = amountRate(form, ctx)
    return {
      ...base,
      amount: {
        amount: amountTaxable(form, ctx) ?? 0,
        ...(acct != null ? { accountId: acct } : {}),
        ...((g === 'claim' || g === 'fold') && rate != null ? { gstRate: rate } : {})
      }
    }
  }
  const { lines } = buyIntentLines(form, ctx)
  return { ...base, items: lines.map((l) => ({ itemId: l.itemId, qty: l.qtyMilli, rate: l.rate, ...(l.discount > 0 ? { discount: l.discount } : {}) })) }
}

export type BuyField = 'date' | 'party' | 'billNo' | 'items' | 'account' | 'amount' | 'gstRate' | 'gstOnBill' | 'payment'

/** Checks before main is asked (each message under its question). */
export function buyFormErrors(form: BuyForm, ctx: BuyContext): Partial<Record<BuyField, MessageKey>> {
  const out: Partial<Record<BuyField, MessageKey>> = {}
  const g = buyGst(form, ctx)
  if (form.supplierId == null) out.party = 'simple.buy.err.supplier'
  if (form.mode === 'items') {
    const { lines, incomplete } = buyIntentLines(form, ctx)
    const bad = incomplete.map((i) => form.lines[i]!)
    if (bad.some((l) => l.itemId == null)) out.items = 'simple.buy.err.pickProduct'
    else if (bad.some((l) => buyQtyMilli(l.qtyText) == null)) out.items = 'simple.buy.err.qty'
    else if (bad.some((l) => l.rate == null)) out.items = 'simple.buy.err.price'
    else if (lines.length === 0) out.items = 'simple.buy.err.noItems'
    if (g === 'none') out.gstOnBill = 'errors.intent.itemsNoGst'
  } else {
    if (form.mode === 'expense' && form.categoryId == null) out.account = 'simple.buy.err.category'
    if (form.amount == null || form.amount <= 0) out.amount = 'simple.buy.err.amount'
    if (g === 'claim' && amountRate(form, ctx) == null) out.gstRate = 'simple.buy.err.gstRate'
  }
  if (form.paid === 'part') {
    const total = buyTotals(form, ctx).total
    if (form.partAmount == null || form.partAmount <= 0) out.payment = 'simple.buy.err.partAmount'
    else if (total > 0 && form.partAmount >= total) out.payment = 'simple.buy.err.partTooMuch'
  }
  return out
}

const money = (p: number): string => formatPaise(p, { symbol: true })

/** The plain line shown before Save — "Bill ₹1,180.00 from Bharat Steel. ₹500.00 paid by UPI now,
 *  ₹680.00 still to pay by 20 Nov 2026." — from simple:preview's facts (computed by main). */
export function purchasePreviewLine(f: IntentFacts, t: Translate): string {
  const head = t('simple.buy.preview.bill', { amount: money(f.total), name: f.partyName ?? '' })
  const how = f.how ?? 'cash'
  const due = f.dueDate ? toPlainDate(f.dueDate) : ''
  const owed = f.due > 0 ? f.due : 0
  if (f.paid > 0 && owed > 0) return `${head} ${t('simple.buy.preview.part', { paid: money(f.paid), how, due: money(owed), date: due })}`
  if (f.paid > 0) return `${head} ${t('simple.buy.preview.paid', { amount: money(f.paid), how })}`
  if (owed > 0) return `${head} ${t(due ? 'simple.buy.preview.dueBy' : 'simple.buy.preview.due', { amount: money(owed), date: due })}`
  return head
}

/** A purchase list row's status chip. */
export type PurchaseStatus = 'paid' | 'part' | 'due' | 'overdue'
export function purchaseStatus(total: number, due: number, overdueDays: number): PurchaseStatus {
  if (due <= 0) return 'paid'
  if (overdueDays > 0) return 'overdue'
  return due < total ? 'part' : 'due'
}

// ---------------------------------------------------------------- read shapes (services/simpleBuy.ts)

export interface BuySupplier {
  id: number
  name: string
  stateCode: string | null
  gstin: string | null
  phone: string | null
}

export interface BuySetup {
  suppliers: BuySupplier[]
  moneyAccounts: { id: number; name: string; kind: 'cash' | 'bank' }[]
  defaults: BuyMoneyDefaults
  /** The WP 5.6 memory the UPI / card / bank default came from ("Pay from"), if any. */
  memoryId: number | null
  /** "Purchases" (its category, else the first purchase account) — simple:post's default. */
  purchaseAccountId: number | null
}

export interface PurchaseRow {
  voucherId: number
  /** The entry's own number. */
  number: string
  /** The supplier's bill number as recorded (null = none). */
  billNo: string | null
  date: string
  partyId: number | null
  partyName: string
  total: number
  tax: number
  /** Total − what is still due on the bill (the Outstandings allocation as on today). */
  paid: number
  due: number
  dueDate: string | null
  overdueDays: number
}

export interface PurchaseView extends PurchaseRow {
  /** Product lines — as saved. */
  items: { name: string; qtyMilli: number; unit: string; ratePaise: number; discountPaise: number; amount: number }[]
  /** Expense / amount bills: the accounts charged. */
  amounts: { name: string; amount: number }[]
  note: string | null
}
