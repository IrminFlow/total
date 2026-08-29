/**
 * What a business's aggregate annual turnover obliges it to do.
 *
 * Almost every threshold in GST is a turnover threshold, and the app knew none of them. It
 * accepted a 4-digit HSN from a ₹50-crore business (rule 46 wants 6), let anyone pick QRMP
 * (capped at ₹5 crore), and never mentioned that e-invoicing is mandatory above ₹5 crore -- so a
 * business over the line could issue B2B invoices for a year with no IRN and only find out when
 * their buyers' input credit was denied.
 *
 * One declared number answers all of it. It is declared rather than computed from the books
 * because the statutory figure is *aggregate* turnover across every GSTIN on the same PAN,
 * including exempt supplies and the part of the year before these books start -- none of which
 * one company file can see. Guessing it from `turnover()` would be confidently wrong for exactly
 * the multi-registration businesses the thresholds are aimed at.
 *
 * Thresholds are in paise, named, and dated in comments, because they have moved repeatedly (the
 * e-invoice threshold came down ₹500cr → ₹100cr → ₹50cr → ₹20cr → ₹10cr → ₹5cr in five years)
 * and will move again.
 */

export const CRORE = 100_00_00_000 // ₹1 crore in paise
const LAKH = 100_00_000 // ₹1 lakh in paise

/** E-invoicing (IRN) is mandatory above this, for B2B supplies. ₹5 crore since 1 Aug 2023. */
export const EINVOICE_THRESHOLD_PAISE = 5 * CRORE

/** QRMP -- quarterly returns with monthly payment -- is available up to this. ₹5 crore. */
export const QRMP_CEILING_PAISE = 5 * CRORE

/** Above this, rule 46 requires 6-digit HSN on every line; at or below it 4 digits suffice. */
export const HSN_SIX_DIGIT_THRESHOLD_PAISE = 5 * CRORE

/** Composition ceilings: goods (and restaurants) vs the separate service-provider scheme. */
export const COMPOSITION_CEILING_GOODS_PAISE = 150 * LAKH // ₹1.5 crore
export const COMPOSITION_CEILING_SERVICE_PAISE = 50 * LAKH // ₹50 lakh

/**
 * Turnover bands, coarse enough that a business can pick one honestly without disclosing a
 * figure it has not closed its books on. `fromPaise` is inclusive, `toPaise` exclusive.
 */
export const TURNOVER_BANDS = [
  { id: 'upto-50L', label: 'Up to ₹50 lakh', fromPaise: 0, toPaise: 50 * LAKH },
  { id: '50L-1.5Cr', label: '₹50 lakh to ₹1.5 crore', fromPaise: 50 * LAKH, toPaise: 150 * LAKH },
  { id: '1.5Cr-5Cr', label: '₹1.5 crore to ₹5 crore', fromPaise: 150 * LAKH, toPaise: 5 * CRORE },
  { id: '5Cr-10Cr', label: '₹5 crore to ₹10 crore', fromPaise: 5 * CRORE, toPaise: 10 * CRORE },
  // The top band exists because section 206C(1H) keys off ₹10 crore. Without a boundary there,
  // no band could express "above it", and the TCS check could never fire for anyone.
  { id: '10Cr-plus', label: 'Over ₹10 crore', fromPaise: 10 * CRORE, toPaise: null }
] as const

export type TurnoverBand = (typeof TURNOVER_BANDS)[number]['id']

/**
 * The turnover a band implies for threshold tests: its lower bound.
 *
 * Using the lower bound is the conservative reading in one direction and not the other, so it is
 * chosen deliberately: a business in '1.5Cr-5Cr' is treated as ₹1.5 crore, which keeps it under
 * the ₹5 crore e-invoice line. That is correct -- the band's whole range is under it. The band
 * boundaries are placed *on* the thresholds precisely so that no band straddles one, and every
 * test below is therefore exact rather than approximate.
 */
export function bandFloorPaise(band: TurnoverBand): number {
  return TURNOVER_BANDS.find((b) => b.id === band)?.fromPaise ?? 0
}

/** The band a known figure falls in. */
export function bandOf(turnoverPaise: number): TurnoverBand {
  for (const b of TURNOVER_BANDS) {
    if (turnoverPaise >= b.fromPaise && (b.toPaise === null || turnoverPaise < b.toPaise)) return b.id
  }
  return 'upto-50L'
}

/** E-invoicing mandatory? Undeclared turnover answers false -- an unprompted warning about a
 *  threshold the user never told us about is noise. */
export function eInvoiceMandatory(band: TurnoverBand | null): boolean {
  return band !== null && bandFloorPaise(band) >= EINVOICE_THRESHOLD_PAISE
}

/** May this business file quarterly under QRMP? */
export function qrmpEligible(band: TurnoverBand | null): boolean {
  return band === null || bandFloorPaise(band) < QRMP_CEILING_PAISE
}

/** Minimum HSN digits rule 46 requires on an invoice line. */
export function minHsnDigits(band: TurnoverBand | null): 4 | 6 {
  return band !== null && bandFloorPaise(band) >= HSN_SIX_DIGIT_THRESHOLD_PAISE ? 6 : 4
}

/**
 * May this business be in the composition scheme?
 *
 * The service-provider scheme (section 10(2A), 6%) has its own much lower ceiling, so the answer
 * depends on which category the dealer is in.
 */
export function compositionEligible(
  band: TurnoverBand | null,
  category: 'trader' | 'restaurant' | 'service'
): boolean {
  if (band === null) return true
  const ceiling =
    category === 'service' ? COMPOSITION_CEILING_SERVICE_PAISE : COMPOSITION_CEILING_GOODS_PAISE
  // A band is eligible only if its whole range sits under the ceiling: a business in
  // '50L-1.5Cr' might be at ₹1.4 crore, which is fine for goods and far over the service cap.
  const band_ = TURNOVER_BANDS.find((b) => b.id === band)!
  return band_.toPaise !== null && band_.toPaise <= ceiling
}

export interface TurnoverObligations {
  band: TurnoverBand | null
  eInvoice: boolean
  qrmp: boolean
  minHsnDigits: 4 | 6
}

/** Everything the declared band implies, for a settings screen to state in one place. */
export function turnoverObligations(band: TurnoverBand | null): TurnoverObligations {
  return {
    band,
    eInvoice: eInvoiceMandatory(band),
    qrmp: qrmpEligible(band),
    minHsnDigits: minHsnDigits(band)
  }
}
