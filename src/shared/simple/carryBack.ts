// WP 9.10 follow-up — the hand-off the OTHER way for an unsaved entry: "Back to simple" from a
// full editor opened by a simple form's "Accountant view" brings what the user changed THERE back
// into the simple form, where the two hold the same fact one-to-one.
//
// `carryBack` is pure. It reads the editor's CURRENT form state next to the state the hand-off
// opened it with (`original`, simple:intentForm's) and the simple form it came from (`base`, kept
// by #122's useKeptForm): a field the user did not touch in the editor keeps the simple form's own
// answer (so a form handed over and straight back is the same form — prices typed with GST
// included), a changed one is read back from the editor. Every editor field with no simple
// counterpart that the user DID change is named in `dropped` (the flow's banner lists them); an
// entry the simple form can't hold at all (a sale whose debit is not a customer, GST that fits no
// rate, a return line at another price …) is `{ ok: false }` and the flow opens as before.
//
// No arithmetic of its own on money: prices change basis only through sell.ts / buy.ts
// (`switchSellBasis` / `switchBuyBasis` / `amountToBasis` — pricing.ts underneath), every carried
// line is checked by the flow's own reader (`exclusiveLines` / `buyIntentLines` / `returnRow` /
// `allocateToBills`) to give back exactly the editor's figures, and a basis that can't is dropped
// for the exact one (prices before GST) rather than rounded.
import type { InvoiceContext, AccountingFormState, AccountingRowState, InvoiceFormState, InvoiceRowState, TaxLedgerIds, TaxSide } from '../voucherEdit'
import type { HandoffEntry, HandoffPending } from './handoff'
import { allocateToBills, foldGstIntoLine, returnRow, returnTaxedOriginal, type IntentDefaults, type IntentLedger, type IntentOriginal, type MoneyHow } from './intents'
import { addBreakups, computeGst, supplyTypeFor, type SupplyType } from '../gst/calc'
import { chargesGstOn } from '../gst/registration'
import { GST_RATE_TABLE } from '../gst/rateTable'
import { roundToRupee } from '../money'
import { solveTaxable } from '../pricing'
import { amountToBasis, exclusiveLines, qtyMilliOf, switchSellBasis, type SellContext, type SellForm, type SellLine } from './sell'
import { buyGst, buyIntentLines, switchBuyBasis, type BuyContext, type BuyForm, type BuyLine } from './buy'
import { ticksToBills, type MoneyInForm, type MoneyOpenBill, type MoneyOutForm, type MoveForm } from './money'
import { returnQtyOf, type ReturnForm } from './returns'

/** The simple flows an unsaved hand-off can come back to. */
export const CARRY_FLOWS = ['simple-sell', 'simple-buy', 'simple-money-in', 'simple-money-out', 'simple-move-money', 'simple-return-sale', 'simple-return-purchase'] as const
export type CarryFlow = (typeof CARRY_FLOWS)[number]

export interface CarryForms {
  'simple-sell': SellForm
  'simple-buy': BuyForm
  'simple-money-in': MoneyInForm
  'simple-money-out': MoneyOutForm
  'simple-move-money': MoveForm
  'simple-return-sale': ReturnForm
  'simple-return-purchase': ReturnForm
}

/** Editor fields with no place in the simple form (the banner's words: `simple.handoff.dropped.*`). */
export const CARRY_DROPPED = [
  'number', 'account', 'extraLines', 'tds', 'tcs', 'costCentres', 'transport', 'currency', 'placeOfSupply', 'optional',
  'dueDate', 'billName', 'billRefs', 'billSplit', 'godowns', 'serials', 'cheque', 'rounding'
] as const
export type CarryDropped = (typeof CARRY_DROPPED)[number]

/** Why an entry can't come back at all (tests / logs only — the flow says it in plain words). */
export type CarryRefusal =
  | 'form' // the editor is not the one the hand-off opened (invoice vs accounting)
  | 'party' // no customer / supplier, or one of the wrong kind (a non-party debit on a sale)
  | 'lines' // the rows can't be read as the flow's lines (mixed kinds, no cash / bank, a line off the bill)
  | 'gst' // the tax fits no GST rate
  | 'price' // a return line at another price than its bill's

/** What main knows that the mapping needs (loaded next to simple:post's own context). */
export interface CarryContext {
  invoice: Omit<InvoiceContext, 'kind'>
  ledgers: ReadonlyMap<number, Pick<IntentLedger, 'id' | 'cls' | 'stateCode' | 'gstRate'>>
  taxLedgers: Record<TaxSide, TaxLedgerIds>
  /** The counter's walk-in customer ("Cash sale"), when it exists. */
  walkInId: number | null
  defaults: Pick<IntentDefaults, 'salesId' | 'purchaseId' | 'drawingsId'>
  /** Per party: its open bills as on the entry's date (Money in / out ticks). */
  openBills: ReadonlyMap<number, readonly MoneyOpenBill[]>
  /** The bill a return is made against (simplePost.loadOriginal). */
  original: IntentOriginal | null
}

export interface CarryInput<F extends CarryFlow = CarryFlow> {
  flow: F
  /** The entry as the hand-off opened the editor. */
  original: HandoffEntry
  /** The same entry as the editor holds it now (its pending accounts included). */
  current: HandoffEntry
  /** The simple form the hand-off came from. */
  base: CarryForms[F]
}

export type CarryResult<F extends CarryFlow = CarryFlow> = { ok: true; form: CarryForms[F]; dropped: CarryDropped[] } | { ok: false; reason: CarryRefusal }

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

class Refuse extends Error {
  constructor(readonly reason: CarryRefusal) {
    super(reason)
  }
}
const refuse = (reason: CarryRefusal): never => {
  throw new Refuse(reason)
}

/** What the editor changed beyond the simple form: compared with `ref` — the entry the carried
 *  form itself hands off (`remap`), else the one the hand-off opened with. */
class Dropped {
  readonly list: CarryDropped[] = []
  constructor(readonly ref: HandoffEntry) {}
  add(d: CarryDropped, when = true): void {
    if (when && !this.list.includes(d)) this.list.push(d)
  }
}

export function carryBack<F extends CarryFlow>(input: CarryInput<F>, ctx: CarryContext, opts: { remap?: (form: CarryForms[F]) => HandoffEntry | null } = {}): CarryResult<F> {
  try {
    let dropped = new Dropped(input.original)
    const form = carry(input as CarryInput, ctx, dropped) as CarryForms[F]
    // What the editor holds beyond the simple form is what differs from the entry the carried form
    // ITSELF hands off — a due date or a note's bill split follows the carried date / lines there.
    const ref = opts.remap ? safely(() => opts.remap!(form)) : null
    if (ref) {
      if (ref.form !== input.current.form) return { ok: false, reason: 'form' }
      dropped = new Dropped(ref)
      carry(input as CarryInput, ctx, dropped)
    }
    return { ok: true, form, dropped: CARRY_DROPPED.filter((d) => dropped.list.includes(d)) }
  } catch (e) {
    if (e instanceof Refuse) return { ok: false, reason: e.reason }
    throw e
  }
}

/** The answers without what is paid / refunded now — the bill alone, as `remap` maps it (a payment
 *  answer kept from the simple form may not fit the carried party yet: the form asks again). */
export function billOnly<T extends Record<string, unknown>>(intent: T): T {
  const { payment: _payment, refund: _refund, ...rest } = intent
  return rest as T
}

function safely<T>(fn: () => T): T | null {
  try {
    return fn()
  } catch {
    return null
  }
}

const refInv = (d: Dropped): InvoiceFormState => (d.ref as Inv).state
const refAcc = (d: Dropped): AccountingFormState => (d.ref as Acc).state

/** The reference entry's trading rows (for what changed in the editor). */
const refRows = (dropped: Dropped, ctx: CarryContext, partyDr: boolean, accountCls: IntentLedger['cls'], ok: (k: RowKind) => boolean): TradeRows =>
  tradeRows(dropped.ref as Acc, ctx, partyDr, accountCls, ok)

function carry(input: CarryInput, ctx: CarryContext, dropped: Dropped): CarryForms[CarryFlow] {
  const { flow, original, current } = input
  if (original.form !== current.form) refuse('form')
  switch (flow) {
    case 'simple-sell':
      return current.form === 'invoice' ? sellItems(input as CarryInput<'simple-sell'>, ctx, dropped) : sellAmount(input as CarryInput<'simple-sell'>, ctx, dropped)
    case 'simple-buy':
      return current.form === 'invoice' ? buyItems(input as CarryInput<'simple-buy'>, ctx, dropped) : buyAmount(input as CarryInput<'simple-buy'>, ctx, dropped)
    case 'simple-money-in':
      return moneyIn(input as CarryInput<'simple-money-in'>, ctx, dropped)
    case 'simple-money-out':
      return original.kind === 'purchase' ? expenseBill(input as CarryInput<'simple-money-out'>, ctx, dropped) : moneyOut(input as CarryInput<'simple-money-out'>, ctx, dropped)
    case 'simple-move-money':
      return move(input as CarryInput<'simple-move-money'>, ctx, dropped)
    case 'simple-return-sale':
    case 'simple-return-purchase':
      return returned(input as CarryInput<'simple-return-sale'>, ctx, dropped)
  }
}

// ---------------------------------------------------------------- shared readers

type Inv = HandoffEntry & { form: 'invoice' }
type Acc = HandoffEntry & { form: 'accounting' }

const supplyOf = (ctx: CarryContext, partyId: number | null): SupplyType =>
  supplyTypeFor(ctx.invoice.companyStateCode, (partyId != null ? ctx.ledgers.get(partyId)?.stateCode : null) ?? ctx.invoice.companyStateCode)

/** What the invoice editor holds that a simple form has no place for — named when changed. */
function invoiceExtras(o: InvoiceFormState, c: InvoiceFormState, dropped: Dropped): void {
  dropped.add('number', c.number.trim() !== '' && c.number.trim() !== o.number.trim())
  dropped.add('transport', c.vehicleNo !== o.vehicleNo || c.transporterId !== o.transporterId || c.distanceKm !== o.distanceKm)
  dropped.add('currency', c.currencyCode !== o.currencyCode || c.fxRateText !== o.fxRateText)
  dropped.add('placeOfSupply', (c.posOverride ?? null) !== (o.posOverride ?? null))
  dropped.add('optional', c.optional !== o.optional)
  dropped.add('dueDate', c.billDueDate !== o.billDueDate)
  dropped.add('tds', !same(c.tds, o.tds))
  dropped.add('tcs', !same(c.tcs, o.tcs))
  // A note's split against its bill follows its total; only another bill or kind of split counts.
  const shape = (x: InvoiceFormState): unknown => x.noteBillRefs.map((r) => [r.kind, r.name])
  dropped.add('billRefs', c.manualNewBillMode !== o.manualNewBillMode || !same(shape(c), shape(o)))
  c.rows.forEach((r, i) => {
    const was = o.rows[i]
    dropped.add('godowns', (r.godownId ?? null) !== (was?.godownId ?? null) || (r.batchId ?? null) !== (was?.batchId ?? null))
    dropped.add('serials', (r.serials?.length ?? 0) > 0 && !same(r.serials, was?.serials))
  })
}

/** The same for the accounting editor (rows are read by the caller). */
function accountingExtras(o: AccountingFormState, c: AccountingFormState, dropped: Dropped, opts: { instrument: boolean }): void {
  dropped.add('number', c.number.trim() !== '' && c.number.trim() !== o.number.trim())
  dropped.add('optional', c.optional !== o.optional)
  dropped.add('tds', !same(c.tds, o.tds))
  dropped.add('tcs', !same(c.tcs ?? null, o.tcs ?? null))
  dropped.add('costCentres', c.rows.some((r) => r.costAllocations.length > 0))
  if (!opts.instrument) dropped.add('cheque', c.instrumentNo.trim() !== o.instrumentNo.trim())
}

type RowKind = 'tax' | 'roundOff' | 'walkIn' | IntentLedger['cls'] | 'unknown'

/** What an accounting row's account is to the mapping (a pending one by how the editor makes it). */
function rowKind(ctx: CarryContext, side: TaxSide, ledgerId: number | null, pending: HandoffPending | null | undefined): { kind: RowKind; head?: 'cgst' | 'sgst' | 'igst' | 'cess' } {
  if (ledgerId == null) {
    if (pending?.create.kind === 'tax') return { kind: 'tax', head: pending.create.taxType }
    if (pending?.create.kind === 'roundOff') return { kind: 'roundOff' }
    if (pending?.create.kind === 'walkIn') return { kind: 'walkIn' }
    return { kind: 'unknown' }
  }
  const t = ctx.taxLedgers[side]
  for (const head of ['cgst', 'sgst', 'igst', 'cess'] as const) if (t[head] === ledgerId) return { kind: 'tax', head }
  if (t.roundOff === ledgerId) return { kind: 'roundOff' }
  if (ctx.walkInId != null && ledgerId === ctx.walkInId) return { kind: 'walkIn' }
  return { kind: ctx.ledgers.get(ledgerId)?.cls ?? 'unknown' }
}

interface TradeRows {
  partyId: number | null
  walkIn: boolean
  total: number
  accountId: number
  taxable: number
  tax: { cgst: number; sgst: number; igst: number; cess: number }
  /** Round off as posted (+ added to the bill). */
  rounding: number
  extra: boolean
}

/** A ledger-line trading entry's rows the way mapIntent's ledgerLines writes them: the party (Dr on
 *  a sale / debit note, Cr on a purchase / credit note), ONE account line at the value before GST,
 *  GST heads, round off; anything else is an extra line. */
function tradeRows(e: Acc, ctx: CarryContext, partyDr: boolean, accountCls: IntentLedger['cls'], partyOk: (k: RowKind) => boolean): TradeRows {
  const side: TaxSide = e.kind === 'purchase' || e.kind === 'debit_note' ? 'input' : 'output'
  const partySide = partyDr ? 'dr' : 'cr'
  const posted = e.state.rows.map((r, i) => ({ r, i, k: rowKind(ctx, side, r.ledgerId, e.pending?.rows?.[i]) })).filter((x) => (x.r.amount ?? 0) > 0)
  const partyRow = posted.find((x) => x.r.drCr === partySide && x.k.kind !== 'tax' && x.k.kind !== 'roundOff')
  if (!partyRow || !partyOk(partyRow.k.kind)) return refuse('party')
  const accountRow = posted.find((x) => x !== partyRow && x.r.drCr !== partySide && x.k.kind === accountCls)
  if (!accountRow) return refuse('lines')
  const tax = { cgst: 0, sgst: 0, igst: 0, cess: 0 }
  let rounding = 0
  let extra = false
  for (const x of posted) {
    if (x === partyRow || x === accountRow) continue
    if (x.k.kind === 'tax' && x.r.drCr !== partySide) tax[x.k.head!] += x.r.amount!
    else if (x.k.kind === 'roundOff') rounding += x.r.drCr !== partySide ? x.r.amount! : -x.r.amount!
    else extra = true
  }
  return {
    partyId: partyRow.k.kind === 'walkIn' ? null : partyRow.r.ledgerId,
    walkIn: partyRow.k.kind === 'walkIn',
    total: partyRow.r.amount!,
    accountId: accountRow.r.ledgerId!,
    taxable: accountRow.r.amount!,
    tax,
    rounding,
    extra
  }
}

/** Every GST rate the books know (the dated slabs of every period), the given ones first. */
function rateCandidates(first: (number | null | undefined)[]): number[] {
  const out: number[] = []
  for (const r of [...first, 0, ...GST_RATE_TABLE.flatMap((p) => p.slabs.map((s) => s.rate))]) if (r != null && !out.includes(r)) out.push(r)
  return out
}

/** The GST rate whose computeGst gives exactly these heads on this value (null = none does). */
function rateFor(taxable: number, tax: TradeRows['tax'], supply: SupplyType, first: (number | null | undefined)[]): number | null {
  if (tax.cess !== 0) return null
  for (const r of rateCandidates(first)) {
    const g = computeGst(taxable, r, supply)
    if (g.cgst === tax.cgst && g.sgst === tax.sgst && g.igst === tax.igst) return r
  }
  return null
}

/** The rupee-rounded bill of a value and its GST (ledgerLines' total without a printed total). */
const roundedBill = (taxable: number, rate: number, supply: SupplyType): number => roundToRupee(addBreakups([computeGst(taxable, rate, supply)]).total)

const rowOf = (l: { itemId: number | null; qtyText: string; rate: number | null; discount: number | null }): string =>
  JSON.stringify([l.itemId, qtyMilliOf(l.qtyText), l.rate, l.discount || null])

const editorRow = (r: InvoiceRowState): string => JSON.stringify([r.itemId, qtyMilliOf(r.qtyText), r.rate, r.discount || null])

/** The editor rows as lines in the editor's basis (before GST); `unchanged[i]` = row i is the row
 *  the hand-off opened with at that place. */
function readLines<L extends { key: number; itemId: number | null; qtyText: string; rate: number | null; discount: number | null }>(
  o: InvoiceFormState,
  c: InvoiceFormState,
  base: L[],
  complete: (l: L) => boolean
): { lines: L[]; unchanged: boolean[]; baseComplete: L[]; incomplete: L[] } {
  const baseComplete = base.filter(complete)
  const incomplete = base.filter((l) => !complete(l))
  const unchanged = c.rows.map((r, i) => o.rows[i] != null && editorRow(r) === editorRow(o.rows[i]!) && baseComplete[i] != null)
  const lines = c.rows.map((r, i) =>
    unchanged[i] ? baseComplete[i]! : ({ ...(baseComplete[i] ?? {}), key: -(i + 1), itemId: r.itemId, qtyText: r.qtyText, rate: r.rate, discount: r.discount || null, auto: false } as unknown as L)
  )
  return { lines, unchanged, baseComplete, incomplete }
}

// ---------------------------------------------------------------- Make a bill

const sellCtx = (ctx: CarryContext): SellContext => ({ invoice: ctx.invoice, salesAccountId: ctx.defaults.salesId })

function sellParty(c: InvoiceFormState, pending: HandoffEntry['pending'], ctx: CarryContext): number | null {
  if (c.partyId == null) return pending?.party?.create.kind === 'walkIn' ? null : refuse('party')
  if (ctx.walkInId != null && c.partyId === ctx.walkInId) return null
  return ctx.ledgers.get(c.partyId)?.cls === 'debtor' ? c.partyId : refuse('party')
}

function sellItems(input: CarryInput<'simple-sell'>, ctx: CarryContext, dropped: Dropped): SellForm {
  const o = (input.original as Inv).state
  const c = (input.current as Inv).state
  const base = input.base
  invoiceExtras(refInv(dropped), c, dropped)
  dropped.add('billName', c.billName.trim() !== refInv(dropped).billName.trim())
  dropped.add('account', c.accountId !== refInv(dropped).accountId)
  const customerId = sellParty(c, input.current.pending, ctx)
  const head: SellForm = { ...base, date: c.date, customerId, mode: 'items', note: c.narration }
  const sctx = sellCtx(ctx)
  const complete = (l: SellLine): boolean => l.itemId != null && qtyMilliOf(l.qtyText) != null && l.rate != null
  const { lines, unchanged, incomplete } = readLines(o, c, base.lines, complete)
  const want = c.rows.filter((r) => r.itemId != null && qtyMilliOf(r.qtyText) != null && r.rate != null).map(editorRow)
  const gives = (f: SellForm): boolean => same(exclusiveLines(f, sctx).lines.map((l) => JSON.stringify([l.itemId, l.qtyMilli, l.rate, l.discount || null])), want)
  // In the editor's basis (before GST) every line is the editor's own.
  const exclusive: SellForm = { ...head, ratesIncludeGst: false, lines: [...lines.map((l, i) => (unchanged[i] && base.ratesIncludeGst ? editorLine(c.rows[i]!, l) : l)), ...incomplete] }
  if (!base.ratesIncludeGst) return gives(exclusive) ? exclusive : refuse('lines')
  // Prices typed with GST: the untouched lines as typed, the changed ones converted (sell.ts).
  const switched = switchSellBasis(exclusive, sctx, true)
  const incl: SellForm = { ...switched, lines: switched.lines.map((l, i) => (i < lines.length && unchanged[i] ? lines[i]! : l)) }
  if (gives(incl)) return incl
  return gives(exclusive) ? exclusive : refuse('lines')
}

/** A line read straight from the editor row (its basis: before GST). */
function editorLine<L extends { key: number }>(r: InvoiceRowState, l: L): L {
  return { ...l, itemId: r.itemId, qtyText: r.qtyText, rate: r.rate, discount: r.discount || null, auto: false } as L
}

function sellAmount(input: CarryInput<'simple-sell'>, ctx: CarryContext, dropped: Dropped): SellForm {
  const o = (input.original as Acc).state
  const c = (input.current as Acc).state
  const base = input.base
  accountingExtras(refAcc(dropped), c, dropped, { instrument: false })
  const ok = (k: RowKind): boolean => k === 'debtor' || k === 'walkIn'
  const was = tradeRows(input.original as Acc, ctx, true, 'income', ok)
  const now = tradeRows(input.current as Acc, ctx, true, 'income', ok)
  dropped.add('extraLines', now.extra)
  dropped.add('account', now.accountId !== refRows(dropped, ctx, true, 'income', ok).accountId)
  dropped.add('billRefs', !sameRefShape(refAcc(dropped), c))
  const supply = supplyOf(ctx, now.partyId)
  const charges = chargesGstOn(ctx.invoice, c.date)
  const rate = rateFor(now.taxable, now.tax, supply, [base.gstRate, ctx.ledgers.get(now.accountId)?.gstRate])
  if (rate == null || (!charges && rate !== 0)) return refuse('gst')
  dropped.add('rounding', now.total !== roundedBill(now.taxable, rate, supply))
  const head: SellForm = { ...base, date: c.date, customerId: now.partyId, mode: 'amount', note: c.narration, gstRate: charges ? rate : base.gstRate }
  const untouched = now.taxable === was.taxable && rate === (base.gstRate ?? rate) && same(now.tax, was.tax)
  if (untouched && base.amount != null) return { ...head, gstRate: base.gstRate }
  return { ...head, ...amountIn(now.taxable, rate, supply, base.ratesIncludeGst && charges) }
}

/** "Just an amount" in the form's basis — with GST when it was typed so and that gives back the
 *  same value before GST (solveTaxable, what the intent posts), else before GST. */
function amountIn(taxable: number, rate: number, supply: SupplyType, incl: boolean): { amount: number; ratesIncludeGst?: boolean } {
  if (!incl || rate <= 0) return { amount: taxable }
  const withGst = amountToBasis(taxable, rate, supply, true)
  return solveTaxable(withGst, rate, 0, supply).taxablePaise === taxable ? { amount: withGst, ratesIncludeGst: true } : { amount: taxable, ratesIncludeGst: false }
}

/** The bill-wise refs of a trading entry agree in everything but their amounts (the total moves
 *  with the lines). */
function sameRefShape(o: AccountingFormState, c: AccountingFormState): boolean {
  const shape = (s: AccountingFormState): unknown => s.billRefs.map((r) => [r.kind, r.name, r.dueDate])
  return same(shape(o), shape(c)) && c.advanceReceipt === o.advanceReceipt
}

// ---------------------------------------------------------------- Record a purchase

const buyCtx = (ctx: CarryContext): BuyContext => ({ invoice: ctx.invoice, purchaseAccountId: ctx.defaults.purchaseId })

function buyParty(id: number | null, ctx: CarryContext): number {
  return id != null && ctx.ledgers.get(id)?.cls === 'creditor' ? id : refuse('party')
}

function buyItems(input: CarryInput<'simple-buy'>, ctx: CarryContext, dropped: Dropped): BuyForm {
  const o = (input.original as Inv).state
  const c = (input.current as Inv).state
  const base = input.base
  invoiceExtras(refInv(dropped), c, dropped)
  dropped.add('account', c.accountId !== refInv(dropped).accountId)
  const supplierId = buyParty(c.partyId, ctx)
  // The supplier's bill number is the bill's name in the editor (mapIntent: billName = billNo).
  const billNo = c.billName.trim() !== o.billName.trim() ? c.billName.trim() : base.billNo
  const head: BuyForm = { ...base, date: c.date, supplierId, billNo, mode: 'items', note: c.narration }
  const bctx = buyCtx(ctx)
  const complete = (l: BuyLine): boolean => l.itemId != null && qtyMilliOf(l.qtyText) != null && l.rate != null
  const { lines, unchanged, incomplete } = readLines(o, c, base.lines, complete)
  const want = c.rows.filter((r) => r.itemId != null && qtyMilliOf(r.qtyText) != null && r.rate != null).map(editorRow)
  const gives = (f: BuyForm): boolean => {
    const g = buyGst(f, bctx)
    const rows = buyIntentLines(f, bctx).lines.map((l) => (g === 'fold' ? { ...l, ...foldGstIntoLine(l.qtyMilli, l.rate, l.discount || null, ctx.invoice.items.get(l.itemId)?.gstRate ?? null) } : l))
    return same(rows.map((l) => JSON.stringify([l.itemId, l.qtyMilli, l.rate, l.discount || null])), want)
  }
  const g = buyGst(head, bctx)
  const asTyped: BuyForm = { ...head, lines: [...lines, ...incomplete] }
  if (gives(asTyped)) return asTyped
  // Lines the user changed are the editor's figures, which are before GST on a claimed bill and
  // the cost itself for a company that can't claim ("prices with GST" = what was paid).
  const editorBasis = g === 'claim' || g === 'none' ? false : true
  const exact: BuyForm = { ...head, ratesIncludeGst: editorBasis, lines: [...lines.map((l, i) => (unchanged[i] && base.ratesIncludeGst !== editorBasis ? editorLine(c.rows[i]!, l) : l)), ...incomplete] }
  if (g === 'claim' && base.ratesIncludeGst) {
    const switched = switchBuyBasis(exact, bctx, true)
    const incl: BuyForm = { ...switched, lines: switched.lines.map((l, i) => (i < lines.length && unchanged[i] ? lines[i]! : l)) }
    if (gives(incl)) return incl
  }
  return gives(exact) ? exact : refuse('lines')
}

function buyAmount(input: CarryInput<'simple-buy'>, ctx: CarryContext, dropped: Dropped): BuyForm {
  const o = (input.original as Acc).state
  const c = (input.current as Acc).state
  const base = input.base
  accountingExtras(refAcc(dropped), c, dropped, { instrument: false })
  const ok = (k: RowKind): boolean => k === 'creditor'
  const was = tradeRows(input.original as Acc, ctx, false, 'expense', ok)
  const now = tradeRows(input.current as Acc, ctx, false, 'expense', ok)
  dropped.add('extraLines', now.extra)
  const supplierId = buyParty(now.partyId, ctx)
  // The bill's own name is the supplier's bill number; its due date has no place here.
  const billNo = billNoFrom(o, c, base.billNo)
  dropped.add('billRefs', !sameRefKinds(refAcc(dropped), c))
  dropped.add('dueDate', !same(refAcc(dropped).billRefs.map((r) => r.dueDate), c.billRefs.map((r) => r.dueDate)))
  // Another expense account: the bill becomes "an expense" on that account.
  const mode = now.accountId === was.accountId ? base.mode : now.accountId === ctx.defaults.purchaseId ? 'amount' : 'expense'
  const categoryId = mode === 'expense' ? now.accountId : base.categoryId
  const head: BuyForm = { ...base, date: c.date, supplierId, billNo, mode, categoryId, note: c.narration }
  const bctx = buyCtx(ctx)
  const g = buyGst(head, bctx)
  const supply = supplyOf(ctx, supplierId)
  const untouched = now.taxable === was.taxable && same(now.tax, was.tax) && now.accountId === was.accountId && base.amount != null
  if (g === 'claim') {
    const rate = rateFor(now.taxable, now.tax, supply, [base.gstRate, ctx.ledgers.get(now.accountId)?.gstRate])
    if (rate == null) return refuse('gst')
    dropped.add('rounding', now.total !== roundedBill(now.taxable, rate, supply))
    if (untouched) return head
    return { ...head, gstRate: rate, ...amountIn(now.taxable, rate, supply, base.ratesIncludeGst) }
  }
  if (now.tax.cgst + now.tax.sgst + now.tax.igst + now.tax.cess !== 0) return refuse('gst')
  dropped.add('rounding', now.total !== roundedBill(now.taxable, 0, supply))
  if (untouched) return head
  // No GST on the bill, or a company that can't claim: the editor's figure is the cost itself.
  return { ...head, amount: now.taxable, ...(g === 'none' ? {} : { ratesIncludeGst: true }) }
}

function billNoFrom(o: AccountingFormState, c: AccountingFormState, fallback: string): string {
  const was = o.billRefs.find((r) => r.kind === 'new')?.name
  const now = c.billRefs.find((r) => r.kind === 'new')?.name
  return now != null && now !== was ? now.trim() : fallback
}

const sameRefKinds = (o: AccountingFormState, c: AccountingFormState): boolean => same(o.billRefs.map((r) => r.kind), c.billRefs.map((r) => r.kind))

// ---------------------------------------------------------------- Money in / out / move

type MoneyRows = { accountRow: AccountingRowState & { ledgerId: number; amount: number }; otherRow: (AccountingRowState & { ledgerId: number; amount: number }) | null; extra: boolean }

/** A receipt / payment / contra: the cash or bank line on its side and the other side's line. */
function moneyRows(s: AccountingFormState, ctx: CarryContext, accountSide: 'dr' | 'cr'): MoneyRows {
  const posted = s.rows.filter((r): r is AccountingRowState & { ledgerId: number; amount: number } => r.ledgerId != null && (r.amount ?? 0) > 0)
  const money = (id: number): boolean => ['cash', 'bank'].includes(ctx.ledgers.get(id)?.cls ?? '')
  const accountRow = posted.find((r) => r.drCr === accountSide && money(r.ledgerId))
  if (!accountRow) return refuse('lines')
  const otherRow = posted.find((r) => r.drCr !== accountSide) ?? null
  const extra = posted.length !== 2 || otherRow == null || otherRow.amount !== accountRow.amount || s.rows.some((r) => r.ledgerId == null && (r.amount ?? 0) > 0)
  return { accountRow, otherRow, extra }
}

/** How the money moved: the simple form's own answer while the account is the one it gave, else
 *  read from the account (a cash account is cash; a bank keeps the way it was said, UPI / card). */
function howOf(base: { how: MoneyHow; accountId: number | null }, was: number, now: number, ctx: CarryContext): { how: MoneyHow; accountId: number | null } {
  if (now === was) return { how: base.how, accountId: base.accountId }
  const cls = ctx.ledgers.get(now)?.cls
  return { how: cls === 'cash' ? 'cash' : base.how === 'cash' ? 'bank' : base.how, accountId: now }
}

/** The bill ticks that make allocateToBills write exactly these refs (the simple form's own
 *  answer first). `null` ticks = oldest first. */
function ticksFor(
  refs: AccountingFormState['billRefs'],
  advanceFlag: boolean,
  amount: number,
  open: readonly MoneyOpenBill[],
  prefer: { ticks: string[] | null; advance: boolean }
): { ticks: string[] | null; advance: boolean } | null {
  const want = JSON.stringify(refs.map((r) => [r.kind, r.kind === 'new' ? '' : r.name, r.amount]))
  const against = refs.filter((r) => r.kind === 'against').map((r) => r.name)
  const advance = advanceFlag || refs.some((r) => r.kind === 'new')
  const tries: { ticks: string[] | null; advance: boolean }[] = [prefer, { ticks: null, advance }, { ticks: against, advance }, { ticks: null, advance: !advance }]
  for (const t of tries) {
    let got: AccountingFormState['billRefs']
    try {
      got = allocateToBills(open, amount, ticksToBills(open, amount, t.ticks)?.map((b) => ({ name: b.name, amount: b.amount })) ?? null, t.advance, '').refs
    } catch {
      continue
    }
    if (JSON.stringify(got.map((r) => [r.kind, r.kind === 'new' ? '' : r.name, r.amount])) === want) return t
  }
  return null
}

/** The refs the accounting editor will post (its advance flag adds the remainder as a new bill). */
function postedRefs(s: AccountingFormState, partyAmount: number): AccountingFormState['billRefs'] {
  const refs = [...s.billRefs]
  if (s.advanceReceipt) {
    const left = partyAmount - refs.reduce((t, r) => t + r.amount, 0)
    if (left > 0) refs.push({ kind: 'new', name: '', amount: left, dueDate: null })
  }
  return refs
}

function moneyIn(input: CarryInput<'simple-money-in'>, ctx: CarryContext, dropped: Dropped): MoneyInForm {
  const o = (input.original as Acc).state
  const c = (input.current as Acc).state
  const base = input.base
  accountingExtras(refAcc(dropped), c, dropped, { instrument: true })
  const was = moneyRows(o, ctx, 'dr')
  const now = moneyRows(c, ctx, 'dr')
  dropped.add('extraLines', now.extra)
  if (!now.otherRow) return refuse('lines')
  const other = now.otherRow.ledgerId
  const amount = now.accountRow.amount
  const head: MoneyInForm = {
    ...base,
    date: c.date,
    amount,
    ...howOf(base, was.accountRow.ledgerId, now.accountRow.ledgerId, ctx),
    reference: c.instrumentNo.trim() !== o.instrumentNo.trim() ? c.instrumentNo : base.reference,
    note: c.narration
  }
  const cls = ctx.ledgers.get(other)?.cls
  const sameOther = other === was.otherRow?.ledgerId
  if (cls === 'debtor') {
    const refs = postedRefs(c, amount)
    const unchanged = sameOther && amount === was.accountRow.amount && same(c.billRefs, o.billRefs) && c.advanceReceipt === o.advanceReceipt
    const t = unchanged && base.who === 'customer' ? { ticks: base.ticks, advance: base.advance } : ticksFor(refs, c.advanceReceipt, amount, ctx.openBills.get(other) ?? [], { ticks: base.ticks, advance: base.advance })
    dropped.add('billSplit', t == null)
    const fallback = { ticks: refs.filter((r) => r.kind === 'against').map((r) => r.name), advance: refs.some((r) => r.kind === 'new') }
    return { ...head, who: 'customer', customerId: other, ...(t ?? fallback) }
  }
  if (cls === 'creditor') {
    dropped.add('billSplit', !same(c.billRefs, refAcc(dropped).billRefs))
    return { ...head, who: 'refund', supplierId: other }
  }
  dropped.add('billRefs', c.billRefs.length > 0 && !same(c.billRefs, refAcc(dropped).billRefs))
  if (cls === 'income') return { ...head, who: sameOther ? base.who : 'income', sourceId: other }
  // Owner's money / a loan taken: the account the simple form says (its question tells them apart).
  if (cls === 'other' && (base.who === 'owner' || base.who === 'loan')) return { ...head, sourceId: other }
  return refuse('party')
}

function moneyOut(input: CarryInput<'simple-money-out'>, ctx: CarryContext, dropped: Dropped): MoneyOutForm {
  const o = (input.original as Acc).state
  const c = (input.current as Acc).state
  const base = input.base
  accountingExtras(refAcc(dropped), c, dropped, { instrument: true })
  const was = moneyRows(o, ctx, 'cr')
  const now = moneyRows(c, ctx, 'cr')
  dropped.add('extraLines', now.extra)
  if (!now.otherRow) return refuse('lines')
  const other = now.otherRow.ledgerId
  const amount = now.accountRow.amount
  const head: MoneyOutForm = {
    ...base,
    date: c.date,
    amount,
    ...howOf(base, was.accountRow.ledgerId, now.accountRow.ledgerId, ctx),
    reference: c.instrumentNo.trim() !== o.instrumentNo.trim() ? c.instrumentNo : base.reference,
    note: c.narration
  }
  const cls = ctx.ledgers.get(other)?.cls
  const sameOther = other === was.otherRow?.ledgerId
  if (cls === 'creditor') {
    const refs = postedRefs(c, amount)
    const unchanged = sameOther && amount === was.accountRow.amount && same(c.billRefs, o.billRefs)
    const t = unchanged && base.who === 'supplier' ? { ticks: base.ticks, advance: base.advance } : ticksFor(refs, false, amount, ctx.openBills.get(other) ?? [], { ticks: base.ticks, advance: base.advance })
    dropped.add('billSplit', t == null)
    const fallback = { ticks: refs.filter((r) => r.kind === 'against').map((r) => r.name), advance: refs.some((r) => r.kind === 'new') }
    return { ...head, who: 'supplier', supplierId: other, ...(t ?? fallback) }
  }
  if (cls === 'debtor') {
    dropped.add('billSplit', !same(c.billRefs, refAcc(dropped).billRefs))
    return { ...head, who: 'refund', customerId: other }
  }
  dropped.add('billRefs', c.billRefs.length > 0 && !same(c.billRefs, refAcc(dropped).billRefs))
  if (ctx.defaults.drawingsId != null && other === ctx.defaults.drawingsId) return { ...head, who: 'owner' }
  if (cls === 'expense' || cls === 'income' || cls === 'other') {
    const who = sameOther ? base.who : base.who === 'salary' && cls === 'expense' ? 'salary' : 'expense'
    // A payment, not a GST bill (that hand-off is `expenseBill`).
    return { ...head, who: who === 'owner' ? 'expense' : who, payeeId: other, gstBill: base.gstBill === true ? false : base.gstBill }
  }
  return refuse('party')
}

/** Money out of an expense with a GST bill: the purchase of just an amount the hand-off opened. */
function expenseBill(input: CarryInput<'simple-money-out'>, ctx: CarryContext, dropped: Dropped): MoneyOutForm {
  const o = (input.original as Acc).state
  const c = (input.current as Acc).state
  const base = input.base
  accountingExtras(refAcc(dropped), c, dropped, { instrument: false })
  const ok = (k: RowKind): boolean => k === 'creditor'
  const now = tradeRows(input.current as Acc, ctx, false, 'expense', ok)
  dropped.add('extraLines', now.extra)
  dropped.add('billRefs', !sameRefKinds(refAcc(dropped), c))
  dropped.add('dueDate', !same(refAcc(dropped).billRefs.map((r) => r.dueDate), c.billRefs.map((r) => r.dueDate)))
  const supplierId = buyParty(now.partyId, ctx)
  const supply = supplyOf(ctx, supplierId)
  const rate = rateFor(now.taxable, now.tax, supply, [base.gstRate, ctx.ledgers.get(now.accountId)?.gstRate])
  if (rate == null) return refuse('gst')
  // The amount typed is the bill's total; its value before GST is solveTaxable's (moneyOutIntentFrom).
  dropped.add('rounding', solveTaxable(now.total, rate, 0, supply).taxablePaise !== now.taxable)
  return {
    ...base,
    date: c.date,
    who: 'expense',
    payeeId: now.accountId,
    gstBill: true,
    billSupplierId: supplierId,
    billNo: billNoFrom(o, c, base.billNo),
    gstRate: rate,
    amount: now.total,
    note: c.narration
  }
}

function move(input: CarryInput<'simple-move-money'>, ctx: CarryContext, dropped: Dropped): MoveForm {
  const o = (input.original as Acc).state
  const c = (input.current as Acc).state
  const base = input.base
  accountingExtras(refAcc(dropped), c, dropped, { instrument: true })
  const now = moneyRows(c, ctx, 'dr')
  dropped.add('extraLines', now.extra)
  dropped.add('billRefs', c.billRefs.length > 0)
  const from = now.otherRow?.ledgerId
  if (from == null || !['cash', 'bank'].includes(ctx.ledgers.get(from)?.cls ?? '')) return refuse('lines')
  return {
    ...base,
    date: c.date,
    amount: now.accountRow.amount,
    toId: now.accountRow.ledgerId,
    fromId: from,
    reference: c.instrumentNo.trim() !== o.instrumentNo.trim() ? c.instrumentNo : base.reference,
    note: c.narration
  }
}

// ---------------------------------------------------------------- Returns

function returned(input: CarryInput<'simple-return-sale'>, ctx: CarryContext, dropped: Dropped): ReturnForm {
  const bill = ctx.original
  const base = input.base
  if (!bill) return refuse('lines')
  if (input.current.form === 'invoice') {
    const o = (input.original as Inv).state
    const c = (input.current as Inv).state
    invoiceExtras(refInv(dropped), c, dropped)
    dropped.add('account', c.accountId !== refInv(dropped).accountId)
    if (c.partyId !== bill.partyId) return refuse('party')
    const qty: Record<string, string> = {}
    for (const l of bill.lines) if (base.qty[l.lineUid] != null && returnQtyOf(base.qty[l.lineUid]) === 0) qty[l.lineUid] = base.qty[l.lineUid]!
    for (const r of c.rows) {
      if (r.itemId == null && !r.qtyText.trim() && r.rate == null) continue
      const line = r.source?.linkType === 'return' ? bill.lines.find((l) => l.lineUid === r.source!.lineUid) : undefined
      const q = qtyMilliOf(r.qtyText)
      if (!line || q == null || (qty[line.lineUid] != null && returnQtyOf(qty[line.lineUid]) !== 0)) return refuse('lines')
      const expect = returnRow(line, q)
      if (r.itemId !== expect.itemId || r.rate !== expect.rate || (r.discount || null) !== (expect.discount || null)) return refuse('price')
      // The quantity as the simple form typed it, while it is the same quantity.
      qty[line.lineUid] = base.qty[line.lineUid] != null && returnQtyOf(base.qty[line.lineUid]) === q ? base.qty[line.lineUid]! : r.qtyText
    }
    return { ...base, date: c.date, qty, reason: c.narration }
  }
  const o = (input.original as Acc).state
  const c = (input.current as Acc).state
  accountingExtras(refAcc(dropped), c, dropped, { instrument: false })
  const sale = input.flow === 'simple-return-sale'
  const ok = (k: RowKind): boolean => k === (sale ? 'debtor' : 'creditor') || (sale && k === 'walkIn')
  // A credit note credits the customer (Dr sales, Cr party); a debit note debits the supplier.
  const now = tradeRows(input.current as Acc, ctx, !sale, sale ? 'income' : 'expense', ok)
  if ((now.partyId ?? ctx.walkInId) !== bill.partyId) return refuse('party')
  dropped.add('extraLines', now.extra)
  dropped.add('account', now.accountId !== refRows(dropped, ctx, !sale, sale ? 'income' : 'expense', ok).accountId)
  dropped.add('billRefs', !sameRefKinds(refAcc(dropped), c))
  const supply = supplyOf(ctx, bill.partyId)
  const charges = chargesGstOn(ctx.invoice, c.date) || returnTaxedOriginal(ctx.invoice, c.date, bill)
  const billRate = bill.rates?.length === 1 ? bill.rates[0]! : null
  const rate = rateFor(now.taxable, now.tax, supply, [base.gstRate, billRate])
  if (rate == null || (!charges && rate !== 0)) return refuse('gst')
  dropped.add('rounding', now.total !== roundedBill(now.taxable, rate, supply))
  // The rate is asked only where 9.1 asks it (several or unknown rates on the bill); elsewhere it
  // is the bill's own and must stay so.
  const asked = charges && bill.carriesGst && billRate == null
  if (charges && bill.carriesGst && !asked && rate !== billRate) return refuse('gst')
  return { ...base, date: c.date, amount: now.taxable, gstRate: asked ? rate : base.gstRate, reason: c.narration }
}
