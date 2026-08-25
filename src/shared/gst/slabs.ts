/**
 * The GST SLAB STRUCTURE in force on a date.
 *
 * This file was `gst/rateHistory.ts` until two lanes shipped a module of that name. The
 * per-item, effective-dated rate engine (cess, the notification citation, period splitting)
 * kept the name; this — "which slabs existed on this date" — is a different question and now
 * lives here. `rateHistory.ts` imports `slabsOn` from this file, so there is exactly one slab
 * table in the app.
 *
 * The header below is carried across unchanged. Read it before trusting anything in it.
 */

/**
 * GST rate history, and what an item's rate was on a given date (roadmap #358).
 *
 * An item has never had one rate. It has had a rate on a date, and the September 2025
 * rationalisation is the case that makes the difference impossible to ignore: an invoice dated
 * 21 September 2025 and one dated 23 September 2025 for the same goods can carry different tax,
 * and a credit note issued in 2026 against a 2025 invoice carries the ORIGINAL invoice's rate
 * (section 34 read with section 15 — a note adjusts the supply it refers to, it is not a fresh
 * supply). A single `stock_items.gst_rate` column cannot answer any of that.
 *
 * So: rates are dated data. `stock_item_gst_rates` holds the changes, the master column holds the
 * current rate for entry convenience, and `itemRateOn` is what a report or a back-dated voucher
 * must ask.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT IS AND IS NOT CLAIMED HERE — read before trusting anything below.
 *
 * This module models the SLAB STRUCTURE in force on a date. It does NOT claim to know which slab
 * any particular HSN falls in, at any date. That mapping is thousands of lines of rate schedule,
 * it changes by notification several times a year, and half-modelling it would produce an app
 * that confidently taxes cement at the wrong rate. The per-item rate is the user's, entered once
 * per change; what this file adds is the date on it, plus a check that the rate entered is a slab
 * that existed on that date.
 *
 * CHECKED AGAINST (August 2026), and flagged where the check was not conclusive:
 *   - Pre-rationalisation slabs 0 / 0.25 / 3 / 5 / 12 / 18 / 28 — the schedule as it stood since
 *     the 2017 rate notifications (1/2017-Central Tax (Rate) and its successors), with 0.25% for
 *     rough precious stones and 3% for gold and silver. Well established.
 *   - The 56th GST Council meeting (3 September 2025) recommended collapsing to two principal
 *     slabs of 5% and 18%, retaining 0 / 0.25 / 3 for the special categories, and introducing a
 *     40% rate for demerit and sin goods, **with effect from 22 September 2025**.
 *     ** THE EFFECTIVE DATE AND THE SLAB LIST ARE FROM THE COUNCIL'S RECOMMENDATION. The rate
 *        notification numbers that gave them effect have NOT been verified by this author, and
 *        the treatment of compensation cess after that date has NOT been verified either. Check
 *        both before relying on the advisory this file produces. **
 *
 * Because of that uncertainty every finding here is ADVICE — `slabAdvice` returns a note, never a
 * refusal, and nothing in the app blocks an entry on the strength of it.
 */

export interface GstSlabSet {
  /** ISO date this structure took effect. */
  effectiveFrom: string
  /** Rates that exist as slabs, ascending. Percent, as the masters hold them. */
  slabs: number[]
  /** Why this set exists, and how sure we are of it. Shown in the UI next to any advice. */
  note: string
  /** True when the entry has not been verified against the notification that made it. */
  unverified: boolean
}

/**
 * Ascending by date. `slabsOn` picks the last entry that has taken effect, so a date before the
 * first entry gets the first entry — refusing to answer for a 2016 voucher helps nobody, and a
 * pre-GST date has no GST slab to be wrong about anyway.
 */
export const GST_SLAB_HISTORY: GstSlabSet[] = [
  {
    effectiveFrom: '2017-07-01',
    slabs: [0, 0.25, 3, 5, 12, 18, 28],
    note: 'GST as introduced: 5/12/18/28 with 0.25% on rough precious stones and 3% on gold and silver.',
    unverified: false
  },
  {
    effectiveFrom: '2025-09-22',
    slabs: [0, 0.25, 3, 5, 18, 40],
    note:
      'Rate rationalisation recommended by the 56th GST Council (3 September 2025): two principal ' +
      'slabs of 5% and 18%, a 40% demerit rate, and 12% and 28% withdrawn. Effective date and ' +
      'slab list taken from the Council recommendation — the rate notifications have not been ' +
      'verified. Treat any advice from this entry as a prompt to check, not as an answer.',
    unverified: true
  }
]

/** The slab structure in force on `date`. */
export function slabsOn(date: string, history: GstSlabSet[] = GST_SLAB_HISTORY): GstSlabSet {
  let current = history[0] as GstSlabSet
  for (const s of history) {
    if (s.effectiveFrom <= date) current = s
    else break
  }
  return current
}

/** Whether `rate` is one of the slabs in force on `date`. */
export function isNotifiedSlab(rate: number, date: string, history: GstSlabSet[] = GST_SLAB_HISTORY): boolean {
  return slabsOn(date, history).slabs.includes(rate)
}

export interface SlabAdvice {
  /** The slab set consulted. */
  set: GstSlabSet
  /** Null when the rate is a slab in force. Otherwise the sentence to show. */
  message: string | null
  /** The nearest surviving slabs, when the rate used is one that was withdrawn. */
  suggestions: number[]
}

/**
 * Advice on a rate used on a date. Never a refusal — see the header.
 *
 * The interesting case is a rate that WAS a slab and no longer is: 12% and 28% on an invoice
 * dated after the rationalisation. That is almost always a master that nobody updated, and it is
 * exactly what the user will be asked about first.
 */
export function slabAdvice(rate: number, date: string, history: GstSlabSet[] = GST_SLAB_HISTORY): SlabAdvice {
  const set = slabsOn(date, history)
  if (set.slabs.includes(rate)) return { set, message: null, suggestions: [] }

  const wasASlab = history.some((s) => s.effectiveFrom < set.effectiveFrom && s.slabs.includes(rate))
  const suggestions = set.slabs.filter((s) => s > 0)
  const message = wasASlab
    ? `${rate}% was withdrawn with effect from ${set.effectiveFrom}. Check the item's rate for this invoice date.`
    : `${rate}% is not a notified slab on ${date}.`
  return { set, message, suggestions }
}

/**
 * Whether a period straddles a change in the slab STRUCTURE.
 *
 * Worth saying out loud on a return: a GSTR-1 for September 2025 contains invoices under two
 * different rate structures, and the HSN summary will legitimately show the same HSN at two
 * rates. Without this, that looks like a data-entry error.
 */
export function structureChangedWithin(
  from: string,
  to: string,
  history: GstSlabSet[] = GST_SLAB_HISTORY
): GstSlabSet | null {
  return history.find((s) => s.effectiveFrom > from && s.effectiveFrom <= to) ?? null
}
