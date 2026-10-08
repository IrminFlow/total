// WP 4.4 — vouchers owned by cash-and-finance records (loan instalments, forex revaluations and
// their reversals, forex settlements) are immutable except through the bin, like depreciation
// and closing journals. vouchers.ts calls these three hooks:
// - assertCashFinanceVoucherEditable on an edit: always refused for an owned voucher;
// - binCashFinancePartners inside deleteVoucher's transaction: a revaluation and its reversal go
//   to the bin together;
// - cashFinanceRestorePlan before restoreVoucher (refusals) and restoreCashFinancePartners inside
//   its transaction (the partner comes back too).
// Restore is refused when it would double-count: a loan instalment that was posted again (or whose
// schedule row no longer exists), a revaluation when another live one exists for the same date, a
// settlement whose bills are no longer open for the amounts it relieves.
import type { DB } from '../db/connection'
import { writeAudit } from './audit'
import { getLockDate, getVoucher } from './vouchers'
import { openBills } from './forex'

type Owner =
  | { kind: 'loan'; loanId: number; seq: number }
  | { kind: 'revaluation' | 'reversal'; revaluationId: number; asOf: string; partner: number | null }
  | { kind: 'settlement'; settlementId: number; partyLedgerId: number }

function ownerOf(db: DB, voucherId: number): Owner | null {
  const loan = db.prepare('SELECT loan_id AS loanId, seq FROM loan_vouchers WHERE voucher_id = ?').get(voucherId) as { loanId: number; seq: number } | undefined
  if (loan) return { kind: 'loan', ...loan }
  const rev = db
    .prepare('SELECT id, as_of AS asOf, voucher_id AS v, reversal_voucher_id AS r FROM fx_revaluations WHERE voucher_id = ? OR reversal_voucher_id = ?')
    .get(voucherId, voucherId) as { id: number; asOf: string; v: number | null; r: number | null } | undefined
  if (rev) {
    const isMain = rev.v === voucherId
    return { kind: isMain ? 'revaluation' : 'reversal', revaluationId: rev.id, asOf: rev.asOf, partner: isMain ? rev.r : rev.v }
  }
  const st = db.prepare('SELECT id, party_ledger_id AS p FROM fx_settlements WHERE voucher_id = ?').get(voucherId) as { id: number; p: number } | undefined
  if (st) return { kind: 'settlement', settlementId: st.id, partyLedgerId: st.p }
  return null
}

const EDIT_REFUSED: Record<Owner['kind'], string> = {
  loan: 'This voucher was posted from Loans (an instalment) — move it to the bin and post the instalment again',
  revaluation: 'This is a forex revaluation journal — move it to the bin (its reversal goes with it) and revalue again',
  reversal: 'This reverses a forex revaluation — move it to the bin (the revaluation goes with it) and revalue again',
  settlement: 'This is a forex settlement from the Forex screen — move it to the bin and settle again'
}

export function assertCashFinanceVoucherEditable(db: DB, voucherId: number): void {
  const o = ownerOf(db, voucherId)
  if (o) throw new Error(EDIT_REFUSED[o.kind])
}

const isLive = (db: DB, id: number): boolean => !!db.prepare('SELECT 1 FROM vouchers WHERE id = ? AND deleted_at IS NULL').get(id)

function assertUnlocked(db: DB, voucherId: number): void {
  const lock = getLockDate(db)
  const v = db.prepare('SELECT date FROM vouchers WHERE id = ?').get(voucherId) as { date: string }
  if (lock && v.date <= lock) throw new Error(`Books are locked up to ${lock} (the paired voucher is dated ${v.date})`)
}

/** Inside deleteVoucher's transaction: bin the revaluation's partner with it. */
export function binCashFinancePartners(db: DB, voucherId: number): void {
  const o = ownerOf(db, voucherId)
  if (!o || (o.kind !== 'revaluation' && o.kind !== 'reversal') || o.partner == null || !isLive(db, o.partner)) return
  assertUnlocked(db, o.partner)
  const before = getVoucher(db, o.partner)
  db.prepare("UPDATE vouchers SET deleted_at = datetime('now') WHERE id = ?").run(o.partner)
  writeAudit(db, 'voucher', o.partner, 'delete', before, { pairedWith: voucherId })
}

/** Before restoreVoucher: refuse a double-counting restore; returns partners to restore too. */
export function cashFinanceRestorePlan(db: DB, voucherId: number): number[] {
  const o = ownerOf(db, voucherId)
  if (!o) return []
  if (o.kind === 'loan') {
    const loan = db.prepare('SELECT 1 FROM loans WHERE id = ?').get(o.loanId)
    const row = db.prepare('SELECT 1 FROM loan_schedules WHERE loan_id = ? AND voucher_id = ?').get(o.loanId, voucherId)
    if (!loan || !row) {
      throw new Error(`Instalment ${o.seq} was posted again or the schedule changed since — this voucher can't come back (purge it from the bin)`)
    }
    return []
  }
  if (o.kind === 'revaluation' || o.kind === 'reversal') {
    const other = db
      .prepare(
        `SELECT v.number FROM fx_revaluations r JOIN vouchers v ON v.id = r.voucher_id
         WHERE r.as_of = ? AND r.id <> ? AND v.deleted_at IS NULL LIMIT 1`
      )
      .get(o.asOf, o.revaluationId) as { number: string } | undefined
    if (other) throw new Error(`A newer revaluation as on ${o.asOf} is live (journal ${other.number}) — bin it first`)
    if (o.partner != null && !isLive(db, o.partner)) {
      assertUnlocked(db, o.partner)
      return [o.partner]
    }
    return []
  }
  if (o.kind !== 'settlement') return []
  // settlement: its bills must still be open for what it relieves
  // Every live settlement counts, including ones dated after this one.
  const open = openBills(db, o.partyLedgerId, '9999-12-31').bills
  const lines = db.prepare('SELECT bill_name AS name, fc_amount AS fc FROM fx_settlement_bills WHERE settlement_id = ?').all(o.settlementId) as { name: string; fc: number }[]
  for (const l of lines) {
    const b = open.find((x) => x.name === l.name)
    if (!b || b.fcOpen < l.fc) throw new Error(`Bill ${l.name} has been settled again since — this settlement can't come back`)
  }
  return []
}

/** Inside restoreVoucher's transaction. */
export function restoreCashFinancePartners(db: DB, ids: number[], restoredWith: number): void {
  for (const id of ids) {
    const before = getVoucher(db, id)
    db.prepare('UPDATE vouchers SET deleted_at = NULL WHERE id = ?').run(id)
    writeAudit(db, 'voucher', id, 'restore', before, { restored: true, pairedWith: restoredWith })
  }
}

/** True when the voucher is owned by a cash-and-finance record (the UI can say so). */
export function isCashFinanceVoucher(db: DB, voucherId: number): boolean {
  return ownerOf(db, voucherId) != null
}
