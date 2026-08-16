import type { DB } from '../db/connection'
import type { Budget, BudgetLine } from '@shared/domain'
import type { BudgetInput } from '@shared/schemas'
import { budgetVariance, type ActualRow, type BudgetLineRow, type BudgetVarianceRow } from '@shared/budgets'
import { fyFromStartYear } from '@shared/dates'
import { descendantIds } from './masters'
import { writeAudit } from './audit'
import { NOT_DELETED } from './vouchers'

interface BudgetRow {
  id: number
  name: string
  fy_start_year: number
}

interface BudgetLineDbRow {
  id: number
  budget_id: number
  ledger_id: number | null
  group_id: number | null
  month: string | null
  amount: number
}

const mapLine = (r: BudgetLineDbRow): BudgetLine => ({
  id: r.id,
  ledgerId: r.ledger_id,
  groupId: r.group_id,
  month: r.month,
  amount: r.amount
})

function getBudget(db: DB, id: number): Budget | null {
  const row = db.prepare('SELECT * FROM budgets WHERE id = ?').get(id) as BudgetRow | undefined
  if (!row) return null
  const lines = (db.prepare('SELECT * FROM budget_lines WHERE budget_id = ? ORDER BY id').all(id) as BudgetLineDbRow[]).map(mapLine)
  return { id: row.id, name: row.name, fyStartYear: row.fy_start_year, lines }
}

export function listBudgets(db: DB): Budget[] {
  const rows = db.prepare('SELECT id FROM budgets ORDER BY fy_start_year DESC, name').all() as { id: number }[]
  return rows.map((r) => getBudget(db, r.id)!)
}

/** Replaces a budget's lines wholesale inside one transaction — simpler and safer than diffing,
 *  and matches how recurring templates / voucher lines are already saved in this codebase. */
export function saveBudget(db: DB, input: BudgetInput, id?: number): Budget {
  const run = db.transaction((): Budget => {
    let budgetId: number
    let before: Budget | null = null
    if (id) {
      before = getBudget(db, id)
      if (!before) throw new Error('Budget not found')
      db.prepare('UPDATE budgets SET name = ?, fy_start_year = ? WHERE id = ?').run(input.name, input.fyStartYear, id)
      db.prepare('DELETE FROM budget_lines WHERE budget_id = ?').run(id)
      budgetId = id
    } else {
      const res = db.prepare('INSERT INTO budgets (name, fy_start_year) VALUES (?, ?)').run(input.name, input.fyStartYear)
      budgetId = Number(res.lastInsertRowid)
    }
    const insertLine = db.prepare(
      'INSERT INTO budget_lines (budget_id, ledger_id, group_id, month, amount) VALUES (?, ?, ?, ?, ?)'
    )
    for (const line of input.lines) {
      insertLine.run(budgetId, line.ledgerId, line.groupId, line.month, line.amount)
    }
    const after = getBudget(db, budgetId)!
    writeAudit(db, 'budget', budgetId, id ? 'update' : 'create', before, after)
    return after
  })
  return run()
}

export function deleteBudget(db: DB, id: number): void {
  const existing = getBudget(db, id)
  if (!existing) throw new Error('Budget not found')
  db.prepare('DELETE FROM budgets WHERE id = ?').run(id)
  writeAudit(db, 'budget', id, 'delete', existing, null)
}


/**
 * Variance report for one budget, as of `upToMonth` ('YYYY-MM'). Pulls every posted (non-deleted)
 * voucher line dated within the budget's financial year, nets it per ledger per month normalized
 * to that ledger's natural direction (expense/other natures: dr − cr; income: cr − dr — matching
 * costCentres.ccReport's convention), then hands the netted actuals to the pure budgetVariance
 * engine along with a groupId -> descendant-ledger-ids map for group-targeted lines.
 */
export function budgetVarianceReport(db: DB, budgetId: number, upToMonth: string): BudgetVarianceRow[] {
  const budget = getBudget(db, budgetId)
  if (!budget) throw new Error('Budget not found')
  if (budget.lines.length === 0) return []
  const fy = fyFromStartYear(budget.fyStartYear)

  // Net per ledger per month, signed by the ledger's natural direction, aggregated in SQL —
  // one grouped row per (ledger, month) instead of shipping every voucher line into JS.
  const actuals = db
    .prepare(
      `SELECT vl.ledger_id AS ledgerId, strftime('%Y-%m', v.date) AS month,
              SUM(CASE WHEN g.nature = 'income'
                       THEN CASE WHEN vl.dr_cr = 'cr' THEN vl.amount ELSE -vl.amount END
                       ELSE CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END END) AS amount
       FROM voucher_lines vl
       JOIN vouchers v ON v.id = vl.voucher_id
       JOIN ledgers l ON l.id = vl.ledger_id
       JOIN groups g ON g.id = l.group_id
       WHERE v.date BETWEEN ? AND ? AND ${NOT_DELETED}
       GROUP BY vl.ledger_id, month`
    )
    .all(fy.from, fy.to) as ActualRow[]

  const ledgerGroup = db.prepare('SELECT id, group_id AS groupId FROM ledgers').all() as { id: number; groupId: number }[]
  const groupDescendants = new Map<number, Set<number>>()
  for (const line of budget.lines) {
    if (line.groupId == null || groupDescendants.has(line.groupId)) continue
    const descGroupIds = descendantIds(db, [line.groupId])
    groupDescendants.set(line.groupId, new Set(ledgerGroup.filter((l) => descGroupIds.has(l.groupId)).map((l) => l.id)))
  }

  const ledgerNames = new Map(
    (db.prepare('SELECT id, name FROM ledgers').all() as { id: number; name: string }[]).map((l) => [l.id, l.name])
  )
  const groupNames = new Map(
    (db.prepare('SELECT id, name FROM groups').all() as { id: number; name: string }[]).map((g) => [g.id, g.name])
  )

  const lineRows: BudgetLineRow[] = budget.lines.map((line) => ({
    targetName:
      line.ledgerId != null
        ? (ledgerNames.get(line.ledgerId) ?? `Ledger #${line.ledgerId}`)
        : (groupNames.get(line.groupId!) ?? `Group #${line.groupId}`),
    ledgerId: line.ledgerId,
    groupId: line.groupId,
    month: line.month,
    amount: line.amount
  }))

  return budgetVariance(lineRows, actuals, groupDescendants, upToMonth)
}
