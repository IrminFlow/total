// Typed quantities → integer thousandths (qtyMilli). ONE reader for every editor (bug hunt
// 2026-11: the accountant editors used parseFloat, so "1,500" was read as 1). Pure, no floats:
// digit grouping is Indian or western ("1,50,000" / "150,000" — groups of 2 or 3 after a first group
// of 1–3, as simple mode's readQty), decimals beyond the third round half-up on the digits.

const QTY_RE = /^(\d{1,3}(?:,\d{2,3})+|\d*)(?:\.(\d*))?$/

/** "1,500" → 1_500_000; "2.5" → 2_500; "0" → 0. Null for blank text, junk, a negative or a value past
 *  the safe-integer range. 0 is returned (a count); callers that need a positive quantity check it. */
export function parseQtyText(text: string | null | undefined): number | null {
  const t = (text ?? '').trim()
  const m = QTY_RE.exec(t)
  if (!m) return null
  const whole = m[1]!.replace(/,/g, '')
  const frac = m[2] ?? ''
  if (whole === '' && frac === '') return null
  let milli = BigInt(whole || '0') * 1000n + BigInt((frac.slice(0, 3) || '0').padEnd(3, '0'))
  if (frac.length > 3 && frac.charCodeAt(3) >= 53 /* '5' */) milli += 1n
  return milli <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(milli) : null
}
