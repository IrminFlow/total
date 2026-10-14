// A ledger-line (amount-only / accounting-mode) sales document has no item master to carry its GST
// rate, and its sales ledger may carry none either. When the voucher POSTS tax lines, the books are
// the truth: the rate is what the posted tax implies. The ledger's rate is only the fallback when no
// tax line is posted (the existing behaviour, unchanged). Pure — no DB.
import { computeGst, type SupplyType } from './calc'
import { GST_RATE_TABLE, slabsOn, type GstSlab } from './rateTable'

export interface PostedRateLine {
  taxable: number
  /** The ledger master's rate (percent); null = the ledger carries none. An explicit 0 is a
   *  declared nil-rated / exempt line and is never given a rate from the posted tax. */
  rate: number | null
}

export interface PostedRates {
  /** One rate per input line, same order (percent; a rate-less line that took none = 0). */
  rates: number[]
  /** The rate-less lines were given a rate from the posted tax. */
  derived: boolean
  /** The posted tax matched no slab (of the voucher's date, or of any earlier / later period): the
   *  rate is the implied one (a warning). */
  offSlab: boolean
}

/** Rounding the posted tax may carry beyond the per-line rounding: books whose tax ledgers round
 *  to the rupee (Tally's "rounding limit 1") post up to 50 paise off per head — ₹1 for CGST + SGST,
 *  the same ±₹1 the GSTR-1 value check (validate.ts VAL_MISMATCH_TOLERANCE_PAISE) accepts. */
export const POSTED_TAX_ROUNDING_PAISE = 100

/** A line under ₹1 beside bigger ones is a round-off, not a supply (round off is < ₹1 by design). */
const ROUND_OFF_SIZE_PAISE = 100

/** Every slab any period of rateTable.ts lists: a credit / debit note follows its ORIGINAL bill's
 *  rate (12 % / 28 % on a pre-22-Sep-2025 bill), and services' rates after 2025 are UNVERIFIED there. */
const ANY_PERIOD_SLABS: readonly GstSlab[] = (() => {
  const seen = new Map<number, GstSlab>()
  for (const p of GST_RATE_TABLE) for (const s of p.slabs) if (!seen.has(s.rate)) seen.set(s.rate, s)
  return [...seen.values()]
})()

const gstOf = (g: { cgst: number; sgst: number; igst: number }): number => g.cgst + g.sgst + g.igst

/** rest / taxable as a percent with 4 decimals, half-up, exact (BigInt — no float overflow). */
function impliedRate(rest: number, taxable: number): number {
  const num = 2n * BigInt(rest) * 1_000_000n + BigInt(taxable)
  return Number(num / (2n * BigInt(taxable))) / 10_000
}

/**
 * `postedGst` = the NET CGST + SGST + IGST the voucher posts on the tax side (paise, cess excluded).
 * Lines whose ledger has a rate (0 included) keep it; the tax they explain is taken off the posted
 * total and the remainder is the rate of the rate-less lines (sub-rupee round-off lines beside
 * bigger ones left out) — the nearest slab whose tax is within the rounding of the lines and of the
 * posted tax (the voucher date's slabs first, then any period's), else the implied rate with
 * `offSlab` set. Several rate-less lines at different true rates get ONE blended rate (the posted
 * tax cannot be attributed per line) — flagged when it fits no slab.
 */
export function resolvePostedRates(lines: PostedRateLine[], postedGst: number, supply: SupplyType, date: string): PostedRates {
  const same: PostedRates = { rates: lines.map((l) => l.rate ?? 0), derived: false, offSlab: false }
  if (postedGst <= 0) return same
  const bare = lines.flatMap((l, i) => (l.rate == null && l.taxable > 0 ? [i] : []))
  if (bare.length === 0) return same
  const explained = lines.reduce((s, l) => s + (l.rate != null && l.rate > 0 ? gstOf(computeGst(l.taxable, l.rate, supply)) : 0), 0)
  const rest = postedGst - explained
  const tolerance = lines.length + POSTED_TAX_ROUNDING_PAISE
  // Nothing left, or (beside rated lines) only their rounding: not a rate.
  if (rest <= 0 || (explained > 0 && rest <= tolerance)) return same
  const big = bare.filter((i) => lines[i]!.taxable >= ROUND_OFF_SIZE_PAISE)
  const target = new Set(big.length > 0 ? big : bare)
  const taxFor = (rate: number): number => [...target].reduce((s, i) => s + gstOf(computeGst(lines[i]!.taxable, rate, supply)), 0)
  const nearest = (slabs: readonly GstSlab[]): number | null => {
    let best: { rate: number; diff: number } | null = null
    for (const s of slabs) {
      if (s.rate <= 0) continue
      const diff = Math.abs(taxFor(s.rate) - rest)
      if (diff <= tolerance && (best == null || diff < best.diff)) best = { rate: s.rate, diff }
    }
    return best?.rate ?? null
  }
  const slab = nearest(slabsOn(date)) ?? nearest(ANY_PERIOD_SLABS)
  const targetTaxable = [...target].reduce((s, i) => s + lines[i]!.taxable, 0)
  const rate = slab ?? impliedRate(rest, targetTaxable)
  return { rates: lines.map((l, i) => (target.has(i) ? rate : (l.rate ?? 0))), derived: true, offSlab: slab == null }
}
