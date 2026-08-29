/**
 * The round-off line: closing a voucher that is a few paise out.
 *
 * A GST invoice is rounded to the rupee under section 170 of the CGST Act, a payment is made in
 * whole rupees, and a percentage split lands on a third of a paisa. Any of those leaves a
 * journal that is out by a handful of paise, and the operator's only options today are to fudge
 * a line by hand or to leave the voucher unsaveable.
 *
 * The rule that makes this safe is the threshold. Below it, the difference is arithmetic and a
 * round-off line is the correct treatment. Above it, the difference is a mistake — a
 * transposed figure, a missing line — and quietly plugging it would turn a voucher that refuses
 * to save into a voucher that saves wrongly. So: paise only, never rupees.
 *
 * The default is 99 paise, i.e. strictly less than one rupee, because that is the largest
 * difference rupee-rounding can produce. A book that rounds to the nearest ten rupees is not a
 * thing, so there is no configuration here to get wrong.
 */

/** Largest difference that is treated as arithmetic rather than a mistake. */
export const ROUND_OFF_LIMIT_PAISE = 99

export interface RoundOffLine {
  /** The side the plug goes on. */
  drCr: 'dr' | 'cr'
  /** Always positive paise. */
  amount: number
}

/**
 * The line that would balance a voucher, or null when one should not be offered.
 *
 * Null covers three distinct cases, all of which mean "do not touch this voucher":
 *  - it already balances,
 *  - it is empty (nothing entered yet is not a rounding difference),
 *  - it is out by a rupee or more, which is a real error.
 */
export function roundOffLine(
  totalDr: number,
  totalCr: number,
  limitPaise: number = ROUND_OFF_LIMIT_PAISE
): RoundOffLine | null {
  if (totalDr <= 0 && totalCr <= 0) return null
  const diff = totalDr - totalCr
  if (diff === 0) return null
  if (Math.abs(diff) > limitPaise) return null
  // Debits exceed credits, so the plug is a credit of the difference — and vice versa.
  return { drCr: diff > 0 ? 'cr' : 'dr', amount: Math.abs(diff) }
}

/** True when the difference is one this module would plug. Kept separate so a screen can decide
 *  whether to show the offer without building the line. */
export function isRoundingDifference(
  totalDr: number,
  totalCr: number,
  limitPaise: number = ROUND_OFF_LIMIT_PAISE
): boolean {
  return roundOffLine(totalDr, totalCr, limitPaise) !== null
}
