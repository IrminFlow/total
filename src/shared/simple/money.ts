// Money in / out / move (WP 9.4, plan 2026-10-13 §3 "Money in", "Money out", "Move money"): the
// PURE half of the simple Money screens — what the forms' answers become as `money_in` /
// `money_out` / `purchase` (an expense with a GST bill) / `move_money` intents
// (shared/simple/intents.ts), the checks a form makes before it asks main, the bill ticks and the
// read shapes services/simpleMoney.ts returns.
//
// No money arithmetic of its own beyond comparing figures the books gave: which bills a payment
// settles is intents.ts `allocateToBills` (the very function simple:post runs, over the
// Outstandings allocation's open bills), a GST-inclusive bill total becomes its value before GST
// through pricing.ts `solveTaxable` (the editor's calculation), and what was recorded is said by
// simple:preview's sentences.

import type { MessageKey } from '../i18n'
import { supplyTypeFor } from '../gst/calc'
import { chargesGstOn, type GstRegistrationFacts } from '../gst/registration'
import { solveTaxable } from '../pricing'
import { allocateToBills, SIMPLE_MAX_DAYS_AHEAD, type IntentOpenBill, type MoneyHow, type SimpleIntentInput } from './intents'
import { addDaysISO } from '../dates'

/** The ways money moves, as the screens offer them (intents.ts MONEY_HOW). */
export const MONEY_HOWS: readonly MoneyHow[] = ['cash', 'upi', 'bank', 'card']

/** "Who paid?" on Money in. */
export const MONEY_IN_WHO = ['customer', 'owner', 'loan', 'income', 'refund'] as const
export type MoneyInWho = (typeof MONEY_IN_WHO)[number]

/** "Paid to" on Money out (salary only while Payroll is on). */
export const MONEY_OUT_WHO = ['supplier', 'expense', 'owner', 'salary'] as const
export type MoneyOutWho = (typeof MONEY_OUT_WHO)[number]

type WithoutClientId<T> = T extends unknown ? Omit<T, 'clientId'> : never
export type MoneyIntentDraft = WithoutClientId<Extract<SimpleIntentInput, { kind: 'money_in' | 'money_out' | 'purchase' | 'move_money' }>>

// ---------------------------------------------------------------- forms

interface MoneyFormBase {
  date: string
  amount: number | null
  how: MoneyHow
  /** The cash / bank account (null = the default for `how`, from simple:money:setup). */
  accountId: number | null
  /** Cheque / UPI reference (optional). */
  reference: string
  note: string
}

export interface MoneyInForm extends MoneyFormBase {
  who: MoneyInWho
  customerId: number | null
  /** Owner's money / a loan taken / an income account. */
  sourceId: number | null
  /** A refund from this supplier. */
  supplierId: number | null
  /** null = untouched (the bills are settled oldest first); else the bill names the user ticked. */
  ticks: string[] | null
  /** "Is this for a bill you haven't made yet?" — what the bills don't take is an advance. */
  advance: boolean
}

export interface MoneyOutForm extends MoneyFormBase {
  who: MoneyOutWho
  supplierId: number | null
  /** The expense / salary account. */
  payeeId: number | null
  ticks: string[] | null
  advance: boolean
  /** "Do you have a GST bill?" (an expense, regular registration on the date). null = not answered. */
  gstBill: boolean | null
  /** The GST bill: who it is from, its number and rate. */
  billSupplierId: number | null
  billNo: string
  gstRate: number | null
}

export interface MoveForm {
  date: string
  amount: number | null
  fromId: number | null
  toId: number | null
  reference: string
  note: string
}

const base = (date: string): MoneyFormBase => ({ date, amount: null, how: 'cash', accountId: null, reference: '', note: '' })

/** Opened from a bank statement line (WP 9.6): that bank account, its reference and description. */
interface FromBank {
  bankId?: number | null
  reference?: string | null
  note?: string | null
}
const fromBank = (date: string, init: FromBank): MoneyFormBase => ({
  ...base(date),
  ...(init.bankId != null ? { how: 'bank' as const, accountId: init.bankId } : {}),
  ...(init.reference ? { reference: init.reference } : {}),
  ...(init.note ? { note: init.note } : {})
})

export const emptyMoneyInForm = (date: string, init: { customerId?: number | null; amount?: number | null; bill?: string | null } & FromBank = {}): MoneyInForm => ({
  ...fromBank(date, init),
  who: 'customer',
  customerId: init.customerId ?? null,
  sourceId: null,
  supplierId: null,
  amount: init.amount ?? null,
  ticks: init.bill ? [init.bill] : null,
  advance: false
})

export const emptyMoneyOutForm = (date: string, init: { supplierId?: number | null; amount?: number | null; bill?: string | null } & FromBank = {}): MoneyOutForm => ({
  ...fromBank(date, init),
  who: 'supplier',
  supplierId: init.supplierId ?? null,
  payeeId: null,
  amount: init.amount ?? null,
  ticks: init.bill ? [init.bill] : null,
  advance: false,
  gstBill: null,
  billSupplierId: null,
  billNo: '',
  gstRate: null
})

export const emptyMoveForm = (date: string): MoveForm => ({ date, amount: null, fromId: null, toId: null, reference: '', note: '' })

// ---------------------------------------------------------------- bills

/** One open bill as the screens show it (the Outstandings allocation, oldest first). */
export interface MoneyOpenBill extends IntentOpenBill {
  dueDate: string | null
  overdueDays: number
}

/** Which bills an amount settles and how much each, plus what is left as an advance — intents.ts
 *  `allocateToBills`, the same function simple:post runs (untouched = oldest first). A tick list
 *  is applied oldest first up to the amount; a ticked bill the amount doesn't reach is dropped. */
export function billAllocation(
  open: readonly MoneyOpenBill[],
  amount: number | null,
  ticks: string[] | null,
  advance: boolean
): { settled: { name: string; amount: number }[]; advance: number; short: boolean } {
  if (amount == null || amount <= 0) return { settled: [], advance: 0, short: false }
  const chosen = ticksToBills(open, amount, ticks)
  const tickedPending = chosen ? chosen.reduce((s, b) => s + b.amount, 0) : null
  // Ticked bills that come to less than the amount need the advance answer (simple_bills_short).
  if (chosen && tickedPending! < amount && !advance) return { settled: chosen, advance: 0, short: true }
  const r = allocateToBills(open, amount, chosen, advance, '')
  return { settled: r.settled, advance: r.advance, short: false }
}

/** The ticked bills as the intent names them — oldest first, each at what is still due on it,
 *  the last one only up to what the amount still covers. null = untouched (oldest first). */
export function ticksToBills(open: readonly MoneyOpenBill[], amount: number, ticks: string[] | null): { name: string; amount: number }[] | null {
  if (ticks == null) return null
  const want = new Set(ticks)
  const seen = new Set<string>()
  const out: { name: string; amount: number }[] = []
  let left = amount
  for (const b of [...open].sort((x, y) => x.date.localeCompare(y.date))) {
    // A settlement by name applies to the OLDEST open bill of that name.
    if (!want.has(b.name) || seen.has(b.name) || b.pending <= 0) continue
    seen.add(b.name)
    if (left <= 0) break
    const take = Math.min(left, b.pending)
    out.push({ name: b.name, amount: take })
    left -= take
  }
  return out
}

/** The open bill a "Record a payment" link pre-ticks: the one whose entry it is (`billId`, its
 *  name may carry the FY when the party had that name open already), else by name; null = no
 *  longer open (the form falls back to oldest first). */
export function linkedBillName(open: readonly MoneyOpenBill[], bill: string | null | undefined, billId: number | null | undefined): string | null {
  const byId = billId != null ? open.find((b) => b.voucherId === billId && b.pending > 0) : undefined
  if (byId) return byId.name
  if (billId != null) return null
  return bill && open.some((b) => b.name === bill && b.pending > 0) ? bill : null
}

/** The bills a fresh pick shows ticked: the ones the amount settles oldest first. */
export function defaultTicks(open: readonly MoneyOpenBill[], amount: number | null): string[] {
  return billAllocation(open, amount, null, false).settled.map((s) => s.name)
}

// ---------------------------------------------------------------- intents

/** The cash / bank account the money goes into / comes out of: the one picked, else the default
 *  for that way (main's memory / counter defaults). */
export const accountFor = (f: { how: MoneyHow; accountId: number | null }, defaults: Record<MoneyHow, number | null>): number | null => f.accountId ?? defaults[f.how] ?? null

const opt = (s: string): string | undefined => (s.trim() ? s.trim() : undefined)

/** Money in → the `money_in` intent (without its clientId — useSimplePost adds it). */
export function moneyInIntentFrom(
  f: MoneyInForm,
  open: readonly MoneyOpenBill[],
  defaults: Record<MoneyHow, number | null>,
  sources: { ownerId: number | null }
): MoneyIntentDraft {
  const accountId = accountFor(f, defaults)
  const into = { how: f.how, ...(accountId != null ? { accountId } : {}), ...(opt(f.reference) ? { reference: opt(f.reference)! } : {}) }
  const head = { kind: 'money_in' as const, date: f.date, amount: f.amount ?? 0, into, ...(opt(f.note) ? { narration: opt(f.note)! } : {}) }
  if (f.who === 'customer') {
    const bills = f.amount != null && f.amount > 0 ? ticksToBills(open, f.amount, f.ticks) : null
    return { ...head, ...(f.customerId != null ? { customerId: f.customerId } : {}), ...(bills ? { bills } : {}), ...(f.advance ? { advance: true } : {}) }
  }
  if (f.who === 'refund') return { ...head, ...(f.supplierId != null ? { supplierId: f.supplierId } : {}) }
  const sourceId = f.who === 'owner' ? (f.sourceId ?? sources.ownerId) : f.sourceId
  return { ...head, ...(sourceId != null ? { sourceId } : {}) }
}

/** The GST % an expense bill is charged at: the rate asked, only while the date charges GST. */
export const expenseGstApplies = (facts: GstRegistrationFacts, f: Pick<MoneyOutForm, 'who' | 'date'>): boolean => f.who === 'expense' && chargesGstOn(facts, f.date)

/** Money out → `money_out`, or — an expense with a GST bill (regular registration) — a `purchase`
 *  of just an amount on that expense account, paid now (one intent: the bill + its payment). The
 *  amount typed is the bill's total WITH GST; its value before GST is solveTaxable's. */
export function moneyOutIntentFrom(
  f: MoneyOutForm,
  open: readonly MoneyOpenBill[],
  defaults: Record<MoneyHow, number | null>,
  ctx: { facts: GstRegistrationFacts; companyStateCode: string; supplierState: (id: number) => string | null; drawingsId: number | null }
): MoneyIntentDraft {
  const accountId = accountFor(f, defaults)
  const narration = opt(f.note) ? { narration: opt(f.note)! } : {}
  if (f.who === 'expense' && f.gstBill === true && expenseGstApplies(ctx.facts, f)) {
    const rate = f.gstRate ?? 0
    const state = (f.billSupplierId != null ? ctx.supplierState(f.billSupplierId) : null) ?? ctx.companyStateCode
    const taxable = f.amount != null && f.amount > 0 ? solveTaxable(f.amount, rate, 0, supplyTypeFor(ctx.companyStateCode, state)).taxablePaise : 0
    return {
      kind: 'purchase',
      date: f.date,
      supplierId: f.billSupplierId ?? 0,
      ...(opt(f.billNo) ? { billNo: opt(f.billNo)! } : {}),
      // The bill is exactly the total typed (what solveTaxable can't reach is its round off), so
      // the money paid is what left the cash / bank — never a rupee-rounded figure.
      amount: { amount: taxable, ...(f.payeeId != null ? { accountId: f.payeeId } : {}), gstRate: rate, ...(f.amount != null && f.amount > 0 ? { billTotal: f.amount } : {}) },
      payment: { how: f.how, ...(accountId != null ? { accountId } : {}), ...(opt(f.reference) ? { reference: opt(f.reference)! } : {}) },
      ...narration
    }
  }
  const from = { how: f.how, ...(accountId != null ? { accountId } : {}), ...(opt(f.reference) ? { reference: opt(f.reference)! } : {}) }
  const head = { kind: 'money_out' as const, date: f.date, amount: f.amount ?? 0, from, ...narration }
  if (f.who === 'supplier') {
    const bills = f.amount != null && f.amount > 0 ? ticksToBills(open, f.amount, f.ticks) : null
    return { ...head, ...(f.supplierId != null ? { supplierId: f.supplierId } : {}), ...(bills ? { bills } : {}), ...(f.advance ? { advance: true } : {}) }
  }
  if (f.who === 'owner') return { ...head, drawings: true }
  return { ...head, ...(f.payeeId != null ? { payeeId: f.payeeId } : {}) }
}

export function moveIntentFrom(f: MoveForm): MoneyIntentDraft {
  return {
    kind: 'move_money',
    date: f.date,
    amount: f.amount ?? 0,
    fromId: f.fromId ?? 0,
    toId: f.toId ?? 0,
    ...(opt(f.reference) ? { reference: opt(f.reference)! } : {}),
    ...(opt(f.note) ? { narration: opt(f.note)! } : {})
  }
}

// ---------------------------------------------------------------- checks

export type MoneyInField = 'date' | 'party' | 'amount' | 'into' | 'bills'
export type MoneyOutField = 'date' | 'party' | 'amount' | 'from' | 'bills' | 'gstBill' | 'billSupplier' | 'billNo' | 'gstRate'
export type MoveField = 'date' | 'amount' | 'from' | 'to'

const PARTY_MISSING_IN: Record<MoneyInWho, MessageKey> = {
  customer: 'simple.money.err.pickCustomer',
  owner: 'simple.money.err.pickOwner',
  loan: 'simple.money.err.pickLoan',
  income: 'simple.money.err.pickIncome',
  refund: 'simple.money.err.pickSupplier'
}
const PARTY_MISSING_OUT: Record<MoneyOutWho, MessageKey> = {
  supplier: 'simple.money.err.pickSupplier',
  expense: 'simple.money.err.pickExpense',
  owner: 'simple.money.err.noDrawings',
  salary: 'simple.money.err.pickSalary'
}

export function moneyInErrors(f: MoneyInForm, open: readonly MoneyOpenBill[], defaults: Record<MoneyHow, number | null>, sources: { ownerId: number | null }): Partial<Record<MoneyInField, MessageKey>> {
  const out: Partial<Record<MoneyInField, MessageKey>> = {}
  const who = f.who === 'customer' ? f.customerId : f.who === 'refund' ? f.supplierId : f.who === 'owner' ? (f.sourceId ?? sources.ownerId ?? -1) : f.sourceId
  if (who == null) out.party = PARTY_MISSING_IN[f.who]
  if (f.amount == null || f.amount <= 0) out.amount = 'simple.money.err.amount'
  if (accountFor(f, defaults) == null) out.into = f.how === 'cash' ? 'simple.money.err.noCash' : 'simple.money.err.noBank'
  if (f.who === 'customer' && billAllocation(open, f.amount, f.ticks, f.advance).short) out.bills = 'simple.money.err.ticksShort'
  return out
}

export function moneyOutErrors(
  f: MoneyOutForm,
  open: readonly MoneyOpenBill[],
  defaults: Record<MoneyHow, number | null>,
  ctx: { facts: GstRegistrationFacts; drawingsId: number | null }
): Partial<Record<MoneyOutField, MessageKey>> {
  const out: Partial<Record<MoneyOutField, MessageKey>> = {}
  // Owner's drawings: a missing account is added on Save (never a dead end), so not an error here.
  const who = f.who === 'supplier' ? f.supplierId : f.who === 'owner' ? 0 : f.payeeId
  if (who == null) out.party = PARTY_MISSING_OUT[f.who]
  if (f.amount == null || f.amount <= 0) out.amount = 'simple.money.err.amount'
  if (accountFor(f, defaults) == null) out.from = f.how === 'cash' ? 'simple.money.err.noCash' : 'simple.money.err.noBank'
  if (f.who === 'supplier' && billAllocation(open, f.amount, f.ticks, f.advance).short) out.bills = 'simple.money.err.ticksShortOut'
  if (expenseGstApplies(ctx.facts, f)) {
    if (f.gstBill == null) out.gstBill = 'simple.money.err.gstBill'
    else if (f.gstBill) {
      if (f.billSupplierId == null) out.billSupplier = 'simple.money.err.billSupplier'
      if (!f.billNo.trim()) out.billNo = 'simple.money.err.billNo'
      if (f.gstRate == null) out.gstRate = 'simple.money.err.gstRate'
    }
  }
  return out
}

export function moveErrors(f: MoveForm): Partial<Record<MoveField, MessageKey>> {
  const out: Partial<Record<MoveField, MessageKey>> = {}
  if (f.fromId == null) out.from = 'simple.money.err.moveFrom'
  if (f.toId == null) out.to = 'simple.money.err.moveTo'
  else if (f.fromId === f.toId) out.to = 'errors.intent.sameAccount'
  if (f.amount == null || f.amount <= 0) out.amount = 'simple.money.err.amount'
  return out
}

/** A refusal from main for a purchase-with-GST-bill intent is on the PURCHASE's fields: its party
 *  is the bill's supplier, its account the expense ("Paid to"), its payment the "from" account. */
export function moneyOutFieldOf(field: string | undefined, purchase: boolean): string | undefined {
  if (!field || !purchase) return field
  const head = field.split('.')[0]
  const map: Record<string, string> = { party: 'billSupplier', account: 'party', amount: 'amount', items: 'amount', payment: 'from', billNo: 'billNo', date: 'date' }
  return map[head!] ?? field
}

// ---------------------------------------------------------------- read shapes (services/simpleMoney.ts)

export interface MoneyParty {
  id: number
  name: string
  stateCode: string | null
  phone: string | null
}

export interface MoneySetup {
  customers: MoneyParty[]
  suppliers: MoneyParty[]
  moneyAccounts: { id: number; name: string; kind: 'cash' | 'bank' }[]
  /** Per way of paying, the default account: money in = the WP 5.6 memory "Receive into" (a
   *  bank), money out = the memory for payments; else the counter's accounts / first bank. */
  defaultsIn: Record<MoneyHow, number | null>
  defaultsOut: Record<MoneyHow, number | null>
  memoryIn: number | null
  memoryOut: number | null
  /** "Owner's money" (Capital Account) / "Owner's drawings" — null until added. */
  ownerId: number | null
  drawingsId: number | null
  /** Loans taken (under Loans (Liability)). */
  loans: { id: number; name: string }[]
  /** Features: TDS (the read-only hint) and Payroll (the Salary choice). */
  tds: boolean
  payroll: boolean
}

export type MoneyDirection = 'in' | 'out' | 'move'
export type MoneyChip = 'bills' | 'advance' | 'onAccount' | 'owner' | 'loan' | 'expense' | 'income' | 'refund'

export interface MoneyRow {
  voucherId: number
  number: string
  date: string
  direction: MoneyDirection
  /** Who paid / was paid (a party or the other account); for a move, where it went. */
  who: string
  partyId: number | null
  /** The cash / bank account (a move: where it came from). */
  account: string
  amount: number
  chips: MoneyChip[]
  /** How many bills the entry settles. */
  billCount: number
  /** Dated after today (simple dates may be up to SIMPLE_MAX_DAYS_AHEAD days ahead). Optional
   *  (absent = not ahead). */
  ahead?: true
}

/** The money list's last day: up to SIMPLE_MAX_DAYS_AHEAD days after the working date (an entry
 *  simple:post accepted is listed at once), or the period's end when the working date is past it. */
export function moneyListUntil(workingDate: string, periodEnd: string): string {
  return workingDate > periodEnd ? periodEnd : addDaysISO(workingDate, SIMPLE_MAX_DAYS_AHEAD)
}

export interface MoneyEntryView extends MoneyRow {
  kind: 'receipt' | 'payment' | 'contra'
  bills: { name: string; amount: number; advance: boolean }[]
  note: string | null
  reference: string | null
}
