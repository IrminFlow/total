/**
 * Interest on overdue bills, per party terms.
 *
 * Small businesses in India charge interest on late payment far more often than they collect it —
 * the number's real job is to appear on a statement and start a conversation. That makes accuracy
 * about the *method* more important than the amount: a supplier who disputes the interest will
 * dispute the days and the rate, so both are stated on every line.
 *
 * Rates are stored in basis points (1% = 100bp) because a rate is a rounded human number and
 * storing it as a float invites 0.18000000000000002 in the books. Interest is integer paise,
 * floored — never charge a paisa you cannot justify.
 */

export interface InterestTerms {
  /** Annual rate in basis points. 1800 = 18% p.a. */
  rateBp: number
  /** Days past the due date before interest starts running. */
  graceDays: number
}

export const DEFAULT_INTEREST_TERMS: InterestTerms = { rateBp: 1800, graceDays: 0 }

/**
 * Simple interest, actual days over a 365-day year, in integer paise (floored).
 *
 * The rate is divided out before the day count is applied. Multiplying all three first overflows
 * the 53-bit integer range at about ₹13.7 crore of principal over a year, which is a plausible
 * enough bill for a business at the top of this app's market — and a silent loss of paise in an
 * interest figure is exactly the sort of thing a customer disputes.
 */
export function simpleInterest(principalPaise: number, rateBp: number, days: number): number {
  if (principalPaise <= 0 || rateBp <= 0 || days <= 0) return 0
  return Math.floor(((principalPaise * rateBp) / 10_000) * (days / 365))
}

export interface InterestLine {
  number: string
  date: string
  dueDate: string | null
  pending: number
  /** Days past due, before grace is applied. */
  overdueDays: number
  /** Days actually charged: overdueDays − graceDays, floored at 0. */
  chargeableDays: number
  interest: number
}

export interface InterestResult {
  lines: InterestLine[]
  /** Sum of `interest` across every line, including the zero ones. */
  total: number
  rateBp: number
  graceDays: number
}

export interface InterestBill {
  number: string
  date: string
  dueDate: string | null
  pending: number
  overdueDays: number
}

/**
 * Interest on every open bill of a party. Bills inside the grace period are kept in the result
 * with zero interest rather than dropped, because "this bill is late but not chargeable yet" is
 * information the person reading the statement wants.
 */
export function interestOnBills(bills: InterestBill[], terms: InterestTerms): InterestResult {
  const lines = bills.map((b) => {
    const chargeableDays = Math.max(0, b.overdueDays - terms.graceDays)
    return {
      number: b.number,
      date: b.date,
      dueDate: b.dueDate,
      pending: b.pending,
      overdueDays: b.overdueDays,
      chargeableDays,
      interest: simpleInterest(b.pending, terms.rateBp, chargeableDays)
    }
  })
  return {
    lines,
    total: lines.reduce((s, l) => s + l.interest, 0),
    rateBp: terms.rateBp,
    graceDays: terms.graceDays
  }
}

/** "18% p.a. after 7 days" — the sentence that goes on the statement. */
export function describeTerms(terms: InterestTerms): string {
  const rate = (terms.rateBp / 100).toFixed(terms.rateBp % 100 === 0 ? 0 : 2)
  const base = `${rate}% p.a.`
  return terms.graceDays > 0 ? `${base} after ${terms.graceDays} day${terms.graceDays === 1 ? '' : 's'}` : base
}
