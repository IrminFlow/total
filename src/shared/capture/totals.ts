// WP 5.4 — the app recomputes a captured bill from its lines; the model never computes. Pure,
// integer paise. Each line's taxable value is qty × rate − discount (half away from zero, the
// invoice grid's own rounding) unless only the printed taxable value is legible; tax comes from
// the printed per-line tax, else the printed tax summary. The recomputed total is compared with
// the printed one — any difference (and a line whose printed taxable value disagrees with
// qty × rate − discount) is a discrepancy shown to the user, never silently corrected.
import { formatPaise } from '../money'
import type { ParsedBill } from './parse'

export interface BillTotals {
  taxable: number
  cgst: number
  sgst: number
  igst: number
  cess: number
  /** cgst + sgst + igst + cess as printed. */
  tax: number
  roundOff: number
  /** taxable + tax + roundOff. */
  computedTotal: number
  printedTotal: number | null
  /** Per line: the taxable value used (null = the line has none). */
  lineTaxable: (number | null)[]
  discrepancies: string[]
}

const rs = (p: number): string => formatPaise(p, { symbol: true })

/** Half away from zero, like money.ts roundPaise — integer maths only. */
function lineGross(qtyMilli: number, ratePaise: number): number {
  const n = qtyMilli * ratePaise
  return n >= 0 ? Math.floor((n + 500) / 1000) : -Math.floor((-n + 500) / 1000)
}

export function recomputeBill(b: ParsedBill): BillTotals {
  const discrepancies: string[] = []
  const lineTaxable = b.lines.map((l) => {
    const fromRate = l.qtyMilli != null && l.ratePaise != null ? lineGross(l.qtyMilli, l.ratePaise) - (l.discountPaise ?? 0) : null
    if (fromRate != null && l.taxablePaise != null && fromRate !== l.taxablePaise) {
      discrepancies.push(
        `Line ${l.index + 1} (${l.description || 'no description'}): qty × rate − discount is ${rs(fromRate)} but ${rs(l.taxablePaise)} is printed`
      )
    }
    if (fromRate != null) return fromRate
    if (l.taxablePaise != null) return l.taxablePaise
    // Some bills print only the amount (taxable) per row.
    if (l.amountPaise != null && l.cgst == null && l.sgst == null && l.igst == null) return l.amountPaise
    return null
  })
  b.lines.forEach((l, i) => {
    if (lineTaxable[i] == null && l.description) discrepancies.push(`Line ${l.index + 1} (${l.description}): no legible quantity, rate or taxable value`)
  })
  const taxable = lineTaxable.reduce<number>((s, v) => s + (v ?? 0), 0)

  const sum = (pick: (x: { cgst: number | null; sgst: number | null; igst: number | null; cess: number | null }) => number | null, rows: { cgst: number | null; sgst: number | null; igst: number | null; cess: number | null }[]): number =>
    rows.reduce((s, r) => s + (pick(r) ?? 0), 0)
  const linesHaveTax = b.lines.some((l) => l.cgst != null || l.sgst != null || l.igst != null || l.cess != null)
  const rows = linesHaveTax ? b.lines : b.taxSummary
  const cgst = sum((r) => r.cgst, rows)
  const sgst = sum((r) => r.sgst, rows)
  const igst = sum((r) => r.igst, rows)
  const cess = sum((r) => r.cess, rows)
  if (linesHaveTax && b.taxSummary.length) {
    const s = { cgst: sum((r) => r.cgst, b.taxSummary), sgst: sum((r) => r.sgst, b.taxSummary), igst: sum((r) => r.igst, b.taxSummary), cess: sum((r) => r.cess, b.taxSummary) }
    for (const k of ['cgst', 'sgst', 'igst', 'cess'] as const) {
      const lineSum = { cgst, sgst, igst, cess }[k]
      if (s[k] !== lineSum) discrepancies.push(`${k.toUpperCase()}: the lines add up to ${rs(lineSum)} but the tax summary prints ${rs(s[k])}`)
    }
  }
  if (b.taxSummary.length) {
    const summaryTaxable = b.taxSummary.reduce((s, r) => s + (r.taxable ?? 0), 0)
    if (b.taxSummary.some((r) => r.taxable != null) && summaryTaxable !== taxable) {
      discrepancies.push(`Taxable value: the lines add up to ${rs(taxable)} but the tax summary prints ${rs(summaryTaxable)}`)
    }
  }
  if (cgst !== sgst) discrepancies.push(`CGST (${rs(cgst)}) and SGST (${rs(sgst)}) differ — they are normally equal halves`)
  if (igst !== 0 && (cgst !== 0 || sgst !== 0)) discrepancies.push('The bill prints both IGST and CGST / SGST')
  const tax = cgst + sgst + igst + cess
  const roundOff = b.roundOff ?? 0
  if (Math.abs(roundOff) >= 100) discrepancies.push(`Round off of ${rs(roundOff)} is a rupee or more`)
  const computedTotal = taxable + tax + roundOff
  if (b.total == null) discrepancies.push('No legible grand total on the bill')
  else if (b.total !== computedTotal) {
    discrepancies.push(
      `The printed total ${rs(b.total)} differs from the lines (taxable ${rs(taxable)} + tax ${rs(tax)}${roundOff ? ` + round off ${rs(roundOff)}` : ''} = ${rs(computedTotal)}) by ${rs(b.total - computedTotal)}`
    )
  }
  return { taxable, cgst, sgst, igst, cess, tax, roundOff, computedTotal, printedTotal: b.total, lineTaxable, discrepancies }
}
