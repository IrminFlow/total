/**
 * Splitting a voucher line across cost centres by percentage (#41).
 *
 * "Rent is 40% Mumbai, 35% Pune, 25% head office" is how the allocation is decided, and until now
 * it had to be typed as three amounts. That works until the rent changes: the percentages are the
 * durable fact, the amounts are derived from them, and re-deriving three figures by hand every
 * month is where the rounding goes wrong.
 *
 * It goes wrong in a specific way. 40% of ₹1,00,000.33 is ₹40,000.132 — thirteen and a fifth
 * paise. Round each share independently and the three shares sum to a paisa less (or more) than
 * the line, and the voucher will not save. Somebody then nudges one share by a paisa, and the
 * allocation no longer means what it says.
 *
 * So the split is done once, over the whole line, by the largest-remainder method: every share
 * gets its floor, and the leftover paise go one each to the shares with the largest discarded
 * fraction. The parts sum to the total exactly, by construction, and the share that gets the
 * extra paisa is the one that came closest to earning it.
 *
 * Percentages are integer BASIS POINTS (40% = 4000). A percentage stored as a float would
 * reintroduce, one layer up, exactly the imprecision this is here to avoid.
 */

/** 100% in basis points. */
export const FULL_BPS = 10_000

/**
 * Split `total` paise across shares given in basis points.
 *
 * The shares need not add to 100%: a partial allocation is a legitimate intermediate state while
 * somebody is still typing, and this returns what those percentages are worth rather than
 * refusing. `allocationComplete` is the separate question of whether it adds up.
 *
 * A negative total splits the same way — a credit line is allocated exactly as a debit one is.
 */
export function splitByPercent(total: number, bps: number[]): number[] {
  if (bps.length === 0) return []

  // Work on the magnitude and put the sign back at the end: flooring a negative rounds away from
  // zero, which would hand the remainder to the wrong shares.
  const sign = total < 0 ? -1 : 1
  const magnitude = Math.abs(total)

  const exact = bps.map((bp) => (magnitude * bp) / FULL_BPS)
  const floors = exact.map((v) => Math.floor(v))
  const assigned = floors.reduce((s, v) => s + v, 0)
  // What the percentages are worth in whole paise, before the remainder is handed out.
  const target = Math.floor((magnitude * bps.reduce((s, b) => s + b, 0)) / FULL_BPS)
  let remainder = target - assigned

  // Largest discarded fraction first; ties go to the earlier row, so the same input always
  // produces the same output and re-opening the modal cannot reshuffle the paise.
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => (b.frac - a.frac) || (a.i - b.i))

  const out = [...floors]
  for (const { i } of order) {
    if (remainder <= 0) break
    out[i]! += 1
    remainder -= 1
  }
  return out.map((v) => v * sign)
}

/** Sum of the shares, in basis points. */
export function totalBps(bps: number[]): number {
  return bps.reduce((s, b) => s + b, 0)
}

/** True when the percentages account for the whole line and nothing more. */
export function allocationComplete(bps: number[]): boolean {
  return totalBps(bps) === FULL_BPS
}

/**
 * An amount expressed as a share of the line, in basis points — for switching the modal from
 * amounts to percentages without changing what is allocated.
 *
 * Rounded to the nearest basis point, so switching back and forth can move a share by up to half
 * a basis point of the line. That is a paisa on a ₹2,000 line and the modal says so; the
 * alternative, refusing to convert an amount that is not a whole percentage, would make the
 * toggle useless on exactly the allocations people have already typed.
 */
export function bpsOfAmount(amount: number, total: number): number {
  if (total === 0) return 0
  return Math.round((amount * FULL_BPS) / total)
}

/** '40.5%' — trailing zeroes trimmed, because most splits are whole percentages. */
export function formatBps(bp: number): string {
  const text = (bp / 100).toFixed(2).replace(/\.?0+$/, '')
  return `${text === '' ? '0' : text}%`
}

/**
 * Read a typed percentage into basis points, or null.
 *
 * Two decimal places is the limit: a hundredth of a percent of a lakh is a rupee, and nobody
 * allocates overheads to a finer grain than that. Anything else returns null and the field shows
 * the same inline error an unparseable amount does.
 */
export function parsePercent(input: string): number | null {
  const text = input.trim().replace(/%$/, '').trim()
  if (text === '') return null
  if (!/^-?\d{0,3}(\.\d{1,2})?$/.test(text)) return null
  const value = Number(text)
  if (!Number.isFinite(value) || value < 0 || value > 100) return null
  return Math.round(value * 100)
}
