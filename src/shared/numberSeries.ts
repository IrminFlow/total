/**
 * Gaps in a voucher-numbering series.
 *
 * A missing invoice number is the first thing an auditor asks about, and the honest answer is
 * usually dull — a voucher was deleted, or the series was started mid-year from an old book.
 * What matters is that the business knows about the gap before it is asked, rather than
 * discovering it across a table.
 *
 * Deliberately detection, not prevention. Refusing to save a voucher that would leave a gap
 * would be worse than the gap: numbers are allocated at save time, two people entering at once
 * legitimately produce a gap when one cancels, and a business that has just deleted a voided
 * invoice must still be able to carry on. The bin is a soft delete, so the number is not
 * reissued either — which is correct, and is exactly what leaves the hole.
 */

export interface NumberGap {
  /** The first missing number in this run. */
  from: number
  /** The last missing number in this run; equal to `from` for a single missing number. */
  to: number
}

/**
 * Runs of missing integers in a sorted-or-not list of used numbers.
 *
 * Consecutive missing numbers are collapsed into one gap: "7 to 19 are missing" is a sentence
 * someone can act on, where thirteen separate rows are a wall.
 *
 * The series is read from its own lowest number rather than from 1. A book started mid-year from
 * a previous system legitimately begins at 214, and reporting 1–213 as missing on day one would
 * make the whole check something to ignore.
 */
export function numberGaps(used: number[]): NumberGap[] {
  const sorted = [...new Set(used.filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b)
  if (sorted.length < 2) return []

  const gaps: NumberGap[] = []
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!
    const cur = sorted[i]!
    if (cur - prev > 1) gaps.push({ from: prev + 1, to: cur - 1 })
  }
  return gaps
}

/** How many numbers a gap covers. */
export function gapSize(gap: NumberGap): number {
  return gap.to - gap.from + 1
}

/** "Invoice 7 is missing" / "Invoices 7 to 19 are missing" — one gap, in words. */
export function describeGap(gap: NumberGap): string {
  return gap.from === gap.to ? `${gap.from}` : `${gap.from} to ${gap.to}`
}
