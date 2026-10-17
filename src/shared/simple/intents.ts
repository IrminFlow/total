// Simple-mode intents (WP 9.1, plan 2026-10-13 §0.1 / §3): what a simple screen asks for, in plain
// answers, and the PURE mapping of those answers to the accountant editors' own form state.
//
// The one architectural rule: an intent is turned into the editor's form state (InvoiceFormState /
// AccountingFormState, src/shared/voucherEdit/) and the payload that state posts is built by the
// editor's own builder (buildInvoicePayload / buildAccountingPayload) — so whatever a simple screen
// saves opens in the full editor and round-trips unchanged. There is no new posting path, no new
// voucher kind and no stored balance; main (services/simplePost.ts) saves every payload through
// saveVoucher inside ONE transaction.
//
// Pure: no DB, no Electron. Everything that needs the books (masters, open bills, prices from
// resolvePrice, the next voucher numbers, the original bill of a return) arrives in an
// IntentContext the service loads. Amounts are integer paise (or typed text read only by
// money.ts parseAmountText); quantities integer thousandths (or typed "2.5"); dates ISO or typed
// text read only by dates.ts resolveDateText against the working date. No floats touch money.

import { z } from 'zod'
import type { SaveVoucherWarnings, VoucherBillRef, VoucherKind } from '../domain'
import type { SaveSummary } from './saveCard'
import type { Translate } from '../i18n'
import { formatPaise, parseAmountText, roundToRupee } from '../money'
import { addDaysISO, fyOf, isValidISODate, resolveDateText, toDisplayDate, toPlainDate } from '../dates'
import { addBreakups, computeGst, supplyTypeFor, type GstBreakup } from '../gst/calc'
import { chargesGstOn, registrationOn } from '../gst/registration'
import { AppError } from '../errors/appError'
import type { ErrorCode } from '../errors/codes'
import { nonClaimableCosts, rateForCost } from '../capture/nonClaimable'
import {
  buildAccountingPayload, buildInvoicePayload, computeInvoice, derivePartyId, emptyInvoiceState, requiredTaxLedgers,
  type AccountingFormState, type AccountingRowState, type InvoiceContext, type InvoiceFormState, type InvoiceRowState,
  type TaxLedgerIds, type TaxSide, type VoucherPayload
} from '../voucherEdit'
import { qtyText } from '../voucherEdit/payload'
import type { PhysicalFormState } from '../voucherEdit/physical'
import type { ManufactureFormState } from '../voucherEdit/manufacture'
import type { ManufactureInput } from '../manufacture'
import type { BomVersion } from '../bom'
// WP 9.7: the stock intents' pure mapping lives beside the Stock screens' helpers (stock.ts only
// imports TYPES from this module, so there is no runtime cycle).
import { mapMakeGoods, mapStockCount, stockSentences } from './stock'

// ---------------------------------------------------------------- schemas

const id = z.number().int().positive()
/** Integer paise, or the amount as typed ("1,180", "1.5 lakh") — read by parseAmountText only. */
const amountIn = z.union([z.number().int().positive().max(1e15), z.string().trim().min(1).max(40)])
/** Integer thousandths, or the quantity as typed ("2", "2.5", "1,000"). */
const qtyIn = z.union([z.number().int().positive().max(1e12), z.string().trim().min(1).max(20)])
/** ISO date or typed text ("today", "15 Aug"); omitted = the working date. */
const dateIn = z.string().trim().min(1).max(40)

/** Simple dates may be at most this many days after the working date (simple:post refuses later
 *  ones, `simple_far_future`); the money list looks that far ahead too. */
export const SIMPLE_MAX_DAYS_AHEAD = 30

export const PAID_HOW = ['cash', 'upi', 'card', 'bank', 'credit'] as const
export type PaidHow = (typeof PAID_HOW)[number]
export const MONEY_HOW = ['cash', 'upi', 'card', 'bank'] as const
export type MoneyHow = (typeof MONEY_HOW)[number]

/** "Paid how?" on a bill: now (cash / UPI / card / bank, all or part) or on credit. */
const paymentSchema = z
  .object({
    how: z.enum(PAID_HOW),
    /** Part payment; omitted = the whole bill. Ignored for credit. */
    amount: amountIn.optional(),
    /** Which cash / bank account; omitted = the default for `how` (Counter options / first bank). */
    accountId: id.optional(),
    /** Cheque / UTR number. */
    reference: z.string().trim().max(60).optional()
  })
  .strict()

/** Where money came in / went out. */
const moneyAccountSchema = z.object({ how: z.enum(MONEY_HOW), accountId: id.optional(), reference: z.string().trim().max(60).optional() }).strict()

const itemLineSchema = z
  .object({
    itemId: id,
    qty: qtyIn,
    /** Per unit, before GST; omitted = the price list (resolvePrice). */
    rate: amountIn.optional(),
    discount: amountIn.optional()
  })
  .strict()

/** "Just an amount" — one line of value before GST on a sales / purchase / expense account. */
const amountLineSchema = z
  .object({
    amount: amountIn,
    /** The income / expense category; omitted = the intent's account, else the default. */
    accountId: id.optional(),
    /** GST % (regular registration only); omitted = the account's rate, else 0. */
    gstRate: z.number().min(0).max(100).optional(),
    /** WP 9.4: the bill's printed total WITH GST (an expense bill paid on Money out). Given, the
     *  bill is that total — what GST + the value leave over (under a rupee) is its round off —
     *  instead of the rupee-rounded total; omitted = rounded to the rupee, as before. */
    billTotal: amountIn.optional()
  })
  .strict()

const base = {
  /** Idempotency key: a retry with the same id returns the same entries and never posts twice. */
  clientId: z.string().trim().min(8).max(80),
  date: dateIn.optional(),
  narration: z.string().trim().max(500).optional()
}

/** `billId` (optional, additive): the entry the bill is from (its voucher id) — picks THAT bill
 *  when the party has two open bills of the same name (numbering restarts every year). */
const billSettleSchema = z.object({ name: z.string().trim().min(1).max(80), amount: amountIn.optional(), billId: z.number().int().positive().optional() }).strict()

export const saleIntentSchema = z
  .object({
    kind: z.literal('sale'),
    ...base,
    /** Omitted = walk-in (the counter's "Cash sale" customer). */
    customerId: id.optional(),
    items: z.array(itemLineSchema).min(1).max(200).optional(),
    amount: amountLineSchema.optional(),
    /** The sales account; omitted = "Sales" (its category), else the first sales account. */
    accountId: id.optional(),
    /** Omitted = cash for walk-in, credit for a named customer. */
    payment: paymentSchema.optional(),
    dueDate: dateIn.optional(),
    /** Only for a hand-numbered bill series. */
    number: z.string().trim().min(1).max(40).optional()
  })
  .strict()

export const purchaseIntentSchema = z
  .object({
    kind: z.literal('purchase'),
    ...base,
    supplierId: id,
    /** The supplier's bill number (the GST registers' supplier invoice no.); `date` is its date. */
    billNo: z.string().trim().min(1).max(80).optional(),
    items: z.array(itemLineSchema).min(1).max(200).optional(),
    amount: amountLineSchema.optional(),
    accountId: id.optional(),
    /** "Does the bill show GST?" — false books no tax; for a company that can't claim GST, true
     *  folds the bill's GST into the cost (WP 8.0). Omitted = true. */
    gstOnBill: z.boolean().optional(),
    payment: paymentSchema.optional(),
    dueDate: dateIn.optional(),
    number: z.string().trim().min(1).max(40).optional()
  })
  .strict()

export const moneyInIntentSchema = z
  .object({
    kind: z.literal('money_in'),
    ...base,
    amount: amountIn,
    into: moneyAccountSchema,
    /** A customer paid: their bills oldest first, or the ones named. */
    customerId: id.optional(),
    bills: z.array(billSettleSchema).max(100).optional(),
    /** "Is this for a bill you haven't made yet?" — what is not against a bill is an advance. */
    advance: z.boolean().optional(),
    /** Anything else: owner's money, a loan taken, other income — that account. */
    sourceId: id.optional(),
    /** WP 9.4: a refund from a supplier — set against what they owe you back (their named
     *  credits, oldest first), the rest on account. */
    supplierId: id.optional(),
    /** A supplier's money that is NOT a refund ("They are paying us for something else"): kept on
     *  account even when they owe us nothing back. Omitted = a refund, refused when they hold no
     *  credit with us (`simple_refund_no_credit`). */
    onAccount: z.boolean().optional(),
    number: z.string().trim().min(1).max(40).optional()
  })
  .strict()

export const moneyOutIntentSchema = z
  .object({
    kind: z.literal('money_out'),
    ...base,
    amount: amountIn,
    from: moneyAccountSchema,
    supplierId: id.optional(),
    bills: z.array(billSettleSchema).max(100).optional(),
    advance: z.boolean().optional(),
    /** An expense category (or any other account that isn't cash / bank / a party). */
    payeeId: id.optional(),
    /** The owner took money: Owner's drawings. */
    drawings: z.boolean().optional(),
    /** A refund TO a customer — set against the credit they hold with us (their named credits:
     *  advances received, credit notes' own bills — oldest first), the rest on account. Refused
     *  for a customer holding no credit (`simple_customer_no_credit`) unless `onAccount`. */
    customerId: id.optional(),
    /** Paying a customer for something that is not a refund: on account even with no credit held. */
    onAccount: z.boolean().optional(),
    number: z.string().trim().min(1).max(40).optional()
  })
  .strict()

export const moveMoneyIntentSchema = z
  .object({
    kind: z.literal('move_money'),
    ...base,
    amount: amountIn,
    fromId: id,
    toId: id,
    reference: z.string().trim().max(60).optional(),
    number: z.string().trim().min(1).max(40).optional()
  })
  .strict()

const returnLineSchema = z.object({ lineUid: z.string().trim().min(1).max(80), qty: qtyIn }).strict()
const returnAmountSchema = z.object({ amount: amountIn, gstRate: z.number().min(0).max(100).optional() }).strict()
const returnBase = {
  ...base,
  /** The original sales / purchase bill. */
  billId: id,
  items: z.array(returnLineSchema).min(1).max(200).optional(),
  amount: returnAmountSchema.optional(),
  /** Money back now; omitted = kept as credit (or taken off the bill). */
  refund: moneyAccountSchema.optional(),
  number: z.string().trim().min(1).max(40).optional()
}
export const returnSaleIntentSchema = z.object({ kind: z.literal('return_sale'), ...returnBase }).strict()
export const returnPurchaseIntentSchema = z.object({ kind: z.literal('return_purchase'), ...returnBase }).strict()

/** WP 9.7: a counted quantity — integer thousandths or typed text; 0 is a count ("none left"). */
const countIn = z.union([z.number().int().min(0).max(1e12), z.string().trim().min(1).max(20)])

/** WP 9.7 "Count your stock": what is on the shelf now, per product (absolute quantities — the
 *  physical-stock entry; a product left out is not touched). */
export const stockCountIntentSchema = z
  .object({
    kind: z.literal('stock_count'),
    ...base,
    counts: z.array(z.object({ itemId: id, qty: countIn }).strict()).min(1).max(2000),
    number: z.string().trim().min(1).max(40).optional()
  })
  .strict()

/** WP 9.7 "Made goods": make `qty` of a product from its recipe (the BOM in force on the date) —
 *  the WP 2.2 manufacture entry. */
export const makeGoodsIntentSchema = z
  .object({
    kind: z.literal('make_goods'),
    ...base,
    itemId: id,
    qty: qtyIn,
    /** What one sells for (the manufacture's average price, margin only); omitted = the editor's
     *  suggestion (this year's sales, else the price list). */
    price: amountIn.optional(),
    /** Labour for this batch; omitted = none. */
    labour: amountIn.optional(),
    /** "Labour already recorded?" — true: paid / billed elsewhere, only added to the goods' value;
     *  false / omitted: recorded here as wages still to pay (the editor's default). */
    labourRecorded: z.boolean().optional(),
    number: z.string().trim().min(1).max(40).optional()
  })
  .strict()

export const simpleIntentSchema = z.discriminatedUnion('kind', [
  saleIntentSchema,
  purchaseIntentSchema,
  moneyInIntentSchema,
  moneyOutIntentSchema,
  moveMoneyIntentSchema,
  returnSaleIntentSchema,
  returnPurchaseIntentSchema,
  stockCountIntentSchema,
  makeGoodsIntentSchema
])

export type SimpleIntent = z.infer<typeof simpleIntentSchema>
/** What a screen sends (schema input: optional fields may be left out). */
export type SimpleIntentInput = z.input<typeof simpleIntentSchema>
export type SimpleIntentKind = SimpleIntent['kind']
export const SIMPLE_INTENT_KINDS: readonly SimpleIntentKind[] = ['sale', 'purchase', 'money_in', 'money_out', 'move_money', 'return_sale', 'return_purchase', 'stock_count', 'make_goods']

// ---------------------------------------------------------------- normalised intents

export interface NItemLine { itemId: number; qtyMilli: number; rate: number | null; discount: number | null }
export interface NAmountLine { amount: number; accountId: number | null; gstRate: number | null; billTotal?: number | null }
export interface NPayment { how: PaidHow; amount: number | null; accountId: number | null; reference: string | null }
export interface NMoneyAccount { how: MoneyHow; accountId: number | null; reference: string | null }
export interface NBill { name: string; amount: number | null; billId?: number | null }

interface NBase { clientId: string; date: string; narration: string; number: string | null }

export type NormalIntent =
  | (NBase & { kind: 'sale'; customerId: number | null; items: NItemLine[] | null; amount: NAmountLine | null; accountId: number | null; payment: NPayment | null; dueDate: string | null })
  | (NBase & { kind: 'purchase'; supplierId: number; billNo: string | null; items: NItemLine[] | null; amount: NAmountLine | null; accountId: number | null; gstOnBill: boolean; payment: NPayment | null; dueDate: string | null })
  | (NBase & { kind: 'money_in'; amount: number; into: NMoneyAccount; customerId: number | null; bills: NBill[] | null; advance: boolean; sourceId: number | null; supplierId: number | null; onAccount: boolean })
  | (NBase & { kind: 'money_out'; amount: number; from: NMoneyAccount; supplierId: number | null; bills: NBill[] | null; advance: boolean; payeeId: number | null; drawings: boolean; customerId: number | null; onAccount: boolean })
  | (NBase & { kind: 'move_money'; amount: number; fromId: number; toId: number; reference: string | null })
  | (NBase & { kind: 'return_sale' | 'return_purchase'; billId: number; items: { lineUid: string; qtyMilli: number }[] | null; amount: { amount: number; gstRate: number | null } | null; refund: NMoneyAccount | null })
  | (NBase & { kind: 'stock_count'; counts: { itemId: number; qtyMilli: number }[] })
  | (NBase & { kind: 'make_goods'; itemId: number; qtyMilli: number; price: number | null; labour: number; labourRecorded: boolean })

const fail = (code: ErrorCode, message: string, field?: string, params?: Record<string, string | number>): never => {
  throw new AppError(code, message, { ...(field ? { field } : {}), ...(params ? { params } : {}) })
}

/** Paise from an integer or typed text (parseAmountText — lakh / crore shorthand, never a float). */
export function readAmount(v: number | string, field: string, opts: { zeroOk?: boolean } = {}): number {
  const p = typeof v === 'number' ? v : parseAmountText(v)
  if (p == null || !Number.isSafeInteger(p) || p < 0 || (p === 0 && !opts.zeroOk)) return fail('simple_bad_amount', `“${String(v)}” is not an amount`, field)
  return p
}

/** Thousandths from an integer or typed text ("2", "2.5", "1,000") — integer maths only. */
export function readQty(v: number | string, field: string): number {
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v) || v <= 0) return fail('simple_bad_qty', `${v} is not a quantity`, field)
    return v
  }
  const m = /^(\d{1,3}(?:,\d{2,3})+|\d+)(?:\.(\d{1,3}))?$/.exec(v.trim())
  if (!m) return fail('simple_bad_qty', `“${v}” is not a quantity`, field)
  const milli = Number(m[1]!.replace(/,/g, '')) * 1000 + Number((m[2] ?? '').padEnd(3, '0'))
  if (!Number.isSafeInteger(milli) || milli <= 0) return fail('simple_bad_qty', `“${v}” is not a quantity`, field)
  return milli
}

/** WP 9.7: a counted quantity — as readQty, but 0 ("none left") is a count. */
export function readCount(v: number | string, field: string): number {
  if (v === 0 || (typeof v === 'string' && /^0+(?:\.0{1,3})?$/.test(v.trim()))) return 0
  return readQty(v, field)
}

/** ISO, or typed text resolved against the working date (resolveDateText); omitted = `today`. */
export function readDate(v: string | undefined, today: string, field = 'date'): string {
  if (v == null || v.trim() === '') return today
  if (/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) {
    if (!isValidISODate(v.trim())) return fail('simple_bad_date', `“${v}” is not a date`, field)
    return v.trim()
  }
  const r = resolveDateText(v, today)
  if (!r) return fail('simple_bad_date', `Could not read the date “${v}”`, field)
  return r.date
}

const optText = (s: string | undefined): string | null => (s && s.trim() ? s.trim() : null)

function nPayment(p: z.infer<typeof paymentSchema> | undefined): NPayment | null {
  if (!p) return null
  return {
    how: p.how,
    amount: p.how === 'credit' || p.amount == null ? null : readAmount(p.amount, 'payment.amount', { zeroOk: true }),
    accountId: p.accountId ?? null,
    reference: optText(p.reference)
  }
}
const nMoney = (p: z.infer<typeof moneyAccountSchema>): NMoneyAccount => ({ how: p.how, accountId: p.accountId ?? null, reference: optText(p.reference) })
/** Omitted = oldest first; an EMPTY list (WP 9.4: the user unticked every bill) = none of them —
 *  the whole amount is the advance (with the flag), else refused as short. */
const nBills = (b: z.infer<typeof billSettleSchema>[] | undefined): NBill[] | null =>
  b ? b.map((x, i) => ({ name: x.name.trim(), amount: x.amount != null ? readAmount(x.amount, `bills.${i}.amount`) : null, ...(x.billId != null ? { billId: x.billId } : {}) })) : null
function nItems(items: z.infer<typeof itemLineSchema>[] | undefined): NItemLine[] | null {
  if (!items) return null
  return items.map((l, i) => ({
    itemId: l.itemId,
    qtyMilli: readQty(l.qty, `items.${i}.qty`),
    rate: l.rate != null ? readAmount(l.rate, `items.${i}.rate`, { zeroOk: true }) : null,
    discount: l.discount != null ? readAmount(l.discount, `items.${i}.discount`, { zeroOk: true }) : null
  }))
}
const nAmount = (a: z.infer<typeof amountLineSchema> | undefined): NAmountLine | null =>
  a ? { amount: readAmount(a.amount, 'amount'), accountId: a.accountId ?? null, gstRate: a.gstRate ?? null, ...(a.billTotal != null ? { billTotal: readAmount(a.billTotal, 'amount') } : {}) } : null

/** Zod-parse and read every amount / quantity / date (against the working date). */
export function normaliseIntent(raw: unknown, today: string): NormalIntent {
  const i = simpleIntentSchema.parse(raw)
  const b: NBase = { clientId: i.clientId, date: readDate(i.date, today), narration: i.narration?.trim() ?? '', number: 'number' in i ? optText(i.number) : null }
  switch (i.kind) {
    case 'sale':
    case 'purchase': {
      if (!!i.items === !!i.amount) fail('simple_no_lines', 'Give either the items or just an amount', 'items')
      const common = { items: nItems(i.items), amount: nAmount(i.amount), accountId: i.accountId ?? null, payment: nPayment(i.payment), dueDate: i.dueDate ? readDate(i.dueDate, today, 'dueDate') : null }
      return i.kind === 'sale'
        ? { ...b, kind: 'sale', customerId: i.customerId ?? null, ...common }
        : { ...b, kind: 'purchase', supplierId: i.supplierId, billNo: optText(i.billNo), gstOnBill: i.gstOnBill ?? true, ...common }
    }
    case 'money_in': {
      const n = (i.customerId != null ? 1 : 0) + (i.sourceId != null ? 1 : 0) + (i.supplierId != null ? 1 : 0)
      if (n !== 1) fail('simple_no_party', 'Say who paid — a customer, or where else the money came from', 'party')
      return {
        ...b, kind: 'money_in', amount: readAmount(i.amount, 'amount'), into: nMoney(i.into), customerId: i.customerId ?? null, bills: nBills(i.bills), advance: !!i.advance,
        sourceId: i.sourceId ?? null, supplierId: i.supplierId ?? null, onAccount: !!i.onAccount
      }
    }
    case 'money_out': {
      const n = (i.supplierId != null ? 1 : 0) + (i.payeeId != null ? 1 : 0) + (i.drawings ? 1 : 0) + (i.customerId != null ? 1 : 0)
      if (n !== 1) fail('simple_no_party', 'Say who was paid — a supplier, an expense, the owner or a customer', 'party')
      return {
        ...b, kind: 'money_out', amount: readAmount(i.amount, 'amount'), from: nMoney(i.from), supplierId: i.supplierId ?? null, bills: nBills(i.bills), advance: !!i.advance,
        payeeId: i.payeeId ?? null, drawings: !!i.drawings, customerId: i.customerId ?? null, onAccount: !!i.onAccount
      }
    }
    case 'move_money':
      return { ...b, kind: 'move_money', amount: readAmount(i.amount, 'amount'), fromId: i.fromId, toId: i.toId, reference: optText(i.reference) }
    case 'return_sale':
    case 'return_purchase':
      if (!!i.items === !!i.amount) fail('simple_no_lines', 'Give either the returned items or just an amount', 'items')
      return {
        ...b,
        kind: i.kind,
        billId: i.billId,
        items: i.items ? i.items.map((l, k) => ({ lineUid: l.lineUid, qtyMilli: readQty(l.qty, `items.${k}.qty`) })) : null,
        amount: i.amount ? { amount: readAmount(i.amount.amount, 'amount'), gstRate: i.amount.gstRate ?? null } : null,
        refund: i.refund ? nMoney(i.refund) : null
      }
    case 'stock_count':
      return { ...b, kind: 'stock_count', counts: i.counts.map((c, k) => ({ itemId: c.itemId, qtyMilli: readCount(c.qty, `counts.${k}.qty`) })) }
    case 'make_goods':
      return {
        ...b,
        kind: 'make_goods',
        itemId: i.itemId,
        qtyMilli: readQty(i.qty, 'qty'),
        price: i.price != null ? readAmount(i.price, 'price', { zeroOk: true }) : null,
        labour: i.labour != null ? readAmount(i.labour, 'labour', { zeroOk: true }) : 0,
        labourRecorded: !!i.labourRecorded
      }
  }
}

// ---------------------------------------------------------------- context (loaded by main)

/** The WP 5.6 ledger classes (src/main/ai/ledgerClass.ts) — what an account may be used for. */
export type IntentLedgerClass = 'cash' | 'bank' | 'debtor' | 'creditor' | 'income' | 'expense' | 'tax' | 'other'

export interface IntentLedger {
  id: number
  name: string
  cls: IntentLedgerClass
  stateCode: string | null
  gstRate: number | null
  creditDays: number | null
}

export interface IntentVoucherType {
  id: number
  name: string
  numbering: 'auto' | 'manual'
  /** The series' next number on the intent's date (what the editor suggests). */
  next: string
}

export interface IntentOpenBill { name: string; date: string; pending: number; voucherId: number | null }

/** The bill a return is made against. */
export interface IntentOriginal {
  voucherId: number
  kind: 'sales' | 'purchase'
  date: string
  number: string
  partyId: number
  /** The sales / purchase account it posts to (null = more than one). */
  accountId: number | null
  /** Its bill-wise name (its 'new' bill ref) and what is still pending on it as on the return's date. */
  billName: string
  pending: number
  /** It posts GST (s.34: a note against it follows it). */
  carriesGst: boolean
  /** The GST rates of its lines as the bill posted them: the item rates when they still give the
   *  bill's tax (one per line, distinct), the bill's own rate for a ledger-line bill; null = they
   *  can't be told from the bill (a rate changed since) — a return then asks / refuses. */
  rates: number[] | null
  lines: IntentOriginalLine[]
  /** WP 9.5: the note's `reference` — the original's number (a sale: e-invoice PrecDocDtls looks
   *  it up), the supplier's bill number for a purchase (the 2B netting key, mismatch2b.ts).
   *  Omitted = its number. */
  noteReference?: string
  /** WP 9.5: a bill without item lines — its value before GST still returnable (the account lines
   *  less the returns made against it: in-books notes of this party carrying `noteReference`);
   *  null / omitted = not capped (an item bill caps each line by `leftMilli`). */
  amountLeft?: number | null
}

export interface IntentOriginalLine { lineUid: string; itemId: number; qtyMilli: number; ratePaise: number; discountPaise: number; godownId: number | null; batchId: number | null; leftMilli: number }

/** WP 9.5: a returned line as the note editor holds it — the rate on the bill, its discount pro
 *  rata (integer half-up), the same godown / batch, linked to the bill's line as a `return`. One
 *  definition for mapReturn and the return screen's live total. */
export function returnRow(line: IntentOriginalLine, qtyMilli: number): InvoiceRowState {
  const discount = line.discountPaise > 0 ? Math.floor((line.discountPaise * qtyMilli * 2 + line.qtyMilli) / (2 * line.qtyMilli)) : 0
  return {
    itemId: line.itemId, qtyText: qtyText(qtyMilli), rate: line.ratePaise, discount: discount || null,
    godownId: line.godownId, batchId: line.batchId, source: { lineUid: line.lineUid, linkType: 'return' as const }
  }
}

/** WP 8.0 / s.34: a note dated when the company doesn't charge GST keeps the GST of an original
 *  from a GST-charging period (or one that carries tax). */
export const returnTaxedOriginal = (facts: Parameters<typeof chargesGstOn>[0], noteDate: string, o: { date: string; carriesGst: boolean }): boolean =>
  !chargesGstOn(facts, noteDate) && (chargesGstOn(facts, o.date) || o.carriesGst)

export interface IntentDefaults {
  walkInId: number | null
  cashId: number | null
  upiId: number | null
  cardId: number | null
  bankId: number | null
  salesId: number | null
  purchaseId: number | null
  drawingsId: number | null
}

export interface IntentContext {
  /** The editor's invoice context (registration facts, company state, items' and ledgers' tax facts). */
  invoice: Omit<InvoiceContext, 'kind'>
  ledgers: ReadonlyMap<number, IntentLedger>
  items: ReadonlyMap<number, { id: number; name: string }>
  types: Partial<Record<VoucherKind, IntentVoucherType>>
  /** Each side's GST / round-off ledgers (pickTaxLedger) — null = not there yet. */
  taxLedgers: Record<TaxSide, TaxLedgerIds>
  defaults: IntentDefaults
  /** Price-list rates (resolvePrice) for item lines given without a rate, by line index. */
  prices: ReadonlyMap<number, { ratePaise: number; discountPaise: number }>
  /** The party's open bills, oldest first (the Outstandings allocation). */
  openBills: ReadonlyMap<number, readonly IntentOpenBill[]>
  original: IntentOriginal | null
  /** WP 9.4: per party, its named credits still open, oldest first (advances paid, debit notes'
   *  own bills — partyAllocationWithCredits); a supplier's refund is set against them, and so is
   *  a refund paid to a customer (their advances, credit notes' own bills). */
  openCredits?: ReadonlyMap<number, readonly { name: string; amount: number }[]>
  /** Per refund party (a supplier paying us back, a customer we pay back): every credit it holds
   *  with us as on the date — the allocation's `unappliedCredit` (named + unnamed). A refund from /
   *  to a party holding none is refused unless `onAccount`. Absent for a party = not checked. */
  heldCredit?: ReadonlyMap<number, number>
  /** Per party: names of its bills and credits still open (a new bill must not reuse one —
   *  a settlement by name applies to the OLDEST open bill of that name). */
  takenNames: ReadonlyMap<number, ReadonlySet<string>>
  /** WP 9.7 (stock_count / make_goods): each product's stock as on the intent's date, BEFORE the
   *  entry — stockAnalysis.stockSummary, the one valuation pass (shared/simple/stock.ts). */
  stock?: ReadonlyMap<number, IntentStockPosition>
  /** WP 9.7 (make_goods): the recipe and the engine's prices for it. */
  make?: IntentMake
}

export interface IntentStockPosition { name: string; unit: string; qtyMilli: number; value: number }

/** What Made goods reads from the books (loaded by main, as the Manufacture screen loads it). */
export interface IntentMake {
  /** The product's BOM versions (every item's — a component's own recipe is told apart). */
  versions: readonly BomVersion[]
  /** manufacture.suggestedSaleRate — the editor's "average price" prefill (paise per unit). */
  suggestedPrice: number | null
  /** manufacture.costPreview of the recipe's rows on the date: each row's engine cost and what
   *  was on hand before it (the derived rule's consumption). */
  priced: { lines: { itemId: number; qtyMilli: number; costPaise: number; onHandQtyMilli: number }[]; totalPaise: number }
  /** The labour accounts the editor would use (Labour Charges / Wages Payable — found or created
   *  by main exactly as saveManufacture does; null while not needed). */
  labour: { expenseId: number | null; creditId: number | null }
}

/** Thrown when an entry needs GST / round-off ledgers that don't exist yet: main creates them
 *  (as the editor does on first use) and maps again. */
export class NeedTaxLedgers extends Error {
  constructor(readonly side: TaxSide, readonly keys: (keyof TaxLedgerIds)[]) {
    super(`needs ${side} ${keys.join(', ')} ledgers`)
    this.name = 'NeedTaxLedgers'
  }
}

// ---------------------------------------------------------------- mapped result

/** What each saved entry is to the intent. */
export type IntentRole = 'bill' | 'payment' | 'money' | 'note' | 'refund' | 'count' | 'made'

export type MappedEntry =
  | { role: IntentRole; kind: VoucherKind; voucherTypeId: number; form: 'invoice'; state: InvoiceFormState; payload: VoucherPayload }
  | { role: IntentRole; kind: VoucherKind; voucherTypeId: number; form: 'accounting'; state: AccountingFormState; payload: VoucherPayload }
  /** WP 9.7: the Physical Stock editor's form (saved through saveVoucher). */
  | { role: IntentRole; kind: VoucherKind; voucherTypeId: number; form: 'physical'; state: PhysicalFormState; payload: VoucherPayload }
  /** WP 9.7: the Manufacture screen's form; `input` is what manufacture:save receives (saved
   *  through saveManufacture → saveVoucher), `payload` the stock journal it posts at the engine's
   *  prices (buildManufactureVoucher — for the preview). */
  | { role: IntentRole; kind: VoucherKind; voucherTypeId: number; form: 'manufacture'; state: ManufactureFormState; input: ManufactureInput; payload: VoucherPayload }

/** The figures the plain sentences are made of (all paise, all from the mapped payloads). */
export interface IntentFacts {
  kind: SimpleIntentKind
  partyName: string | null
  /** The bill / note / money moved. */
  total: number
  tax: number
  /** Paid / received / refunded now. */
  paid: number
  how: MoneyHow | null
  moneyAccount: string | null
  /** What stays open on this bill (bill − paid), or kept as credit. */
  due: number
  settled: { name: string; amount: number }[]
  advance: number
  /** Money moved between own accounts / the other side of a money in / out. */
  fromName: string | null
  toName: string | null
  /** Return set against the original bill (its bill name). */
  againstBill: string | null
  /** Returns: the part taken off the original bill, and the credit the note created. */
  offBill: number
  credit: number
  walkIn: boolean
  /** The party's position AFTER the save (Outstandings allocation: open bills − credit; > 0 owes /
   *  you owe, < 0 paid ahead) — filled by main from the saved books; null = not known. */
  balance: number | null
  /** A GST rate was asked for but the company doesn't charge GST on that date (WP 8.0). */
  noGst: 'composition' | 'unregistered' | null
  /** Which side the party is on (null = no customer / supplier: walk-in aside, a source or payee). */
  side: 'customer' | 'supplier' | null
  /** WP 9.2: when what stays open on a sale / purchase bill falls due (bill date + the party's
   *  credit days, or the date given); absent when nothing stays open. */
  dueDate?: string | null
  /** WP 10.8: a purchase of just an amount on an expense account (not the purchases account) —
   *  that account's name, so the sentence says "Bill … for Rent". */
  forWhat?: string
  /** WP 9.7 stock_count: per product counted, what the books said and what was counted; the
   *  value change is the valuation engine's (filled by main from the saved books). */
  count?: CountFacts
  /** WP 9.7 make_goods: what was made, from what, and what it adds to stock. */
  made?: MadeFacts
}

export interface CountFacts {
  lines: { itemId: number; name: string; unit: string; beforeMilli: number; countedMilli: number; valueChange: number | null }[]
}

export interface MadeFacts {
  itemId: number
  name: string
  unit: string
  qtyMilli: number
  materials: { itemId: number; name: string; unit: string; qtyMilli: number; costPaise: number }[]
  materialPaise: number
  labourPaise: number
  labourRecorded: boolean
  /** What the made goods enter stock at: materials + labour (the derived rule). */
  valuePaise: number
  /** Sale amount − that value at the price given (negative = sold below cost). */
  profitPaise: number
}

export interface MappedIntent {
  entries: MappedEntry[]
  facts: IntentFacts
}

// ---------------------------------------------------------------- helpers

function ledgerOf(ctx: IntentContext, ledgerId: number | null, ok: readonly IntentLedgerClass[], code: 'simple_no_party' | 'simple_wrong_account', field: string, what: string): IntentLedger {
  const l = ledgerId != null ? ctx.ledgers.get(ledgerId) : undefined
  if (!l) return fail(code, `Pick the ${what}`, field)
  if (!ok.includes(l.cls)) return fail(code, `${l.name} can’t be the ${what}`, field, { name: l.name })
  return l
}

function typeOf(ctx: IntentContext, kind: VoucherKind, number: string | null, field: string): { type: IntentVoucherType; number: string } {
  const t = ctx.types[kind]
  if (!t) return fail('simple_no_type', `This company has no ${kind.replace('_', ' ')} entry type`, field)
  if (t.numbering === 'manual') {
    if (!number) return fail('number_required', `${t.name} is numbered by hand — give its number`, field === 'date' ? 'number' : field)
    return { type: t, number }
  }
  return { type: t, number: number ?? t.next }
}

const PARTY_OR_TDS = (ctx: IntentContext) => (ledgerId: number): boolean => {
  const c = ctx.ledgers.get(ledgerId)?.cls
  return c === 'debtor' || c === 'creditor'
}

/** The cash / bank account for "paid how": the one picked, else the default for that way. */
function moneyAccount(ctx: IntentContext, how: MoneyHow, accountId: number | null, field: string): IntentLedger {
  const id =
    accountId ?? (how === 'cash' ? ctx.defaults.cashId : how === 'upi' ? ctx.defaults.upiId : how === 'card' ? ctx.defaults.cardId : ctx.defaults.bankId)
  if (id == null) return fail('simple_no_money_account', how === 'cash' ? 'There is no cash account' : 'Add a bank account first', field)
  const ok: IntentLedgerClass[] = how === 'cash' ? ['cash'] : ['bank', 'cash']
  return ledgerOf(ctx, id, ok, 'simple_wrong_account', field, how === 'cash' ? 'cash account' : 'bank account')
}

function taxIds(ctx: IntentContext, side: TaxSide, need: (keyof TaxLedgerIds)[]): TaxLedgerIds {
  const have = ctx.taxLedgers[side]
  const missing = need.filter((k) => have[k] == null)
  if (missing.length) throw new NeedTaxLedgers(side, missing)
  return have
}

const row = (drCr: 'dr' | 'cr', ledgerId: number, amount: number): AccountingRowState => ({ drCr, ledgerId, amount, costAllocations: [] })

function accountingEntry(
  ctx: IntentContext,
  role: IntentRole,
  kind: VoucherKind,
  type: IntentVoucherType,
  s: Omit<AccountingFormState, 'instrumentNo' | 'advanceReceipt' | 'optional' | 'tds' | 'tcs' | 'original'> & { instrumentNo?: string }
): MappedEntry {
  const state: AccountingFormState = {
    instrumentNo: '', advanceReceipt: false, optional: false, tds: null, tcs: null, original: null, ...s
  }
  const built = buildAccountingPayload(state, { kind, voucherTypeId: type.id, derivedPartyId: derivePartyId(state.rows, PARTY_OR_TDS(ctx), null) })
  if (!built.ok) return fail('simple_cannot_build', built.error)
  return { role, kind, voucherTypeId: type.id, form: 'accounting', state, payload: built.payload }
}

function invoiceEntry(ctx: IntentContext, role: IntentRole, kind: VoucherKind, type: IntentVoucherType, state: InvoiceFormState, field: string): { entry: MappedEntry; total: number; tax: number } {
  const invCtx: InvoiceContext = { ...ctx.invoice, kind }
  const c = computeInvoice(state, invCtx)
  if (c.detail.length !== state.rows.length) return fail('simple_bad_qty', 'Every line needs a quantity and a rate', field)
  const side: TaxSide = kind === 'purchase' || kind === 'debit_note' ? 'input' : 'output'
  const built = buildInvoicePayload(state, invCtx, type.id, taxIds(ctx, side, requiredTaxLedgers(c)))
  if (!built.ok) return fail('simple_cannot_build', built.error, field)
  return { entry: { role, kind, voucherTypeId: type.id, form: 'invoice', state, payload: built.payload }, total: c.rounded, tax: c.gst.total - c.gst.taxable }
}

/** Ledger-line trading entry (the accounting form — the editor's own mode for a sales / purchase
 *  without item lines): party, the account at the taxable value, each GST head (computeGst — the
 *  editor's calculation), round off. Same line order as buildInvoicePayload. */
function ledgerLines(
  ctx: IntentContext,
  kind: 'sales' | 'purchase' | 'credit_note' | 'debit_note',
  party: IntentLedger,
  accountId: number,
  taxable: number,
  rate: number,
  printedTotal: number | null = null
): { rows: AccountingRowState[]; total: number; gst: GstBreakup } {
  const supply = supplyTypeFor(ctx.invoice.companyStateCode, party.stateCode ?? ctx.invoice.companyStateCode)
  const gst = addBreakups([computeGst(taxable, rate, supply)])
  // A printed total (WP 9.4) is the bill as the supplier wrote it; the rest is round off (< ₹1).
  if (printedTotal != null && Math.abs(printedTotal - gst.total) >= 100) {
    fail('simple_bill_total', `The bill total ${formatPaise(printedTotal, { symbol: true })} does not fit its value and GST (${formatPaise(gst.total, { symbol: true })})`, 'amount', { amount: formatPaise(gst.total, { symbol: true }) })
  }
  const total = printedTotal ?? roundToRupee(gst.total)
  const roundDiff = total - gst.total
  const partyDr = kind === 'sales' || kind === 'debit_note'
  const partySide = partyDr ? 'dr' : 'cr'
  const counter = partyDr ? 'cr' : 'dr'
  const side: TaxSide = kind === 'purchase' || kind === 'debit_note' ? 'input' : 'output'
  const need: (keyof TaxLedgerIds)[] = []
  if (gst.cgst > 0) need.push('cgst')
  if (gst.sgst > 0) need.push('sgst')
  if (gst.igst > 0) need.push('igst')
  if (roundDiff !== 0) need.push('roundOff')
  const tax = taxIds(ctx, side, need)
  const rows = [row(partySide, party.id, total), row(counter, accountId, gst.taxable)]
  if (gst.cgst > 0) rows.push(row(counter, tax.cgst!, gst.cgst))
  if (gst.sgst > 0) rows.push(row(counter, tax.sgst!, gst.sgst))
  if (gst.igst > 0) rows.push(row(counter, tax.igst!, gst.igst))
  if (roundDiff !== 0) rows.push(row(roundDiff > 0 ? counter : partySide, tax.roundOff!, Math.abs(roundDiff)))
  return { rows, total, gst }
}

const emptyFacts = (kind: SimpleIntentKind): IntentFacts => ({
  kind, partyName: null, total: 0, tax: 0, paid: 0, how: null, moneyAccount: null, due: 0, settled: [], advance: 0, fromName: null, toName: null, againstBill: null,
  offBill: 0, credit: 0, walkIn: false, balance: null, noGst: null, side: null
})

/** `base`, or — when the party already has an open bill / credit of that name — the name with the
 *  financial year ("1/25-26"), then a counter. Numbering restarts each year and per series, and a
 *  settlement by name applies to the OLDEST open bill of that name. */
export function uniqueName(base: string, taken: ReadonlySet<string> | undefined, date: string): string {
  if (!taken || !taken.has(base)) return base
  const fy = `${base}/${fyOf(date).label.slice(2)}`
  if (!taken.has(fy)) return fy
  for (let i = 2; ; i++) if (!taken.has(`${fy} (${i})`)) return `${fy} (${i})`
}

// ---------------------------------------------------------------- sale / purchase

/** WP 8.0: an item line of a purchase by a company that can't claim GST, with the bill's GST
 *  (at `gstRate` %) folded into its cost — the editor's rates are GST-inclusive there. Integer
 *  paise (capture's nonClaimableCosts / rateForCost); a 0 % rate leaves the line as it is. WP 9.3
 *  shows the same figure live, so this is the one place it is worked out. */
export function foldGstIntoLine(qtyMilli: number, rate: number, discount: number | null, gstRate: number | null): { rate: number; discount: number | null } {
  const rateBp = Math.round((gstRate ?? 0) * 100)
  if (rateBp <= 0) return { rate, discount }
  const gross = Math.round((qtyMilli * rate) / 1000)
  const taxable = gross - Math.min(gross, discount ?? 0)
  const cost = nonClaimableCosts([{ taxable, rateBp, printedTax: null }], null)[0]!.cost
  const folded = rateForCost(cost, qtyMilli)
  return { rate: folded.ratePaise, discount: folded.discountPaise || null }
}

/** WP 8.0: "just an amount" (before GST) of such a purchase with the bill's GST folded in. */
export function foldGstIntoAmount(taxable: number, gstRate: number | null): number {
  const rateBp = Math.round((gstRate ?? 0) * 100)
  return rateBp > 0 ? nonClaimableCosts([{ taxable, rateBp, printedTax: null }], null)[0]!.cost : taxable
}

/** Would these product lines carry GST in the editor (computeInvoice's rate: the item's, else the
 *  account's; or a cess)? A product bill without GST is refused only then (WP 9.3). */
export function itemsCarryGst(
  lines: readonly { itemId: number }[],
  invoice: Pick<InvoiceContext, 'items' | 'ledgers'>,
  accountId: number | null
): boolean {
  const accountRate = accountId != null ? (invoice.ledgers.get(accountId)?.gstRate ?? null) : null
  return lines.some((l) => {
    const item = invoice.items.get(l.itemId)
    return (item?.gstRate ?? accountRate ?? 0) > 0 || (item?.cessRate ?? 0) > 0
  })
}

function mapTrade(n: Extract<NormalIntent, { kind: 'sale' | 'purchase' }>, ctx: IntentContext): MappedIntent {
  const sale = n.kind === 'sale'
  const kind: VoucherKind = sale ? 'sales' : 'purchase'
  const walkIn = sale && n.customerId == null
  const partyId = sale ? (n.customerId ?? ctx.defaults.walkInId) : n.supplierId
  const party = ledgerOf(ctx, partyId, [sale ? 'debtor' : 'creditor'], 'simple_no_party', 'party', sale ? 'customer' : 'supplier')
  const { type, number } = typeOf(ctx, kind, n.number, 'number')
  const date = n.date
  const billNo = n.kind === 'purchase' ? n.billNo : null
  const billName = uniqueName(billNo ?? number, ctx.takenNames.get(party.id), date)
  const due = n.dueDate ?? addDaysISO(date, party.creditDays ?? 0)
  const accountClasses: IntentLedgerClass[] = sale ? ['income'] : ['expense']
  const defaultAccount = sale ? ctx.defaults.salesId : ctx.defaults.purchaseId
  const charges = chargesGstOn(ctx.invoice, date)
  const gstOnBill = n.kind === 'purchase' ? n.gstOnBill : true
  const facts: IntentFacts = { ...emptyFacts(n.kind), partyName: party.name, walkIn, side: sale ? 'customer' : 'supplier' }

  let bill: MappedEntry
  let total: number
  if (n.items) {
    const account = ledgerOf(ctx, n.accountId ?? defaultAccount, accountClasses, 'simple_wrong_account', 'account', sale ? 'sales account' : 'purchase account')
    // WP 9.3: the purchase editor's item lines always carry their items' GST while the company
    // charges it — a bill WITHOUT GST can't be held there when a product carries GST, so it is
    // refused (never posted with tax the bill doesn't show); as "just an amount" it books no tax.
    // Products at nil GST (and no cess) post no tax either way, so they are fine.
    if (!sale && charges && !gstOnBill && itemsCarryGst(n.items, ctx.invoice, account.id)) {
      fail('simple_items_no_gst', 'A bill without GST can’t list products here — record it as just an amount, or in the full editor', 'gstOnBill')
    }
    const rows: InvoiceRowState[] = n.items.map((l, i) => {
      if (!ctx.items.has(l.itemId)) fail('simple_no_item', 'Pick the product', `items.${i}.item`)
      const priced = l.rate == null ? ctx.prices.get(i) : undefined
      const rate = l.rate ?? priced?.ratePaise
      if (rate == null) return fail('simple_no_price', 'Type the price — there is none saved for this product', `items.${i}.rate`)
      const discount = l.discount ?? (priced && priced.discountPaise > 0 ? priced.discountPaise : null)
      let r: InvoiceRowState = { itemId: l.itemId, qtyText: qtyText(l.qtyMilli), rate, discount, godownId: null, batchId: null }
      // WP 8.0: a purchase by a company that can't claim GST books the bill's GST as part of the
      // cost (the editor's rates are GST-inclusive there): fold it into the line, integer paise.
      if (!sale && !charges && gstOnBill) r = { ...r, ...foldGstIntoLine(l.qtyMilli, rate, discount, ctx.invoice.items.get(l.itemId)?.gstRate ?? null) }
      return r
    })
    const state: InvoiceFormState = {
      ...emptyInvoiceState(date),
      number,
      partyId: party.id,
      accountId: account.id,
      rows,
      narration: n.narration,
      billName,
      billDueDate: due,
      reference: billNo
    }
    const built = invoiceEntry(ctx, 'bill', kind, type, state, 'items')
    bill = built.entry
    total = built.total
    facts.tax = built.tax
  } else {
    const a = n.amount!
    const account = ledgerOf(ctx, a.accountId ?? n.accountId ?? defaultAccount, accountClasses, 'simple_wrong_account', 'account', sale ? 'income account' : 'expense account')
    let taxable = a.amount
    let rate = charges && gstOnBill ? (a.gstRate ?? account.gstRate ?? 0) : 0
    if (sale && !charges && a.gstRate != null && a.gstRate > 0) facts.noGst = registrationOn(ctx.invoice, date) === 'composition' ? 'composition' : 'unregistered'
    if (!sale && !charges && gstOnBill) {
      taxable = foldGstIntoAmount(taxable, a.gstRate ?? account.gstRate ?? null)
      rate = 0
    }
    const lines = ledgerLines(ctx, kind as 'sales' | 'purchase', party, account.id, taxable, rate, a.billTotal ?? null)
    // WP 10.8: a bill for an expense (rent, electricity …) is said as that, not "Purchase bill".
    if (!sale && account.id !== ctx.defaults.purchaseId) facts.forWhat = account.name
    total = lines.total
    facts.tax = lines.gst.total - lines.gst.taxable
    bill = accountingEntry(ctx, 'bill', kind, type, {
      date, number, rows: lines.rows, narration: n.narration, reference: billNo,
      billRefs: [{ kind: 'new', name: billName, amount: total, dueDate: due }]
    })
  }

  const payment = n.payment ?? { how: walkIn ? ('cash' as const) : ('credit' as const), amount: null, accountId: null, reference: null }
  const paid = payment.how === 'credit' ? 0 : (payment.amount ?? total)
  if (paid > total) fail('simple_overpaid', `${formatPaise(paid, { symbol: true })} is more than the bill (${formatPaise(total, { symbol: true })})`, 'payment.amount', { amount: formatPaise(total, { symbol: true }) })
  if (walkIn && paid !== total) fail('simple_walk_in_unpaid', 'A walk-in sale is paid in full — pick the customer to sell on credit', 'payment')
  const entries = [bill]
  facts.total = total
  facts.paid = paid
  facts.due = total - paid
  // WP 10.8: a party without days to pay has no due date to tell (the bill is still due on its
  // date in the books, as before) — the preview says "no due date set" rather than "due by today".
  if (facts.due > 0 && (n.dueDate != null || (party.creditDays ?? 0) > 0)) facts.dueDate = due
  if (paid > 0) {
    const how = payment.how as MoneyHow
    const acct = moneyAccount(ctx, how, payment.accountId, 'payment')
    const payKind: VoucherKind = sale ? 'receipt' : 'payment'
    const { type: payType, number: payNumber } = typeOf(ctx, payKind, null, 'payment')
    entries.push(
      accountingEntry(ctx, 'payment', payKind, payType, {
        date,
        number: payNumber,
        rows: sale ? [row('dr', acct.id, paid), row('cr', party.id, paid)] : [row('dr', party.id, paid), row('cr', acct.id, paid)],
        narration: n.narration,
        instrumentNo: payment.reference ?? '',
        billRefs: [{ kind: 'against', name: billName, amount: paid, dueDate: null }]
      })
    )
    facts.how = how
    facts.moneyAccount = acct.name
  }
  return { entries, facts }
}

// ---------------------------------------------------------------- money in / out / move

/** Bill-wise allocation over the Outstandings engine's open bills: the named bills (each at its
 *  pending amount unless given), or oldest first up to the amount.
 *
 *  What is left over: with the advance flag ("for a bill you haven't made yet") it is a NEW bill
 *  named after the entry — the accounting form's existing advance flag, whose GSTR-1 treatment
 *  (advances received) is unchanged. Without it, oldest first, the whole entry stays ON ACCOUNT
 *  (no bill refs): the Outstandings engine settles the same bills oldest first and holds the rest
 *  as unapplied credit (an advance) — a 'new' bill on a receipt would show as money owed. Named
 *  bills that come to less than the amount need the flag (bill refs must add up to the entry). */
export function allocateToBills(
  open: readonly IntentOpenBill[],
  amount: number,
  chosen: NBill[] | null,
  advance: boolean,
  advanceName: string
): { refs: VoucherBillRef[]; settled: { name: string; amount: number }[]; advance: number; picked: IntentOpenBill[] } {
  const refs: VoucherBillRef[] = []
  // The open bills oldest first. A settlement names a bill and applies to the OLDEST open bill of
  // that name (shared/outstanding.ts), so two bills of one name (numbering restarts every year)
  // are reached in turn: a ref settles the older in full, the next ref of that name the newer.
  const live = [...open].filter((b) => b.pending > 0).sort((a, b) => a.date.localeCompare(b.date))
  const picked: IntentOpenBill[] = []
  if (chosen) {
    // Each chosen bill is one open bill: by its entry (`billId`) when given, else the oldest of that
    // name not chosen yet. A newer bill that shares its name with an older open one can be paid
    // only once the older is paid off in full by this entry, named before it.
    const paid = new Map<IntentOpenBill, number>()
    chosen.forEach((c, i) => {
      const twins = live.filter((b) => b.name === c.name)
      const b = c.billId != null ? twins.find((x) => x.voucherId === c.billId) : twins.find((x) => !paid.has(x))
      if (!b) fail('simple_bill_unknown', `There is no open bill “${c.name}”`, `bills.${i}`, { bill: c.name })
      if (paid.has(b!)) fail('simple_bill_unknown', `Bill ${c.name} is named twice`, `bills.${i}`, { bill: c.name })
      const amt = c.amount ?? b!.pending
      if (amt > b!.pending) fail('simple_bill_over', `Only ${formatPaise(b!.pending, { symbol: true })} is due on bill ${b!.name}`, `bills.${i}`, { bill: b!.name, amount: formatPaise(b!.pending, { symbol: true }) })
      const blocking = twins.slice(0, twins.indexOf(b!)).find((x) => paid.get(x) !== x.pending)
      if (blocking) fail('simple_bill_older_first', `An older bill ${b!.name} (${blocking.date}) is still open — bills of one name are paid oldest first`, `bills.${i}`, { bill: b!.name, date: blocking.date })
      paid.set(b!, amt)
      picked.push(b!)
      refs.push({ kind: 'against', name: b!.name, amount: amt, dueDate: null })
    })
    const sum = refs.reduce((s, r) => s + r.amount, 0)
    if (sum > amount) fail('simple_bills_exceed', `The bills (${formatPaise(sum, { symbol: true })}) are more than the amount`, 'amount', { amount: formatPaise(sum, { symbol: true }) })
    if (sum < amount && !advance) fail('simple_bills_short', `The bills (${formatPaise(sum, { symbol: true })}) are less than the amount — tick more, or keep the rest as an advance`, 'bills', { amount: formatPaise(sum, { symbol: true }) })
  } else {
    let left = amount
    for (const b of live) {
      if (left <= 0) break
      const amt = Math.min(left, b.pending)
      picked.push(b)
      refs.push({ kind: 'against', name: b.name, amount: amt, dueDate: null })
      left -= amt
    }
  }
  const settled = refs.map((r) => ({ name: r.name, amount: r.amount }))
  const extra = amount - refs.reduce((s, r) => s + r.amount, 0)
  if (extra <= 0) return { refs, settled, advance: 0, picked }
  if (advance) return { refs: [...refs, { kind: 'new', name: advanceName, amount: extra, dueDate: null }], settled, advance: extra, picked }
  // Oldest first with money left over: on account (the engine settles the same bills, FIFO).
  return { refs: [], settled, advance: extra, picked }
}

/** A refund received against a supplier's named credits — or paid against a customer's — oldest first. The Outstandings engine
 *  lets a positive event's 'against' ref use a named credit and opens a bill named after the entry
 *  for any excess — so the excess rides on the last credit's ref (refs add up to the entry). No
 *  named credit: no refs (on account — the engine nets it off unnamed credit, FIFO). */
export function refundRefs(credits: readonly { name: string; amount: number }[], amount: number): VoucherBillRef[] {
  const refs: VoucherBillRef[] = []
  let left = amount
  for (const c of credits) {
    if (left <= 0) break
    if (c.amount <= 0) continue
    const take = Math.min(c.amount, left)
    const same = refs.find((r) => r.name === c.name)
    if (same) same.amount += take
    else refs.push({ kind: 'against', name: c.name, amount: take, dueDate: null })
    left -= take
  }
  if (left > 0 && refs.length) refs[refs.length - 1]!.amount += left
  return refs
}

const NOT_SOURCE: readonly IntentLedgerClass[] = ['cash', 'bank', 'debtor', 'creditor', 'tax']
const OTHER_SIDE: IntentLedgerClass[] = ['income', 'expense', 'other']

function mapMoney(n: Extract<NormalIntent, { kind: 'money_in' | 'money_out' }>, ctx: IntentContext): MappedIntent {
  const into = n.kind === 'money_in'
  const kind: VoucherKind = into ? 'receipt' : 'payment'
  const { type, number } = typeOf(ctx, kind, n.number, 'number')
  const money = into ? n.into : n.from
  const acct = moneyAccount(ctx, money.how, money.accountId, into ? 'into' : 'from')
  const facts: IntentFacts = { ...emptyFacts(n.kind), total: n.amount, paid: n.amount, how: money.how, moneyAccount: acct.name }
  // A refund: from a supplier (money in, WP 9.4) or to a customer (money out) — symmetric.
  const refundParty = into ? (n as Extract<NormalIntent, { kind: 'money_in' }>).supplierId : (n as Extract<NormalIntent, { kind: 'money_out' }>).customerId
  const partyId = into ? n.customerId : n.supplierId
  let other: IntentLedger
  let billRefs: VoucherBillRef[] = []
  if (refundParty != null) {
    // A refund settles what the party holds with us — their named credits (an advance, a note's
    // own bill) oldest first, else it stays on account. A party holding no credit at all is not
    // owed a refund: refused (it would only raise what one side owes) unless the user said it is
    // for something else (`onAccount` — on account, as before).
    other = ledgerOf(ctx, refundParty, [into ? 'creditor' : 'debtor'], 'simple_no_party', 'party', into ? 'supplier' : 'customer')
    const held = ctx.heldCredit?.get(other.id)
    if (!n.onAccount && held !== undefined && held <= 0) {
      if (into) fail('simple_refund_no_credit', `${other.name} owes you nothing back — record it as other money in`, 'party', { name: other.name })
      fail('simple_customer_no_credit', `${other.name} holds no credit with you — there is nothing to pay back`, 'party', { name: other.name })
    }
    billRefs = n.onAccount ? [] : refundRefs(ctx.openCredits?.get(other.id) ?? [], n.amount)
    facts.settled = billRefs.map((r) => ({ name: r.name, amount: r.amount }))
    facts.partyName = other.name
    facts.side = into ? 'supplier' : 'customer'
  } else if (partyId != null) {
    other = ledgerOf(ctx, partyId, [into ? 'debtor' : 'creditor'], 'simple_no_party', 'party', into ? 'customer' : 'supplier')
    const alloc = allocateToBills(ctx.openBills.get(other.id) ?? [], n.amount, n.bills, n.advance, uniqueName(number, ctx.takenNames.get(other.id), n.date))
    billRefs = alloc.refs
    facts.settled = alloc.settled
    facts.advance = alloc.advance
    facts.partyName = other.name
    facts.side = into ? 'customer' : 'supplier'
  } else {
    const otherId = into ? (n as Extract<NormalIntent, { kind: 'money_in' }>).sourceId : (n as Extract<NormalIntent, { kind: 'money_out' }>).drawings ? ctx.defaults.drawingsId : (n as Extract<NormalIntent, { kind: 'money_out' }>).payeeId
    if (otherId == null) return fail('simple_wrong_account', 'There is no Owner’s drawings account — pick the account', 'party')
    other = ledgerOf(ctx, otherId, OTHER_SIDE, 'simple_wrong_account', 'party', into ? 'source of the money' : 'expense')
    if (NOT_SOURCE.includes(other.cls)) fail('simple_wrong_account', `${other.name} can’t be used here`, 'party')
    facts.partyName = other.name
  }
  if (into) {
    facts.fromName = other.name
    facts.toName = acct.name
  } else {
    facts.fromName = acct.name
    facts.toName = other.name
  }
  const rows = into ? [row('dr', acct.id, n.amount), row('cr', other.id, n.amount)] : [row('dr', other.id, n.amount), row('cr', acct.id, n.amount)]
  return {
    entries: [accountingEntry(ctx, 'money', kind, type, { date: n.date, number, rows, narration: n.narration, instrumentNo: money.reference ?? '', billRefs })],
    facts
  }
}

function mapMove(n: Extract<NormalIntent, { kind: 'move_money' }>, ctx: IntentContext): MappedIntent {
  const from = ledgerOf(ctx, n.fromId, ['cash', 'bank'], 'simple_wrong_account', 'from', 'cash or bank account')
  const to = ledgerOf(ctx, n.toId, ['cash', 'bank'], 'simple_wrong_account', 'to', 'cash or bank account')
  if (from.id === to.id) fail('simple_same_account', 'Pick two different accounts', 'to')
  const { type, number } = typeOf(ctx, 'contra', n.number, 'number')
  return {
    entries: [accountingEntry(ctx, 'money', 'contra', type, { date: n.date, number, rows: [row('dr', to.id, n.amount), row('cr', from.id, n.amount)], narration: n.narration, instrumentNo: n.reference ?? '', billRefs: [] })],
    facts: { ...emptyFacts('move_money'), total: n.amount, fromName: from.name, toName: to.name }
  }
}

// ---------------------------------------------------------------- returns

function mapReturn(n: Extract<NormalIntent, { kind: 'return_sale' | 'return_purchase' }>, ctx: IntentContext): MappedIntent {
  const sale = n.kind === 'return_sale'
  const o = ctx.original
  if (!o || o.voucherId !== n.billId || o.kind !== (sale ? 'sales' : 'purchase')) return fail('simple_original_missing', sale ? 'Pick the sale bill being returned' : 'Pick the purchase bill being returned', 'bill')
  const kind: VoucherKind = sale ? 'credit_note' : 'debit_note'
  const party = ledgerOf(ctx, o.partyId, [sale ? 'debtor' : 'creditor'], 'simple_no_party', 'bill', sale ? 'customer' : 'supplier')
  const { type, number } = typeOf(ctx, kind, n.number, 'number')
  const date = n.date
  // A return before its bill would find nothing pending on it (the whole return a credit) and slip
  // past what is left of an amount bill — refused at the date.
  if (date < o.date) fail('simple_return_before_bill', `The bill is dated ${toDisplayDate(o.date)} — a return can only be on that day or later`, 'date', { date: o.date }) // ISO: mapError writes it in the reader's language
  const accountId = o.accountId ?? (sale ? ctx.defaults.salesId : ctx.defaults.purchaseId)
  const account = ledgerOf(ctx, accountId, sale ? ['income'] : ['expense'], 'simple_wrong_account', 'bill', sale ? 'sales account' : 'purchase account')
  // WP 8.0 / s.34: a note against a bill of a GST-charging period (or one that carries tax) keeps its GST.
  const taxedOriginal = returnTaxedOriginal(ctx.invoice, date, o)
  const reference = o.noteReference ?? o.number
  const facts: IntentFacts = { ...emptyFacts(n.kind), partyName: party.name, side: sale ? 'customer' : 'supplier' }

  let note: MappedEntry
  let total: number
  // The note takes what is still pending off the original bill; anything beyond that is its own
  // bill — a CREDIT for the party (a 'new' ref on a settling entry, shared/outstanding.ts), named
  // so it can't be mistaken for another open bill. A note entirely within the pending amount is
  // set against the bill alone; one on a fully paid bill is a credit alone.
  const noteBill = uniqueName(number, ctx.takenNames.get(party.id), date)
  const settle = (t: number): { refs: VoucherBillRef[]; credit: number } => {
    const off = Math.min(Math.max(o.pending, 0), t)
    const refs: VoucherBillRef[] = []
    if (off > 0) refs.push({ kind: 'against', name: o.billName, amount: off, dueDate: null })
    if (t - off > 0) refs.push({ kind: 'new', name: noteBill, amount: t - off, dueDate: date })
    return { refs, credit: t - off }
  }
  const charges = chargesGstOn(ctx.invoice, date) || taxedOriginal
  let settled: { refs: VoucherBillRef[]; credit: number }
  if (n.items) {
    // Rates come from the ORIGINAL bill: main checks that the item rates still give the tax the
    // bill posted (o.rates null = they don't — a rate changed since, or a mixed bill).
    if (charges && o.carriesGst && o.rates == null) return fail('simple_return_rate', 'The GST rates changed since this bill — enter the return in the full editor', 'items')
    const taken = new Map<string, number>()
    const rows: InvoiceRowState[] = n.items.map((r, i) => {
      const line = o.lines.find((l) => l.lineUid === r.lineUid)
      if (!line) return fail('simple_return_line', 'That line is not on the bill', `items.${i}`)
      const left = line.leftMilli - (taken.get(line.lineUid) ?? 0)
      if (r.qtyMilli > left) fail('simple_return_qty', `Only ${left / 1000} left to return on this line`, `items.${i}.qty`, { qty: String(left / 1000) })
      taken.set(line.lineUid, (taken.get(line.lineUid) ?? 0) + r.qtyMilli)
      return returnRow(line, r.qtyMilli)
    })
    const state: InvoiceFormState = {
      ...emptyInvoiceState(date), number, partyId: party.id, accountId: account.id, rows, narration: n.narration, billName: '', billDueDate: date, reference,
      ...(taxedOriginal ? { taxedOriginal: true } : {})
    }
    const probe = computeInvoice(state, { ...ctx.invoice, kind })
    settled = settle(probe.rounded)
    const only = settled.refs.length === 1 ? settled.refs[0]! : null
    const final: InvoiceFormState =
      only && only.kind === 'new' ? { ...state, manualNewBillMode: true, billName: noteBill, billDueDate: date } : { ...state, noteBillRefs: settled.refs }
    const built = invoiceEntry(ctx, 'note', kind, type, final, 'items')
    note = built.entry
    total = built.total
    facts.tax = built.tax
  } else {
    const a = n.amount!
    if (o.amountLeft != null && a.amount > o.amountLeft) {
      const left = formatPaise(Math.max(0, o.amountLeft), { symbol: true })
      fail('simple_return_amount', `Only ${left} of bill ${o.number} is left to return`, 'amount', { amount: left })
    }
    let rate = a.gstRate
    if (rate == null && charges && o.carriesGst) {
      if (o.rates == null || o.rates.length !== 1) return fail('simple_return_rate', 'The bill has more than one GST rate — say the rate of what is returned', 'amount')
      rate = o.rates[0]!
    }
    const lines = ledgerLines(ctx, kind as 'credit_note' | 'debit_note', party, account.id, a.amount, charges ? (rate ?? 0) : 0)
    total = lines.total
    facts.tax = lines.gst.total - lines.gst.taxable
    settled = settle(total)
    note = accountingEntry(ctx, 'note', kind, type, { date, number, rows: lines.rows, narration: n.narration, reference, billRefs: settled.refs })
  }
  facts.total = total
  facts.credit = settled.credit
  const offBill = settled.refs.find((r) => r.kind === 'against')
  if (offBill) {
    facts.againstBill = o.billName
    facts.offBill = offBill.amount
  }
  const entries = [note]
  if (n.refund) {
    // Only the credit the note created can be paid back — never more.
    if (settled.credit <= 0) fail('simple_refund_not_due', `The return comes off bill ${o.billName}, which is not paid yet — nothing to refund`, 'refund', { bill: o.billName })
    const acct = moneyAccount(ctx, n.refund.how, n.refund.accountId, 'refund')
    const payKind: VoucherKind = sale ? 'payment' : 'receipt'
    const { type: payType, number: payNumber } = typeOf(ctx, payKind, null, 'refund')
    const back = settled.credit
    entries.push(
      accountingEntry(ctx, 'refund', payKind, payType, {
        date,
        number: payNumber,
        rows: sale ? [row('dr', party.id, back), row('cr', acct.id, back)] : [row('dr', acct.id, back), row('cr', party.id, back)],
        narration: n.narration,
        instrumentNo: n.refund.reference ?? '',
        // The NOTE's own bill (its credit), by its unique name.
        billRefs: [{ kind: 'against', name: noteBill, amount: back, dueDate: null }]
      })
    )
    facts.paid = back
    facts.how = n.refund.how
    facts.moneyAccount = acct.name
  }
  return { entries, facts }
}

// ---------------------------------------------------------------- entry point

/** Map a normalised intent to the editor form state(s) + payload(s) it saves. Throws AppError
 *  (with the intent's field) when an answer can't be used, NeedTaxLedgers when a GST / round-off
 *  ledger has to be created first. */
export function mapIntent(n: NormalIntent, ctx: IntentContext): MappedIntent {
  switch (n.kind) {
    case 'sale':
    case 'purchase':
      return mapTrade(n, ctx)
    case 'money_in':
    case 'money_out':
      return mapMoney(n, ctx)
    case 'move_money':
      return mapMove(n, ctx)
    case 'return_sale':
    case 'return_purchase':
      return mapReturn(n, ctx)
    case 'stock_count':
      return mapStockCount(n, ctx, emptyFacts('stock_count'))
    case 'make_goods':
      return mapMakeGoods(n, ctx, emptyFacts('make_goods'))
  }
}

// ---------------------------------------------------------------- plain words

/** What will be recorded, in plain sentences (t() + money.ts; never a model). Where the party
 *  stands comes from `balance` (the allocation after the save) when main filled it in. */
export function intentSentences(f: IntentFacts, t: Translate): string[] {
  const m = (p: number): string => formatPaise(p, { symbol: true })
  const out: string[] = []
  const name = f.partyName ?? ''
  const how = f.how ?? 'cash'
  const position = (fallback: () => void): void => {
    if (f.balance == null || !f.side || f.walkIn) return fallback()
    const vars = { name, amount: m(Math.abs(f.balance)) }
    if (f.side === 'customer') out.push(t(f.balance > 0 ? 'simple.saveCard.customerOwes' : f.balance < 0 ? 'simple.saveCard.customerAhead' : 'simple.saveCard.customerSettled', vars))
    else out.push(t(f.balance > 0 ? 'simple.saveCard.supplierOwed' : f.balance < 0 ? 'simple.saveCard.supplierAhead' : 'simple.saveCard.supplierSettled', vars))
  }
  switch (f.kind) {
    case 'sale':
      out.push(t(f.walkIn ? 'simple.intent.saleWalkIn' : 'simple.intent.sale', { amount: m(f.total), name }))
      if (f.tax > 0) out.push(t('simple.intent.tax', { amount: m(f.tax) }))
      if (f.noGst) out.push(t('simple.intent.noGst', { type: f.noGst }))
      if (f.paid > 0) out.push(t('simple.intent.received', { amount: m(f.paid), how }))
      position(() => { if (f.due > 0) out.push(t('simple.intent.dueFrom', { amount: m(f.due), name })) })
      break
    case 'purchase':
      out.push(f.forWhat ? t('simple.intent.purchaseFor', { amount: m(f.total), name, what: f.forWhat }) : t('simple.intent.purchase', { amount: m(f.total), name }))
      if (f.tax > 0) out.push(t('simple.intent.tax', { amount: m(f.tax) }))
      if (f.paid > 0) out.push(t('simple.intent.paid', { amount: m(f.paid), how }))
      position(() => { if (f.due > 0) out.push(t('simple.intent.dueTo', { amount: m(f.due), name })) })
      break
    case 'money_in':
    case 'money_out':
      out.push(t(f.kind === 'money_in' ? 'simple.intent.moneyIn' : 'simple.intent.moneyOut', { amount: m(f.total), name, account: f.moneyAccount ?? '' }))
      for (const s of f.settled) out.push(t('simple.intent.settles', { bill: s.name, amount: m(s.amount) }))
      if (f.advance > 0) out.push(t('simple.intent.advance', { amount: m(f.advance) }))
      position(() => undefined)
      break
    case 'move_money':
      out.push(t('simple.intent.move', { amount: m(f.total), from: f.fromName ?? '', to: f.toName ?? '' }))
      break
    case 'return_sale':
    case 'return_purchase':
      out.push(t(f.kind === 'return_sale' ? 'simple.intent.returnSale' : 'simple.intent.returnPurchase', { amount: m(f.total), name }))
      if (f.tax > 0) out.push(t('simple.intent.tax', { amount: m(f.tax) }))
      if (f.againstBill && f.offBill > 0) out.push(t('simple.intent.offBill', { bill: f.againstBill, amount: m(f.offBill) }))
      if (f.credit > 0) {
        if (f.paid > 0) out.push(t(f.kind === 'return_sale' ? 'simple.intent.refunded' : 'simple.intent.refundIn', { amount: m(f.paid), how }))
        else out.push(t(f.kind === 'return_sale' ? 'simple.intent.creditKept' : 'simple.intent.creditHeld', { amount: m(f.credit), name }))
      }
      // WP 10.8: the kept credit IS where they stand — not said twice.
      if (!(f.credit > 0 && f.paid === 0 && f.balance === -f.credit)) position(() => undefined)
      break
    case 'stock_count':
    case 'make_goods':
      out.push(...stockSentences(f, t))
      break
  }
  return out
}

// ---------------------------------------------------------------- results (IPC shapes)

/** One entry as the accountant sees it (exact accounts, side, amount). */
export interface PreviewEntry {
  role: IntentRole
  kind: VoucherKind
  typeName: string
  number: string
  date: string
  lines: { ledgerId: number; name: string; drCr: 'dr' | 'cr'; amount: number }[]
  billRefs: VoucherBillRef[]
  items: { itemId: number; name: string; qtyMilli: number; ratePaise: number; amount: number; direction: 'in' | 'out' }[]
}

export interface SimplePreview {
  kind: SimpleIntentKind
  sentences: string[]
  facts: IntentFacts
  entries: PreviewEntry[]
  /** Non-blocking notes from the save (negative stock, credit limit), every entry's merged. */
  warnings: SaveVoucherWarnings
  /** WP 9.4: TDS is on and the existing eligibility rules say this payment / bill should carry
   *  TDS (the deduction itself is made in the accountant view). Absent = nothing to say. */
  tds?: { partyName: string; sectionCode: string; tdsPaise: number | null }[]
}

export interface SimplePostResult {
  voucherIds: number[]
  entries: { role: IntentRole; voucherId: number; kind: VoucherKind; number: string }[]
  /** true = this clientId was posted before; nothing new was saved. */
  replayed: boolean
  summary: SaveSummary
  sentences: string[]
  facts: IntentFacts
  warnings: SaveVoucherWarnings
}
