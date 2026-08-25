/**
 * Price list versioning with effective dates (roadmap E #128).
 *
 * The table `price_list_rates` has carried an `effective_from` since price levels were built, so
 * the storage was never the problem. What was missing is the idea a user actually has, which is
 * not "a rate with a date on it" but **a version**: on 1 October the wholesale list changed, all
 * forty items at once, and the question afterwards is "what was the wholesale list on 20
 * September" — one date, one whole list.
 *
 * That is the same shape as `statutory.ts`: what a price WAS on a date has to stay answerable
 * after it changes. It matters more here than it looks. A reprinted invoice takes its rate from
 * the inventory line, so history is safe there — but a credit note raised in November against a
 * September invoice, a price-protection claim, and every "why is this customer arguing about the
 * rate" conversation are all answered from the list as it stood, and a list that only remembers
 * today's rates cannot answer any of them.
 *
 * A version is therefore not a stored row. It is the set of rates sharing an `effective_from`,
 * derived — because a stored version header and the rates under it are two things that can
 * disagree, and the rates are the ones that price the invoice.
 */

/** Signed BigInt division rounded half away from zero. */
function divRound(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n !== denominator < 0n
  const n = numerator < 0n ? -numerator : numerator
  const d = denominator < 0n ? -denominator : denominator
  const q = (2n * n + d) / (2n * d)
  return negative ? -q : q
}

export interface DatedRate {
  stockItemId: number
  /** Paise per whole unit. */
  rate: number
  /** ISO date this rate came into force. */
  effectiveFrom: string
}

/**
 * The rate in force for one item on `date`: latest `effectiveFrom` on or before it.
 *
 * The pure twin of the service's `rateFor`, so the same rule can be tested exhaustively without a
 * database and reused by the screen to show what a version will do before it is saved.
 */
export function rateOn(rates: readonly DatedRate[], stockItemId: number, date: string): number | null {
  let best: DatedRate | null = null
  for (const r of rates) {
    if (r.stockItemId !== stockItemId || r.effectiveFrom > date) continue
    if (!best || r.effectiveFrom > best.effectiveFrom) best = r
  }
  return best ? best.rate : null
}

/** The whole list as it stood on `date`: one rate per item, the one in force. */
export function listOn(rates: readonly DatedRate[], date: string): Map<number, number> {
  const out = new Map<number, number>()
  const at = new Map<number, string>()
  for (const r of rates) {
    if (r.effectiveFrom > date) continue
    const seen = at.get(r.stockItemId)
    if (seen === undefined || r.effectiveFrom > seen) {
      at.set(r.stockItemId, r.effectiveFrom)
      out.set(r.stockItemId, r.rate)
    }
  }
  return out
}

export interface PriceVersion {
  effectiveFrom: string
  /** Items whose rate CHANGED on this date. Not the size of the list — the size of the revision. */
  itemCount: number
  /** True once the date has arrived. A version dated next month is staged, not in force. */
  inForce: boolean
}

/**
 * The versions of a level, newest first.
 *
 * `inForce` is against a date the caller passes rather than "now", because a report run as on 31
 * March must describe the list as it was then — including calling a version that has since taken
 * effect "not yet in force".
 */
export function versionsOf(rates: readonly DatedRate[], asOn: string): PriceVersion[] {
  const counts = new Map<string, number>()
  for (const r of rates) counts.set(r.effectiveFrom, (counts.get(r.effectiveFrom) ?? 0) + 1)
  return [...counts.entries()]
    .map(([effectiveFrom, itemCount]) => ({ effectiveFrom, itemCount, inForce: effectiveFrom <= asOn }))
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))
}

export type Rounding = 'paise' | 'rupee' | 'ten'

/** Paise in one step of each rounding. A price list is set in rupees far more often than paise. */
function stepOf(rounding: Rounding): number {
  return rounding === 'paise' ? 1 : rounding === 'rupee' ? 100 : 1000
}

/** Round a paise figure to the nearest whole rupee or ten rupees — what a price list is set to. */
export function roundPrice(paise: number, rounding: Rounding): number {
  const step = stepOf(rounding)
  return step === 1 ? paise : Number(divRound(BigInt(paise), BigInt(step))) * step
}

/**
 * Move a rate by `changeBp` and round it to `rounding` — in ONE division, not two.
 *
 * Rounding to paise and then to rupees rounds twice, and twice is how ₹103.33 + 5% becomes ₹109:
 * ₹108.4965 rounds up to ₹108.50, and ₹108.50 then rounds up again to ₹109. The right answer is
 * ₹108, and it is only reachable by never materialising the intermediate.
 */
export function revisedRate(rate: number, changeBp: number, rounding: Rounding = 'paise'): number {
  const step = BigInt(stepOf(rounding))
  return Number(divRound(BigInt(rate) * BigInt(10_000 + changeBp), 10_000n * step)) * Number(step)
}

export interface RevisionInput {
  /** The rates in force on the day before the new version starts — what is being revised. */
  base: { stockItemId: number; rate: number }[]
  /** The date the new version takes effect. */
  effectiveFrom: string
  /** Change in basis points: +500 is +5%, −250 is −2.5%. Integer, because a percentage stored as
   *  a float reintroduces one layer up the imprecision paise exist to avoid. */
  changeBp: number
  rounding?: Rounding
  /** Items to leave out of the revision entirely — the ones whose price was just negotiated. */
  skip?: readonly number[]
}

export interface RevisionRow {
  stockItemId: number
  fromRate: number
  rate: number
  effectiveFrom: string
}

export interface RevisionPlan {
  rows: RevisionRow[]
  effectiveFrom: string
  errors: string[]
}

/**
 * Plan the next version of a list: take what is in force, move it by a percentage, round it.
 *
 * Computed on the BASE rate, once, rather than by applying a percentage to whatever the previous
 * revision rounded to. Two 5% rises off a rounded ₹100 give ₹110, and off the unrounded figures
 * give ₹110.25 — the second is right and the first is how a list drifts away from its own
 * arithmetic over a few years.
 *
 * Rows whose rate does not move are dropped, so a version records a revision rather than a copy of
 * the list. A version of forty rows where two prices changed makes the history unreadable.
 */
export function planRevision(input: RevisionInput): RevisionPlan {
  const errors: string[] = []
  if (!Number.isInteger(input.changeBp)) errors.push('A price change is whole basis points')
  if (input.changeBp <= -10_000) errors.push('A price list cannot fall by 100% or more')
  if (input.base.length === 0) errors.push('There is no price list to revise yet')
  // Refused before anything is computed: a fractional basis point cannot be arithmetic'd in
  // integers at all, and continuing would throw somewhere less legible than here.
  if (errors.length) return { rows: [], effectiveFrom: input.effectiveFrom, errors }

  const skip = new Set(input.skip ?? [])
  const rows: RevisionRow[] = []
  for (const b of input.base) {
    if (skip.has(b.stockItemId)) continue
    const rate = revisedRate(b.rate, input.changeBp, input.rounding ?? 'paise')
    if (rate === b.rate) continue
    if (rate <= 0) {
      // Rounding a 10-paise item to whole rupees really does land on zero, and a price of zero is
      // not a price — it is an item that would go out free and look deliberate on the invoice.
      errors.push(`Item ${b.stockItemId} would price at nothing after rounding`)
      continue
    }
    rows.push({ stockItemId: b.stockItemId, fromRate: b.rate, rate, effectiveFrom: input.effectiveFrom })
  }
  if (rows.length === 0 && errors.length === 0) {
    errors.push('Nothing would change — every price rounds back to what it already is')
  }
  return { rows, effectiveFrom: input.effectiveFrom, errors }
}
