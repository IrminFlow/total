/**
 * Budget-vs-actual variance — pure engine, no DB. The caller (src/main/services/budgets.ts)
 * resolves each budget line's display name and pulls actuals from voucher_lines; this module only
 * does the arithmetic, so it stays testable without SQLite.
 */

/** One row of a saved budget, with its display name already resolved by the caller. */
export interface BudgetLineRow {
  /** Ledger or group name, whichever this line targets — carried through to the output row as-is. */
  targetName: string
  ledgerId: number | null
  groupId: number | null
  /** 'YYYY-MM' for a monthly line, null for an annual line (compared FY-to-date). */
  month: string | null
  /** Budgeted amount, paise. */
  amount: number
}

/** One ledger's net actual for one month, already normalized to the ledger's natural direction —
 *  expense ledgers report dr-positive net (dr − cr), income ledgers report cr-positive net
 *  (cr − dr). The caller (budgetVarianceReport) does this normalization from raw dr/cr postings;
 *  this module just sums whatever it's handed. */
export interface ActualRow {
  ledgerId: number
  /** 'YYYY-MM'. */
  month: string
  amount: number
}

export interface BudgetVarianceRow {
  targetName: string
  month: string | null
  budget: number
  actual: number
  /** actual − budget. */
  variance: number
  /** Integer percent of budget actually spent/earned, rounded; null when budget is 0 (division
   *  by zero has no meaningful percent). */
  pct: number | null
}

/** True if `ledgerId` falls under a budget line's target: exact match for a ledger line, or
 *  membership in the line's group's descendant-ledger set for a group line. */
function matchesTarget(ledgerId: number, line: BudgetLineRow, groupDescendants: Map<number, Set<number>>): boolean {
  if (line.ledgerId != null) return ledgerId === line.ledgerId
  if (line.groupId != null) return groupDescendants.get(line.groupId)?.has(ledgerId) ?? false
  return false
}

/**
 * Variance for every line of one budget.
 * - Monthly lines (`month` set): actual = sum of actuals for that ledger/group in that exact month.
 * - Annual lines (`month` null): actual = FY-to-date sum of actuals through `upToMonth` inclusive
 *   (months after `upToMonth` are excluded — the caller is expected to have already scoped
 *   `actuals` to the budget's financial year, so no FY-start filtering happens here).
 *
 * `groupDescendants` maps a target group id (as it appears on a budget line) to the set of ledger
 * ids in its subtree — built by the caller (masters.descendantIds + a ledger→group join) so this
 * function never has to walk the group tree itself.
 */
export function budgetVariance(
  lines: BudgetLineRow[],
  actuals: ActualRow[],
  groupDescendants: Map<number, Set<number>>,
  upToMonth: string
): BudgetVarianceRow[] {
  return lines.map((line) => {
    const relevant = line.month
      ? actuals.filter((a) => a.month === line.month)
      : actuals.filter((a) => a.month <= upToMonth)
    const actual = relevant.filter((a) => matchesTarget(a.ledgerId, line, groupDescendants)).reduce((sum, a) => sum + a.amount, 0)
    const budget = line.amount
    const variance = actual - budget
    const pct = budget === 0 ? null : Math.round((actual * 100) / budget)
    return { targetName: line.targetName, month: line.month, budget, actual, variance, pct }
  })
}
