// WP 4.4 addition to the year-end close preview — kept in its own function (and IPC channel) so
// yearEnd.closePreview stays untouched.
import type { DB } from '../db/connection'
import type { CashFinanceCloseWarnings } from '@shared/cashFinance'
import { fyFromStartYear } from '@shared/dates'
import { revaluedOn, unrevaluedBalances } from './forex'

/** Year-end close warning: foreign balances open on 31 March with no revaluation as on that day.
 *  Warn-only. */
export function closeWarnings(db: DB, fyStartYear: number): CashFinanceCloseWarnings {
  const fy = fyFromStartYear(fyStartYear)
  const revalued = revaluedOn(db, fy.to)
  return {
    unrevalued: revalued ? [] : unrevaluedBalances(db, fy.to),
    revaluedOnFyEnd: revalued
  }
}
