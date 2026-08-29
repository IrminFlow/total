/**
 * GST rate history per item — a rate is effective-dated data, not a field. (roadmap D-92)
 *
 * A stock item carrying ONE `gst_rate` column is fine right up to the first time the Council
 * changes a rate. When it does, editing the item silently rewrites history: every past invoice
 * reprinted, and every return recomputed, now uses the new rate. A return computed last year must
 * still answer what it answered when it was filed — so the rate an item charges is a list of
 * dated changes, exactly like the thresholds in `src/shared/statutory.ts`, and a document is
 * always priced with the rate in force on its own document date.
 *
 * Every change carries the notification that made it, because a rate with no citation is a rate
 * nobody can audit.
 *
 * Rates here are percentages (plain numbers) — that is what the statute states and what the
 * portal expects. Money stays integer paise and is computed elsewhere (`gst/calc.ts`); nothing in
 * this module does arithmetic on an amount.
 *
 * Dates are ISO 'YYYY-MM-DD' and all arithmetic goes through `src/shared/dates.ts` (UTC).
 *
 * The slab table this file warns against lives in `./slabs.ts` — one slab history for the whole
 * app, with its verification caveats written out in full. Read those before trusting a warning.
 * Storage is `stock_item_gst_rates` (see `src/main/services/itemRates.ts`).
 */

import { addDays, isValidISODate, toDisplayDate } from '../dates'
import { slabsOn } from './slabs'

export interface RateChange {
  /** ISO date the rate took effect. In force ON this day (see `rateOn`). */
  effectiveFrom: string
  /** Combined GST rate, percent — split into CGST/SGST or IGST by `computeGst`. */
  ratePercent: number
  /** Compensation cess, percent. Zero for almost everything; never negative. */
  cessPercent: number
  /** The notification that made the change, e.g. "32/2017-CTR". Shown in the UI. */
  note: string | null
}

export type RateHistory = RateChange[]

/** A stretch of a reporting period over which one rate was in force. */
export interface RatePeriod {
  from: string
  to: string
  /** The change in force across the stretch, or null when the item had no rate yet. */
  rate: RateChange | null
}

export type ProblemSeverity = 'error' | 'warning'

export interface RateProblem {
  severity: ProblemSeverity
  message: string
  /** Index into the history the problem belongs to, or null when it is about the list itself. */
  index: number | null
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/**
 * Ascending by effective date.
 *
 * Two changes on the same date: **the one later in the list wins**. Same-day duplicates only
 * happen because a human recorded the rate twice for that date — a correction — and the
 * correction is the entry they typed second. The sort is stable, so a later-in-input entry stays
 * later after sorting, and `rateOn` deliberately takes the LAST entry that has taken effect.
 *
 * Nothing is dropped: the duplicate stays in the list so `validateRateHistory` can still report
 * it and the user can decide. Silently deleting a rate somebody entered is how books lose data.
 */
export function normalizeRateHistory(history: RateHistory): RateHistory {
  return [...history].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : a.effectiveFrom > b.effectiveFrom ? 1 : 0))
}

/**
 * The change in force ON `date` — the latest one whose `effectiveFrom` is on or before it.
 *
 * The boundary is inclusive: a notification "with effect from 22-09-2025" applies to an invoice
 * dated 22 September, not from the 23rd.
 *
 * Returns null when the item had no rate yet on that date. That is NOT the same as zero-rated —
 * "nobody has told us" and "the Council notified nil" are different answers, and collapsing the
 * first into 0 is how an unpriced item quietly ships tax-free.
 */
export function rateOn(history: RateHistory, date: string): RateChange | null {
  const sorted = normalizeRateHistory(history)
  let current: RateChange | null = null
  for (const c of sorted) {
    if (c.effectiveFrom <= date) current = c
    else break
  }
  return current
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Structured problems, so callers can block on errors and merely show warnings. */
export function checkRateHistory(history: RateHistory): RateProblem[] {
  const problems: RateProblem[] = []

  if (history.length === 0) {
    problems.push({
      severity: 'error',
      message: 'No rate has been recorded for this item — it cannot be billed until one is.',
      index: null
    })
    return problems
  }

  const sorted = normalizeRateHistory(history)
  const seenDates = new Set<string>()

  sorted.forEach((c, i) => {
    if (!isValidISODate(c.effectiveFrom)) {
      problems.push({
        severity: 'error',
        message: `"${c.effectiveFrom}" is not a valid date (expected YYYY-MM-DD).`,
        index: i
      })
      return
    }
    if (seenDates.has(c.effectiveFrom)) {
      problems.push({
        severity: 'error',
        message: `Two rate changes are dated ${toDisplayDate(c.effectiveFrom)} — only the last one would ever apply.`,
        index: i
      })
    }
    seenDates.add(c.effectiveFrom)

    if (!Number.isFinite(c.ratePercent) || c.ratePercent < 0) {
      problems.push({
        severity: 'error',
        message: `A GST rate cannot be ${c.ratePercent}% — rates are zero or above.`,
        index: i
      })
    } else {
      const set = slabsOn(c.effectiveFrom)
      if (!set.slabs.includes(c.ratePercent)) {
        problems.push({
          severity: 'warning',
          message:
            `${c.ratePercent}% was not a notified slab on ${toDisplayDate(c.effectiveFrom)} ` +
            `(${set.slabs.map((s) => `${s}%`).join(', ')}). Recorded anyway — check the notification.`,
          index: i
        })
      }
    }

    if (!Number.isFinite(c.cessPercent) || c.cessPercent < 0) {
      problems.push({
        severity: 'error',
        message: `Compensation cess cannot be ${c.cessPercent}% — cess is never negative.`,
        index: i
      })
    }
  })

  return problems
}

/**
 * Human-readable problems, one line each, prefixed by severity.
 *
 * Warnings are advisory and must never block saving: an unusual rate is usually a real rate the
 * slab table has not caught up with.
 */
export function validateRateHistory(history: RateHistory): string[] {
  return checkRateHistory(history).map((p) => `${p.severity === 'error' ? 'Error' : 'Warning'}: ${p.message}`)
}

/** True when nothing is wrong enough to refuse the save. */
export function hasRateHistoryErrors(history: RateHistory): boolean {
  return checkRateHistory(history).some((p) => p.severity === 'error')
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/**
 * The sub-periods of [from, to] and the rate in force in each.
 *
 * This is what lets a report say "this period contained a rate change on 22-Sep-25" rather than
 * silently applying one rate to both halves of a month. A period with no change in it yields
 * exactly one sub-period spanning the whole thing.
 *
 * Cuts land on the change date (inclusive start), so the previous sub-period ends the day before.
 */
export function splitByRatePeriods(history: RateHistory, from: string, to: string): RatePeriod[] {
  if (from > to) return []

  const sorted = normalizeRateHistory(history)
  const periods: RatePeriod[] = []
  let cursor = from
  let current = rateOn(sorted, from)

  for (const c of sorted) {
    if (c.effectiveFrom <= from) continue
    if (c.effectiveFrom > to) break
    // Same-date duplicates: the last one wins, so an empty stretch is never emitted.
    if (c.effectiveFrom > cursor) {
      periods.push({ from: cursor, to: addDays(c.effectiveFrom, -1), rate: current })
      cursor = c.effectiveFrom
    }
    current = c
  }

  periods.push({ from: cursor, to, rate: current })
  return periods
}

/** True when the period straddles a rate change — worth telling the user before they file. */
export function rateChangedWithin(history: RateHistory, from: string, to: string): boolean {
  return splitByRatePeriods(history, from, to).length > 1
}

const pct = (n: number): string => `${n}%`

/** A one-line sentence for the UI. `prev` is null for the very first rate an item is given. */
export function describeRateChange(prev: RateChange | null, next: RateChange): string {
  const when = toDisplayDate(next.effectiveFrom)
  const cite = next.note ? ` (${next.note})` : ''
  const cess = next.cessPercent > 0 ? ` + ${pct(next.cessPercent)} cess` : ''

  if (!prev) return `GST set to ${pct(next.ratePercent)}${cess} with effect from ${when}${cite}.`

  const bits: string[] = []
  if (prev.ratePercent !== next.ratePercent) {
    const direction = next.ratePercent > prev.ratePercent ? 'raised' : 'reduced'
    bits.push(`GST ${direction} from ${pct(prev.ratePercent)} to ${pct(next.ratePercent)}`)
  }
  if (prev.cessPercent !== next.cessPercent) {
    bits.push(`cess ${pct(prev.cessPercent)} → ${pct(next.cessPercent)}`)
  }
  if (bits.length === 0) return `Rate re-stated at ${pct(next.ratePercent)}${cess} with effect from ${when}${cite}.`
  return `${bits.join(', ')} with effect from ${when}${cite}.`
}
