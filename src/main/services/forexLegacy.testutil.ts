// TEST ONLY — the forex write paths an older Total had (WP 4.4: closing rates, the foreign
// opening editor, revaluation journals, bill-wise settlement), removed from the app in the 1.0
// cleanup (owner's plan, PR #186; reversing a revaluation stays in the app — forex.ts). Kept verbatim so dbtests can build books such a version wrote
// and prove the app still reads them exactly as before (cashFinanceGuards, Outstandings, the
// statement's foreign opening). Never import this from app code.
import type { DB } from '../db/connection'
import { z } from 'zod'
import type { FxExposureRow, FxRate, FxRevaluationRow } from '@shared/cashFinance'
import { allocateFifo, foldExposure, revalue, settleBills, rateToMicro, inrFromFc, type FxLine } from '@shared/forex'
import { isoDate, ledgerInputSchema } from '@shared/schemas'
import { toDisplayDate } from '@shared/dates'
import { writeAudit } from './audit'
import { descendantIdsByName, cashBankGroupIds, getLedger, updateLedger } from './masters'
import { IN_BOOKS, saveVoucher } from './vouchers'
import { addDays, booksBeginDay, ledgerInfo, postingBlock, systemVoucherTypeId } from './cashFinanceCommon'
import { exposureLedgers, isForeign, listRevaluations, openBills } from './forex'
export { listRevaluations, reverseRevaluation } from './forex'

// ---------- the old write schemas (were in @shared/cashFinance) ----------
const id = z.number().int().positive()
const currencyCode = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'Expected a 3-letter currency code')
const rateMicro = z.number().int().positive().max(1_000_000_000_000)

export const fxRateInputSchema = z.object({
  date: isoDate,
  currencyCode,
  rateMicro,
  note: z.string().trim().max(120).nullable().default(null)
})
export type FxRateInput = z.input<typeof fxRateInputSchema>

/** A foreign-currency opening entered in its currency: the rupee opening (ledgers.opening_balance)
 *  becomes fc × the rate on the books-begin day (`rateMicro`, else the closing rate stored for
 *  that day or the latest before it). */
export const fxForeignOpeningSchema = z.object({
  ledgerId: id,
  currencyCode,
  /** Foreign amount (hundredths, dr-positive: negative = a credit opening). */
  fc: z.number().int().safe().refine((v) => v !== 0, 'Enter the foreign amount'),
  rateMicro: z.number().int().positive().safe().optional()
})
export type FxForeignOpeningInput = z.input<typeof fxForeignOpeningSchema>

export interface FxForeignOpeningResult { ledgerId: number; currencyCode: string; fc: number; openingInr: number; rateMicro: number; rateDate: string | null; booksBegin: string }

export const fxRevaluePostSchema = z.object({
  asOf: isoDate,
  /** Post the reversal dated the next day (Tally-style adjustment). */
  autoReverse: z.boolean().default(true)
})

export const fxSettleInputSchema = z.object({
  partyLedgerId: id,
  bankLedgerId: id,
  date: isoDate,
  /** Foreign amount settled, hundredths of the currency — spread over the open bills oldest
   *  first when `bills` is empty. */
  fcAmount: z.number().int().positive().safe().optional(),
  /** Bill-wise: the foreign amount taken off each open bill (by its name). */
  bills: z.array(z.object({ name: z.string().min(1).max(80), fc: z.number().int().positive().safe() })).max(100).default([]),
  settleRateMicro: rateMicro,
  narration: z.string().trim().max(200).nullable().default(null)
})
export type FxSettleInput = z.input<typeof fxSettleInputSchema>

export interface FxRevaluationPreview {
  asOf: string
  rows: FxExposureRow[]
  /** Currencies with an open balance but no closing rate on or before asOf. */
  missingRates: string[]
  gain: number
  loss: number
  /** Why posting is refused, if it is. */
  blocked: string | null
}

export interface FxSettleResult {
  /** The one settlement voucher (Receipt / Payment, or Journal when the difference sits on the money side). */
  voucherId: number
  bills: { name: string; voucherId: number | null; fc: number; bookInr: number }[]
  bankInr: number
  partyInr: number
  gainLoss: number
}

export const UNREALISED_GAIN = { name: 'Unrealised Forex Gain', group: 'Indirect Incomes' }
export const UNREALISED_LOSS = { name: 'Unrealised Forex Loss', group: 'Indirect Expenses' }
export const REALISED_GAIN = { name: 'Realised Forex Gain', group: 'Indirect Incomes' }
export const REALISED_LOSS = { name: 'Realised Forex Loss', group: 'Indirect Expenses' }
/** The gain / loss ledger: an existing ledger of that name is used only when it sits under an
 *  income (gain) or expense (loss) group; otherwise a fresh "<name> (forex)" ledger is created
 *  under the default group, so a same-named balance-sheet ledger never receives P&L entries. */
export function ensurePlLedger(db: DB, def: { name: string; group: string }): number {
  const want = def.group === 'Indirect Incomes' ? 'income' : 'expense'
  for (const name of [def.name, `${def.name} (forex)`]) {
    const row = db.prepare('SELECT l.id, g.nature FROM ledgers l JOIN groups g ON g.id = l.group_id WHERE l.name = ? COLLATE NOCASE').get(name) as { id: number; nature: string } | undefined
    if (row && row.nature === want) return row.id
    if (row) continue
    const g = db.prepare('SELECT id FROM groups WHERE name = ?').get(def.group) as { id: number } | undefined
    if (!g) throw new Error(`Group ${def.group} missing`)
    return Number(db.prepare('INSERT INTO ledgers (name, group_id, is_system) VALUES (?, ?, 0)').run(name, g.id).lastInsertRowid)
  }
  throw new Error(`Ledgers named ${def.name} exist outside ${def.group} — rename one`)
}
/** Insert or replace the rate for (date, currency). */
export function saveRate(db: DB, raw: FxRateInput): FxRate {
  const input = fxRateInputSchema.parse(raw)
  const before = db.prepare('SELECT id, date, currency_code AS currencyCode, rate_micro AS rateMicro, note FROM fx_rates WHERE date = ? AND currency_code = ?')
    .get(input.date, input.currencyCode) as FxRate | undefined
  if (before) db.prepare('UPDATE fx_rates SET rate_micro = ?, note = ? WHERE id = ?').run(input.rateMicro, input.note, before.id)
  else db.prepare('INSERT INTO fx_rates (date, currency_code, rate_micro, note) VALUES (?, ?, ?, ?)').run(input.date, input.currencyCode, input.rateMicro, input.note)
  const after = db.prepare('SELECT id, date, currency_code AS currencyCode, rate_micro AS rateMicro, note FROM fx_rates WHERE date = ? AND currency_code = ?')
    .get(input.date, input.currencyCode) as FxRate
  writeAudit(db, 'fx_rate', after.id, before ? 'update' : 'create', before ?? null, after)
  return after
}

export function rateOn(db: DB, currency: string, asOf: string): { rateMicro: number; date: string } | null {
  return (db
    .prepare('SELECT rate_micro AS rateMicro, date FROM fx_rates WHERE currency_code = ? AND date <= ? ORDER BY date DESC LIMIT 1')
    .get(currency, asOf) as { rateMicro: number; date: string } | undefined) ?? null
}

// ---------- ledger currency ----------

export function setLedgerCurrency(db: DB, ledgerId: number, currencyCode: string | null, openingFc: number | null = null): void {
  const l = ledgerInfo(db, ledgerId)
  if (!l) throw new Error('Ledger not found')
  const before = db.prepare('SELECT currency_code AS currencyCode, opening_fc AS openingFc FROM fx_ledger_currency WHERE ledger_id = ?').get(ledgerId) as
    | { currencyCode: string; openingFc: number | null }
    | undefined
  if (currencyCode == null) db.prepare('DELETE FROM fx_ledger_currency WHERE ledger_id = ?').run(ledgerId)
  else {
    if (currencyCode === 'INR') throw new Error('Pick a foreign currency')
    const ob = (db.prepare('SELECT opening_balance AS ob FROM ledgers WHERE id = ?').get(ledgerId) as { ob: number }).ob
    if (openingFc != null && (openingFc === 0 || ob === 0 || Math.sign(openingFc) !== Math.sign(ob))) {
      throw new Error('The foreign opening needs a rupee opening balance on the same side (Dr / Cr)')
    }
    db.prepare(
      `INSERT INTO fx_ledger_currency (ledger_id, currency_code, opening_fc) VALUES (?, ?, ?)
       ON CONFLICT(ledger_id) DO UPDATE SET currency_code = excluded.currency_code, opening_fc = excluded.opening_fc`
    ).run(ledgerId, currencyCode, openingFc)
  }
  writeAudit(db, 'fx_ledger_currency', ledgerId, before ? (currencyCode ? 'update' : 'delete') : 'create',
    before ? { ledgerId, ...before } : null, currencyCode ? { ledgerId, currencyCode, openingFc } : null)
}

/** Enter a ledger's opening in its currency: the rupee opening (ledgers.opening_balance, through
 *  masters.updateLedger — audited, opening bills follow it) = `fc` × the rate on the books-begin
 *  day (given, else the closing rate stored on or before that day), and the foreign amount is
 *  kept as opening_fc. A customer / supplier or a cash / bank ledger only. One transaction. */
export function setForeignOpening(db: DB, raw: FxForeignOpeningInput): FxForeignOpeningResult {
  const input = fxForeignOpeningSchema.parse(raw)
  if (input.currencyCode === 'INR') throw new Error('Pick a foreign currency')
  return db.transaction((): FxForeignOpeningResult => {
    const l = ledgerInfo(db, input.ledgerId)
    if (!l) throw new Error('Ledger not found')
    const party = descendantIdsByName(db, ['Sundry Debtors', 'Sundry Creditors']).has(l.groupId)
    if (!party && !cashBankGroupIds(db).has(l.groupId)) throw new Error(`${l.name} is not a customer, supplier or bank account — only those carry a foreign-currency opening`)
    const begin = booksBeginDay(db)
    const stored = input.rateMicro == null ? rateOn(db, input.currencyCode, begin) : null
    const rateMicro = input.rateMicro ?? stored?.rateMicro
    if (!rateMicro) throw new Error(`Enter the ${input.currencyCode} rate on ${toDisplayDate(begin)}, the day the books begin`)
    const openingInr = inrFromFc(input.fc, rateMicro)
    if (openingInr === 0) throw new Error('That foreign amount is less than a paisa at this rate')
    const ledger = getLedger(db, input.ledgerId)!
    if (ledger.openingBalance !== openingInr) updateLedger(db, ledger.id, ledgerInputSchema.parse({ ...ledger, openingBalance: openingInr }))
    setLedgerCurrency(db, input.ledgerId, input.currencyCode, input.fc)
    return { ledgerId: input.ledgerId, currencyCode: input.currencyCode, fc: input.fc, openingInr, rateMicro, rateDate: stored?.date ?? null, booksBegin: begin }
  })()
}

/** Every voucher line of `ledgerId` up to `asOf`, as FxLines (chronological). */
function fxLines(db: DB, ledgerId: number, asOf: string): FxLine[] {
  const rows = db
    .prepare(
      `SELECT v.date, v.id AS voucherId, CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END AS amount,
              v.currency_code AS currency, v.exchange_rate AS rate,
              (SELECT s.fc_amount FROM fx_settlements s WHERE s.voucher_id = v.id AND s.party_ledger_id = vl.ledger_id) AS settledFc,
              CASE WHEN EXISTS (SELECT 1 FROM fx_revaluations r WHERE r.voucher_id = v.id OR r.reversal_voucher_id = v.id) THEN 1 ELSE 0 END AS neutral
       FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
       WHERE vl.ledger_id = ? AND v.date <= ? AND ${IN_BOOKS}
       ORDER BY v.date, v.id, vl.id`
    )
    .all(ledgerId, asOf) as { date: string; voucherId: number; amount: number; currency: string | null; rate: number | null; settledFc: number | null; neutral: number }[]
  return rows.map((r) => ({
    date: r.date,
    voucherId: r.voucherId,
    amount: r.amount,
    currency: isForeign(r.currency) ? r.currency.toUpperCase() : null,
    rateMicro: isForeign(r.currency) && r.rate ? rateToMicro(r.rate) : null,
    fcOverride: r.settledFc != null ? Math.sign(r.amount) * r.settledFc : null,
    revaluation: r.neutral === 1
  }))
}

export function exposure(db: DB, ledgerId: number, asOf: string): ReturnType<typeof foldExposure> & { currencyCode: string; kind: FxExposureRow['kind'] } {
  const led = exposureLedgers(db, asOf).find((e) => e.ledgerId === ledgerId)
  if (!led) throw new Error('This ledger has no foreign-currency balance')
  return { ...foldExposure(fxLines(db, ledgerId, asOf), led.currencyCode, led.opening), currencyCode: led.currencyCode, kind: led.kind }
}

/** Exposures as on `asOf` with the closing rate on or before it and the unrealised difference. */
export function revaluationPreview(db: DB, asOf: string): FxRevaluationPreview {
  const rows: FxExposureRow[] = []
  const missing = new Set<string>()
  for (const e of exposureLedgers(db, asOf)) {
    const f = foldExposure(fxLines(db, e.ledgerId, asOf), e.currencyCode, e.opening)
    if (f.fcBalance === 0 && f.inrBook === 0) continue
    const rate = rateOn(db, e.currencyCode, asOf)
    if (!rate) missing.add(e.currencyCode)
    const r = rate ? revalue(f.fcBalance, f.inrBook, rate.rateMicro) : null
    rows.push({
      ledgerId: e.ledgerId, ledgerName: e.ledgerName, kind: e.kind, currencyCode: e.currencyCode, fcBalance: f.fcBalance, inrBook: f.inrBook,
      carryingRateMicro: f.carryingRateMicro, closingRateMicro: rate?.rateMicro ?? null, closingRateDate: rate?.date ?? null,
      target: r?.target ?? null, gainLoss: r?.gainLoss ?? null, rupeeLines: f.rupeeLines
    })
  }
  rows.sort((a, b) => a.currencyCode.localeCompare(b.currencyCode) || a.ledgerName.localeCompare(b.ledgerName))
  const gain = rows.reduce((s, r) => s + Math.max(0, r.gainLoss ?? 0), 0)
  const loss = rows.reduce((s, r) => s + Math.max(0, -(r.gainLoss ?? 0)), 0)
  let blocked: string | null = null
  const existing = liveRevaluationOn(db, asOf)
  if (existing) blocked = `Already revalued as on ${toDisplayDate(asOf)} (journal ${existing.number}) — move it to the bin to revalue again`
  else if (missing.size > 0) blocked = `Enter a closing rate for ${[...missing].sort().join(', ')} on or before ${toDisplayDate(asOf)}`
  else if (gain === 0 && loss === 0) blocked = rows.length === 0 ? 'No foreign-currency balances to revalue' : 'Every balance is already at the closing rate'
  else blocked = postingBlock(db, asOf)
  return { asOf, rows, missingRates: [...missing].sort(), gain, loss, blocked }
}

function liveRevaluationOn(db: DB, asOf: string): { id: number; number: string } | null {
  return (db
    .prepare(
      `SELECT r.id, v.number FROM fx_revaluations r JOIN vouchers v ON v.id = r.voucher_id
       WHERE r.as_of = ? AND v.deleted_at IS NULL LIMIT 1`
    )
    .get(asOf) as { id: number; number: string } | undefined) ?? null
}

type Line = { ledgerId: number; drCr: 'dr' | 'cr'; amount: number; costAllocations: [] }
const flip = (l: Line): Line => ({ ...l, drCr: l.drCr === 'dr' ? 'cr' : 'dr' })

function journal(db: DB, date: string, narration: string, lines: Line[], reference: string | null = null): { id: number; number: string } {
  const v = saveVoucher(db, {
    voucherTypeId: systemVoucherTypeId(db, 'journal'), date, partyLedgerId: null, narration, reference, lines, inventory: [], billRefs: [], tds: null
  })
  return { id: v.id, number: v.number }
}

/** Post the revaluation journal as on `asOf` (and its reversal the next day when asked). */
export function postRevaluation(db: DB, raw: { asOf: string; autoReverse?: boolean }): FxRevaluationRow {
  const { asOf, autoReverse } = fxRevaluePostSchema.parse(raw)
  const run = db.transaction((): number => {
    const p = revaluationPreview(db, asOf)
    if (p.blocked) throw new Error(p.blocked)
    const reverseOn = addDays(asOf, 1)
    if (autoReverse) {
      const b = postingBlock(db, reverseOn)
      if (b) throw new Error(`The reversal on ${toDisplayDate(reverseOn)} can't be posted: ${b}`)
    }
    const lines: Line[] = []
    for (const r of p.rows) {
      const adj = r.gainLoss ?? 0
      if (adj === 0) continue
      lines.push({ ledgerId: r.ledgerId, drCr: adj > 0 ? 'dr' : 'cr', amount: Math.abs(adj), costAllocations: [] })
    }
    if (p.gain > 0) lines.push({ ledgerId: ensurePlLedger(db, UNREALISED_GAIN), drCr: 'cr', amount: p.gain, costAllocations: [] })
    if (p.loss > 0) lines.push({ ledgerId: ensurePlLedger(db, UNREALISED_LOSS), drCr: 'dr', amount: p.loss, costAllocations: [] })
    const currencies = [...new Set(p.rows.map((r) => r.currencyCode))].join(', ')
    const v = journal(db, asOf, `Forex revaluation as on ${toDisplayDate(asOf)} at closing rates (${currencies}) — AS 11 / Ind AS 21: monetary items at the closing rate`, lines)
    let reversalId: number | null = null
    if (autoReverse) {
      reversalId = journal(db, reverseOn, `Reversal of forex revaluation as on ${toDisplayDate(asOf)} (journal ${v.number})`, lines.map(flip)).id
    }
    const revId = Number(db.prepare('INSERT INTO fx_revaluations (as_of, voucher_id, reversal_voucher_id, auto_reverse, gain, loss) VALUES (?, ?, ?, ?, ?, ?)')
      .run(asOf, v.id, reversalId, autoReverse ? 1 : 0, p.gain, p.loss).lastInsertRowid)
    const ins = db.prepare(
      `INSERT INTO fx_revaluation_lines (revaluation_id, ledger_id, currency_code, fc_balance, book_inr, rate_micro, target_inr, adjustment)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const r of p.rows) ins.run(revId, r.ledgerId, r.currencyCode, r.fcBalance, r.inrBook, r.closingRateMicro, r.target, r.gainLoss)
    return revId
  })
  const id = run()
  const row = listRevaluations(db).find((r) => r.id === id)!
  writeAudit(db, 'fx_revaluation', id, 'create', null, { ...row, lines: revaluationLines(db, id) })
  return row
}

export function revaluationLines(db: DB, id: number): { ledgerId: number; ledgerName: string; currencyCode: string; fcBalance: number; bookInr: number; rateMicro: number; targetInr: number; adjustment: number }[] {
  return db
    .prepare(
      `SELECT x.ledger_id AS ledgerId, l.name AS ledgerName, x.currency_code AS currencyCode, x.fc_balance AS fcBalance, x.book_inr AS bookInr,
              x.rate_micro AS rateMicro, x.target_inr AS targetInr, x.adjustment
       FROM fx_revaluation_lines x JOIN ledgers l ON l.id = x.ledger_id WHERE x.revaluation_id = ? ORDER BY x.currency_code, l.name`
    )
    .all(id) as { ledgerId: number; ledgerName: string; currencyCode: string; fcBalance: number; bookInr: number; rateMicro: number; targetInr: number; adjustment: number }[]
}

/** Record a settlement at the actual rate, bill by bill (AS 11 para 13 / Ind AS 21 para 28): one
 *  voucher — bank at the rupees moved, the party at the bills' book value with bill references
 *  against them, the realised difference on Realised Forex Gain / Loss. Without explicit bills the
 *  foreign amount is spread over the open bills oldest first (each still at its own rate). */
export function settle(db: DB, raw: FxSettleInput): FxSettleResult {
  const input = fxSettleInputSchema.parse(raw)
  const run = db.transaction((): FxSettleResult & { id: number } => {
    const party = ledgerInfo(db, input.partyLedgerId)
    if (!party) throw new Error('Party ledger not found')
    if (!cashBankGroupIds(db).has(ledgerInfo(db, input.bankLedgerId)?.groupId ?? -1)) throw new Error('Settle through a cash or bank ledger')
    const { currencyCode, kind, bills } = openBills(db, input.partyLedgerId, input.date)
    if (kind === 'bank') throw new Error('Pick a customer or supplier')
    const allocations = input.bills.length > 0 ? input.bills : allocateFifo(bills, input.fcAmount ?? 0)
    const split = settleBills(bills, allocations, input.settleRateMicro, kind)
    const block = postingBlock(db, input.date)
    if (block) throw new Error(block)
    const receivable = kind === 'receivable'
    const rate = input.settleRateMicro / 1_000_000
    const fcText = `${(split.fcTotal / 100).toFixed(2)} ${currencyCode}`
    type L = { ledgerId: number; drCr: 'dr' | 'cr'; amount: number; costAllocations: [] }
    const lines: L[] = receivable
      ? [{ ledgerId: input.bankLedgerId, drCr: 'dr', amount: split.bankInr, costAllocations: [] }, { ledgerId: input.partyLedgerId, drCr: 'cr', amount: split.partyInr, costAllocations: [] }]
      : [{ ledgerId: input.partyLedgerId, drCr: 'dr', amount: split.partyInr, costAllocations: [] }, { ledgerId: input.bankLedgerId, drCr: 'cr', amount: split.bankInr, costAllocations: [] }]
    const gain = split.gainLoss > 0
    if (split.gainLoss !== 0) {
      lines.push({ ledgerId: ensurePlLedger(db, gain ? REALISED_GAIN : REALISED_LOSS), drCr: gain ? 'cr' : 'dr', amount: Math.abs(split.gainLoss), costAllocations: [] })
    }
    // Receipt / Payment when the P&L line sits on the non-money side; otherwise a Journal.
    const voucherKind = split.gainLoss === 0 || (receivable ? gain : !gain) ? (receivable ? 'receipt' : 'payment') : 'journal'
    const v = saveVoucher(db, {
      voucherTypeId: systemVoucherTypeId(db, voucherKind),
      date: input.date,
      partyLedgerId: input.partyLedgerId,
      narration: input.narration ?? `${receivable ? 'Received' : 'Paid'} ${fcText} at ₹${rate} against ${split.lines.map((l) => l.name).join(', ')} — ${party.name}${split.gainLoss ? ` (realised ${gain ? 'gain' : 'loss'})` : ''}`,
      reference: null,
      currencyCode,
      exchangeRate: rate,
      lines,
      inventory: [],
      billRefs: split.lines.filter((l) => l.bookInr > 0).map((l) => ({ kind: 'against' as const, name: l.name, amount: l.bookInr, dueDate: null })),
      tds: null
    })
    const id = Number(db.prepare(
      `INSERT INTO fx_settlements (voucher_id, party_ledger_id, currency_code, fc_amount, settle_rate_micro, party_inr, bank_inr, gain_loss)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(v.id, input.partyLedgerId, currencyCode, split.fcTotal, input.settleRateMicro, split.partyInr, split.bankInr, split.gainLoss).lastInsertRowid)
    const ins = db.prepare('INSERT INTO fx_settlement_bills (settlement_id, invoice_voucher_id, bill_name, fc_amount, book_inr) VALUES (?, ?, ?, ?, ?)')
    for (const l of split.lines) ins.run(id, l.voucherId, l.name, l.fc, l.bookInr)
    return { id, voucherId: v.id, bankInr: split.bankInr, partyInr: split.partyInr, gainLoss: split.gainLoss, bills: split.lines }
  })
  const { id, ...result } = run()
  writeAudit(db, 'fx_settlement', id, 'create', null, { ...result, partyLedgerId: input.partyLedgerId, settleRateMicro: input.settleRateMicro })
  return result
}
