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
 */

import { addDays, isValidISODate, toDisplayDate } from '../dates'

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
// The notified slabs — dated data, in the shape statutory.ts uses.
// ---------------------------------------------------------------------------

export interface SlabSet {
  /** ISO date this set of slabs took effect. */
  effectiveFrom: string
  /** The rates notified as slabs on that date, percent. */
  slabs: number[]
  /** Why this set exists — shown with the warning so a rate can be checked against its source. */
  note: string
}

/**
 * VERIFY: checked against the CGST rate notifications and Council press releases as at
 * 2026-08-25. The slab list is used ONLY to decide whether to *warn*; it never rejects a rate.
 * The Council has notified odd rates before (1.5% on diamond job work, 6% on certain goods,
 * 7.5%/12% composition-adjacent oddities), and an app that refuses to record reality is worse
 * than one that queries it. If a slab set changes, append an entry — never edit an old one, for
 * the same reason the rate history itself is append-only.
 */
export const GST_SLAB_HISTORY: SlabSet[] = [
  {
    effectiveFrom: '2017-07-01',
    slabs: [0, 0.25, 3, 5, 12, 18, 28],
    note: 'GST rollout: nil, 0.25% (rough precious stones), 3% (bullion), 5/12/18/28%.'
  },
  {
    effectiveFrom: '2019-10-01',
    slabs: [0, 0.25, 1.5, 3, 5, 12, 18, 28],
    note: '1.5% notified for job work on diamonds (Notification 20/2019-CTR).'
  },
  {
    effectiveFrom: '2021-10-01',
    slabs: [0, 0.25, 1.5, 3, 5, 6, 12, 18, 28],
    note: '6% notified for certain goods (Notification 8/2021-CTR).'
  },
  {
    effectiveFrom: '2025-09-22',
    slabs: [0, 0.25, 1.5, 3, 5, 18, 40],
    note:
      'GST rationalisation (56th Council meeting): two main slabs 5% and 18%, a 40% demerit rate, ' +
      '0.25%/3% retained for precious stones and metals. 12% and 28% withdrawn.'
  }
]

/** The slab set in force on `date`. Dates before GST get the first set — old books still import. */
export function slabsOn(date: string, history: SlabSet[] = GST_SLAB_HISTORY): SlabSet {
  let current = history[0] as SlabSet
  for (const s of history) {
    if (s.effectiveFrom <= date) current = s
    else break
  }
  return current
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
