/**
 * Configurable ageing bands.
 *
 * The 0-30 / 31-60 / 61-90 / 90+ split is the industry default and stays the default here, but it
 * is a convention, not a law: a trade on 45-day terms wants 45/90/180, and a CA closing a year
 * wants 180/365 because that is where provisioning rules bite.
 *
 * A band set is stored as its cut points — [30, 60, 90] means four bands, the last one open-ended.
 * Storing cuts rather than labels means the labels can never disagree with the arithmetic.
 */

export const DEFAULT_BAND_CUTS = [30, 60, 90]

/** Cuts must be positive, ascending and distinct; anything else is rejected rather than repaired,
 *  because a silently reordered band set produces a report nobody can reconcile. */
export function validBandCuts(cuts: number[]): boolean {
  if (cuts.length === 0 || cuts.length > 6) return false
  return cuts.every((c, i) => Number.isInteger(c) && c > 0 && (i === 0 || c > (cuts[i - 1] as number)))
}

export function normaliseBandCuts(cuts: number[] | null | undefined): number[] {
  if (!cuts || !validBandCuts(cuts)) return DEFAULT_BAND_CUTS
  return cuts
}

/** ['0-30 days', '31-60 days', '61-90 days', '90+ days'] for [30, 60, 90]. */
export function bandLabels(cuts: number[]): string[] {
  const c = normaliseBandCuts(cuts)
  const labels = c.map((cut, i) => (i === 0 ? `0-${cut} days` : `${(c[i - 1] as number) + 1}-${cut} days`))
  labels.push(`${c[c.length - 1] as number}+ days`)
  return labels
}

/** Index of the band a given overdue-day count falls in. */
export function bandIndex(days: number, cuts: number[]): number {
  const c = normaliseBandCuts(cuts)
  for (let i = 0; i < c.length; i++) if (days <= (c[i] as number)) return i
  return c.length
}

export interface AgeingBill {
  pending: number
  overdueDays: number
}

/** Total pending per band. Length is always cuts.length + 1. */
export function bucketByBand(bills: AgeingBill[], cuts: number[]): number[] {
  const c = normaliseBandCuts(cuts)
  const out = new Array<number>(c.length + 1).fill(0)
  for (const b of bills) {
    const i = bandIndex(b.overdueDays, c)
    out[i] = (out[i] as number) + b.pending
  }
  return out
}
