// Foreign-currency READERS (WP 4.4; the forex screen, revaluation, settlement and foreign-opening
// editor went in the 1.0 cleanup — owner's plan, PR #186) — plus the one write kept: reversing a
// revaluation posted without its next-day reversal (`reverseRevaluation`, the "Reverse…" action on
// that journal in the full app; review of #195), since a hand-made reversal would be counted by
// bill-wise ageing (NOT_FX_REVALUATION ignores only real revaluation vouchers) and Outstandings
// would stop agreeing with the trial balance. Books that already hold foreign data
// report exactly as before: a voucher keeps its `currency_code` / `exchange_rate`, ledgers keep
// their `fx_ledger_currency` row (opening_fc), and revaluation / settlement vouchers stay in the
// books, bin-only (cashFinanceGuards.ts, which reads `openBills` to refuse restoring a settlement
// whose bills were settled again). The statement's foreign opening (reports.ts), the
// revaluation filter on bill-wise ageing (NOT_FX_REVALUATION, analysis.ts) and the stored closing
// rates (`listRates` — the simple AI helper's rupee cost) read the same tables, unchanged.
import type { DB } from '../db/connection'
import type { FxExposureRow, FxRate, FxRevaluationRow } from '@shared/cashFinance'
import { openForeignBills, openingBillsFc, rateToMicro, fcFromInr, type ForeignBill, type ForeignEntry } from '@shared/forex'
import { OPENING_BALANCE_NAME } from '@shared/simple/openings'
import { descendantIdsByName, cashBankGroupIds } from './masters'
import { openingBillsByParty } from './openingBills'
import { toDisplayDate } from '@shared/dates'
import { writeAudit } from './audit'
import { IN_BOOKS, saveVoucher } from './vouchers'
import { addDays, systemVoucherTypeId } from './cashFinanceCommon'

export const isForeign = (code: string | null): code is string => !!code && code.toUpperCase() !== 'INR'

// ---------- closing rates ----------

export function listRates(db: DB): FxRate[] {
  return db
    .prepare('SELECT id, date, currency_code AS currencyCode, rate_micro AS rateMicro, note FROM fx_rates ORDER BY date DESC, currency_code')
    .all() as FxRate[]
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

export function exposureLedgers(db: DB, asOf: string): ExposureLedger[] {
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

// ---------- open foreign bills ----------

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
  if (ex.opening) {
    // A party whose opening is split into bills (WP 8.7): each bill at the opening's one rate,
    // named as Outstandings names it; otherwise the one 'Opening' bill, as before.
    const split = openingBillsByParty(db, [partyLedgerId]).get(partyLedgerId)
    if (split?.length) {
      for (const b of openingBillsFc(ex.opening, split, OPENING_BALANCE_NAME)) bills.push({ name: b.name, voucherId: null, date: b.date, fc: b.fc, inr: b.inr })
    } else bills.push({ name: 'Opening', voucherId: null, date: '0000-01-01', fc: Math.abs(ex.opening.fc), inr: Math.abs(ex.opening.inr) })
  }
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

/** A ledger's stored foreign opening (entered on the removed Forex screen), for the ledger form's
 *  note that it no longer follows the rupee opening. Null when there is none. */
export function foreignOpeningOf(db: DB, ledgerId: number): { currencyCode: string; openingFc: number } | null {
  return (db
    .prepare('SELECT currency_code AS currencyCode, opening_fc AS openingFc FROM fx_ledger_currency WHERE ledger_id = ? AND opening_fc IS NOT NULL')
    .get(ledgerId) as { currencyCode: string; openingFc: number } | undefined) ?? null
}

// ---------- revaluations already in the books ----------

type Line = { ledgerId: number; drCr: 'dr' | 'cr'; amount: number; costAllocations: [] }
const flip = (l: Line): Line => ({ ...l, drCr: l.drCr === 'dr' ? 'cr' : 'dr' })

function journal(db: DB, date: string, narration: string, lines: Line[]): { id: number; number: string } {
  const v = saveVoucher(db, {
    voucherTypeId: systemVoucherTypeId(db, 'journal'), date, partyLedgerId: null, narration, reference: null, lines, inventory: [], billRefs: [], tds: null
  })
  return { id: v.id, number: v.number }
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

/** The revaluation a voucher is the journal of (not its reversal), for the voucher view's
 *  "Reverse…" action: `reversed` = a live reversal exists. Null for any other voucher. */
export function revaluationOf(db: DB, voucherId: number): { id: number; asOf: string; reversed: boolean } | null {
  const rev = db
    .prepare('SELECT r.id FROM fx_revaluations r JOIN vouchers v ON v.id = r.voucher_id WHERE r.voucher_id = ? AND v.deleted_at IS NULL')
    .get(voucherId) as { id: number } | undefined
  if (!rev) return null // not a revaluation journal, or one in the bin (Reverse… would be refused)
  const row = listRevaluations(db).find((x) => x.id === rev.id)!
  return { id: row.id, asOf: row.asOf, reversed: row.reversalVoucherId != null }
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
