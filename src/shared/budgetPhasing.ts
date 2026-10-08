/**
 * Budgets vs actuals by month (WP 4.4) — pure, no DB. Extends shared/budgets.ts (whose
 * annual-vs-YTD `budgetVariance` stays exactly as it was) with:
 * - monthly phasing of an annual line: `even` (amount ÷ 12), `seasonal` (the budget's 12-month
 *   weight profile) or `manual` (twelve amounts typed in). Rounding: each month gets the floor of
 *   its share; MARCH (the FY's last month) absorbs the remainder, so the months always add up to
 *   the annual amount exactly. `annual` (no phasing, the original behaviour) compares the whole
 *   amount with the FY-to-date actual and has no per-month figure.
 * - a cost-centre dimension: a line with a cost centre compares against the amounts allocated to
 *   that centre (and its sub-centres) on the target's ledgers — the same allocations the cost-centre
 *   P&L (services/costCentres.ccReport) adds up.
 * - favourable / unfavourable: an income target is favourable when actual ≥ budget, every other
 *   target when actual ≤ budget.
 */

export type BudgetPhasing = 'annual' | 'even' | 'seasonal' | 'manual'

export const PHASING_LABELS: Record<BudgetPhasing, string> = {
  annual: 'Annual (vs year to date)',
  even: 'Even (÷ 12)',
  seasonal: 'Seasonal profile',
  manual: 'Manual by month'
}

/** The twelve 'YYYY-MM' months of a financial year, April to March. */
export function fyMonthList(fyStartYear: number): string[] {
  const out: string[] = []
  for (let m = 4; m <= 12; m++) out.push(`${fyStartYear}-${String(m).padStart(2, '0')}`)
  for (let m = 1; m <= 3; m++) out.push(`${fyStartYear + 1}-${String(m).padStart(2, '0')}`)
  return out
}

/** Split `amount` over 12 months by integer `weights` (floor each, last absorbs the remainder). */
export function phaseByWeights(amount: number, weights: readonly number[]): number[] {
  if (weights.length !== 12) throw new Error('A seasonal profile needs 12 monthly weights')
  if (weights.some((w) => !Number.isInteger(w) || w < 0)) throw new Error('Seasonal weights must be whole numbers ≥ 0')
  const total = weights.reduce((s, w) => s + w, 0)
  if (total === 0) throw new Error('A seasonal profile needs at least one non-zero weight')
  const out = weights.map((w) => Number((BigInt(amount) * BigInt(w)) / BigInt(total)))
  out[11] = out[11]! + (amount - out.reduce((s, v) => s + v, 0))
  return out
}

export const EVEN_WEIGHTS: readonly number[] = Array(12).fill(1)

/** Monthly budget amounts (Apr..Mar) of one line; null for an `annual` line (no monthly figure). */
export function phaseLine(
  line: { month: string | null; amount: number; phasing: BudgetPhasing; monthly: readonly number[] | null },
  months: readonly string[],
  seasonal: readonly number[] | null
): number[] | null {
  if (line.month) return months.map((m) => (m === line.month ? line.amount : 0))
  switch (line.phasing) {
    case 'annual':
      return null
    case 'even':
      return phaseByWeights(line.amount, EVEN_WEIGHTS)
    case 'seasonal':
      return phaseByWeights(line.amount, seasonal ?? EVEN_WEIGHTS)
    case 'manual': {
      if (!line.monthly || line.monthly.length !== 12) throw new Error('A manual line needs 12 monthly amounts')
      return [...line.monthly]
    }
  }
}

export interface PhasedLine {
  lineId: number
  targetName: string
  ledgerId: number | null
  groupId: number | null
  costCentreId: number | null
  costCentreName: string | null
  /** 'income' targets are favourable when actual ≥ budget; anything else when actual ≤ budget. */
  nature: 'income' | 'expense' | 'asset' | 'liability'
  month: string | null
  phasing: BudgetPhasing
  amount: number
  monthly: number[] | null
}

/** A ledger's net actual for a month in its natural direction; `costCentreId` set for an
 *  allocation row (amount = the allocation), null for a whole-ledger row. */
export interface MonthActual {
  ledgerId: number
  costCentreId: number | null
  month: string
  amount: number
}

export interface Figure {
  budget: number | null
  actual: number
  /** actual − budget (null when there is no budget figure). */
  variance: number | null
  /** Integer percent of budget used / earned; null when budget is 0 or absent. */
  pct: number | null
  favourable: boolean | null
}

export interface MonthlyVarianceRow extends Omit<PhasedLine, 'monthly' | 'amount'> {
  annualBudget: number
  /** Apr..Mar. */
  months: Figure[]
  /** The selected month. */
  current: Figure
  /** April through the selected month (an annual line: the whole annual amount). */
  ytd: Figure
}

export function figure(budget: number | null, actual: number, nature: PhasedLine['nature']): Figure {
  if (budget == null) return { budget: null, actual, variance: null, pct: null, favourable: null }
  const variance = actual - budget
  const pct = budget === 0 ? null : Math.round((actual * 100) / budget)
  const favourable = budget === 0 && actual === 0 ? null : nature === 'income' ? actual >= budget : actual <= budget
  return { budget, actual, variance, pct, favourable }
}

/**
 * Month-by-month and year-to-date variance for every line. `groupLedgers` maps a target group to
 * its subtree's ledger ids; `ccSubtree` maps a cost centre to itself plus its descendants.
 */
export function monthlyVariance(
  lines: readonly PhasedLine[],
  actuals: readonly MonthActual[],
  groupLedgers: ReadonlyMap<number, ReadonlySet<number>>,
  ccSubtree: ReadonlyMap<number, ReadonlySet<number>>,
  months: readonly string[],
  upToMonth: string
): MonthlyVarianceRow[] {
  const upIdx = Math.max(0, months.indexOf(upToMonth))
  return lines.map((line) => {
    const ledgerOk = (id: number): boolean =>
      line.ledgerId != null ? id === line.ledgerId : (groupLedgers.get(line.groupId!)?.has(id) ?? false)
    const ccSet = line.costCentreId != null ? ccSubtree.get(line.costCentreId) ?? new Set([line.costCentreId]) : null
    const byMonth = new Map<string, number>()
    for (const a of actuals) {
      if (!ledgerOk(a.ledgerId)) continue
      if (ccSet ? a.costCentreId == null || !ccSet.has(a.costCentreId) : a.costCentreId != null) continue
      byMonth.set(a.month, (byMonth.get(a.month) ?? 0) + a.amount)
    }
    const actualOf = (m: string): number => byMonth.get(m) ?? 0
    const { monthly, amount, ...rest } = line
    let monthFigures: Figure[]
    let ytd: Figure
    if (line.month) {
      // A single-month line budgets that month only (the original monthly-line meaning).
      monthFigures = months.map((m) => figure(m === line.month ? amount : null, actualOf(m), line.nature))
      const inRange = months.indexOf(line.month) <= upIdx
      ytd = figure(inRange ? amount : 0, inRange ? actualOf(line.month) : 0, line.nature)
    } else {
      monthFigures = months.map((m, i) => figure(monthly ? monthly[i]! : null, actualOf(m), line.nature))
      const ytdActual = months.slice(0, upIdx + 1).reduce((s, m) => s + actualOf(m), 0)
      const ytdBudget = monthly ? monthly.slice(0, upIdx + 1).reduce((s, v) => s + v, 0) : amount
      ytd = figure(ytdBudget, ytdActual, line.nature)
    }
    return { ...rest, annualBudget: amount, months: monthFigures, current: monthFigures[upIdx]!, ytd }
  })
}

/** Rows over budget in `month` (unfavourable with a budget for that month) — the dashboard chip. */
export function overBudgetRows(rows: readonly MonthlyVarianceRow[]): MonthlyVarianceRow[] {
  return rows.filter((r) => r.current.budget != null && r.current.budget > 0 && r.current.favourable === false && r.nature !== 'income')
}

// ---------- CSV ----------

export const BUDGET_CSV_HEADER = ['Target type', 'Target', 'Cost centre', 'Phasing', 'Month', 'Annual amount', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar']
