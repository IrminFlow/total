// Rows of features removed in the 1.0 cleanup (budgets, loan schedules) that books from before
// still hold. No screen edits them any more, but their foreign keys — `budget_lines` (ledger_id /
// group_id / cost_centre_id) and `loans` (loan / bank / interest ledger) — would make a delete of
// the ledger, group or cost centre they point at fail. masters.deleteLedger / deleteGroup and
// costCentres.deleteCostCentre call this inside their transaction:
// - a budget line pointing at the target goes (the budget audited as an update, whole lines
//   before / after);
// - a loan whose nullable bank / interest ledger is the target keeps, that column cleared (audited
//   loan update) — an unused account must never need a voucher binned to go;
// - a loan whose LOAN ledger is the target goes with its schedule, prepayments and the links of
//   binned vouchers (audited loan delete, whole before-image) — refused (`ledger_loan_in_use`,
//   naming the loan) while any of its entries is still in the books. Vouchers are never touched.
import type { DB } from '../db/connection'
import { AppError } from '@shared/errors'
import { writeAudit } from './audit'

type Target = { ledgerId: number } | { groupId: number } | { costCentreId: number }

interface LoanRow { id: number; name: string; loan_ledger_id: number; bank_ledger_id: number | null; interest_ledger_id: number | null; [k: string]: unknown }

/** The loans whose loan ledger is `ledgerId` (to delete) — refusing when one still has entries in
 *  the books — and those that only use it as their bank / interest ledger (to clear). Read-only. */
function loansOf(db: DB, ledgerId: number): { remove: LoanRow[]; clear: LoanRow[] } {
  const loans = db
    .prepare('SELECT * FROM loans WHERE loan_ledger_id = ? OR bank_ledger_id = ? OR interest_ledger_id = ? ORDER BY id')
    .all(ledgerId, ledgerId, ledgerId) as LoanRow[]
  const remove = loans.filter((l) => l.loan_ledger_id === ledgerId)
  for (const loan of remove) {
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
        `This ledger is the loan “${loan.name}”, whose entries (e.g. ${live.number}) are still in the books — move them to the bin first`,
        { params: { loan: loan.name } }
      )
    }
  }
  return { remove, clear: loans.filter((l) => l.loan_ledger_id !== ledgerId) }
}

/** Remove the leftover budget lines / loans that point at the target; returns how many went (for
 *  the target's own audit row's `cascaded`). Throws before writing anything when it can't. */
export function removeLeftoverPlanning(db: DB, target: Target): Record<string, number> {
  const loans = 'ledgerId' in target ? loansOf(db, target.ledgerId) : { remove: [], clear: [] }
  const removed: Record<string, number> = {}

  const [col, id] = 'ledgerId' in target ? ['ledger_id', target.ledgerId] : 'groupId' in target ? ['group_id', target.groupId] : ['cost_centre_id', target.costCentreId]
  const budgetIds = (db.prepare(`SELECT DISTINCT budget_id AS b FROM budget_lines WHERE ${col} = ? ORDER BY budget_id`).all(id) as { b: number }[]).map((r) => r.b)
  for (const budgetId of budgetIds) {
    const budget = db.prepare('SELECT * FROM budgets WHERE id = ?').get(budgetId) as Record<string, unknown>
    const lines = () => db.prepare('SELECT * FROM budget_lines WHERE budget_id = ? ORDER BY id').all(budgetId)
    const before = { ...budget, lines: lines() }
    const n = db.prepare(`DELETE FROM budget_lines WHERE budget_id = ? AND ${col} = ?`).run(budgetId, id).changes
    removed.budget_lines = (removed.budget_lines ?? 0) + n
    writeAudit(db, 'budget', budgetId, 'update', before, { ...budget, lines: lines() })
  }

  if ('ledgerId' in target) {
    for (const loan of loans.clear) {
      const after = {
        ...loan,
        bank_ledger_id: loan.bank_ledger_id === target.ledgerId ? null : loan.bank_ledger_id,
        interest_ledger_id: loan.interest_ledger_id === target.ledgerId ? null : loan.interest_ledger_id
      }
      db.prepare('UPDATE loans SET bank_ledger_id = ?, interest_ledger_id = ? WHERE id = ?').run(after.bank_ledger_id, after.interest_ledger_id, loan.id)
      removed.loan_ledgers_cleared = (removed.loan_ledgers_cleared ?? 0) + 1
      writeAudit(db, 'loan', loan.id, 'update', loan, after)
    }
  }

  for (const loan of loans.remove) {
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
