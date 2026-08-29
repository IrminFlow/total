/**
 * Pay cycles that are not a month (roadmap #179).
 *
 * Payroll in this app assumed a month everywhere, and most of India's payroll is monthly. But a
 * factory pays its floor weekly and its office monthly, and a business that runs a weekly wage
 * sheet in a spreadsheet beside the app is a business whose books are wrong by the amount of the
 * spreadsheet.
 *
 * The arithmetic of paying a week's wages is trivial. What is not trivial, and what this file
 * exists for, is that the statutory deductions are not weekly quantities:
 *
 *   - The PF wage ceiling is ₹15,000 A MONTH (EPF Scheme 1952, para 26A / the 2014-09-01
 *     notification). A quarter of a month's basic is under the ceiling when the month's basic is
 *     over it, so computing PF week by week over-contributes.
 *   - ESI's eligibility limit is ₹21,000 gross A MONTH (ESI (Central) Rules, rule 50). A weekly
 *     gross is always under it, so computing ESI week by week makes every employee eligible.
 *   - Professional tax slabs are monthly gross ceilings in every state that levies it. A weekly
 *     gross falls into the bottom slab, which is usually nil.
 *   - TDS on salary under section 192 is one twelfth of the year's liability, deducted monthly.
 *
 * Each of those computed per week produces a number that is wrong, and wrong in the direction the
 * employee only discovers years later — when EPFO's passbook does not match their payslips, or
 * when a notice arrives for tax nobody deducted.
 *
 * So the rule this module implements, and which the service follows exactly:
 *
 *   **Earnings are prorated to the cycle. Statutory deductions are computed on the STATUTORY
 *   MONTH and apportioned across that month's cycles, and each cycle deducts the difference
 *   between its cumulative share and what the month's earlier cycles already deducted.**
 *
 * The true-up matters. A month's attendance is not fully known when its first week is paid, so
 * the monthly figure computed in week 1 is not the monthly figure computed in week 4. Deducting
 * the cumulative difference means the month always lands on the right total whatever happened in
 * between, and it lands there without anyone reconciling anything by hand.
 *
 * A cycle that straddles a month end belongs to the month its LAST day falls in — wages accrue as
 * the period closes, and that is also the month whose ECR the run has to appear in.
 */

import { addDays, daysBetween } from './dates'

export const PAY_CYCLES = ['monthly', 'fortnightly', 'weekly'] as const
export type PayCycle = (typeof PAY_CYCLES)[number]

export const PAY_CYCLE_LABELS: Record<PayCycle, string> = {
  monthly: 'Monthly',
  fortnightly: 'Fortnightly',
  weekly: 'Weekly'
}

/** Days in a cycle. Monthly is variable, so it is not in here. */
const FIXED_LENGTH: Partial<Record<PayCycle, number>> = { fortnightly: 14, weekly: 7 }

export interface CyclePeriod {
  cycle: PayCycle
  /** Stable identifier: '2026-06' for a month, otherwise the period's first day. */
  key: string
  /** Human label: 'June 2026' or '01–07 Jun 2026'. */
  label: string
  from: string
  to: string
  /** Calendar days in the period, inclusive of both ends. */
  days: number
  /** 'YYYY-MM' — the month the period's last day falls in. */
  statutoryMonth: string
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function daysInMonthOf(month: string): number {
  const [y, m] = month.split('-').map(Number) as [number, number]
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

export function monthLabelOf(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  return `${MONTHS[m - 1]} ${y}`
}

function shortDate(iso: string): string {
  const [, m, d] = iso.split('-') as [string, string, string]
  return `${d} ${MON[Number(m) - 1]}`
}

function periodFrom(cycle: PayCycle, from: string, to: string): CyclePeriod {
  const statutoryMonth = to.slice(0, 7)
  return {
    cycle,
    key: cycle === 'monthly' ? from.slice(0, 7) : from,
    label:
      cycle === 'monthly'
        ? monthLabelOf(from.slice(0, 7))
        : `${shortDate(from)} – ${shortDate(to)} ${to.slice(0, 4)}`,
    from,
    to,
    days: daysBetween(from, to) + 1,
    statutoryMonth
  }
}

/**
 * The cycles of a statutory month, in order.
 *
 * `anchor` is the date some weekly or fortnightly cycle started — a company's own pay-week
 * boundary, which is a Monday in most factories and a Saturday in some. Every period is
 * `anchor + k × length`, so the boundary never drifts and two months' worth of cycles line up.
 *
 * The month's cycles are those whose LAST day falls in the month. A month therefore has four or
 * five weekly cycles depending on where the boundary sits, which is the truth about weekly pay
 * and is exactly why the statutory apportionment cannot be a fixed fraction.
 */
export function cyclesInMonth(cycle: PayCycle, month: string, anchor: string): CyclePeriod[] {
  if (cycle === 'monthly') {
    const from = `${month}-01`
    const to = `${month}-${String(daysInMonthOf(month)).padStart(2, '0')}`
    return [periodFrom('monthly', from, to)]
  }
  const length = FIXED_LENGTH[cycle]!
  const monthStart = `${month}-01`
  const monthEnd = `${month}-${String(daysInMonthOf(month)).padStart(2, '0')}`

  // Walk back from the anchor to the first period that could still end inside the month, then
  // forward. Integer division on the day gap rather than a loop from the anchor: an anchor set
  // years ago must not cost years of iterations.
  const gap = daysBetween(anchor, monthStart)
  let k = Math.floor(gap / length) - 1
  const out: CyclePeriod[] = []
  for (let guard = 0; guard < 12; guard++, k++) {
    const from = addDays(anchor, k * length)
    const to = addDays(from, length - 1)
    if (to < monthStart) continue
    if (to > monthEnd) break
    out.push(periodFrom(cycle, from, to))
  }
  return out
}

/** The cycle period containing a date — what "run payroll for this week" means. */
export function cycleContaining(cycle: PayCycle, date: string, anchor: string): CyclePeriod {
  if (cycle === 'monthly') {
    const month = date.slice(0, 7)
    return periodFrom('monthly', `${month}-01`, `${month}-${String(daysInMonthOf(month)).padStart(2, '0')}`)
  }
  const length = FIXED_LENGTH[cycle]!
  const k = Math.floor(daysBetween(anchor, date) / length)
  const from = addDays(anchor, k * length)
  return periodFrom(cycle, from, addDays(from, length - 1))
}

/**
 * The cycles of a month up to and including one of them, plus the weights used to apportion the
 * month's statutory deductions across them.
 *
 * The weight is calendar days in the period, not payable days: PF and ESI are a share of the
 * month's contribution and the month's contribution is already computed on the month's payable
 * days. Weighting again by attendance would prorate twice.
 */
export interface CycleShare {
  /** Days of the month covered by cycles up to and including this one. */
  cumulativeDays: number
  /** Days of the month covered by all its cycles. */
  totalDays: number
  /** True for the month's last cycle — where the rounding remainder lands, and where a monthly
   *  event like an advance instalment is recovered. */
  isLast: boolean
  index: number
  count: number
}

export function cycleShare(periods: CyclePeriod[], key: string): CycleShare | null {
  const index = periods.findIndex((p) => p.key === key)
  if (index < 0) return null
  let cumulative = 0
  for (let i = 0; i <= index; i++) cumulative += periods[i]!.days
  return {
    cumulativeDays: cumulative,
    totalDays: periods.reduce((s, p) => s + p.days, 0),
    isLast: index === periods.length - 1,
    index,
    count: periods.length
  }
}

/**
 * What this cycle deducts, given the month's whole statutory figure and what the month's earlier
 * cycles already deducted.
 *
 * Two properties hold, and the tests pin both:
 *
 *   1. Across a month's cycles the deductions sum to exactly the monthly figure — no paisa is
 *      created or lost by rounding, and the sum is not "close".
 *   2. If the monthly figure changes mid-month (a late attendance entry, a mid-month joiner), the
 *      remaining cycles absorb the whole difference. The month still lands correctly.
 *
 * The result can be negative — a refund — when the month's figure fell after money was already
 * deducted. That is the honest answer and the caller must be able to show it rather than clamp
 * it, because clamping it means the employee is permanently short.
 */
export function cycleStatutory(monthlyTotal: number, share: CycleShare, alreadyDeducted: number): number {
  if (share.totalDays <= 0) return 0
  // The month's LAST cycle always trues up to the full monthly figure, whatever the day weights
  // rounded to — the whole point is that a month's contributions add up.
  const cumulativeTarget = share.isLast
    ? monthlyTotal
    : Math.sign(monthlyTotal) * Math.round((Math.abs(monthlyTotal) * share.cumulativeDays) / share.totalDays)
  return cumulativeTarget - alreadyDeducted
}

/**
 * Split a month's payable days across a cycle.
 *
 * `monthPayableDays` is what the attendance register says for the whole month; a cycle is paid
 * its share of them. An employee who joined mid-month is handled by the caller clipping the
 * cycle's days — see `payableDaysInCycle`.
 */
export function proratedPayableDays(monthPayableDays: number, share: CycleShare, cyclePeriodDays: number): number {
  if (share.totalDays <= 0) return 0
  const full = (monthPayableDays * cyclePeriodDays) / share.totalDays
  // Half-day granularity, which is what the attendance register itself records.
  return Math.round(full * 2) / 2
}

/**
 * Days of a cycle an employee is actually on the payroll for.
 *
 * A mid-cycle joiner is paid from the day they joined, not from the Monday the cycle opened; a
 * mid-cycle leaver is paid to their last day. Returning 0 rather than a negative number matters:
 * a cycle entirely before someone joined is not a cycle they owe the company days for.
 */
export function payableDaysInCycle(period: CyclePeriod, joined: string | null, lastDay: string | null): number {
  const from = joined && joined > period.from ? joined : period.from
  const to = lastDay && lastDay < period.to ? lastDay : period.to
  if (to < from) return 0
  return daysBetween(from, to) + 1
}
