/**
 * Small exact integer helpers shared by the forex maths and the cash-flow forecast (they lived in
 * loanSchedule.ts, removed with the loan schedules; unchanged).
 */

/** a × b / d for integers, rounded half away from zero — exact via BigInt (any signs, d ≠ 0). */
export function mulDivRound(a: number, b: number, d: number): number {
  if (d === 0) throw new Error('Division by zero')
  const neg = (a < 0) !== (b < 0) !== (d < 0)
  const n = BigInt(Math.abs(Math.round(a))) * BigInt(Math.abs(Math.round(b)))
  const den = BigInt(Math.abs(Math.round(d)))
  const q = Number((n * 2n + den) / (den * 2n))
  return neg && q !== 0 ? -q : q
}

/** `firstDueDate`'s day-of-month, `k` months on, clamped to the month's length. */
export function instalmentDate(firstDueDate: string, k: number): string {
  const [y, m, d] = firstDueDate.split('-').map(Number) as [number, number, number]
  const idx = y * 12 + (m - 1) + k
  const yy = Math.floor(idx / 12)
  const mm = (idx % 12) + 1
  const last = new Date(Date.UTC(yy, mm, 0)).getUTCDate()
  return `${yy}-${String(mm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`
}
