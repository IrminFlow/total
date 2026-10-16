// "Why?" sentences for the simple People screens (review, to-do §4). Pure functions of what
// simple:people:billsToPay returned (the Outstandings allocation as on today, billsToPayTotals),
// through t() — the amounts are the service's totals; only the bills behind them are counted.

import type { Translate } from '../i18n'
import type { BillsToPay } from './people'
import { join, money, shortDate } from './explainCommon'

/** Bills to pay "due this week" / "due this month": how many bills from how many suppliers make
 *  up the tile's total (late bills included, as the tile counts them) and the late part. */
export function billsToPayWhy(b: BillsToPay, which: 'week' | 'month', t: Translate): string {
  const end = which === 'week' ? b.weekEnd : b.monthEnd
  const amount = which === 'week' ? b.dueThisWeek : b.dueThisMonth
  const date = shortDate(end, b.today, t.lang)
  const counted = b.bills.filter((x) => x.pending > 0 && (x.dueDate ?? x.date) <= end)
  if (counted.length === 0) return t('simple.why.billsToPayNone', { date })
  const suppliers = new Set(counted.map((x) => x.ledgerId)).size
  return join([
    t('simple.why.billsToPay', { count: counted.length, suppliers, date, amount: money(amount) }),
    b.late > 0 ? t('simple.why.billsToPayLate', { amount: money(b.late) }) : null
  ])
}
