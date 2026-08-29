/**
 * Cash-flow forecast — composed only from things the books already know.
 *
 * There is no trend line here and no growth assumption. Every rupee in this forecast is traceable
 * to a row someone can open: an open bill with a due date, a post-dated cheque with a maturity
 * date, or a recurring template with a cadence. A projection nobody can trace is worse than no
 * projection, because it gets quoted to a bank.
 *
 * Confidence is carried per item rather than blended into one number:
 *   'contracted' — a bill or a PDC. The amount and the date are already agreed.
 *   'expected'   — a recurring template. The cadence is the user's own, but the occurrence has
 *                  not happened yet and may be skipped.
 * The screen totals both and shows the contracted-only line beside it, so "what if nothing
 * recurring goes out" is one glance rather than a second report.
 */

import { addDays } from './dates'

export type ForecastSource = 'receivable' | 'payable' | 'pdc' | 'recurring'
export type ForecastCertainty = 'contracted' | 'expected'

export interface ForecastItem {
  /** The date the cash is expected to move. Items dated before the window start are overdue and
   *  land in the first bucket — they are due now, not on the date printed on them. */
  date: string
  /** Signed paise: positive is money in, negative is money out. */
  amount: number
  source: ForecastSource
  certainty: ForecastCertainty
  label: string
  /** Present when the row can be opened on a screen. */
  ledgerId?: number
  voucherId?: number
}

export interface ForecastBucket {
  from: string
  to: string
  inflow: number
  outflow: number
  /** inflow + outflow (outflow is already negative). */
  net: number
  /** Running cash balance at the end of this bucket, including expected items. */
  closing: number
  /** The same running balance counting only contracted items — the pessimistic line. */
  closingContracted: number
  items: ForecastItem[]
}

export interface CashForecast {
  from: string
  to: string
  openingCash: number
  buckets: ForecastBucket[]
  closingCash: number
  /** First bucket whose closing balance is below zero, or null when it never is. */
  shortfallDate: string | null
  /** The worst closing balance across the window (equals openingCash for an empty forecast). */
  lowestBalance: number
  totalIn: number
  totalOut: number
}

export interface ForecastInput {
  from: string
  to: string
  openingCash: number
  items: ForecastItem[]
  /** Bucket width in days. 7 by default: a business plans payments by week, not by day. */
  bucketDays?: number
}

/**
 * Bucket the items and run the balance forward.
 *
 * A single-day window still produces exactly one bucket — `from` and `to` are inclusive, and a
 * zero-length window would otherwise produce none and report a closing balance from nowhere.
 */
export function buildForecast(input: ForecastInput): CashForecast {
  const bucketDays = Math.max(1, input.bucketDays ?? 7)
  const buckets: ForecastBucket[] = []

  // Windows are inclusive at both ends, so the loop starts a bucket on `from` and keeps going
  // while the bucket's first day is still within `to`.
  for (let start = input.from; start <= input.to; start = addDays(start, bucketDays)) {
    const end = addDays(start, bucketDays - 1)
    buckets.push({
      from: start,
      to: end > input.to ? input.to : end,
      inflow: 0,
      outflow: 0,
      net: 0,
      closing: 0,
      closingContracted: 0,
      items: []
    })
  }
  if (buckets.length === 0) {
    return {
      from: input.from,
      to: input.to,
      openingCash: input.openingCash,
      buckets: [],
      closingCash: input.openingCash,
      shortfallDate: input.openingCash < 0 ? input.from : null,
      lowestBalance: input.openingCash,
      totalIn: 0,
      totalOut: 0
    }
  }

  for (const item of input.items) {
    if (item.amount === 0) continue
    // Past the window is genuinely out of scope; before it is overdue and belongs at the front.
    if (item.date > input.to) continue
    const idx = buckets.findIndex((b) => item.date <= b.to)
    const bucket = buckets[idx === -1 ? buckets.length - 1 : idx]!
    bucket.items.push(item)
    if (item.amount > 0) bucket.inflow += item.amount
    else bucket.outflow += item.amount
  }

  let running = input.openingCash
  let contracted = input.openingCash
  let shortfallDate: string | null = input.openingCash < 0 ? input.from : null
  let lowestBalance = input.openingCash
  let totalIn = 0
  let totalOut = 0

  for (const b of buckets) {
    b.net = b.inflow + b.outflow
    running += b.net
    contracted += b.items.filter((i) => i.certainty === 'contracted').reduce((s, i) => s + i.amount, 0)
    b.closing = running
    b.closingContracted = contracted
    totalIn += b.inflow
    totalOut += b.outflow
    if (shortfallDate === null && running < 0) shortfallDate = b.to
    if (running < lowestBalance) lowestBalance = running
    // Newest promises first inside a bucket reads worse than largest first: the point of the row
    // list is which single item moves the week.
    b.items.sort((a, c) => Math.abs(c.amount) - Math.abs(a.amount) || a.date.localeCompare(c.date))
  }

  return {
    from: input.from,
    to: input.to,
    openingCash: input.openingCash,
    buckets,
    closingCash: running,
    shortfallDate,
    lowestBalance,
    totalIn,
    totalOut
  }
}
