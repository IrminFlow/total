/** WP 6.5 — ageing of an inter-company balance: the balance is attributed to the most recent
 *  movements on its own side (first in, first out), bucketed by days before the as-on date. */

export const AGEING_BUCKETS = ['0–30', '31–60', '61–90', '91–180', '> 180'] as const
const LIMITS = [30, 60, 90, 180]

const days = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)

/** `movements`: dated dr-positive amounts (the opening balance dated at the books' start). Returns
 *  signed amounts per bucket that add up to the balance. */
export function ageBalance(movements: { date: string; amount: number }[], asOn: string): number[] {
  const out = AGEING_BUCKETS.map(() => 0)
  const upto = movements.filter((m) => m.date <= asOn)
  const balance = upto.reduce((s, m) => s + m.amount, 0)
  if (balance === 0) return out
  const sign = balance > 0 ? 1 : -1
  let left = Math.abs(balance)
  const same = upto.filter((m) => Math.sign(m.amount) === sign).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  for (const m of same) {
    if (left === 0) break
    const take = Math.min(left, Math.abs(m.amount))
    const d = days(m.date, asOn)
    const idx = LIMITS.findIndex((lim) => d <= lim)
    out[idx === -1 ? LIMITS.length : idx]! += sign * take
    left -= take
  }
  if (left > 0) out[LIMITS.length]! += sign * left
  return out
}
