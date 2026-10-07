import type { EdocInvoice } from '../gst/edocs'
import { computeGst } from '../gst/calc'

/** One aggregated row of a printed invoice's tax summary. */
export interface TaxSummaryRow {
  /** '' for lines whose item has no HSN (and always '' for a by-rate summary). */
  hsn: string
  rate: number
  cessRate: number
  qtyMilli: number
  taxable: number
  cgst: number
  sgst: number
  igst: number
  cess: number
}

/**
 * Tax summary for one invoice, by (hsn, rate, cess) — the HSN-wise block (task Q2 #96) — or by
 * (rate, cess) only. Aggregates taxable value per bucket FIRST and runs computeGst ONCE per
 * aggregate (portal semantics, mirrors the GSTR-1 HSN table's bucket-then-round path), so the
 * printed block agrees with the filed table. The 'hsn' mode is exactly the old
 * hsnSummaryForInvoice (same buckets, same sort).
 *
 * `supplyHint` should be passed when known; the `igst > 0` fallback misclassifies an inter-state
 * invoice whose lines are all 0%/exempt.
 */
export function taxSummaryForInvoice(
  inv: EdocInvoice,
  by: 'hsn' | 'rate' = 'hsn',
  supplyHint?: 'inter' | 'intra'
): TaxSummaryRow[] {
  const supply: 'inter' | 'intra' = supplyHint ?? (inv.igst > 0 ? 'inter' : 'intra')
  const buckets = new Map<string, { hsn: string; rate: number; cessRate: number; qtyMilli: number; taxable: number }>()
  for (const item of inv.items) {
    const hsn = by === 'hsn' ? (item.hsn ?? '') : ''
    const key = `${hsn}|${item.rate}|${item.cessRate}`
    const bucket = buckets.get(key) ?? { hsn, rate: item.rate, cessRate: item.cessRate, qtyMilli: 0, taxable: 0 }
    bucket.qtyMilli += item.qtyMilli
    bucket.taxable += item.taxablePaise
    buckets.set(key, bucket)
  }
  return [...buckets.values()]
    // Same comparator as the old HSN block (stable sort: equal hsn+rate keep first-seen order).
    .sort((a, b) => (a.hsn === b.hsn ? a.rate - b.rate : a.hsn < b.hsn ? -1 : 1))
    .map((b) => {
      const g = computeGst(b.taxable, b.rate, supply, b.cessRate)
      return { hsn: b.hsn, rate: b.rate, cessRate: b.cessRate, qtyMilli: b.qtyMilli, taxable: b.taxable, cgst: g.cgst, sgst: g.sgst, igst: g.igst, cess: g.cess }
    })
}
