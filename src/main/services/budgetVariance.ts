// Budgets vs actuals by month and cost centre (WP 4.4): the monthly / YTD variance report, its
// drill-down to vouchers, the revision history, CSV import / export and the dashboard's
// "over budget this month" chip. Actuals come from voucher_lines (whole-ledger lines) and
// voucher_line_cost_allocations (cost-centre lines) at query time, IN_BOOKS and excluding
// year-end closing journals — the same scope as the P&L (pnlLedgerAmounts) and the cost-centre
// P&L (costCentres.ccReport, which a dbtest ties this report to).
import type { DB } from '../db/connection'
import type { Budget } from '@shared/domain'
import {
  BUDGET_CSV_HEADER, fyMonthList, monthlyVariance, overBudgetRows, phaseLine,
  type BudgetPhasing, type MonthActual, type PhasedLine
} from '@shared/budgetPhasing'
import type {
  BudgetCsvResult, BudgetDrillRow, BudgetMonthlyReport, BudgetRevision, OverBudgetChip, OverBudgetRow
} from '@shared/cashFinance'
import type { BudgetLineInput } from '@shared/schemas'
import { fyFromStartYear, fyOf } from '@shared/dates'
import { parseCsv, rowsToCsv } from '@shared/csv'
import { parseRupees, plainRupees } from '@shared/money'
import { descendantIds } from './masters'
import { getBudget, saveBudget } from './budgets'
import { IN_BOOKS, NOT_YEAR_END_CLOSE } from './vouchers'

type Nature = PhasedLine['nature']

interface Lookups {
  ledgerName: Map<number, string>
  ledgerNature: Map<number, Nature>
  ledgerGroup: Map<number, number>
  groupName: Map<number, string>
  groupNature: Map<number, Nature>
  ccName: Map<number, string>
  ccParent: Map<number, number | null>
}

function lookups(db: DB): Lookups {
  const ledgers = db
    .prepare('SELECT l.id, l.name, l.group_id AS groupId, g.nature FROM ledgers l JOIN groups g ON g.id = l.group_id')
    .all() as { id: number; name: string; groupId: number; nature: Nature }[]
  const groups = db.prepare('SELECT id, name, nature FROM groups').all() as { id: number; name: string; nature: Nature }[]
  const ccs = db.prepare('SELECT id, name, parent_id AS parentId FROM cost_centres').all() as { id: number; name: string; parentId: number | null }[]
  return {
    ledgerName: new Map(ledgers.map((l) => [l.id, l.name])),
    ledgerNature: new Map(ledgers.map((l) => [l.id, l.nature])),
    ledgerGroup: new Map(ledgers.map((l) => [l.id, l.groupId])),
    groupName: new Map(groups.map((g) => [g.id, g.name])),
    groupNature: new Map(groups.map((g) => [g.id, g.nature])),
    ccName: new Map(ccs.map((c) => [c.id, c.name])),
    ccParent: new Map(ccs.map((c) => [c.id, c.parentId]))
  }
}

/** A cost centre plus all of its sub-centres. */
function ccSubtreeOf(lk: Lookups, root: number): Set<number> {
  const out = new Set<number>([root])
  let grew = true
  while (grew) {
    grew = false
    for (const [id, parent] of lk.ccParent) {
      if (parent != null && out.has(parent) && !out.has(id)) {
        out.add(id)
        grew = true
      }
    }
  }
  return out
}

function phasedLines(db: DB, budget: Budget, lk: Lookups, months: string[]): PhasedLine[] {
  return budget.lines.map((l) => ({
    lineId: l.id,
    targetName: l.ledgerId != null ? (lk.ledgerName.get(l.ledgerId) ?? `Ledger #${l.ledgerId}`) : (lk.groupName.get(l.groupId!) ?? `Group #${l.groupId}`),
    ledgerId: l.ledgerId,
    groupId: l.groupId,
    costCentreId: l.costCentreId,
    costCentreName: l.costCentreId != null ? (lk.ccName.get(l.costCentreId) ?? null) : null,
    nature: (l.ledgerId != null ? lk.ledgerNature.get(l.ledgerId) : lk.groupNature.get(l.groupId!)) ?? 'expense',
    month: l.month,
    phasing: l.phasing,
    amount: l.amount,
    monthly: l.month ? null : phaseLine({ month: null, amount: l.amount, phasing: l.phasing, monthly: l.monthly }, months, budget.seasonal)
  }))
}

const SIGNED = `CASE WHEN g.nature = 'income'
                    THEN CASE WHEN vl.dr_cr = 'cr' THEN %A ELSE -%A END
                    ELSE CASE WHEN vl.dr_cr = 'dr' THEN %A ELSE -%A END END`
const signed = (col: string): string => SIGNED.replaceAll('%A', col)

/** Whole-ledger and per-cost-centre actuals for a date range, netted per (ledger, [cc,] month). */
function monthActuals(db: DB, from: string, to: string): MonthActual[] {
  const ledgerRows = db
    .prepare(
      `SELECT vl.ledger_id AS ledgerId, NULL AS costCentreId, substr(v.date, 1, 7) AS month, SUM(${signed('vl.amount')}) AS amount
       FROM voucher_lines vl
       JOIN vouchers v ON v.id = vl.voucher_id
       JOIN ledgers l ON l.id = vl.ledger_id
       JOIN groups g ON g.id = l.group_id
       WHERE v.date BETWEEN ? AND ? AND ${IN_BOOKS} AND ${NOT_YEAR_END_CLOSE}
       GROUP BY vl.ledger_id, month`
    )
    .all(from, to) as MonthActual[]
  const ccRows = db
    .prepare(
      `SELECT vl.ledger_id AS ledgerId, vlca.cost_centre_id AS costCentreId, substr(v.date, 1, 7) AS month, SUM(${signed('vlca.amount')}) AS amount
       FROM voucher_line_cost_allocations vlca
       JOIN voucher_lines vl ON vl.id = vlca.voucher_line_id
       JOIN vouchers v ON v.id = vl.voucher_id
       JOIN ledgers l ON l.id = vl.ledger_id
       JOIN groups g ON g.id = l.group_id
       WHERE v.date BETWEEN ? AND ? AND ${IN_BOOKS} AND ${NOT_YEAR_END_CLOSE}
       GROUP BY vl.ledger_id, vlca.cost_centre_id, month`
    )
    .all(from, to) as MonthActual[]
  return [...ledgerRows, ...ccRows]
}

function groupLedgerMap(db: DB, lk: Lookups, lines: PhasedLine[]): Map<number, Set<number>> {
  const out = new Map<number, Set<number>>()
  for (const l of lines) {
    if (l.groupId == null || out.has(l.groupId)) continue
    const groups = descendantIds(db, [l.groupId])
    out.set(l.groupId, new Set([...lk.ledgerGroup].filter(([, g]) => groups.has(g)).map(([id]) => id)))
  }
  return out
}

/** Month-by-month and YTD variance for one budget through `upToMonth`. */
export function budgetMonthlyReport(db: DB, budgetId: number, upToMonth: string): BudgetMonthlyReport {
  const budget = getBudget(db, budgetId)
  if (!budget) throw new Error('Budget not found')
  const months = fyMonthList(budget.fyStartYear)
  const up = months.includes(upToMonth) ? upToMonth : upToMonth < months[0]! ? months[0]! : months[11]!
  const lk = lookups(db)
  const lines = phasedLines(db, budget, lk, months)
  const fy = fyFromStartYear(budget.fyStartYear)
  const ccSub = new Map<number, Set<number>>()
  for (const l of lines) if (l.costCentreId != null && !ccSub.has(l.costCentreId)) ccSub.set(l.costCentreId, ccSubtreeOf(lk, l.costCentreId))
  const rows = lines.length === 0 ? [] : monthlyVariance(lines, monthActuals(db, fy.from, fy.to), groupLedgerMap(db, lk, lines), ccSub, months, up)
  return { budgetId, fyStartYear: budget.fyStartYear, months, upToMonth: up, rows }
}

/** The voucher lines behind one budget line's actual for a month (or April..upToMonth). Their
 *  amounts (signed in the target's natural direction) add up to the report's actual. */
export function budgetDrill(db: DB, budgetId: number, lineId: number, month: string | null, upToMonth: string): BudgetDrillRow[] {
  const budget = getBudget(db, budgetId)
  if (!budget) throw new Error('Budget not found')
  const line = budget.lines.find((l) => l.id === lineId)
  if (!line) throw new Error('Budget line not found')
  const months = fyMonthList(budget.fyStartYear)
  const fy = fyFromStartYear(budget.fyStartYear)
  const from = month ? `${month}-01` : fy.from
  const lastMonth = month ?? (line.month ?? (months.includes(upToMonth) ? upToMonth : months[11]!))
  const to = `${lastMonth}-31`
  const fromEff = line.month && !month ? `${line.month}-01` : from
  const lk = lookups(db)
  const ledgerIds =
    line.ledgerId != null
      ? [line.ledgerId]
      : (() => {
          const groups = descendantIds(db, [line.groupId!])
          return [...lk.ledgerGroup].filter(([, g]) => groups.has(g)).map(([id]) => id)
        })()
  if (ledgerIds.length === 0) return []
  const ph = ledgerIds.map(() => '?').join(',')
  const cc = line.costCentreId != null ? [...ccSubtreeOf(lk, line.costCentreId)] : null
  const sql = cc
    ? `SELECT v.id AS voucherId, v.date, v.number, vt.name AS voucherType, vl.ledger_id AS ledgerId, l.name AS ledgerName, SUM(${signed('vlca.amount')}) AS amount
       FROM voucher_line_cost_allocations vlca
       JOIN voucher_lines vl ON vl.id = vlca.voucher_line_id
       JOIN vouchers v ON v.id = vl.voucher_id
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       JOIN ledgers l ON l.id = vl.ledger_id
       JOIN groups g ON g.id = l.group_id
       WHERE vl.ledger_id IN (${ph}) AND vlca.cost_centre_id IN (${cc.map(() => '?').join(',')})
         AND v.date BETWEEN ? AND ? AND ${IN_BOOKS} AND ${NOT_YEAR_END_CLOSE}
       GROUP BY v.id, vl.ledger_id ORDER BY v.date, v.id`
    : `SELECT v.id AS voucherId, v.date, v.number, vt.name AS voucherType, vl.ledger_id AS ledgerId, l.name AS ledgerName, SUM(${signed('vl.amount')}) AS amount
       FROM voucher_lines vl
       JOIN vouchers v ON v.id = vl.voucher_id
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       JOIN ledgers l ON l.id = vl.ledger_id
       JOIN groups g ON g.id = l.group_id
       WHERE vl.ledger_id IN (${ph}) AND v.date BETWEEN ? AND ? AND ${IN_BOOKS} AND ${NOT_YEAR_END_CLOSE}
       GROUP BY v.id, vl.ledger_id ORDER BY v.date, v.id`
  const params = cc ? [...ledgerIds, ...cc, fromEff, to] : [...ledgerIds, fromEff, to]
  return db.prepare(sql).all(...params) as BudgetDrillRow[]
}

export function budgetRevisions(db: DB, budgetId: number): BudgetRevision[] {
  const rows = db
    .prepare(
      `SELECT id, budget_id AS budgetId, revision_no AS revisionNo, revised_at AS revisedAt, user_name AS userName, reason,
              total_before AS totalBefore, total_after AS totalAfter, before_json AS b, after_json AS a
       FROM budget_revisions WHERE budget_id = ? ORDER BY revision_no DESC`
    )
    .all(budgetId) as (Omit<BudgetRevision, 'linesBefore' | 'linesAfter'> & { b: string; a: string })[]
  return rows.map(({ b, a, ...r }) => ({
    ...r,
    linesBefore: (JSON.parse(b) as Budget).lines.length,
    linesAfter: (JSON.parse(a) as Budget).lines.length
  }))
}

/** One revision's before / after budgets (for the history drawer). */
export function budgetRevisionDetail(db: DB, revisionId: number): { before: Budget; after: Budget } {
  const row = db.prepare('SELECT before_json AS b, after_json AS a FROM budget_revisions WHERE id = ?').get(revisionId) as { b: string; a: string } | undefined
  if (!row) throw new Error('Revision not found')
  return { before: JSON.parse(row.b) as Budget, after: JSON.parse(row.a) as Budget }
}

// ---------- CSV ----------

export function budgetCsv(db: DB, budgetId: number): string {
  const budget = getBudget(db, budgetId)
  if (!budget) throw new Error('Budget not found')
  const months = fyMonthList(budget.fyStartYear)
  const lk = lookups(db)
  const rows = budget.lines.map((l) => {
    const phased = phaseLine({ month: l.month, amount: l.amount, phasing: l.phasing, monthly: l.monthly }, months, budget.seasonal)
    return [
      l.ledgerId != null ? 'Ledger' : 'Group',
      l.ledgerId != null ? (lk.ledgerName.get(l.ledgerId) ?? '') : (lk.groupName.get(l.groupId!) ?? ''),
      l.costCentreId != null ? (lk.ccName.get(l.costCentreId) ?? '') : '',
      l.month ? 'month' : l.phasing,
      l.month ?? '',
      plainRupees(l.amount),
      ...(phased ? phased.map(plainRupees) : Array<string>(12).fill(''))
    ]
  })
  return rowsToCsv(BUDGET_CSV_HEADER, rows)
}

const PHASINGS: readonly BudgetPhasing[] = ['annual', 'even', 'seasonal', 'manual']

/** Parse a budget CSV (the export's layout) into budget lines; every problem is reported by line. */
export function parseBudgetCsv(db: DB, fyStartYear: number, csvText: string): { lines: BudgetLineInput[]; errors: string[] } {
  const records = parseCsv(csvText.replace(/^﻿/, ''))
  const errors: string[] = []
  const lines: BudgetLineInput[] = []
  if (records.length === 0) return { lines, errors: ['The file is empty'] }
  const header = records[0]!.cells.map((c) => c.trim().toLowerCase())
  if (header[0] !== 'target type' || header[1] !== 'target') return { lines, errors: ['Expected the budget export layout (first columns: Target type, Target)'] }
  const ledgers = new Map((db.prepare('SELECT id, name FROM ledgers').all() as { id: number; name: string }[]).map((l) => [l.name.toLowerCase(), l.id]))
  const groups = new Map((db.prepare('SELECT id, name FROM groups').all() as { id: number; name: string }[]).map((g) => [g.name.toLowerCase(), g.id]))
  const ccs = new Map((db.prepare('SELECT id, name FROM cost_centres').all() as { id: number; name: string }[]).map((c) => [c.name.toLowerCase(), c.id]))
  const months = fyMonthList(fyStartYear)
  for (const rec of records.slice(1)) {
    const c = rec.cells.map((x) => x.trim())
    const where = `Line ${rec.line}`
    const type = (c[0] ?? '').toLowerCase()
    const name = c[1] ?? ''
    const ledgerId = type === 'ledger' ? ledgers.get(name.toLowerCase()) ?? null : null
    const groupId = type === 'group' ? groups.get(name.toLowerCase()) ?? null : null
    if (type !== 'ledger' && type !== 'group') { errors.push(`${where}: target type must be Ledger or Group`); continue }
    if (ledgerId == null && groupId == null) { errors.push(`${where}: no ${type} named “${name}”`); continue }
    const ccText = c[2] ?? ''
    const costCentreId = ccText ? ccs.get(ccText.toLowerCase()) ?? null : null
    if (ccText && costCentreId == null) { errors.push(`${where}: no cost centre named “${ccText}”`); continue }
    const phasingText = (c[3] ?? '').toLowerCase() || 'annual'
    const month = c[4] || null
    if (month && !months.includes(month)) { errors.push(`${where}: month ${month} is outside the budget's year`); continue }
    if (!month && !PHASINGS.includes(phasingText as BudgetPhasing)) { errors.push(`${where}: phasing must be annual, even, seasonal or manual`); continue }
    const phasing = (month ? 'annual' : phasingText) as BudgetPhasing
    let monthly: number[] | null = null
    if (phasing === 'manual') {
      const vals = months.map((_, i) => parseRupees(c[6 + i] ?? '') ?? 0)
      if (vals.some((v) => v < 0)) { errors.push(`${where}: monthly amounts cannot be negative`); continue }
      monthly = vals
    }
    const annualText = c[5] ?? ''
    const amount = annualText ? parseRupees(annualText) : monthly ? monthly.reduce((s, v) => s + v, 0) : null
    if (amount == null || amount <= 0) { errors.push(`${where}: enter an annual amount above zero`); continue }
    if (monthly && monthly.reduce((s, v) => s + v, 0) !== amount) { errors.push(`${where}: monthly amounts must add up to the annual amount`); continue }
    lines.push({ ledgerId, groupId, month, amount, costCentreId, phasing, monthly })
  }
  return { lines, errors }
}

/** Replace a budget's lines from a CSV. Nothing is saved when any line has an error. */
export function importBudgetCsv(db: DB, budgetId: number, csvText: string, reason: string | null): BudgetCsvResult {
  const budget = getBudget(db, budgetId)
  if (!budget) throw new Error('Budget not found')
  const { lines, errors } = parseBudgetCsv(db, budget.fyStartYear, csvText)
  if (errors.length > 0) return { lines: 0, errors }
  saveBudget(db, { name: budget.name, fyStartYear: budget.fyStartYear, lines, reason: reason ?? 'CSV import' }, budgetId)
  return { lines: lines.length, errors: [] }
}

// ---------- dashboard / year-end ----------

/** Expense / cost lines whose actual this month exceeds their phased budget for the month, across
 *  the budgets of today's financial year (the dashboard's "over budget this month" chip). */
export function overBudgetThisMonth(db: DB, today: string): OverBudgetChip {
  const month = today.slice(0, 7)
  const fy = fyOf(today)
  const budgets = db.prepare('SELECT id, name FROM budgets WHERE fy_start_year = ? ORDER BY name').all(fy.startYear) as { id: number; name: string }[]
  const rows: OverBudgetRow[] = []
  for (const b of budgets) {
    const report = budgetMonthlyReport(db, b.id, month)
    for (const r of overBudgetRows(report.rows)) {
      rows.push({ budgetId: b.id, budgetName: b.name, lineId: r.lineId, targetName: r.targetName, costCentreName: r.costCentreName, budget: r.current.budget!, actual: r.current.actual })
    }
  }
  return { month, rows }
}

/** Lines over budget for the whole financial year (year-end warning) — cost-centre lines first. */
export function overBudgetForYear(db: DB, fyStartYear: number): OverBudgetRow[] {
  const budgets = db.prepare('SELECT id, name FROM budgets WHERE fy_start_year = ? ORDER BY name').all(fyStartYear) as { id: number; name: string }[]
  const out: OverBudgetRow[] = []
  for (const b of budgets) {
    const report = budgetMonthlyReport(db, b.id, fyMonthList(fyStartYear)[11]!)
    for (const r of report.rows) {
      if (r.nature === 'income' || r.ytd.favourable !== false || !r.ytd.budget) continue
      out.push({ budgetId: b.id, budgetName: b.name, lineId: r.lineId, targetName: r.targetName, costCentreName: r.costCentreName, budget: r.ytd.budget, actual: r.ytd.actual })
    }
  }
  return out.sort((a, b) => (a.costCentreName == null ? 1 : 0) - (b.costCentreName == null ? 1 : 0) || (b.actual - b.budget) - (a.actual - a.budget))
}
