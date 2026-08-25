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
 * Every rate below is a FULL GST rate — the figure a user types into an item master. The rate
 * notifications are written in central-tax halves (1/2017-Central Tax (Rate) Schedule II is "6%",
 * meaning 6% CGST + 6% SGST = 12% GST), so a schedule heading read straight off a CGST notification
 * is half of the number that belongs here. That mistake is why 6% is not in this table.
 *
 * CHECKED AGAINST, notification by notification (August 2026):
 *   - Notn. 1/2017-Central Tax (Rate) dated 28 Jun 2017 as originally issued: Schedules I to VI at
 *     2.5 / 6 / 9 / 14 / 1.5 / 0.125 per cent central tax — i.e. GST slabs 5 / 12 / 18 / 28 / 3 /
 *     0.25 — over the exempt (nil) schedule of Notn. 2/2017-CT(R).
 *   - Notn. 6/2022-Central Tax (Rate) dated 13 Jul 2022, para 1.F: "after Schedule VI and before
 *     Explanation, following entries shall be inserted, namely: - 'Schedule VII - 0.75%' " covering
 *     7102 and 7104 other than rough — cut and polished diamonds — and para 2: "This notification
 *     shall come into force on the 18th day of July, 2022." 0.75% central tax is 1.5% GST. That
 *     slab was missing from this table until it was read in the notification.
 *   - Notn. 9/2025-Integrated Tax (Rate) dated 17 Sep 2025 (corrected by G.S.R. 677(E) dated
 *     18 Sep 2025), in supersession of Notn. 1/2017-Integrated Tax (Rate), notifies integrated tax
 *     of "(i) 5 per cent ... Schedule I, (ii) 18 per cent ... Schedule II, (iii) 40 per cent ...
 *     Schedule III, (iv) 3 per cent ... Schedule IV, (v) 0.25 per cent ... Schedule V, (vi) 1.50
 *     per cent ... Schedule VI, and (vii) 28 per cent ... Schedule VII", and para 2: "This
 *     notification shall come into force with effect from the 22nd day of September, 2025." Its
 *     central-tax twin is Notn. 9/2025-Central Tax (Rate) of the same date, in the same terms at
 *     half the rates. Because the integrated notification states FULL GST rates it is the one
 *     quoted here.
 *     TWO THINGS THIS FILE HAD WRONG, both read straight off the press description of the 56th
 *     Council rather than the notification: 28% did NOT go — Schedule VII keeps it for pan masala
 *     and tobacco (2106 90 20, 2401, 2402, 2403, 2404 11 00, 2404 19 00) — and 1.5% is a schedule
 *     of its own, not a rate that disappeared.
 *
 * STILL NOT CHECKED, and stated precisely so the next person knows what is left:
 *   - The SERVICES rate structure. Notn. 11/2017-Central Tax (Rate) and whatever superseded it in
 *     September 2025 are not read here, so a service-only rate — the 1.5% on job work in relation
 *     to diamonds inserted in 11/2017-CT(R) by Notn. 20/2019-CT(R) — is covered by this table only
 *     because 1.5% happens also to be a goods slab from 18 Jul 2022. If a services-only rate ever
 *     needs to be advised on, this table is the wrong source for it.
 *   - The 1 February 2026 tobacco restructure. Notn. 3/2025-Compensation Cess (Rate) dated
 *     31 Dec 2025 is reported to have taken compensation cess on pan masala and tobacco to Nil, and
 *     Notn. 19/2025-Central Tax (Rate) of the same date to have moved those goods out of Schedule
 *     VII, both with effect from 1 Feb 2026. NEITHER NOTIFICATION COULD BE OBTAINED FROM A
 *     GOVERNMENT SOURCE as at 25 August 2026 — cbic-gst.gov.in and gstcouncil.gov.in both still
 *     list Central Tax (Rate) notifications only to 08/2025 — so no entry is made for it and this
 *     table continues to report 28% as a slab after 1 Feb 2026. If the restructure happened as
 *     described, that is the one date on which this table is knowingly behind. Add the entry when
 *     the notification can be read.
 *   - COMPENSATION CESS is not modelled here at all, and that is now a deliberate boundary rather
 *     than a gap: cess is levied by a different Act (the GST (Compensation to States) Act 2017,
 *     s.8) under its own rate notifications, it is not a GST slab, and `rateHistory.ts` carries it
 *     per item where it belongs.
 *
 * Every finding here is still ADVICE — `slabAdvice` returns a note, never a refusal, and nothing
 * in the app blocks an entry on the strength of it. A verified table is a better prompt; it is not
 * a licence to refuse a user's own rate.
 */

export interface GstSlabSet {
  /** ISO date this structure took effect. */
  effectiveFrom: string
  /** Rates that exist as slabs, ascending. Percent, as the masters hold them. */
  slabs: number[]
  /** Why this set exists, and how sure we are of it. Shown in the UI next to any advice. */
  note: string
  /** The notification this entry was read in. Shown with the advice — a rate with no citation is
   *  a rate nobody can audit. */
  notification: string
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
    notification: 'Notn. 1/2017-Central Tax (Rate) dated 28 Jun 2017, Schedules I to VI (rates there are central tax; these are the GST rates), with nil under Notn. 2/2017-CT(R).',
    unverified: false
  },
  {
    effectiveFrom: '2022-07-18',
    slabs: [0, 0.25, 1.5, 3, 5, 12, 18, 28],
    note:
      'Cut and polished diamonds get a slab of their own at 1.5%, above the 0.25% that stays on rough ' +
      'stones. Nothing else moves.',
    notification: 'Notn. 6/2022-Central Tax (Rate) dated 13 Jul 2022, para 1.F, inserting "Schedule VII - 0.75%" in Notn. 1/2017-CT(R), in force 18 Jul 2022.',
    unverified: false
  },
  {
    effectiveFrom: '2025-09-22',
    slabs: [0, 0.25, 1.5, 3, 5, 18, 28, 40],
    note:
      'Rate rationalisation: 12% withdrawn, 5% and 18% carry almost everything, and a 40% demerit rate ' +
      'appears. 28% is NOT withdrawn — Schedule VII keeps it for pan masala and tobacco until those goods ' +
      'are moved separately. 0.25%, 1.5% and 3% survive unchanged.',
    notification: 'Notn. 9/2025-Integrated Tax (Rate) dated 17 Sep 2025 (Schedules I-VII: 5/18/40/3/0.25/1.50/28), in supersession of Notn. 1/2017-IT(R), in force 22 Sep 2025; central-tax twin Notn. 9/2025-CT(R) of the same date.',
    unverified: false
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
