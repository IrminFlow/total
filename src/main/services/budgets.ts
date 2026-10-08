import type { DB } from '../db/connection'
import type { Budget, BudgetLine } from '@shared/domain'
import { budgetInputSchema, type BudgetInput } from '@shared/schemas'
import { budgetVariance, type ActualRow, type BudgetLineRow, type BudgetVarianceRow } from '@shared/budgets'
import { fyFromStartYear } from '@shared/dates'
import { descendantIds } from './masters'
import { writeAudit } from './audit'
// IN_BOOKS, not NOT_DELETED: budget actuals must tie to the P&L for the same period, which
// excludes optional (memorandum) and unmatured post-dated vouchers.
import { IN_BOOKS, NOT_YEAR_END_CLOSE } from './vouchers'

interface BudgetRow {
  id: number
  name: string
  fy_start_year: number
  seasonal_json: string | null
}

interface BudgetLineDbRow {
  id: number
  budget_id: number
  ledger_id: number | null
  group_id: number | null
  month: string | null
  amount: number
  cost_centre_id: number | null
  phasing: BudgetLine['phasing']
  monthly_json: string | null
}

const mapLine = (r: BudgetLineDbRow): BudgetLine => ({
  id: r.id,
  ledgerId: r.ledger_id,
  groupId: r.group_id,
  month: r.month,
  amount: r.amount,
  costCentreId: r.cost_centre_id,
  phasing: r.phasing,
  monthly: r.monthly_json ? (JSON.parse(r.monthly_json) as number[]) : null
})

export function getBudget(db: DB, id: number): Budget | null {
  const row = db.prepare('SELECT * FROM budgets WHERE id = ?').get(id) as BudgetRow | undefined
  if (!row) return null
  const lines = (db.prepare('SELECT * FROM budget_lines WHERE budget_id = ? ORDER BY id').all(id) as BudgetLineDbRow[]).map(mapLine)
  return {
    id: row.id,
    name: row.name,
    fyStartYear: row.fy_start_year,
    lines,
    seasonal: row.seasonal_json ? (JSON.parse(row.seasonal_json) as number[]) : null
  }
}

export function listBudgets(db: DB): Budget[] {
  const rows = db.prepare('SELECT id FROM budgets ORDER BY fy_start_year DESC, name').all() as { id: number }[]
  return rows.map((r) => getBudget(db, r.id)!)
}

/** Replaces a budget's lines wholesale inside one transaction — simpler and safer than diffing,
 *  and matches how voucher lines are already saved in this codebase. WP 4.4: every save of an
 *  existing budget also records a revision (the whole before / after line set, who and why). */
export function saveBudget(db: DB, raw: BudgetInput, id?: number): Budget {
  const input = budgetInputSchema.parse(raw)
  const run = db.transaction((): Budget => {
    let budgetId: number
    let before: Budget | null = null
    if (id) {
      before = getBudget(db, id)
      if (!before) throw new Error('Budget not found')
      const seasonal = input.seasonal === undefined ? before.seasonal : input.seasonal
      db.prepare('UPDATE budgets SET name = ?, fy_start_year = ?, seasonal_json = ? WHERE id = ?')
        .run(input.name, input.fyStartYear, seasonal ? JSON.stringify(seasonal) : null, id)
      db.prepare('DELETE FROM budget_lines WHERE budget_id = ?').run(id)
      budgetId = id
    } else {
      const res = db
        .prepare('INSERT INTO budgets (name, fy_start_year, seasonal_json) VALUES (?, ?, ?)')
        .run(input.name, input.fyStartYear, input.seasonal ? JSON.stringify(input.seasonal) : null)
      budgetId = Number(res.lastInsertRowid)
    }
    const insertLine = db.prepare(
      `INSERT INTO budget_lines (budget_id, ledger_id, group_id, month, amount, cost_centre_id, phasing, monthly_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const line of input.lines) {
      // A single-month line has no phasing of its own.
      const phasing = line.month ? 'annual' : line.phasing
      insertLine.run(
        budgetId, line.ledgerId, line.groupId, line.month, line.amount, line.costCentreId, phasing,
        phasing === 'manual' && line.monthly ? JSON.stringify(line.monthly) : null
      )
    }
    const after = getBudget(db, budgetId)!
    writeAudit(db, 'budget', budgetId, id ? 'update' : 'create', before, after)
    if (before) recordRevision(db, before, after, input.reason ?? null)
    return after
  })
  return run()
}

const budgetTotal = (b: Budget): number => b.lines.reduce((s, l) => s + l.amount, 0)

/** WP 4.4: one budget_revisions row per update — numbered per budget, attributed to the user the
 *  audit row just written names (the same attribution as the edit log). */
function recordRevision(db: DB, before: Budget, after: Budget, reason: string | null): void {
  const next = (db.prepare('SELECT COALESCE(MAX(revision_no), 0) + 1 AS n FROM budget_revisions WHERE budget_id = ?').get(after.id) as { n: number }).n
  const user = db
    .prepare("SELECT user_name AS u FROM audit_log WHERE entity = 'budget' AND entity_id = ? ORDER BY id DESC LIMIT 1")
    .get(after.id) as { u: string | null } | undefined
  db.prepare(
    `INSERT INTO budget_revisions (budget_id, revision_no, user_name, reason, before_json, after_json, total_before, total_after)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(after.id, next, user?.u ?? null, reason, JSON.stringify(before), JSON.stringify(after), budgetTotal(before), budgetTotal(after))
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
 * (The original annual-vs-YTD view; WP 4.4's month / cost-centre report is budgetVariance.ts.)
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
       WHERE v.date BETWEEN ? AND ? AND ${IN_BOOKS} AND ${NOT_YEAR_END_CLOSE}
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
