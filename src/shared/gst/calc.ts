import { percentOf } from '../money'

export type SupplyType = 'intra' | 'inter'

export interface GstBreakup {
  taxable: number
  cgst: number
  sgst: number
  igst: number
  cess: number
  total: number
}

/**
 * Split a GST rate across components for a supply.
 * Intra-state: CGST + SGST at half rate each. Inter-state: IGST at full rate.
 * Amounts in paise, rounded half away from zero per component (portal convention:
 * tax amounts reported to 2 decimals).
 */
export function computeGst(
  taxablePaise: number,
  ratePercent: number,
  supply: SupplyType,
  cessPercent = 0
): GstBreakup {
  const cess = cessPercent ? percentOf(taxablePaise, cessPercent) : 0
  if (supply === 'inter') {
    const igst = percentOf(taxablePaise, ratePercent)
    return { taxable: taxablePaise, cgst: 0, sgst: 0, igst, cess, total: taxablePaise + igst + cess }
  }
  const half = percentOf(taxablePaise, ratePercent / 2)
  return {
    taxable: taxablePaise,
    cgst: half,
    sgst: half,
    igst: 0,
    cess,
    total: taxablePaise + half * 2 + cess
  }
}

/** Determine supply type from the company's state and the place of supply. */
export function supplyTypeFor(companyState: string, placeOfSupply: string): SupplyType {
  return companyState === placeOfSupply ? 'intra' : 'inter'
}

export function addBreakups(items: GstBreakup[]): GstBreakup {
  return items.reduce(
    (acc, b) => ({
      taxable: acc.taxable + b.taxable,
      cgst: acc.cgst + b.cgst,
      sgst: acc.sgst + b.sgst,
      igst: acc.igst + b.igst,
      cess: acc.cess + b.cess,
      total: acc.total + b.total
    }),
    { taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0, total: 0 }
  )
}
