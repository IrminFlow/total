// WP 5.3 drafting — the building half: resolved inputs → the EDITOR'S form state (built by the
// same @shared/voucherEdit / tradeCycle mapping the editor uses, so the draft opens in its proper
// mode and saves to the same rows) → the payload that state posts → a rehearsed save (rehearse.ts)
// → the stored draft payload with its sources and assumptions.
//
// The model never supplies a tax amount, a total or an allocation: GST comes from computeInvoice
// (the invoice editor's own calculation), bill amounts from the Outstandings allocation (openBills),
// prices from the pricing resolver (resolvePrice), manufacture costs from the valuation engine
// (costPreview) — and every figure in a draft summary is formatted from those integers.
import type { DB } from '../../db/connection'
import type { Ledger, SaveVoucherWarnings, StockItem, TradeDocKind, VoucherKind, VoucherType } from '@shared/domain'
import type { AiDraftForm, AiVoucherDraftPayload } from '@shared/ai'
import { formatPaise, formatQtyMilli } from '@shared/money'
import { addDaysISO, toDisplayDate } from '@shared/dates'
import { supplyTypeFor } from '@shared/gst/calc'
import { stateName } from '@shared/gst/states'
import { voucherInputSchema, type VoucherInputParsed } from '@shared/schemas'
import { validateVoucher } from '@shared/posting'
import { resolveName } from '@shared/aiResolve'
import { pickBomVersion, explodeBom } from '@shared/bom'
import { needsLossConfirmation } from '@shared/manufacture'
import {
  buildAccountingPayload, buildInvoicePayload, buildStockNotePayload, computeInvoice, derivePartyId, emptyInvoiceState,
  emptyManufactureState, emptyStockNoteState, evaluateManufactureForm, padManufactureRows, qtyText, requiredTaxLedgers,
  STOCK_NOTE_PURPOSES, taxLedgerIdsFrom, taxSideOf, DEFAULT_PURPOSE,
  type AccountingFormState, type AccountingRowState, type InvoiceContext, type InvoiceFormState, type InvoiceRowState,
  type ManufactureFormState, type StockNoteFormState, type StockNoteKind, type TaxLedgerIds
} from '@shared/voucherEdit'
import { buildTradeDocPayload, computeTradeDoc, creditLimitWarningText, emptyTradeDocState, TRADE_DOC_TITLES, tradeDocIsSales, type TradeDocFormState } from '@shared/tradeCycle/edit'
import { ledgerFactsResolver, nextVoucherNumber, saveVoucher, NOT_DELETED, getVoucher } from '../../services/vouchers'
import { createLedger, listVoucherTypes } from '../../services/masters'
import { openBills } from '../../services/analysis'
import { pricingLoader } from '../../services/pricing'
import { costPreview, saveManufacture, suggestedSaleRate } from '../../services/manufacture'
import { listBomVersions } from '../../services/bom'
import { saveTradeDoc } from '../../services/tradeDocs'
import { listTradeDocTypes } from '../../services/tradeDocTypes'
import { rehearse } from './rehearse'
import { DraftWork, isCashOrBank, isCreditor, isDebtor, isParty, underGroup, type DraftMasters } from './work'

export interface BuiltDraft {
  payload: AiVoucherDraftPayload
  summary: string
}

const rs = (p: number): string => formatPaise(p, { symbol: true })

// ---------- shared pieces ----------

function voucherTypeFor(m: DraftMasters, kind: VoucherKind, wanted?: number): VoucherType {
  const types = listVoucherTypes(m.db)
  const t = wanted ? types.find((x) => x.id === wanted) : types.find((x) => x.kind === kind)
  if (!t) throw new Error(wanted ? `There is no voucher type with id ${wanted}` : `This company has no ${kind.replace('_', ' ')} voucher type`)
  if (t.kind !== kind) throw new Error(`Voucher type ${t.name} is a ${t.kind.replace('_', ' ')}, not a ${kind.replace('_', ' ')}`)
  return t
}

/** The number the rehearsal saves with: the series' next number (what the editor suggests), or a
 *  placeholder for a hand-numbered type (the user types the real one). */
function rehearsalNumber(w: DraftWork, t: VoucherType, date: string): string {
  if (t.numbering === 'manual') {
    w.assume(`${t.name} is numbered by hand — type the voucher number before saving`)
    return 'AI-DRAFT'
  }
  return nextVoucherNumber(w.m.db, t.id, date)
}

/** The save's warnings (it saves anyway) become assumptions the user sees before saving. */
function saveWarnings(w: DraftWork, warnings: SaveVoucherWarnings | undefined): void {
  if (!warnings) return
  for (const n of warnings.negativeStock) w.assume(`${n.name} goes negative (${formatQtyMilli(n.closingQtyMilli)} ${n.unitSymbol}) on this date`)
  if (warnings.creditLimitExceeded) w.assume(creditLimitWarningText(warnings.creditLimitExceeded))
  for (const d of warnings.linkDates ?? []) w.assume(d)
}

/** Zod + validateVoucher with the save's ledger facts — the clear-message pre-check; the
 *  rehearsed save then applies everything else. */
function precheck(db: DB, payload: VoucherInputParsed, kind: VoucherKind): VoucherInputParsed {
  const parsed = voucherInputSchema.parse(payload)
  const errors = validateVoucher(parsed, kind, ledgerFactsResolver(db))
  if (errors.length) throw new Error(errors.map((e) => e.message).join('; '))
  return parsed
}

function ledgerName(m: DraftMasters, id: number): string {
  return m.ledgers.find((l) => l.id === id)?.name ?? `#${id}`
}

function finish(
  w: DraftWork,
  base: Omit<AiVoucherDraftPayload, 'sources' | 'assumptions' | 'fields'>,
  summary: string
): BuiltDraft {
  return {
    payload: { ...base, sources: [...w.sources], assumptions: [...w.assumptions], fields: [...w.fields] },
    summary
  }
}

/** The editor's tax-ledger lookups, plus — inside a rehearsal only — the ledgers it would create
 *  on first use (pickers.tsx useTaxLedgers: named CGST / SGST / IGST / CESS under Duties & Taxes,
 *  "Round Off" under Indirect Expenses). */
function ensureTaxLedgers(db: DB, m: DraftMasters, need: (keyof TaxLedgerIds)[], have: TaxLedgerIds): TaxLedgerIds {
  const out = { ...have }
  const groupId = (name: string): number => {
    const g = [...m.groups.values()].find((x) => x.name === name)
    if (!g) throw new Error(`${name} group missing`)
    return g.id
  }
  for (const k of need) {
    if (out[k] != null) continue
    const base = { openingBalance: 0, gstin: null, stateCode: null, address: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null }
    out[k] =
      k === 'roundOff'
        ? createLedger(db, { ...base, name: 'Round Off', groupId: groupId('Indirect Expenses'), taxType: null }).id
        : createLedger(db, { ...base, name: k.toUpperCase(), groupId: groupId('Duties & Taxes'), taxType: k }).id
  }
  return out
}

interface LineInput {
  item?: string
  itemId?: number
  qty: string | number
  rate?: string
  discount?: string
  discountPercent?: string
}

/** Price one line the way the grid does when the rate is left blank (WP 2.6 resolvePrice: party
 *  rate → level → scheme → default level → MRP / last purchase). A rate the user gave is never
 *  overridden. */
function priceLine(
  w: DraftWork,
  i: number,
  item: StockItem,
  qtyMilli: number,
  given: LineInput,
  opts: {
    date: string
    partyId: number | null
    supply: 'intra' | 'inter'
    fallbackRate?: { ratePaise: number; why: string } | null
    /** With fallbackRate: the original line's discount for this quantity (a return credits what was charged). */
    fallbackDiscount?: { discountPaise: number; why: string } | null
    zeroOk?: boolean
    noCost?: boolean
  }
): { rate: number; discount: number | null } {
  const field = `line:${i}`
  let rate: number | null = given.rate ? w.amount(field, given.rate, `Line ${i + 1} rate`) : null
  let discount: number | null = null
  if (rate == null && opts.fallbackRate) {
    rate = opts.fallbackRate.ratePaise
    w.assume(`Rate for ${item.name}: ${rs(rate)} ${opts.fallbackRate.why}`)
    if (opts.fallbackDiscount && opts.fallbackDiscount.discountPaise > 0 && !given.discount && !given.discountPercent) {
      discount = opts.fallbackDiscount.discountPaise
      w.assume(`Discount on ${item.name}: ${rs(discount)} ${opts.fallbackDiscount.why}`)
    }
  }
  if (rate == null) {
    const price = pricingLoader(w.m.db)({ date: opts.date, partyLedgerId: opts.partyId, currency: 'INR', supply: opts.supply }, item.id, qtyMilli)
    // A challan carries the taxable value — the order / price-list rate, never the cost (rule 55(1);
    // voucherEdit/stockNote.ts): the resolver's last-purchase fallback is not used there.
    if (price.ratePaise != null && price.ratePaise > 0 && !(opts.noCost && price.source === 'last_purchase')) {
      rate = price.ratePaise
      w.source({ field, kind: 'rate', label: `${rs(rate)} per ${w.unitOf(item) || 'unit'}`, id: item.id, why: `${price.label || 'the price resolver'} (no rate was given)` })
      w.assume(`Rate for ${item.name}: ${rs(rate)} from ${price.label || 'the price list'} — no rate was given`)
      if (price.discountPaise > 0 && !given.discount && !given.discountPercent) {
        discount = price.discountPaise
        w.assume(`Discount of ${rs(discount)} on ${item.name} from ${price.label}`)
      }
    } else if (opts.zeroOk) {
      rate = 0
      w.assume(`No rate for ${item.name} in the price lists — valued at ₹0.00; type the rate`)
    } else {
      w.ask({ field, said: item.name, question: `What rate for ${item.name}? There is none in the price lists or past purchases.`, candidates: [] })
      rate = 0
    }
  }
  if (given.discount) discount = w.amount(field, given.discount, `Line ${i + 1} discount`)
  else if (given.discountPercent) {
    const bp = w.percentBp(given.discountPercent, `Line ${i + 1} discount`)
    const gross = Math.round((qtyMilli * rate) / 1000)
    // Half away from zero, the GST rounding convention (money.ts roundPaise) — integer maths.
    discount = Math.floor((gross * bp + 5000) / 10000)
    w.assume(`Discount on ${item.name}: ${given.discountPercent.replace(/\s*%?$/, '')}% of ${rs(gross)} = ${rs(discount)}`)
  }
  return { rate, discount: discount && discount > 0 ? discount : null }
}

function gstAssumptions(w: DraftWork, items: StockItem[], supply: 'intra' | 'inter', partyState: string | null, pos: string | null): void {
  for (const it of items) {
    if (it.gstRate != null) w.assume(`${it.gstRate}% GST on ${it.name} from the item master${it.cessRate ? ` (+ ${it.cessRate}% cess)` : ''}`)
    else w.assume(`${it.name} has no GST rate in the item master — the ledger's rate (or 0%) applies`)
  }
  const st = pos ?? partyState
  w.assume(
    `${supply === 'intra' ? 'Intra-state: CGST + SGST' : 'Inter-state: IGST'} — place of supply ${st ? `${st} ${stateName(st) ?? ''}`.trim() : 'the company’s state'}${pos ? ' (as given)' : ' (the party’s state)'}`
  )
}

function invoiceCtx(m: DraftMasters, kind: VoucherKind): InvoiceContext {
  return {
    kind,
    companyStateCode: m.company.stateCode,
    items: new Map(m.items.map((i) => [i.id, { gstRate: i.gstRate, cessRate: i.cessRate }])),
    ledgers: new Map(
      m.ledgers.map((l) => [l.id, { stateCode: l.stateCode, gstRate: l.gstRate, tdsPayableSectionId: l.tdsPayableSectionId, tcsPayableSectionId: l.tcsPayableSectionId ?? null }])
    )
  }
}

// ---------- accounting: payment / receipt / contra / journal ----------

export interface AccountingDraftInput {
  kind: 'payment' | 'receipt' | 'contra' | 'journal'
  voucherTypeId?: number
  date?: string
  narration?: string
  reference?: string
  lines?: { ledgerId?: number; ledger?: string; drCr: 'dr' | 'cr'; amount: string }[]
  party?: string
  partyLedgerId?: number
  account?: string
  accountLedgerId?: number
  amount?: string
  bills?: { bill: string; amount?: string }[]
  oldestBillsFirst?: boolean
  instrumentNo?: string
}

export function buildAccountingDraft(w: DraftWork, input: AccountingDraftInput): BuiltDraft {
  const m = w.m
  const type = voucherTypeFor(m, input.kind, input.voucherTypeId)
  const date = w.date('date', input.date)
  const rows: AccountingRowState[] = []
  let party: Ledger | null = null

  if (input.lines && input.lines.length) {
    input.lines.forEach((l, i) => {
      const field = `line:${i}`
      let ledger: Ledger | null = null
      if (l.ledgerId != null) {
        // A 5.1-style id: unknown ids are left to validateVoucher ("Unknown ledger on line N").
        ledger = m.ledgers.find((x) => x.id === l.ledgerId) ?? null
        if (ledger) w.source({ field, kind: 'ledger', label: ledger.name, id: ledger.id, said: String(l.ledgerId), why: 'the id from an earlier tool result' })
        else rows.push({ drCr: l.drCr, ledgerId: l.ledgerId, amount: w.amount(field, l.amount, `Line ${i + 1}`), costAllocations: [] })
      } else if (l.ledger) {
        ledger = w.ledger(field, l.ledger, { what: 'ledger' })
      } else {
        throw new Error(`Line ${i + 1}: give the ledger (ledger name or ledgerId)`)
      }
      if (ledger) rows.push({ drCr: l.drCr, ledgerId: ledger.id, amount: w.amount(field, l.amount, `Line ${i + 1}`), costAllocations: [] })
    })
    if (input.party != null || input.partyLedgerId != null) party = w.party('party', input.partyLedgerId ?? input.party, 'any')
  } else {
    if (input.kind !== 'payment' && input.kind !== 'receipt') throw new Error(`A ${input.kind} needs its debit and credit lines`)
    const side = input.kind === 'payment' ? 'creditor' : 'debtor'
    party = w.party('party', input.partyLedgerId ?? input.party ?? null, side)
    if (!party && input.party == null && input.partyLedgerId == null) throw new Error(`Say who the ${input.kind} is ${input.kind === 'payment' ? 'to' : 'from'} (party)`)
    let account: Ledger | null = null
    if (input.accountLedgerId != null || input.account) {
      account = w.ledger('account', input.accountLedgerId ?? input.account, { what: 'cash or bank ledger', filter: (l) => isCashOrBank(m, l) })
    } else {
      const cb = m.ledgers.filter((l) => isCashOrBank(m, l))
      if (cb.length === 1) {
        account = cb[0]!
        w.source({ field: 'account', kind: 'ledger', label: account.name, id: account.id, why: 'the only cash / bank ledger' })
        w.assume(`${input.kind === 'payment' ? 'Paid from' : 'Received into'} ${account.name} — the only cash / bank ledger`)
      } else {
        w.ask({
          field: 'account',
          said: '',
          question: `${input.kind === 'payment' ? 'Paid from' : 'Received into'} which cash or bank account?`,
          candidates: cb.map((l) => ({ id: l.id, name: l.name }))
        })
      }
    }
    w.settle()
    const alloc = allocateBills(w, party!, input.kind, date, input.amount ? w.amount('amount', input.amount, 'Amount') : null, input.bills, !!input.oldestBillsFirst, advanceNameFor(w, type, date))
    const partyRow: AccountingRowState = { drCr: input.kind === 'payment' ? 'dr' : 'cr', ledgerId: party!.id, amount: alloc.total, costAllocations: [] }
    const accountRow: AccountingRowState = { drCr: input.kind === 'payment' ? 'cr' : 'dr', ledgerId: account!.id, amount: alloc.total, costAllocations: [] }
    rows.push(...(input.kind === 'payment' ? [partyRow, accountRow] : [accountRow, partyRow]))
    w.fields.add('line:0').add('line:1')
    return accountingResult(w, type, date, rows, input, alloc.refs, alloc.note)
  }
  w.settle()
  let refs: NonNullable<AiVoucherDraftPayload['billRefs']> = []
  let note = ''
  if (input.bills?.length || input.oldestBillsFirst) {
    if (!party) {
      const ids = [...new Set(rows.map((r) => r.ledgerId).filter((x): x is number => x != null))]
      const parties = ids.map((id) => m.ledgers.find((l) => l.id === id)).filter((l): l is Ledger => !!l && isParty(m, l))
      if (parties.length !== 1) throw new Error('Bill allocation needs exactly one party ledger among the lines')
      party = parties[0]!
    }
    const partyTotal = rows.filter((r) => r.ledgerId === party!.id).reduce((s, r) => s + (r.amount ?? 0), 0)
    if (partyTotal === 0) throw new Error(`${party.name} is not on any line`)
    const alloc = allocateBills(w, party, input.kind, date, partyTotal, input.bills, !!input.oldestBillsFirst, advanceNameFor(w, type, date))
    refs = alloc.refs
    note = alloc.note
  }
  return accountingResult(w, type, date, rows, input, refs, note)
}

function accountingResult(
  w: DraftWork,
  type: VoucherType,
  date: string,
  rows: AccountingRowState[],
  input: AccountingDraftInput,
  refs: NonNullable<AiVoucherDraftPayload['billRefs']>,
  billNote: string
): BuiltDraft {
  const m = w.m
  if (input.narration) w.fields.add('narration')
  if (input.instrumentNo) w.fields.add('instrumentNo')
  const state: AccountingFormState = {
    date, number: '', rows, narration: input.narration?.trim() ?? '', instrumentNo: input.instrumentNo?.trim() ?? '',
    billRefs: refs, advanceReceipt: false, optional: false, tds: null, tcs: null, original: null
  }
  const isPartyOrTds = (id: number): boolean => {
    const l = m.ledgers.find((x) => x.id === id)
    return !!l && (isParty(m, l) || l.tdsSectionId != null)
  }
  const derived = derivePartyId(rows, isPartyOrTds, null)
  const built = buildAccountingPayload(state, { kind: type.kind, voucherTypeId: type.id, derivedPartyId: derived })
  if (!built.ok) throw new Error(built.error)
  // The 5.1 tool carried `reference` straight onto the voucher; the accounting form passes the
  // stored reference through `original`, so a new draft keeps it the same way.
  const payload: VoucherInputParsed = { ...built.payload, reference: input.reference?.trim() || null }
  if (payload.reference) state.original = { ...emptyOriginal(), reference: payload.reference, ledgerIds: [], inventory: [] }
  const lines = payload.lines
  const dr = lines.filter((l) => l.drCr === 'dr').reduce((s, l) => s + l.amount, 0)
  const cr = lines.filter((l) => l.drCr === 'cr').reduce((s, l) => s + l.amount, 0)
  const parsed = precheck(m.db, payload, type.kind)
  if (dr !== cr) throw new Error(`Debits (${formatPaise(dr)}) and credits (${formatPaise(cr)}) differ`)
  saveWarnings(w, rehearse(m.db, () => saveVoucher(m.db, { ...parsed, number: rehearsalNumber(w, type, date) })).warnings)
  const names = (side: 'dr' | 'cr'): string => lines.filter((l) => l.drCr === side).map((l) => ledgerName(m, l.ledgerId)).join(', ')
  const summary = `${type.name} of ${rs(dr)} on ${date}: Dr ${names('dr')} / Cr ${names('cr')}${billNote}`
  return finish(
    w,
    {
      voucherTypeId: type.id, voucherKind: type.kind, date, partyLedgerId: payload.partyLedgerId, narration: payload.narration, reference: payload.reference,
      lines: lines.map((l) => ({ ledgerId: l.ledgerId, drCr: l.drCr, amount: l.amount })),
      form: 'accounting' as AiDraftForm, state, total: dr, ...(refs.length ? { billRefs: refs } : {})
    },
    summary
  )
}

/** voucherEdit/accounting.ts names an advance after the voucher number ('Advance' without one). */
function advanceNameFor(w: DraftWork, t: VoucherType, date: string): string {
  return t.numbering === 'manual' ? 'Advance' : nextVoucherNumber(w.m.db, t.id, date)
}

function emptyOriginal(): Omit<NonNullable<AccountingFormState['original']>, 'ledgerIds' | 'inventory'> {
  return {
    partyLedgerId: null, reference: null, instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null,
    transportDistanceKm: null, posOverride: null, currencyCode: null, exchangeRate: null
  }
}

/** Bill-wise allocation from the Outstandings engine (openBills): the named bills (each at its
 *  pending amount unless an amount is given), or oldest first up to the amount. The total is the
 *  given amount, else the bills' pending sum — computed here, never by the model. */
function allocateBills(
  w: DraftWork,
  party: Ledger,
  kind: string,
  date: string,
  amount: number | null,
  bills: { bill: string; amount?: string }[] | undefined,
  oldestFirst: boolean,
  /** Name of the 'new' bill an excess becomes — the voucher number, as the accounting form names it. */
  advanceName: string
): { total: number; refs: NonNullable<AiVoucherDraftPayload['billRefs']>; note: string } {
  const open = openBills(w.m.db, party.id, date).filter((b) => b.pending > 0)
  // A settlement names a bill, and the allocation settles the OLDEST open bill of that name
  // (shared/outstanding.ts settleNamed): with duplicate names only that one can be targeted.
  const firstOfName = (j: number): boolean => open.findIndex((x) => x.number === open[j]!.number) === j
  const refs: NonNullable<AiVoucherDraftPayload['billRefs']> = []
  if (bills && bills.length) {
    bills.forEach((b, i) => {
      const r = resolveName(
        b.bill,
        open.flatMap((o, j) => (firstOfName(j) ? [{ id: j, name: o.number, keys: [o.number], detail: `${toDisplayDate(o.date)} · ${rs(o.pending)} pending` }] : [])),
        { minScore: 90 }
      )
      if (r.status !== 'match') {
        w.ask({
          field: 'bills',
          said: b.bill,
          question: r.status === 'ambiguous' ? `Which bill of ${party.name} is “${b.bill}”?` : `${party.name} has no open bill “${b.bill}”. Its open bills:`,
          candidates: open.slice(0, 10).map((o, j) => ({ id: j, name: o.number, detail: `${toDisplayDate(o.date)} · ${rs(o.pending)} pending` }))
        })
        return
      }
      const bill = open[r.id]!
      const amt = b.amount ? w.amount('bills', b.amount, `Bill ${b.bill}`) : bill.pending
      if (amt > bill.pending) throw new Error(`${rs(amt)} is more than the ${rs(bill.pending)} pending on bill ${bill.number}`)
      if (refs.some((x) => x.name === bill.number)) throw new Error(`Bill ${bill.number} is named twice`)
      const twins = open.filter((x) => x.number === bill.number).length
      if (twins > 1) w.assume(`${twins} open bills are named ${bill.number}; a settlement by name applies to the oldest first — the one dated ${toDisplayDate(bill.date)}`)
      refs.push({ kind: 'against', name: bill.number, amount: amt, dueDate: null })
      w.source({
        field: 'bills', kind: 'bill', label: `${bill.number} (${toDisplayDate(bill.date)})`, ...(bill.voucherId ? { id: bill.voucherId } : {}), said: b.bill,
        why: `${r.why}; ${rs(bill.pending)} pending as on ${toDisplayDate(date)}${b.amount ? '' : ' — allocated in full'}`
      })
      void i
    })
    w.settle()
  } else if (oldestFirst) {
    if (amount == null) throw new Error('Give the amount to allocate oldest bill first')
    let left = amount
    for (const bill of [...open].sort((a, b) => a.date.localeCompare(b.date))) {
      if (left <= 0) break
      if (refs.some((x) => x.name === bill.number)) continue // a duplicate name settles the oldest one only
      const amt = Math.min(left, bill.pending)
      refs.push({ kind: 'against', name: bill.number, amount: amt, dueDate: null })
      w.source({ field: 'bills', kind: 'bill', label: `${bill.number} (${toDisplayDate(bill.date)})`, ...(bill.voucherId ? { id: bill.voucherId } : {}), why: `oldest open bill first; ${rs(bill.pending)} pending` })
      left -= amt
    }
    if (refs.length === 0) w.assume(`${party.name} has no open bills — the amount stays on account`)
  }
  const allocated = refs.reduce((s, r) => s + r.amount, 0)
  const total = amount ?? allocated
  if (total <= 0) throw new Error(`Give the amount of the ${kind}, or the bills it settles`)
  if (amount == null && refs.length) {
    w.source({ field: 'amount', kind: 'amount', label: rs(total), why: `the pending amount of bill${refs.length > 1 ? 's' : ''} ${refs.map((r) => r.name).join(', ')}` })
  }
  if (allocated > total) throw new Error(`The bills (${rs(allocated)}) are more than the ${kind} (${rs(total)})`)
  if (refs.length && allocated < total) {
    refs.push({ kind: 'new', name: advanceName, amount: total - allocated, dueDate: null })
    w.assume(`${rs(total - allocated)} more than the bills — kept as an advance (new bill “${advanceName}”, the voucher number)`)
  }
  if (refs.length) w.fields.add('bills')
  else if (open.length && !bills?.length) w.assume(`Not allocated against ${party.name}'s open bills (on account) — name the bills to settle them`)
  const against = refs.filter((r) => r.kind === 'against')
  return { total, refs, note: against.length ? ` against ${against.map((r) => `${r.name} (${rs(r.amount)})`).join(', ')}` : '' }
}

// ---------- invoices: sales / purchase / credit note / debit note ----------

export interface InvoiceDraftInput {
  kind: 'sales' | 'purchase' | 'credit_note' | 'debit_note'
  voucherTypeId?: number
  party?: string
  partyLedgerId?: number
  date?: string
  account?: string
  accountLedgerId?: number
  items: LineInput[]
  placeOfSupply?: string
  narration?: string
  billNo?: string
  dueDate?: string
  againstInvoice?: string
}

const SIDE: Record<InvoiceDraftInput['kind'], 'debtor' | 'creditor'> = { sales: 'debtor', credit_note: 'debtor', purchase: 'creditor', debit_note: 'creditor' }
const ACCOUNT_GROUP: Record<InvoiceDraftInput['kind'], string> = { sales: 'Sales Accounts', credit_note: 'Sales Accounts', purchase: 'Purchase Accounts', debit_note: 'Purchase Accounts' }
const KIND_LABEL: Record<string, string> = {
  sales: 'Sales invoice', purchase: 'Purchase invoice', credit_note: 'Credit note', debit_note: 'Debit note', delivery_note: 'Delivery challan', receipt_note: 'Goods receipt note'
}

/** The sales / purchase ledger: as given, else the only one, else the one this party's (then
 *  anyone's) invoices post to most — always stated as an assumption. */
function pickAccount(w: DraftWork, kind: InvoiceDraftInput['kind'], said: string | number | undefined, partyId: number | null): Ledger | null {
  const m = w.m
  const group = ACCOUNT_GROUP[kind]
  const pool = (l: Ledger): boolean => underGroup(m, l, [group])
  if (said != null && said !== '') return w.ledger('account', said, { what: `${group.toLowerCase().replace(' accounts', '')} ledger`, filter: pool })
  const cands = m.ledgers.filter(pool)
  if (cands.length === 0) throw new Error(`No ledger under ${group} — create a ${group === 'Sales Accounts' ? 'sales' : 'purchase'} ledger first`)
  if (cands.length === 1) {
    w.source({ field: 'account', kind: 'ledger', label: cands[0]!.name, id: cands[0]!.id, why: `the only ledger under ${group}` })
    w.assume(`${group === 'Sales Accounts' ? 'Sales' : 'Purchase'} ledger: ${cands[0]!.name} (the only one)`)
    return cands[0]!
  }
  const usage = (byParty: boolean): { id: number; n: number }[] =>
    m.db
      .prepare(
        `SELECT vl.ledger_id AS id, COUNT(*) AS n FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
         WHERE ${NOT_DELETED} AND vl.ledger_id IN (${cands.map(() => '?').join(',')}) ${byParty ? 'AND v.party_ledger_id = ?' : ''}
         GROUP BY vl.ledger_id ORDER BY n DESC, vl.ledger_id`
      )
      .all(...cands.map((c) => c.id), ...(byParty ? [partyId] : [])) as { id: number; n: number }[]
  const top = (partyId != null ? usage(true) : [])[0] ?? usage(false)[0]
  if (top) {
    const l = cands.find((c) => c.id === top.id)!
    w.source({ field: 'account', kind: 'ledger', label: l.name, id: l.id, why: 'the ledger these invoices post to most' })
    w.assume(`${group === 'Sales Accounts' ? 'Sales' : 'Purchase'} ledger: ${l.name} — the one used most${partyId != null ? ' for this party' : ''}`)
    return l
  }
  w.ask({ field: 'account', said: '', question: `Which ${group === 'Sales Accounts' ? 'sales' : 'purchase'} ledger?`, candidates: cands.map((l) => ({ id: l.id, name: l.name })) })
  return null
}

/** The original invoice a note returns against (by number or bill name, this party only). */
function findOriginalInvoice(w: DraftWork, kind: 'credit_note' | 'debit_note', partyId: number, said: string): { id: number; number: string; billName: string } | null {
  const original = kind === 'credit_note' ? 'sales' : 'purchase'
  const rows = w.m.db
    .prepare(
      `SELECT v.id, v.number, v.date,
              (SELECT br.name FROM bill_refs br WHERE br.voucher_id = v.id AND br.kind = 'new' ORDER BY br.id LIMIT 1) AS billName
       FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id
       WHERE ${NOT_DELETED} AND vt.kind = ? AND v.party_ledger_id = ? ORDER BY v.date DESC, v.id DESC LIMIT 500`
    )
    .all(original, partyId) as { id: number; number: string; date: string; billName: string | null }[]
  const r = resolveName(said, rows.map((x) => ({ id: x.id, name: x.number, keys: [x.number, x.billName], detail: toDisplayDate(x.date) })), { minScore: 90 })
  if (r.status !== 'match') {
    w.ask({
      field: 'againstInvoice',
      said,
      question: `Which ${original} invoice of this party is “${said}”?`,
      candidates: (r.status === 'ambiguous' ? r.candidates : rows.slice(0, 8).map((x) => ({ id: x.id, name: x.number, detail: toDisplayDate(x.date), score: 0 }))).map((c) => ({ id: c.id, name: c.name, ...(c.detail ? { detail: c.detail } : {}) }))
    })
    return null
  }
  const hit = rows.find((x) => x.id === r.id)!
  w.source({ field: 'againstInvoice', kind: 'voucher', label: `${original === 'sales' ? 'Sales' : 'Purchase'} ${hit.number} (${toDisplayDate(hit.date)})`, id: hit.id, said, why: r.why })
  return { id: hit.id, number: hit.number, billName: hit.billName ?? hit.number }
}

export function buildInvoiceDraft(w: DraftWork, input: InvoiceDraftInput): BuiltDraft {
  const m = w.m
  const kind = input.kind
  const type = voucherTypeFor(m, kind, input.voucherTypeId)
  const date = w.date('date', input.date)
  const party = w.party('party', input.partyLedgerId ?? input.party ?? null, SIDE[kind])
  if (input.party == null && input.partyLedgerId == null) throw new Error('Give the party (name, GSTIN or ledgerId)')
  const account = pickAccount(w, kind, input.accountLedgerId ?? input.account, party?.id ?? null)
  const pos = input.placeOfSupply ? w.stateCode('pos', input.placeOfSupply) : null
  const resolved = input.items.map((l, i) => {
    const item = w.item(`line:${i}`, l.itemId ?? l.item ?? null)
    if (l.itemId == null && !l.item) throw new Error(`Line ${i + 1}: give the item (name, barcode or HSN)`)
    return { item, qtyMilli: w.qty(`line:${i}`, l.qty, `Line ${i + 1}`, item), given: l }
  })
  w.settle()
  const original = (kind === 'credit_note' || kind === 'debit_note') && input.againstInvoice ? findOriginalInvoice(w, kind, party!.id, input.againstInvoice) : null
  w.settle()
  const originalVoucher = original ? getVoucher(m.db, original.id) : null
  const partyState = pos ?? party!.stateCode ?? m.company.stateCode
  const supply = supplyTypeFor(m.company.stateCode, partyState)
  // Quantity already returned against each original line (live notes), plus what this draft takes.
  const returnedStmt = m.db.prepare(
    `SELECT COALESCE(SUM(ll.qty_milli), 0) AS q FROM line_links ll JOIN vouchers v ON v.id = ll.to_voucher_id
     WHERE ll.from_line_uid = ? AND ll.link_type = 'return' AND ${NOT_DELETED}`
  )
  const taken = new Map<string, number>()
  const rows: InvoiceRowState[] = resolved.map((r, i) => {
    let source: InvoiceRowState['source'] = null
    let fallbackRate: { ratePaise: number; why: string } | null = null
    let fallbackDiscount: { discountPaise: number; why: string } | null = null
    if (originalVoucher) {
      const lines = originalVoucher.inventory.filter((l) => l.stockItemId === r.item!.id && l.lineUid)
      if (lines.length === 0) throw new Error(`${r.item!.name} is not on ${kind === 'credit_note' ? 'sales' : 'purchase'} invoice ${original!.number}`)
      const left = (l: (typeof lines)[number]): number => l.qtyMilli - (returnedStmt.get(l.lineUid) as { q: number }).q - (taken.get(l.lineUid!) ?? 0)
      const line = lines.find((l) => left(l) >= r.qtyMilli)
      if (!line) {
        const most = Math.max(...lines.map(left))
        throw new Error(
          `Only ${formatQtyMilli(Math.max(0, most))} ${w.unitOf(r.item!)} of ${r.item!.name} on invoice ${original!.number} is left to return (some was returned already)`
        )
      }
      taken.set(line.lineUid!, (taken.get(line.lineUid!) ?? 0) + r.qtyMilli)
      source = { lineUid: line.lineUid!, linkType: 'return' }
      fallbackRate = { ratePaise: line.ratePaise, why: `— the rate on invoice ${original!.number}` }
      if (line.discountPaise > 0) {
        // Pro rata, integer half-up: discount × returned qty ÷ original qty.
        const d = Math.floor((line.discountPaise * r.qtyMilli * 2 + line.qtyMilli) / (2 * line.qtyMilli))
        fallbackDiscount = { discountPaise: d, why: `— ${formatQtyMilli(r.qtyMilli)} of ${formatQtyMilli(line.qtyMilli)}'s share of the ${rs(line.discountPaise)} discount on invoice ${original!.number}` }
      }
    }
    const { rate, discount } = priceLine(w, i, r.item!, r.qtyMilli, r.given, { date, partyId: party!.id, supply, fallbackRate, fallbackDiscount })
    w.fields.add(`line:${i}`)
    return { itemId: r.item!.id, qtyText: qtyText(r.qtyMilli), rate, discount, godownId: null, batchId: null, ...(source ? { source } : {}) }
  })
  w.settle()
  gstAssumptions(w, [...new Map(resolved.map((r) => [r.item!.id, r.item!])).values()], supply, party!.stateCode, pos)

  const isNote = kind === 'credit_note' || kind === 'debit_note'
  const dueGiven = w.optionalDate('dueDate', input.dueDate)
  const state: InvoiceFormState = {
    ...emptyInvoiceState(date),
    partyId: party!.id,
    accountId: account!.id,
    rows,
    narration: input.narration?.trim() ?? '',
    posOverride: pos && pos !== party!.stateCode ? pos : null,
    billName: !isNote && input.billNo ? input.billNo.trim() : '',
    billDueDate: dueGiven ?? addDaysISO(date, party!.creditDays ?? 0)
  }
  if (input.narration) w.fields.add('narration')
  if (input.billNo && !isNote) w.fields.add('bills')
  const ctx = invoiceCtx(m, kind)
  const computed = computeInvoice(state, ctx)
  if (computed.detail.length !== rows.length) throw new Error('A line could not be priced — check the quantities and rates')
  // Notes: against the original invoice's bill while it has that much pending; else a new bill.
  if (isNote) {
    if (original) {
      const pending = openBills(m.db, party!.id, date).find((b) => b.number === original.billName)?.pending ?? 0
      if (pending >= computed.rounded) {
        state.noteBillRefs = [{ kind: 'against', name: original.billName, amount: computed.rounded, dueDate: null }]
        w.source({ field: 'bills', kind: 'bill', label: original.billName, id: original.id, why: `${rs(pending)} pending on it — the note is set against it` })
      } else {
        state.manualNewBillMode = true
        w.assume(`Only ${rs(pending)} is pending on ${original.billName}, so the note is kept as its own bill (on account)`)
      }
      w.fields.add('bills')
    } else {
      w.assume('Not set against an invoice — name the original invoice to link the returned lines and settle its bill')
    }
  }
  if (!isNote && !input.billNo) w.assume('Bill name: the voucher number (as the form sets it)')
  if (!input.dueDate && !isNote) w.assume(`Due ${toDisplayDate(state.billDueDate)} — ${party!.creditDays ? `${party!.creditDays} days' credit from the party master` : 'no credit days on the party'}`)

  const taxHave = taxLedgerIdsFrom(m.ledgers, taxSideOf(kind))
  const need = requiredTaxLedgers(computed)
  for (const k of need) if (taxHave[k] == null) w.assume(`No ${k === 'roundOff' ? 'Round Off' : k.toUpperCase()} ledger yet — the editor creates it when you save`)
  const rehearsed = rehearse(m.db, () => {
    const taxLedgers = ensureTaxLedgers(m.db, m, need, taxHave)
    const number = rehearsalNumber(w, type, date)
    const built = buildInvoicePayload({ ...state, number, billName: state.billName || number }, ctx, type.id, taxLedgers)
    if (!built.ok) throw new Error(built.error)
    const parsed = precheck(m.db, built.payload, kind)
    const res = saveVoucher(m.db, parsed)
    saveWarnings(w, res.warnings)
    return built.payload
  })
  // Ledger lines for the 5.1 fields: only ledgers that already exist (a tax ledger the editor will
  // create has no id outside the rehearsal).
  const existing = new Set(m.ledgers.map((l) => l.id))
  const g = computed.gst
  const tax = [g.cgst ? `CGST ${rs(g.cgst)}` : null, g.sgst ? `SGST ${rs(g.sgst)}` : null, g.igst ? `IGST ${rs(g.igst)}` : null, g.cess ? `cess ${rs(g.cess)}` : null].filter(Boolean)
  const linesText = computed.detail
    .map((d) => `${formatQtyMilli(d.qtyMilli)} × ${m.items.find((i) => i.id === d.itemId)?.name} @ ${rs(d.ratePaise)}${d.discountPaise ? ` less ${rs(d.discountPaise)}` : ''}`)
    .join('; ')
  const summary =
    `${KIND_LABEL[kind]} ${kind === 'sales' || kind === 'debit_note' ? 'to' : 'from'} ${party!.name} on ${date}: ${linesText} — taxable ${rs(g.taxable)}` +
    `${tax.length ? `, ${tax.join(', ')}` : ''}${computed.roundDiff ? `, round off ${rs(computed.roundDiff)}` : ''}, total ${rs(computed.rounded)}` +
    (original ? ` (against ${original.number})` : '')
  return finish(
    w,
    {
      voucherTypeId: type.id, voucherKind: kind, date, partyLedgerId: party!.id, narration: state.narration || null, reference: null,
      lines: rehearsed.lines.filter((l) => existing.has(l.ledgerId)).map((l) => ({ ledgerId: l.ledgerId, drCr: l.drCr, amount: l.amount })),
      form: 'invoice', state, total: computed.rounded, ...(rehearsed.billRefs.length && isNote ? { billRefs: rehearsed.billRefs } : {})
    },
    summary
  )
}

// ---------- delivery challans / GRNs ----------

export interface StockNoteDraftInput {
  kind: StockNoteKind
  voucherTypeId?: number
  party?: string
  partyLedgerId?: number
  date?: string
  purpose?: string
  items: LineInput[]
  reference?: string
  narration?: string
  vehicleNo?: string
}

export function buildStockNoteDraft(w: DraftWork, input: StockNoteDraftInput): BuiltDraft {
  const m = w.m
  const kind = input.kind
  const type = voucherTypeFor(m, kind, input.voucherTypeId)
  const date = w.date('date', input.date)
  if (input.party == null && input.partyLedgerId == null) throw new Error('Give the party (name, GSTIN or ledgerId)')
  const party = w.party('party', input.partyLedgerId ?? input.party ?? null, kind === 'delivery_note' ? 'debtor' : 'creditor')
  const purposes = STOCK_NOTE_PURPOSES[kind]
  let purpose = DEFAULT_PURPOSE[kind]
  if (input.purpose) {
    const p = purposes.find((x) => x.value === input.purpose || x.label.toLowerCase() === input.purpose!.toLowerCase())
    if (!p) throw new Error(`A ${KIND_LABEL[kind]!.toLowerCase()} purpose is one of: ${purposes.map((x) => x.value).join(', ')}`)
    purpose = p.value
    w.fields.add('purpose')
  } else {
    w.assume(`Purpose: ${purposes.find((x) => x.value === purpose)!.label} (the default)`)
  }
  const resolved = input.items.map((l, i) => {
    const item = w.item(`line:${i}`, l.itemId ?? l.item ?? null)
    return { item, qtyMilli: w.qty(`line:${i}`, l.qty, `Line ${i + 1}`, item), given: l }
  })
  w.settle()
  const supply = supplyTypeFor(m.company.stateCode, party!.stateCode ?? m.company.stateCode)
  const rows: InvoiceRowState[] = resolved.map((r, i) => {
    const { rate, discount } = priceLine(w, i, r.item!, r.qtyMilli, r.given, { date, partyId: party!.id, supply, zeroOk: true, noCost: kind === 'delivery_note' })
    w.fields.add(`line:${i}`)
    return { itemId: r.item!.id, qtyText: qtyText(r.qtyMilli), rate, discount, godownId: null, batchId: null }
  })
  if (input.reference) w.fields.add('reference')
  if (input.narration) w.fields.add('narration')
  const state: StockNoteFormState = {
    ...emptyStockNoteState(kind, date),
    partyId: party!.id,
    purpose,
    rows,
    narration: input.narration?.trim() ?? '',
    reference: input.reference?.trim() ?? '',
    vehicleNo: input.vehicleNo?.trim().toUpperCase() ?? ''
  }
  const ctx = { kind, companyStateCode: m.company.stateCode, items: invoiceCtx(m, 'sales').items, ledgers: new Map(m.ledgers.map((l) => [l.id, { stateCode: l.stateCode }])) }
  const built = buildStockNotePayload(state, ctx, type.id)
  if (!built.ok) throw new Error(built.error)
  const parsed = precheck(m.db, built.payload, kind)
  saveWarnings(w, rehearse(m.db, () => saveVoucher(m.db, { ...parsed, number: rehearsalNumber(w, type, date) })).warnings)
  const value = parsed.inventory.reduce((s, l) => s + l.amount, 0)
  const summary = `${KIND_LABEL[kind]} ${kind === 'delivery_note' ? 'to' : 'from'} ${party!.name} on ${date} (${purposes.find((x) => x.value === purpose)!.label.toLowerCase()}): ${parsed.inventory
    .map((l) => `${formatQtyMilli(l.qtyMilli)} × ${m.items.find((i) => i.id === l.stockItemId)?.name}`)
    .join('; ')} — goods value ${rs(value)}`
  return finish(w, { voucherTypeId: type.id, voucherKind: kind, date, partyLedgerId: party!.id, narration: parsed.narration, reference: parsed.reference, lines: [], form: 'stockNote', state, total: value }, summary)
}

// ---------- manufacture (BOM) ----------

export interface ManufactureDraftInput {
  item?: string
  itemId?: number
  qty: string | number
  date?: string
  godown?: string
  labour?: string
  saleRate?: string
  narration?: string
  components?: { item?: string; itemId?: number; qty: string | number }[]
}

export function buildManufactureDraft(w: DraftWork, input: ManufactureDraftInput): BuiltDraft {
  const m = w.m
  const type = voucherTypeFor(m, 'stock_journal')
  const date = w.date('date', input.date)
  if (input.item == null && input.itemId == null) throw new Error('Give the item to manufacture')
  const item = w.item('finishedItem', input.itemId ?? input.item ?? null)
  const qtyMilli = w.qty('qty', input.qty, 'Quantity', item)
  let godownId: number | null = null
  if (input.godown) {
    const godowns = m.db.prepare("SELECT id, name FROM godowns WHERE kind = 'own' ORDER BY name").all() as { id: number; name: string }[]
    const r = resolveName(input.godown, godowns.map((g) => ({ id: g.id, name: g.name })))
    if (r.status === 'match') {
      godownId = r.id
      w.source({ field: 'godown', kind: 'godown', label: r.name, id: r.id, said: input.godown, why: r.why })
    } else {
      w.ask({ field: 'godown', said: input.godown, question: `Which godown is “${input.godown}”?`, candidates: (r.status === 'ambiguous' ? r.candidates : godowns.slice(0, 8)).map((g) => ({ id: g.id, name: g.name })) })
    }
  }
  const comps = (input.components ?? []).map((c, i) => {
    const it = w.item(`line:${i}`, c.itemId ?? c.item ?? null)
    return { item: it, qtyMilli: w.qty(`line:${i}`, c.qty, `Component ${i + 1}`, it) }
  })
  w.settle()
  const versions = listBomVersions(m.db)
  let rows: { itemId: number; qtyMilli: number }[]
  let bomVersionId: number | null = null
  if (comps.length) {
    rows = comps.map((c) => ({ itemId: c.item!.id, qtyMilli: c.qtyMilli }))
    w.assume('Components as given (not from the bill of materials)')
  } else {
    const version = pickBomVersion(versions, item!.id, date)
    if (!version) throw new Error(`${item!.name} has no bill of materials in force on ${toDisplayDate(date)} — give the components`)
    const ex = explodeBom(item!.id, qtyMilli, versions, date, { levels: 'single', versionId: version.id })
    if (!ex.ok) throw new Error(`The bill of materials of ${item!.name} could not be used: ${'error' in ex ? String((ex as { error: unknown }).error) : 'invalid'}`)
    rows = ex.rows.map((r) => ({ itemId: r.componentId, qtyMilli: r.qtyMilli }))
    bomVersionId = version.id
    w.source({ field: 'bom', kind: 'bom', label: `${item!.name} BOM ${version.name}`, id: item!.id, why: `in force on ${toDisplayDate(date)}; scaled to ${formatQtyMilli(qtyMilli)}` })
    w.assume(`Raw materials from the bill of materials (${version.name}) for ${formatQtyMilli(qtyMilli)} ${w.unitOf(item!)}`.trim())
  }
  rows.forEach((_, i) => w.fields.add(`line:${i}`))
  const labourPaise = input.labour ? w.amount('labour', input.labour, 'Labour') : null
  let saleRatePaise: number | null = input.saleRate ? w.amount('saleRate', input.saleRate, 'Sale rate') : null
  if (saleRatePaise == null) {
    const s = suggestedSaleRate(m.db, item!.id, date)
    saleRatePaise = s.ratePaise
    if (s.ratePaise != null) w.assume(`Sale rate ${rs(s.ratePaise)} — ${s.source === 'sales' ? 'the average selling rate this year' : 'from the price list'} (for the profit line only)`)
  }
  const state: ManufactureFormState = {
    ...emptyManufactureState(date),
    godownId,
    narration: input.narration?.trim() ?? '',
    finishedItemId: item!.id,
    qtyText: qtyText(qtyMilli),
    saleRatePaise,
    labourPaise,
    labourPosted: true,
    labourCreditLedgerId: null,
    rows: padManufactureRows(rows.map((r) => ({ itemId: r.itemId, qtyText: qtyText(r.qtyMilli), godownId: null }))),
    byProducts: [],
    bomVersionId,
    bomExploded: false,
    jobWork: null
  }
  if (labourPaise) w.assume('Labour credited to Wages Payable (the form’s default)')
  if (input.narration) w.fields.add('narration')
  const preview = costPreview(m.db, { date, finishedItemId: item!.id, lines: rows })
  const itemName = (id: number): string => m.items.find((i) => i.id === id)?.name ?? ''
  const ev = evaluateManufactureForm(state, { voucherTypeId: type.id, materialPaise: preview.totalPaise, itemName })
  if (ev.issues.length) throw new Error(ev.issues.map((i) => i.message).join('; '))
  const loss = needsLossConfirmation(ev.totals.profit)
  if (loss) w.assume(`At these costs it makes a loss of ${rs(-ev.totals.profit)} — the editor asks you to confirm`)
  for (const l of preview.lines) {
    if (l.onHandQtyMilli < l.qtyMilli) w.assume(`${itemName(l.itemId)}: only ${formatQtyMilli(l.onHandQtyMilli)} on hand for ${formatQtyMilli(l.qtyMilli)} needed`)
  }
  rehearse(m.db, () => saveManufacture(m.db, { ...ev.input, number: rehearsalNumber(w, type, date), ...(loss ? { confirmLoss: true } : {}) }))
  const production = ev.totals.productionCost
  const summary =
    `Manufacture of ${formatQtyMilli(qtyMilli)} × ${item!.name} on ${date}: raw materials ${rs(preview.totalPaise)}` +
    `${labourPaise ? ` + labour ${rs(labourPaise)}` : ''} = production cost ${rs(production)}` +
    ` (${rows.map((r) => `${formatQtyMilli(r.qtyMilli)} × ${itemName(r.itemId)}`).join(', ')})`
  return finish(w, { voucherTypeId: type.id, voucherKind: 'stock_journal', date, partyLedgerId: null, narration: state.narration || null, reference: null, lines: [], form: 'manufacture', state, total: production }, summary)
}

// ---------- quotations / sales orders / purchase orders ----------

export interface TradeDocDraftInput {
  kind: TradeDocKind
  docTypeId?: number
  series?: string
  party?: string
  partyLedgerId?: number
  date?: string
  items: LineInput[]
  validUntil?: string
  dueDate?: string
  reference?: string
  terms?: string
  narration?: string
  placeOfSupply?: string
}

export function buildTradeDocDraft(w: DraftWork, input: TradeDocDraftInput): BuiltDraft {
  const m = w.m
  const kind = input.kind
  const series = listTradeDocTypes(m.db).filter((t) => t.kind === kind)
  if (series.length === 0) throw new Error(`This company has no ${TRADE_DOC_TITLES[kind].toLowerCase()} series`)
  let docType = series[0]!
  if (input.docTypeId != null) {
    const t = series.find((x) => x.id === input.docTypeId)
    if (!t) throw new Error(`There is no ${TRADE_DOC_TITLES[kind].toLowerCase()} series with id ${input.docTypeId}`)
    docType = t
  } else if (input.series) {
    const r = resolveName(input.series, series.map((t) => ({ id: t.id, name: t.name, keys: [t.prefix] })))
    if (r.status === 'match') {
      docType = series.find((t) => t.id === r.id)!
      w.source({ field: 'series', kind: 'trade_doc', label: docType.name, said: input.series, why: r.why })
    } else {
      w.ask({ field: 'series', said: input.series, question: `Which ${TRADE_DOC_TITLES[kind].toLowerCase()} series is “${input.series}”?`, candidates: series.map((t) => ({ id: t.id, name: t.name })) })
    }
  } else if (series.length > 1) {
    w.assume(`Series: ${docType.name} (the first of ${series.length})`)
  }
  const date = w.date('date', input.date)
  if (input.party == null && input.partyLedgerId == null) throw new Error('Give the party (name, GSTIN or ledgerId)')
  const sales = tradeDocIsSales(kind)
  const party = w.party('party', input.partyLedgerId ?? input.party ?? null, sales ? 'debtor' : 'creditor')
  const pos = input.placeOfSupply ? w.stateCode('pos', input.placeOfSupply) : null
  const resolved = input.items.map((l, i) => {
    const item = w.item(`line:${i}`, l.itemId ?? l.item ?? null)
    return { item, qtyMilli: w.qty(`line:${i}`, l.qty, `Line ${i + 1}`, item), given: l }
  })
  w.settle()
  const supply = supplyTypeFor(m.company.stateCode, pos ?? party!.stateCode ?? m.company.stateCode)
  const rows = resolved.map((r, i) => {
    const { rate, discount } = priceLine(w, i, r.item!, r.qtyMilli, r.given, { date, partyId: party!.id, supply })
    w.fields.add(`line:${i}`)
    return { itemId: r.item!.id, qtyText: qtyText(r.qtyMilli), rate, discount, godownId: null, batchId: null }
  })
  w.settle()
  gstAssumptions(w, [...new Map(resolved.map((r) => [r.item!.id, r.item!])).values()], supply, party!.stateCode, pos)
  const validUntil = kind === 'quotation' ? w.optionalDate('validUntil', input.validUntil) : null
  const dueDate = kind !== 'quotation' ? w.optionalDate('dueDate', input.dueDate) : null
  for (const [k, v] of [['reference', input.reference], ['terms', input.terms], ['narration', input.narration]] as const) if (v) w.fields.add(k)
  const state: TradeDocFormState = {
    ...emptyTradeDocState(kind, date),
    partyId: party!.id,
    validUntil: validUntil ?? '',
    dueDate: dueDate ?? '',
    reference: input.reference?.trim() ?? '',
    terms: input.terms?.trim() ?? '',
    narration: input.narration?.trim() ?? '',
    posOverride: pos && pos !== party!.stateCode ? pos : null,
    rows
  }
  const ctx = { kind, companyStateCode: m.company.stateCode, items: invoiceCtx(m, 'sales').items, ledgers: new Map(m.ledgers.map((l) => [l.id, { stateCode: l.stateCode }])) }
  const built = buildTradeDocPayload(state, ctx, docType.id)
  if (!built.ok) throw new Error(built.error)
  let rehearsalPayload = built.payload
  if (docType.numbering === 'manual') {
    w.assume(`${docType.name} is numbered by hand — type the document number before saving`)
    rehearsalPayload = { ...built.payload, number: 'AI-DRAFT' }
  }
  const saved = rehearse(m.db, () => saveTradeDoc(m.db, rehearsalPayload))
  for (const msg of saved.warnings.linkDates) w.assume(msg)
  const c = computeTradeDoc(state, ctx)
  const g = c.gst
  const tax = [g.cgst ? `CGST ${rs(g.cgst)}` : null, g.sgst ? `SGST ${rs(g.sgst)}` : null, g.igst ? `IGST ${rs(g.igst)}` : null, g.cess ? `cess ${rs(g.cess)}` : null].filter(Boolean)
  const summary =
    `${TRADE_DOC_TITLES[kind]} ${sales ? 'to' : 'from'} ${party!.name} on ${date}: ${c.detail
      .map((d) => `${formatQtyMilli(d.qtyMilli)} × ${m.items.find((i) => i.id === d.itemId)?.name} @ ${rs(d.ratePaise)}`)
      .join('; ')} — taxable ${rs(g.taxable)}${tax.length ? `, ${tax.join(', ')}` : ''}, total ${rs(c.rounded)}`
  return finish(
    w,
    { voucherTypeId: docType.id, voucherKind: kind, date, partyLedgerId: party!.id, narration: state.narration || null, reference: state.reference || null, lines: [], form: 'tradeDoc', state, total: c.rounded },
    summary
  )
}

// re-exported for tests
export { isDebtor, isCreditor }
