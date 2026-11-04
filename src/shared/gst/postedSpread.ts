// PR #190 review: a return note made from the running total (shared/simple/intents.ts
// runningReturnTax) posts each GST head a paisa or so away from what its lines compute one by one,
// so GSTR-1 / 3B recomputing the lines would disagree with the books (and the 9 × ₹1.11 less
// ₹0.05 case even went a paisa below zero over the bill + its returns). The returns report the
// POSTED head instead, spread over the note's lines so each line's share stays its own computed
// tax ± the difference: largest remainder by the lines' computed tax (by their taxable value when
// none computes any), never below zero. Pure — no DB.

/** Spread `target` (the posted head, paise, ≥ 0) over lines whose own computation gave
 *  `computed`; `weights` break the split when the computed tax is all zero. Returns one share per
 *  line, adding up to `target` exactly, none negative. */
export function spreadPosted(computed: readonly number[], target: number, weights: readonly number[] = computed): number[] {
  const sum = computed.reduce((s, x) => s + x, 0)
  if (sum === target || computed.length === 0) return [...computed]
  const w = computed.some((x) => x > 0) ? computed : weights.some((x) => x > 0) ? weights : computed.map(() => 1)
  const W = w.reduce((s, x) => s + Math.max(0, x), 0)
  const diff = target - sum
  const sign = diff > 0 ? 1 : -1
  const abs = Math.abs(diff)
  const out = [...computed]
  // Whole shares first, then one paisa each by the largest remainder (ties: the earlier line).
  const shares = w.map((x, i) => {
    const exact = (abs * Math.max(0, x)) / W
    return { i, whole: Math.floor(exact), rem: exact - Math.floor(exact) }
  })
  let left = abs
  for (const s of shares) {
    const take = sign < 0 ? Math.min(s.whole, out[s.i]!) : s.whole
    out[s.i]! += sign * take
    left -= take
  }
  const order = [...shares].sort((a, b) => b.rem - a.rem || a.i - b.i)
  // Taking away never makes a line negative: lines with nothing left are skipped.
  for (let guard = 0; left > 0 && guard < 4 * out.length + abs; guard++) {
    for (const s of order) {
      if (left === 0) break
      if (sign < 0 && out[s.i]! <= 0) continue
      out[s.i]! += sign
      left--
    }
  }
  return out
}
