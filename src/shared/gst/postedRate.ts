// A ledger-line (amount-only / accounting-mode) sales document has no item master to carry its GST
// rate, and its sales ledger may carry none either. When the voucher POSTS tax lines, the books are
// the truth: the rate is what the posted tax implies. The ledger's rate is only the fallback when no
// tax line is posted (the existing behaviour, unchanged). Pure — no DB.
import { computeGst, type SupplyType } from './calc'
import { slabsOn } from './rateTable'

export interface PostedRateLine {
  taxable: number
  /** The rate the master gives (percent); 0 when the ledger carries none. */
  rate: number
}

export interface PostedRates {
  /** One rate per input line, same order (percent). */
  rates: number[]
  /** The rate-less lines were given a rate from the posted tax. */
  derived: boolean
  /** The posted tax matched no slab of the voucher's date: the rate is the implied one (a warning). */
  offSlab: boolean
}

const gstOf = (g: { cgst: number; sgst: number; igst: number }): number => g.cgst + g.sgst + g.igst

/**
 * `postedGst` = the NET CGST + SGST + IGST the voucher posts on the tax side (paise, cess excluded).
 * Lines whose ledger has a rate keep it; the tax they explain is taken off the posted total and the
 * remainder is the rate of the rate-less lines — a known slab (computed tax equal to the remainder
 * within the rounding of the lines), else the implied rate with `offSlab` set.
 */
export function resolvePostedRates(lines: PostedRateLine[], postedGst: number, supply: SupplyType, date: string): PostedRates {
  const same: PostedRates = { rates: lines.map((l) => l.rate), derived: false, offSlab: false }
  if (postedGst <= 0) return same
  const bare = lines.filter((l) => l.rate === 0 && l.taxable > 0)
  if (bare.length === 0) return same
  const explained = lines.reduce((s, l) => s + (l.rate > 0 ? gstOf(computeGst(l.taxable, l.rate, supply)) : 0), 0)
  const rest = postedGst - explained
  // A remainder within the lines' own rounding is not a rate (a bare income line beside taxed ones).
  if (rest <= lines.length) return same
  const bareTaxable = bare.reduce((s, l) => s + l.taxable, 0)
  const taxFor = (rate: number): number => bare.reduce((s, l) => s + gstOf(computeGst(l.taxable, rate, supply)), 0)
  let best: { rate: number; diff: number } | null = null
  for (const s of slabsOn(date)) {
    if (s.rate <= 0) continue
    const diff = Math.abs(taxFor(s.rate) - rest)
    if (diff <= bare.length && (best == null || diff < best.diff)) best = { rate: s.rate, diff }
  }
  const offSlab = best == null
  // Implied percent, 4 decimals (basis-point precision is 2; this only matters for the warning case).
  const rate = best ? best.rate : Math.round((rest * 1_000_000) / bareTaxable) / 10_000
  return { rates: lines.map((l) => (l.rate === 0 && l.taxable > 0 ? rate : l.rate)), derived: true, offSlab }
}
