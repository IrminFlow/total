/**
 * GST on the sale of a capital good on which input tax credit was taken — CGST Act s.18(6) with
 * CGST Rules rule 40(2) and rule 44(6) (texts quoted in ./fixedAssetSources.ts, keys CGST-S18-6,
 * CGST-R40-2, CGST-R44-6; the readings the law leaves open are in FIXED_ASSET_UNVERIFIED).
 *
 * s.18(6): pay "an amount equal to the input tax credit taken on the said capital goods … reduced
 * by such percentage points as may be prescribed or the tax on the transaction value … whichever
 * is higher". Two rules prescribe the reduction and they differ, so BOTH are computed:
 *  - rule 40(2): the input tax reduced by five percentage points for every quarter or part
 *    thereof from the date of the invoice;
 *  - rule 44(6) with 44(1)(b): the credit "involved in the remaining useful life in months …
 *    pro-rata basis, taking the useful life as five years", per tax head separately — the
 *    remaining life in WHOLE months, "ignoring a part of the month" (the rule's own illustration:
 *    4 years 6 months 15 days used ⇒ 5 months remain ⇒ C × 5/60).
 * The higher of the two readings is the credit-based amount (the reading that pays no less than
 * either rule asks — UNVERIFIED 'cg-two-rules'). The tax on the transaction value goes on the tax
 * invoice; when the credit-based amount is higher, rule 44(6)'s proviso makes the difference
 * "part of the output tax liability" — the EXCESS, paid under the supply's own tax heads.
 *
 * Pure: integer paise, BigInt-exact rounding (half away from zero), no I/O.
 */
import { addMonths, mulDivRound } from './depreciation'

export interface TaxHeads {
  igst: number
  cgst: number
  sgst: number
  cess: number
}

export const ZERO_TAX_HEADS: TaxHeads = { igst: 0, cgst: 0, sgst: 0, cess: 0 }
const HEADS = ['igst', 'cgst', 'sgst', 'cess'] as const
/** GST heads without cess (the s.18(6) comparison is on these; cess is compared on its own). */
export const gstTotal = (h: TaxHeads): number => h.igst + h.cgst + h.sgst
export const headsTotal = (h: TaxHeads): number => gstTotal(h) + h.cess

/** Five years (rule 44(1)(b)). */
export const CAPITAL_GOODS_LIFE_MONTHS = 60
/** Five percentage points (rule 40(2)), in basis points. */
export const POINTS_PER_QUARTER_BP = 500

/** Quarters "or part thereof" from the invoice date to the supply date: the number of three-month
 *  periods starting on the invoice date needed to reach the supply date (a supply on the invoice
 *  date itself is in the first quarter → 1). UNVERIFIED 'cg-quarters'. */
export function quartersOrPart(invoiceDate: string, supplyDate: string): number {
  if (supplyDate < invoiceDate) throw new Error('The sale is dated before the purchase invoice')
  let q = 1
  while (addMonths(invoiceDate, 3 * q) <= supplyDate) q++
  return q
}

/** Whole months from the invoice date to the supply date. */
export function wholeMonthsUsed(invoiceDate: string, supplyDate: string): number {
  if (supplyDate < invoiceDate) throw new Error('The sale is dated before the purchase invoice')
  let m = 0
  while (addMonths(invoiceDate, m + 1) <= supplyDate) m++
  return m
}

/** Months used for rule 44(1)(b): a part of a month counts as used, so the REMAINING life is the
 *  whole months left "ignoring a part of the month" (the illustration under rule 44(1)(b): in use
 *  4 years, 6 months and 15 days ⇒ remaining life 5 months, not 6). */
export function monthsUsedOrPart(invoiceDate: string, supplyDate: string): number {
  const whole = wholeMonthsUsed(invoiceDate, supplyDate)
  return addMonths(invoiceDate, whole) < supplyDate ? whole + 1 : whole
}

const scale = (h: TaxHeads, num: number, den: number): TaxHeads => ({
  igst: mulDivRound(h.igst, num, den), cgst: mulDivRound(h.cgst, num, den),
  sgst: mulDivRound(h.sgst, num, den), cess: mulDivRound(h.cess, num, den)
})

export interface CapitalGoodsSaleWorking {
  invoiceDate: string
  supplyDate: string
  /** Credit taken on the goods, per head. */
  itc: TaxHeads
  /** Tax on the transaction value (what the invoice charges), per head. */
  taxOnValue: TaxHeads
  rule40: { quarters: number; reductionBp: number; heads: TaxHeads }
  /** monthsUsed counts a part month as used (rule 44(1)(b) illustration). */
  rule44: { monthsUsed: number; remainingMonths: number; heads: TaxHeads }
  /** The higher of the two credit-based readings (by GST total; cess by its own). */
  creditBased: TaxHeads
  /** The s.18(6) amount: the higher of the credit-based amount and the tax on the value. */
  payable: TaxHeads
  /** payable − taxOnValue: output tax paid beyond the invoice (rule 44(6) proviso), in the
   *  supply's heads (intra-State CGST + SGST, inter-State IGST; cess as cess). */
  excess: TaxHeads
  /** s.18(6) proviso (refractory bricks, moulds and dies, jigs and fixtures supplied as scrap):
   *  the tax on the transaction value only. */
  scrapProviso: boolean
}

/**
 * The s.18(6) working. `supply` decides the heads the excess is paid in. With no credit taken the
 * working is the ordinary tax on the value (excess 0).
 */
export function capitalGoodsSale(input: {
  itc: TaxHeads
  invoiceDate: string
  supplyDate: string
  taxOnValue: TaxHeads
  supply: 'intra' | 'inter'
  scrapProviso?: boolean
}): CapitalGoodsSaleWorking {
  const quarters = quartersOrPart(input.invoiceDate, input.supplyDate)
  const reductionBp = Math.min(10_000, quarters * POINTS_PER_QUARTER_BP)
  const r40 = scale(input.itc, 10_000 - reductionBp, 10_000)
  const monthsUsed = monthsUsedOrPart(input.invoiceDate, input.supplyDate)
  const remainingMonths = Math.max(0, CAPITAL_GOODS_LIFE_MONTHS - monthsUsed)
  const r44 = scale(input.itc, remainingMonths, CAPITAL_GOODS_LIFE_MONTHS)
  const gstPick = gstTotal(r44) >= gstTotal(r40) ? r44 : r40
  const creditBased: TaxHeads = { igst: gstPick.igst, cgst: gstPick.cgst, sgst: gstPick.sgst, cess: Math.max(r40.cess, r44.cess) }
  const tv = input.taxOnValue
  const proviso = !!input.scrapProviso
  const gstExcess = proviso ? 0 : Math.max(0, gstTotal(creditBased) - gstTotal(tv))
  const cessExcess = proviso ? 0 : Math.max(0, creditBased.cess - tv.cess)
  const excess: TaxHeads =
    input.supply === 'inter'
      ? { igst: gstExcess, cgst: 0, sgst: 0, cess: cessExcess }
      : { igst: 0, cgst: gstExcess - Math.floor(gstExcess / 2), sgst: Math.floor(gstExcess / 2), cess: cessExcess }
  const payable = Object.fromEntries(HEADS.map((k) => [k, tv[k] + excess[k]])) as unknown as TaxHeads
  return {
    invoiceDate: input.invoiceDate, supplyDate: input.supplyDate, itc: input.itc, taxOnValue: tv,
    rule40: { quarters, reductionBp, heads: r40 },
    rule44: { monthsUsed, remainingMonths, heads: r44 },
    creditBased, payable, excess, scrapProviso: proviso
  }
}

const rupees = (p: number): string => {
  const neg = p < 0
  const a = Math.abs(p)
  return `${neg ? '-' : ''}₹${Math.floor(a / 100).toLocaleString('en-IN')}.${String(a % 100).padStart(2, '0')}`
}

/** One line for the voucher narration / the preview: the figures and which one was paid. */
export function capitalGoodsWorkingText(w: CapitalGoodsSaleWorking): string {
  if (headsTotal(w.itc) === 0) return `GST on the value ${rupees(headsTotal(w.taxOnValue))} (no input tax credit on the goods)`
  const parts = [
    `s.18(6) CGST Act: ITC ${rupees(headsTotal(w.itc))}`,
    `rule 40(2) ${w.rule40.quarters} quarter${w.rule40.quarters === 1 ? '' : 's'} → less ${w.rule40.reductionBp / 100} points = ${rupees(headsTotal(w.rule40.heads))}`,
    `rule 44(6) ${w.rule44.remainingMonths}/60 months left = ${rupees(headsTotal(w.rule44.heads))}`,
    `tax on the value ${rupees(headsTotal(w.taxOnValue))}`
  ]
  const excess = headsTotal(w.excess)
  parts.push(w.scrapProviso ? 'scrap proviso: tax on the value only' : excess > 0 ? `higher = ${rupees(headsTotal(w.payable))} (extra output tax ${rupees(excess)})` : 'tax on the value is the higher')
  return parts.join('; ')
}
