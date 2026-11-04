// Rows of features removed in the 1.0 cleanup (budgets, loan schedules) that books from before
// still hold. No screen edits them any more, but their `budget_lines` (ledger_id / group_id) and
// `loans` (loan / bank / interest ledger) columns are foreign keys, so a ledger or group they point
// at could not be deleted. masters.deleteLedger / deleteGroup call this inside their transaction:
// the rows go, each audited with its whole before-image; vouchers are never touched — a loan whose
// entries are still in the books refuses the delete (`ledger_loan_in_use`, naming the loan).
import type { DB } from '../db/connection'
import { AppError } from '@shared/errors'
import { writeAudit } from './audit'

type Target = { ledgerId: number } | { groupId: number }

interface LoanRow { id: number; name: string; [k: string]: unknown }

/** Loans that point at `ledgerId`, refusing when one still has entries in the books. Read-only. */
function loansOf(db: DB, ledgerId: number): LoanRow[] {
  const loans = db
    .prepare('SELECT * FROM loans WHERE loan_ledger_id = ? OR bank_ledger_id = ? OR interest_ledger_id = ? ORDER BY id')
    .all(ledgerId, ledgerId, ledgerId) as LoanRow[]
  for (const loan of loans) {
    const live = db
      .prepare(
        `SELECT v.number FROM vouchers v
         WHERE v.deleted_at IS NULL AND (v.id IN (SELECT voucher_id FROM loan_vouchers WHERE loan_id = ?)
           OR v.id IN (SELECT voucher_id FROM loan_schedules WHERE loan_id = ? AND voucher_id IS NOT NULL))
         ORDER BY v.date, v.id LIMIT 1`
      )
      .get(loan.id, loan.id) as { number: string } | undefined
    if (live) {
      throw new AppError(
        'ledger_loan_in_use',
        `This ledger belongs to the loan “${loan.name}”, whose entries (e.g. ${live.number}) are still in the books — move them to the bin first`,
        { params: { loan: loan.name } }
      )
    }
  }
  return loans
}

/** Remove the leftover budget lines / loans that point at the target; returns how many went (for
 *  the ledger / group audit row's `cascaded`). Throws before writing anything when it can't. */
export function removeLeftoverPlanning(db: DB, target: Target): Record<string, number> {
  const loans = 'ledgerId' in target ? loansOf(db, target.ledgerId) : []
  const removed: Record<string, number> = {}

  const col = 'ledgerId' in target ? 'ledger_id' : 'group_id'
  const id = 'ledgerId' in target ? target.ledgerId : target.groupId
  const budgetIds = (db.prepare(`SELECT DISTINCT budget_id AS b FROM budget_lines WHERE ${col} = ? ORDER BY budget_id`).all(id) as { b: number }[]).map((r) => r.b)
  for (const budgetId of budgetIds) {
    const budget = db.prepare('SELECT * FROM budgets WHERE id = ?').get(budgetId) as Record<string, unknown>
    const lines = () => db.prepare('SELECT * FROM budget_lines WHERE budget_id = ? ORDER BY id').all(budgetId)
    const before = { ...budget, lines: lines() }
    const n = db.prepare(`DELETE FROM budget_lines WHERE budget_id = ? AND ${col} = ?`).run(budgetId, id).changes
    removed.budget_lines = (removed.budget_lines ?? 0) + n
    writeAudit(db, 'budget', budgetId, 'update', before, { ...budget, lines: lines() })
  }

  for (const loan of loans) {
    const before = {
      ...loan,
      schedule: db.prepare('SELECT * FROM loan_schedules WHERE loan_id = ? ORDER BY seq').all(loan.id),
      prepayments: db.prepare('SELECT * FROM loan_prepayments WHERE loan_id = ? ORDER BY id').all(loan.id),
      // Links of binned vouchers (purged ones are already gone); the vouchers stay in the bin.
      voucherLinks: db.prepare('SELECT voucher_id AS voucherId, seq, kind FROM loan_vouchers WHERE loan_id = ? ORDER BY voucher_id').all(loan.id)
    }
    db.prepare('DELETE FROM loan_vouchers WHERE loan_id = ?').run(loan.id)
    db.prepare('DELETE FROM loans WHERE id = ?').run(loan.id) // schedule + prepayments: ON DELETE CASCADE
    removed.loans = (removed.loans ?? 0) + 1
    writeAudit(db, 'loan', loan.id, 'delete', before, null)
  }
  return removed
}
