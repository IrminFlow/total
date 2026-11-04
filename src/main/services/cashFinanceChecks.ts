// WP 4.4 additions to the year-end close preview and the dashboard — kept in their own functions
// (and IPC channels) so yearEnd.closePreview and dashboard.dashboardSeries stay untouched.
import type { DB } from '../db/connection'
import type { CashFinanceCloseWarnings, FinanceReminders } from '@shared/cashFinance'
import { fyFromStartYear } from '@shared/dates'
import { emiReminders, unpostedForYear } from './loans'
import { revaluedOn, unrevaluedBalances } from './forex'

/** Year-end close warnings: unposted EMIs due in the year and foreign balances open on 31 March
 *  with no revaluation as on that day. Warn-only. */
export function closeWarnings(db: DB, fyStartYear: number): CashFinanceCloseWarnings {
  const fy = fyFromStartYear(fyStartYear)
  const revalued = revaluedOn(db, fy.to)
  return {
    unpostedEmis: unpostedForYear(db, fy.from, fy.to),
    unrevalued: revalued ? [] : unrevaluedBalances(db, fy.to),
    revaluedOnFyEnd: revalued
  }
}

/** The dashboard compliance card's extra rows: EMIs due within a week (or overdue). */
export function financeReminders(db: DB, today: string): FinanceReminders {
  return { emis: emiReminders(db, today, 7) }
}
