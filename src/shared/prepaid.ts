/**
 * Spreading a payment over the months it belongs to (roadmap #374).
 *
 * An annual insurance premium paid in April is not an April expense. Booked whole, it makes April
 * look terrible, makes every month after it look better than it was, and has to be explained to
 * somebody in March. The same arithmetic run the other way is an accrual: rent for March paid in
 * April is a March expense whatever the bank statement says.
 *
 * Both are the same operation — take an amount and a period, and say what belongs to each month —
 * so there is one function and a direction.
 */
import { addDays, daysBetween } from './dates'

export type SpreadBasis = 'month' | 'day'

export interface AmortisationInput {
  amountPaise: number
  /** First day the amount covers, ISO. */
  from: string
  /** Last day it covers, inclusive, ISO. */
  to: string
  /**
   * `month` splits evenly across the calendar months touched; `day` weights each month by the
   * days it actually covers. Day basis matters when the period starts mid-month — a policy
   * running 15 April to 14 April should not charge a full month to each end.
   */
  basis: SpreadBasis
}

export interface AmortisationRow {
  /** 'YYYY-MM'. */
  month: string
  from: string
  to: string
  days: number
  amountPaise: number
  cumulativePaise: number
  /** Still to be charged after this month — the prepaid balance carried on the balance sheet. */
  unexpiredPaise: number
}

const monthKey = (iso: string): string => iso.slice(0, 7)
const monthEnd = (iso: string): string => {
  const [y, m] = iso.split('-').map(Number) as [number, number]
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return `${iso.slice(0, 7)}-${String(last).padStart(2, '0')}`
}

/**
 * The month-by-month schedule.
 *
 * The last month takes whatever is left rather than its own computed share, so the rows always
 * sum to the amount paid. A twelve-way split of ₹10,000 is ₹833.33 eleven times and ₹833.37 once;
 * distributing the remainder evenly instead would leave a prepaid balance of four paise that
 * never clears and that somebody eventually writes a journal to remove.
 */
export function amortiseOverMonths(input: AmortisationInput): AmortisationRow[] {
  if (input.from > input.to) throw new Error('The period ends before it starts')
  if (input.amountPaise <= 0) throw new Error('There is nothing to spread')

  // Segment the period into calendar months.
  const segments: { month: string; from: string; to: string; days: number }[] = []
  let cursor = input.from
  while (cursor <= input.to) {
    const end = monthEnd(cursor) < input.to ? monthEnd(cursor) : input.to
    segments.push({ month: monthKey(cursor), from: cursor, to: end, days: daysBetween(cursor, end) + 1 })
    cursor = addDays(end, 1)
  }

  const totalDays = segments.reduce((s, x) => s + x.days, 0)
  const rows: AmortisationRow[] = []
  let allocated = 0
  segments.forEach((seg, i) => {
    const last = i === segments.length - 1
    const share = last
      ? input.amountPaise - allocated
      : input.basis === 'day'
        ? Math.round((input.amountPaise * seg.days) / totalDays)
        : Math.round(input.amountPaise / segments.length)
    allocated += share
    rows.push({
      ...seg,
      amountPaise: share,
      cumulativePaise: allocated,
      unexpiredPaise: input.amountPaise - allocated
    })
  })
  return rows
}

/** What has expired by `asOn` — the expense to date. The rest is the prepaid asset. */
export function expiredBy(rows: AmortisationRow[], asOn: string): number {
  return rows.filter((r) => r.to <= asOn).reduce((s, r) => s + r.amountPaise, 0)
}

/** What is still unexpired on `asOn` — the balance-sheet figure. */
export function unexpiredOn(rows: AmortisationRow[], totalPaise: number, asOn: string): number {
  return totalPaise - expiredBy(rows, asOn)
}
