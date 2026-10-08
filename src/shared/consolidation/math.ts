/** Integer helpers for consolidation — paise × basis points can pass 2^53, so go through BigInt. */

/** round(amount × num / den), half away from zero, exact for any safe-integer inputs. */
export function mulDiv(amount: number, num: number, den: number): number {
  if (den === 0) throw new Error('mulDiv: zero denominator')
  const sign = (amount < 0 ? -1 : 1) * (num < 0 ? -1 : 1) * (den < 0 ? -1 : 1)
  const a = BigInt(Math.abs(amount)) * BigInt(Math.abs(num))
  const d = BigInt(Math.abs(den))
  const q = (a * 2n + d) / (2n * d)
  return sign * Number(q)
}

/** `bp` basis points of `amount` (10000 = 100 %). */
export const shareOf = (amount: number, bp: number): number => mulDiv(amount, bp, 10000)

/** Split `total` across `weights` in SIGNED proportion (a negative weight takes a share of the
 *  opposite sign), by largest remainder, so the parts sum exactly. With weights summing to zero
 *  the whole total goes to the first weight. */
export function allocate(total: number, weights: number[]): number[] {
  const sumW = weights.reduce((s, w) => s + w, 0)
  if (sumW === 0 || weights.length === 0) return weights.map((_, i) => (i === 0 ? total : 0))
  const parts = weights.map((w) => mulDiv(total, w, sumW))
  let diff = total - parts.reduce((s, p) => s + p, 0)
  const order = weights.map((w, i) => ({ i, w: Math.abs(w) })).sort((x, y) => y.w - x.w)
  const step = diff > 0 ? 1 : -1
  for (let k = 0; diff !== 0; k = (k + 1) % order.length) {
    parts[order[k]!.i]! += step
    diff -= step
  }
  return parts
}

export const normKey = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ')
