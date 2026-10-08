// Foreign-currency exposures, closing rates, revaluation journals and settlements (WP 4.4).
//
// What existed before this WP (documented, unchanged): a voucher can carry `currency_code` and
// `exchange_rate` (₹ per unit); the invoice editor converts foreign rates to ₹ lines at that rate,
// and the books are kept in ₹ only. Receipts and payments carry no currency in their editor, and
// nothing computed realised or unrealised exchange differences.
//
// This service adds, on top (src/shared/forex.ts has the arithmetic and the AS 11 / Ind AS 21
// basis):
// - exposures: party ledgers (Sundry Debtors / Creditors) with foreign-currency vouchers, plus any
//   ledger the user designates as kept in a currency (fx_ledger_currency — e.g. an EEFC bank
//   account). Foreign balances are folded from voucher lines at query time; rupee lines that carry
//   no foreign amount are converted at the carrying rate (flagged on the screen);
// - closing rates the user enters by date (fx_rates; no network);
// - the revaluation journal as on a date: each exposure restated at the closing rate, the
//   difference Dr/Cr the ledger against Unrealised Forex Gain (Indirect Incomes) / Unrealised
//   Forex Loss (Indirect Expenses), optionally reversed the next day;
// - settlement at an actual rate, BILL BY BILL: each foreign invoice / bill is relieved at its own
//   book rate (AS 11 para 13 — no weighted average), in ONE voucher: bank at the rupees actually
//   moved, the party at the bills' book value (with bill references against those bills, so
//   Outstandings agree), the realised difference on Realised Forex Gain / Loss. A Receipt or
//   Payment voucher can't carry a P&L ledger on its money side, so a receipt at a loss (or a
//   payment at a gain) is posted as a Journal.
// - rupee entries on a foreign party (a rupee sale, a receipt entered without a foreign amount)
//   are rupee money: they are not part of the foreign balance and are never revalued.
// - Tally-imported or hand-entered openings: the ledger's rupee opening counts as foreign money
//   only when its foreign amount is entered on Forex → foreign-currency ledgers (opening_fc).
import type { DB } from '../db/connection'
import {
  fxRateInputSchema, fxRevaluePostSchema, fxSettleInputSchema,
  type FxExposureRow, type FxRate, type FxRateInput, type FxRevaluationPreview, type FxRevaluationRow, type FxSettleInput, type FxSettleResult
} from '@shared/cashFinance'
import { allocateFifo, foldExposure, openForeignBills, revalue, settleBills, rateToMicro, fcFromInr, type ForeignBill, type ForeignEntry, type FxLine } from '@shared/forex'
import { toDisplayDate } from '@shared/dates'
import { writeAudit } from './audit'
import { descendantIdsByName, cashBankGroupIds } from './masters'
import { IN_BOOKS, saveVoucher } from './vouchers'
import { addDays, ledgerInfo, postingBlock, systemVoucherTypeId } from './cashFinanceCommon'

export const UNREALISED_GAIN = { name: 'Unrealised Forex Gain', group: 'Indirect Incomes' }
export const UNREALISED_LOSS = { name: 'Unrealised Forex Loss', group: 'Indirect Expenses' }
export const REALISED_GAIN = { name: 'Realised Forex Gain', group: 'Indirect Incomes' }
export const REALISED_LOSS = { name: 'Realised Forex Loss', group: 'Indirect Expenses' }

const isForeign = (code: string | null): code is string => !!code && code.toUpperCase() !== 'INR'

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

// ---------- closing rates ----------

export function listRates(db: DB): FxRate[] {
  return db
    .prepare('SELECT id, date, currency_code AS currencyCode, rate_micro AS rateMicro, note FROM fx_rates ORDER BY date DESC, currency_code')
    .all() as FxRate[]
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

export function deleteRate(db: DB, id: number): void {
  const before = db.prepare('SELECT id, date, currency_code AS currencyCode, rate_micro AS rateMicro, note FROM fx_rates WHERE id = ?').get(id) as FxRate | undefined
  if (!before) throw new Error('Rate not found')
  db.prepare('DELETE FROM fx_rates WHERE id = ?').run(id)
  writeAudit(db, 'fx_rate', id, 'delete', before, null)
}

/** The latest rate for `currency` dated on or before `asOf`. */
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

export function listLedgerCurrencies(db: DB): { ledgerId: number; ledgerName: string; currencyCode: string; openingFc: number | null; openingInr: number }[] {
  return db
    .prepare(
      `SELECT f.ledger_id AS ledgerId, l.name AS ledgerName, f.currency_code AS currencyCode, f.opening_fc AS openingFc, l.opening_balance AS openingInr
       FROM fx_ledger_currency f JOIN ledgers l ON l.id = f.ledger_id ORDER BY l.name`
    )
    .all() as { ledgerId: number; ledgerName: string; currencyCode: string; openingFc: number | null; openingInr: number }[]
}

// ---------- exposures ----------

interface ExposureLedger { ledgerId: number; ledgerName: string; currencyCode: string; kind: FxExposureRow['kind']; opening: { fc: number; inr: number } | null }

function exposureLedgers(db: DB, asOf: string): ExposureLedger[] {
  const debtors = descendantIdsByName(db, ['Sundry Debtors'])
  const creditors = descendantIdsByName(db, ['Sundry Creditors'])
  const banks = cashBankGroupIds(db)
  const ledgers = new Map(
    (db.prepare('SELECT id, name, group_id AS groupId FROM ledgers').all() as { id: number; name: string; groupId: number }[]).map((l) => [l.id, l])
  )
  const out = new Map<number, ExposureLedger>()
  const kindOf = (groupId: number): FxExposureRow['kind'] =>
    banks.has(groupId) ? 'bank' : creditors.has(groupId) ? 'payable' : 'receivable'
  for (const d of listLedgerCurrencies(db)) {
    const l = ledgers.get(d.ledgerId)
    if (l) out.set(d.ledgerId, { ledgerId: d.ledgerId, ledgerName: d.ledgerName, currencyCode: d.currencyCode, kind: kindOf(l.groupId), opening: d.openingFc ? { fc: d.openingFc, inr: d.openingInr } : null })
  }
  // Party ledgers: the currency of their most recent foreign-currency voucher.
  const party = db
    .prepare(
      `SELECT vl.ledger_id AS ledgerId, v.currency_code AS currencyCode
       FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
       WHERE v.currency_code IS NOT NULL AND UPPER(v.currency_code) <> 'INR' AND v.date <= ? AND ${IN_BOOKS}
       ORDER BY v.date DESC, v.id DESC`
    )
    .all(asOf) as { ledgerId: number; currencyCode: string }[]
  for (const p of party) {
    if (out.has(p.ledgerId)) continue
    const l = ledgers.get(p.ledgerId)
    if (!l || !(debtors.has(l.groupId) || creditors.has(l.groupId))) continue
    out.set(p.ledgerId, { ledgerId: p.ledgerId, ledgerName: l.name, currencyCode: p.currencyCode.toUpperCase(), kind: kindOf(l.groupId), opening: null })
  }
  return [...out.values()]
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

/** Reverse a revaluation that was posted without auto-reversal (dated `date`, default next day). */
export function reverseRevaluation(db: DB, id: number, date?: string): FxRevaluationRow {
  const run = db.transaction(() => {
    const rev = db.prepare('SELECT * FROM fx_revaluations WHERE id = ?').get(id) as { id: number; as_of: string; voucher_id: number | null; reversal_voucher_id: number | null } | undefined
    if (!rev || rev.voucher_id == null) throw new Error('Revaluation not found')
    const live = db.prepare('SELECT number FROM vouchers WHERE id = ? AND deleted_at IS NULL').get(rev.voucher_id) as { number: string } | undefined
    if (!live) throw new Error('The revaluation journal is in the bin')
    if (rev.reversal_voucher_id != null && db.prepare('SELECT 1 FROM vouchers WHERE id = ? AND deleted_at IS NULL').get(rev.reversal_voucher_id)) {
      throw new Error('Already reversed')
    }
    const on = date ?? addDays(rev.as_of, 1)
    if (on <= rev.as_of) throw new Error('The reversal must be dated after the revaluation')
    const lines = (db.prepare('SELECT ledger_id AS ledgerId, dr_cr AS drCr, amount FROM voucher_lines WHERE voucher_id = ? ORDER BY id').all(rev.voucher_id) as Line[])
      .map((l) => flip({ ...l, costAllocations: [] }))
    const r = journal(db, on, `Reversal of forex revaluation as on ${toDisplayDate(rev.as_of)} (journal ${live.number})`, lines)
    db.prepare('UPDATE fx_revaluations SET reversal_voucher_id = ? WHERE id = ?').run(r.id, id)
  })
  run()
  const row = listRevaluations(db).find((r) => r.id === id)!
  writeAudit(db, 'fx_revaluation', id, 'update', { reversed: false }, row)
  return row
}

export function listRevaluations(db: DB): FxRevaluationRow[] {
  return (db
    .prepare(
      `SELECT r.id, r.as_of AS asOf, r.voucher_id AS voucherId, v.number AS voucherNumber, r.reversal_voucher_id AS reversalVoucherId,
              rv.number AS reversalVoucherNumber, r.auto_reverse AS autoReverse, r.gain, r.loss, r.created_at AS createdAt,
              CASE WHEN v.id IS NOT NULL AND v.deleted_at IS NULL THEN 1 ELSE 0 END AS live,
              CASE WHEN rv.id IS NOT NULL AND rv.deleted_at IS NULL THEN 1 ELSE 0 END AS revLive
       FROM fx_revaluations r LEFT JOIN vouchers v ON v.id = r.voucher_id LEFT JOIN vouchers rv ON rv.id = r.reversal_voucher_id
       ORDER BY r.as_of DESC, r.id DESC`
    )
    .all() as (Omit<FxRevaluationRow, 'autoReverse' | 'live'> & { autoReverse: number; live: number; revLive: number })[]).map(({ revLive, ...r }) => ({
    ...r,
    autoReverse: !!r.autoReverse,
    live: !!r.live,
    reversalVoucherId: revLive ? r.reversalVoucherId : null,
    reversalVoucherNumber: revLive ? r.reversalVoucherNumber : null
  }))
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

/** Whether a live revaluation exists as on `asOf` (year-end check). */
export function revaluedOn(db: DB, asOf: string): boolean {
  return liveRevaluationOn(db, asOf) != null
}

// ---------- settlement ----------

/** The foreign bills of an exposure still open on `asOf`, oldest first — each with its own book
 *  rate. A bill is named by its bill reference (else the voucher number, as Outstandings does). */
export function openBills(db: DB, partyLedgerId: number, asOf: string): { currencyCode: string; kind: FxExposureRow['kind']; bills: ForeignBill[] } {
  const ex = exposureLedgers(db, asOf).find((e) => e.ledgerId === partyLedgerId)
  if (!ex) throw new Error('This ledger has no foreign-currency balance')
  const receivable = ex.kind !== 'payable'
  const rows = db
    .prepare(
      `SELECT v.id AS voucherId, v.date, v.number, v.exchange_rate AS rate,
              SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END) AS amount,
              (SELECT br.name FROM bill_refs br WHERE br.voucher_id = v.id AND br.party_ledger_id = vl.ledger_id AND br.kind = 'new' ORDER BY br.id LIMIT 1) AS billName
       FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
       WHERE vl.ledger_id = ? AND v.date <= ? AND ${IN_BOOKS} AND UPPER(v.currency_code) = ? AND v.exchange_rate > 0
         AND v.id NOT IN (SELECT voucher_id FROM fx_settlements)
         AND v.id NOT IN (SELECT voucher_id FROM fx_revaluations WHERE voucher_id IS NOT NULL)
         AND v.id NOT IN (SELECT reversal_voucher_id FROM fx_revaluations WHERE reversal_voucher_id IS NOT NULL)
       GROUP BY v.id ORDER BY v.date, v.id`
    )
    .all(partyLedgerId, asOf, ex.currencyCode) as { voucherId: number; date: string; number: string; rate: number; amount: number; billName: string | null }[]
  const bills: ForeignEntry[] = []
  const reductions: { fc: number }[] = []
  if (ex.opening) bills.push({ name: 'Opening', voucherId: null, date: '0000-01-01', fc: Math.abs(ex.opening.fc), inr: Math.abs(ex.opening.inr) })
  for (const r of rows) {
    const fc = Math.abs(fcFromInr(r.amount, rateToMicro(r.rate)))
    if (fc === 0) continue
    if ((r.amount > 0) === receivable) bills.push({ name: r.billName ?? r.number, voucherId: r.voucherId, date: r.date, fc, inr: Math.abs(r.amount) })
    else reductions.push({ fc })
  }
  const settled = db
    .prepare(
      `SELECT b.bill_name AS name, b.fc_amount AS fc, b.book_inr AS bookInr
       FROM fx_settlement_bills b JOIN fx_settlements s ON s.id = b.settlement_id JOIN vouchers v ON v.id = s.voucher_id
       WHERE s.party_ledger_id = ? AND v.date <= ? AND ${IN_BOOKS} ORDER BY v.date, v.id, b.id`
    )
    .all(partyLedgerId, asOf) as { name: string; fc: number; bookInr: number }[]
  return { currencyCode: ex.currencyCode, kind: ex.kind, bills: openForeignBills(bills, reductions, settled) }
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

/** Open foreign balances as on the FY's last day, by currency (year-end warning). */
export function unrevaluedBalances(db: DB, asOf: string): { currencyCode: string; ledgers: number; fcBalance: number }[] {
  const by = new Map<string, { currencyCode: string; ledgers: number; fcBalance: number }>()
  for (const e of exposureLedgers(db, asOf)) {
    const f = foldExposure(fxLines(db, e.ledgerId, asOf), e.currencyCode, e.opening)
    if (f.fcBalance === 0) continue
    const row = by.get(e.currencyCode) ?? { currencyCode: e.currencyCode, ledgers: 0, fcBalance: 0 }
    row.ledgers++
    row.fcBalance += f.fcBalance
    by.set(e.currencyCode, row)
  }
  return [...by.values()].sort((a, b) => a.currencyCode.localeCompare(b.currencyCode))
}
