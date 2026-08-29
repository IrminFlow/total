/**
 * Customer credit scoring from payment history.
 *
 * Deliberately not a black box. The owner already has an opinion about every party, and a score
 * that disagrees with it will be ignored unless it can show its work — so the score is a weighted
 * average of four numbers the owner would recognise, and each is returned alongside it.
 *
 * A score is refused, not guessed, below `MIN_SAMPLE` settled bills. Three invoices is not a
 * payment history, and a confident-looking 82 derived from three is worse than no number.
 */

export const MIN_SAMPLE = 4

export interface SettledBill {
  /** Paise. Weights the party's behaviour by how much was at stake. */
  amount: number
  /** Days between the due date and the day it was actually settled. Negative = paid early. */
  daysLate: number
}

export interface OpenExposure {
  amount: number
  overdueDays: number
}

export type CreditBand = 'excellent' | 'good' | 'fair' | 'poor'

export interface CreditScore {
  /** 0-100, higher is better. */
  score: number
  band: CreditBand
  /** Amount-weighted mean of daysLate across settled bills. */
  avgDaysLate: number
  /** Fraction of settled bills paid on or before the due date, by count. */
  onTimeRate: number
  worstDaysLate: number
  /** Paise currently overdue. Drags the score down regardless of past behaviour. */
  overdueNow: number
  sample: number
}

export function bandFor(score: number): CreditBand {
  if (score >= 80) return 'excellent'
  if (score >= 60) return 'good'
  if (score >= 40) return 'fair'
  return 'poor'
}

/** 100 at zero days late, 0 at 90+ days late, linear between. */
function promptness(avgDaysLate: number): number {
  if (avgDaysLate <= 0) return 100
  if (avgDaysLate >= 90) return 0
  return 100 - (avgDaysLate / 90) * 100
}

/**
 * Score a party. Returns null when there is not enough settled history to say anything.
 *
 * Weights: how promptly they pay on average (40), how often they are on time at all (30), how bad
 * their worst lapse was (15), and how much is overdue right now (15). Past behaviour dominates,
 * but a party sitting on an overdue bill today cannot score 'excellent' on a good history.
 */
export function creditScore(settled: SettledBill[], open: OpenExposure[] = []): CreditScore | null {
  if (settled.length < MIN_SAMPLE) return null

  const weight = settled.reduce((s, b) => s + Math.max(1, b.amount), 0)
  const avgDaysLate = settled.reduce((s, b) => s + b.daysLate * Math.max(1, b.amount), 0) / weight
  const onTimeRate = settled.filter((b) => b.daysLate <= 0).length / settled.length
  const worstDaysLate = settled.reduce((m, b) => Math.max(m, b.daysLate), 0)

  const overdueNow = open.filter((o) => o.overdueDays > 0).reduce((s, o) => s + o.amount, 0)
  const exposure = open.reduce((s, o) => s + o.amount, 0)
  const overdueShare = exposure > 0 ? overdueNow / exposure : 0

  const raw =
    0.4 * promptness(avgDaysLate) +
    0.3 * (onTimeRate * 100) +
    0.15 * promptness(worstDaysLate) +
    0.15 * ((1 - overdueShare) * 100)

  const score = Math.max(0, Math.min(100, Math.round(raw)))
  return {
    score,
    band: bandFor(score),
    avgDaysLate: Math.round(avgDaysLate * 10) / 10,
    onTimeRate,
    worstDaysLate,
    overdueNow,
    sample: settled.length
  }
}

/** One sentence explaining the score, for the tooltip and the statement. */
export function explainScore(s: CreditScore): string {
  const pace =
    s.avgDaysLate <= 0
      ? `pays ${Math.abs(Math.round(s.avgDaysLate))} days early on average`
      : `pays ${Math.round(s.avgDaysLate)} days late on average`
  const onTime = `${Math.round(s.onTimeRate * 100)}% of ${s.sample} bills on time`
  return `${pace}, ${onTime}`
}
