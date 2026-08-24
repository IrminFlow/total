/**
 * How much of a business rests on how few customers.
 *
 * A business with one customer at 60% of turnover is a materially different business from one
 * with forty customers at 2.5% each, and nothing in the books says so — the P&L looks identical.
 * Losing that customer is not a bad quarter, it is an existential event, and the owner usually
 * knows it in their gut long before any report tells them.
 *
 * Two measures, because they answer different questions:
 *  - **Top-N share** answers "how exposed am I to my largest customers", which is the question
 *    an owner actually asks.
 *  - **HHI** (the Herfindahl-Hirschman index, the sum of squared shares) answers "how spread out
 *    is the book overall". It is included because top-N is blind to the shape of the tail: two
 *    books can share a top-3 of 50% while one has ten more customers and the other has two.
 *
 * Thresholds here are judgement, not law, and are named so they can be argued with rather than
 * being magic numbers buried in a comparison.
 */

/** Above this share, a single customer is a concentration risk worth naming. */
export const SINGLE_PARTY_WARN = 0.25

/** Above this share, the top three together are a concentration risk. */
export const TOP3_WARN = 0.5

/**
 * HHI thresholds, using the same 0–1 scale as the shares (competition authorities use 0–10,000;
 * this is that divided by 10,000). 0.15 and 0.25 are the conventional moderate/high boundaries.
 */
export const HHI_MODERATE = 0.15
export const HHI_HIGH = 0.25

export type ConcentrationLevel = 'diversified' | 'moderate' | 'concentrated'

export interface Concentration {
  /** Share of the largest single party, 0–1. Zero when there is nothing to divide. */
  top1: number
  /** Combined share of the largest three. */
  top3: number
  /** Sum of squared shares, 0–1. 1 means a single party; 1/n means n equal parties. */
  hhi: number
  level: ConcentrationLevel
  /** How many parties make up the total — the denominator behind every figure above. */
  partyCount: number
  /** A sentence naming the risk, or null when there is nothing to say. */
  warning: string | null
}

/**
 * Compute concentration from a list of amounts.
 *
 * Amounts are taken as given, in whatever unit the caller uses; only ratios matter. Negative and
 * zero amounts are dropped rather than netted: a customer who returned more than they bought is
 * not a share of turnover, and letting them offset a real customer's share would understate the
 * exposure that this exists to surface.
 */
export function concentration(amounts: number[]): Concentration {
  const positive = amounts.filter((a) => a > 0).sort((a, b) => b - a)
  const total = positive.reduce((s, a) => s + a, 0)

  if (total === 0) {
    return { top1: 0, top3: 0, hhi: 0, level: 'diversified', partyCount: 0, warning: null }
  }

  const shares = positive.map((a) => a / total)
  const top1 = shares[0] ?? 0
  const top3 = shares.slice(0, 3).reduce((s, x) => s + x, 0)
  const hhi = shares.reduce((s, x) => s + x * x, 0)

  const level: ConcentrationLevel =
    hhi >= HHI_HIGH || top1 >= SINGLE_PARTY_WARN
      ? 'concentrated'
      : hhi >= HHI_MODERATE || top3 >= TOP3_WARN
        ? 'moderate'
        : 'diversified'

  const pct = (x: number): string => `${Math.round(x * 100)}%`
  const warning =
    top1 >= SINGLE_PARTY_WARN
      ? `Your largest party is ${pct(top1)} of the total. Losing them would not be a bad quarter.`
      : top3 >= TOP3_WARN
        ? `Your three largest parties are ${pct(top3)} of the total between them.`
        : positive.length <= 3 && positive.length > 0
          ? `Everything here comes from ${positive.length} part${positive.length === 1 ? 'y' : 'ies'}.`
          : null

  return { top1, top3, hhi, level, partyCount: positive.length, warning }
}
