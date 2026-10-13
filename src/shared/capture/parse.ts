// WP 5.4 — reading an extraction's printed text into the app's integers. Amounts go ONLY through
// money.ts parseAmountText (→ integer paise; a float artefact like "1234.5600000001" or a third
// decimal is refused, never rounded), quantities to integer thousandths, dates through the dates
// module (ISO, else the printed day-first date). Anything unreadable becomes null plus a warning
// the user sees — the app never guesses a figure.
import { parseAmountText } from '../money'
import { isValidISODate, parseSmartDate } from '../dates'
import { stateName } from '../gst/states'
import type { BillExtraction } from './schema'

export interface ParsedBillLine {
  index: number
  description: string
  hsn: string | null
  qtyMilli: number | null
  unit: string | null
  ratePaise: number | null
  discountPaise: number | null
  taxablePaise: number | null
  /** Basis points (1800 = 18%). */
  gstRateBp: number | null
  cgst: number | null
  sgst: number | null
  igst: number | null
  cess: number | null
  amountPaise: number | null
}

export interface ParsedTaxRow {
  rateBp: number | null
  taxable: number | null
  cgst: number | null
  sgst: number | null
  igst: number | null
  cess: number | null
}

export interface ParsedBill {
  documentType: BillExtraction['documentType']
  supplierName: string | null
  supplierGstin: string | null
  supplierStateCode: string | null
  buyerGstin: string | null
  invoiceNo: string | null
  date: string | null
  dueDate: string | null
  /** Two-digit GST state code of the printed place of supply. */
  placeOfSupply: string | null
  paymentTerms: string | null
  currency: string | null
  lines: ParsedBillLine[]
  taxSummary: ParsedTaxRow[]
  roundOff: number | null
  total: number | null
  confidence: BillExtraction['confidence']
  notes: string | null
  /** What could not be read, in plain words. */
  warnings: string[]
  /** GSTINs printed on the bill when the supplier's could not be told apart (asked, never guessed). */
  gstinCandidates?: string[]
}

/** Printed amount → signed integer paise, or null. Accepts "₹ 1,20,000.00", "Rs. 450/-", "-0.40",
 *  "(0.40)", "(-)0.40", "0.40 Cr" (negative) / "0.40 Dr" (positive) and Indian / Western grouping; refuses anything parseAmountText refuses
 *  (more than two significant decimals, mixed grouping, words). */
export function amountFromText(input: string | null | undefined): number | null {
  if (input == null) return null
  let t = input.trim().replace(/\s+/g, ' ')
  if (!t || t === '-' || t === '—' || /^nil$/i.test(t)) return null
  let sign = 1
  // "(-) 0.40" (Tally's printed minus) before the parenthesised-negative form.
  if (/^\(\s*[-−–]\s*\)/.test(t)) {
    sign = -1
    t = t.replace(/^\(\s*[-−–]\s*\)\s*/, '')
  }
  const paren = /^\((.*)\)$/.exec(t)
  if (paren) {
    sign = -sign
    t = paren[1]!.trim()
  }
  // A Dr / Cr marker is a sign, never dropped: dr-positive, as everywhere in the app (CLAUDE.md).
  const marker = /\s*(cr|dr)\.?$/i.exec(t)
  if (marker) {
    if (marker[1]!.toLowerCase() === 'cr') sign = -sign
    t = t.slice(0, marker.index).trim()
  }
  if (/^[-−–]/.test(t)) {
    sign = -sign
    t = t.slice(1).trim()
  } else if (t.startsWith('+')) t = t.slice(1).trim()
  // A rupee sign after a minus ("-₹0.40") or a trailing "INR".
  t = t.replace(/\s*inr$/i, '').trim()
  if (/^[-−–]/.test(t)) return null
  // "1,234.50" with a trailing ".00"-style float artefact is refused by parseAmountText.
  const p = parseAmountText(t)
  if (p === null) return null
  return sign * p
}

/** "18%", "18 %", "18.0", "9+9" (CGST+SGST halves) → basis points, or null. */
export function rateFromText(input: string | null | undefined): number | null {
  if (input == null) return null
  const t = input.trim().replace(/%/g, '').replace(/\s+/g, '')
  if (!t) return null
  const halves = /^(\d{1,2}(?:\.\d{1,2})?)\+(\d{1,2}(?:\.\d{1,2})?)$/.exec(t)
  if (halves) {
    const a = bp(halves[1]!)
    const b = bp(halves[2]!)
    return a != null && b != null ? a + b : null
  }
  return bp(t)
}

function bp(t: string): number | null {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(t)
  if (!m) return null
  const v = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'))
  return v <= 10_000 ? v : null
}

/** "2", "2.5", "1,000", "2 Nos", "12.000 KGS" → thousandths; a bare unit or words → null. */
export function qtyFromText(input: string | null | undefined): { qtyMilli: number; unit: string | null } | null {
  if (input == null) return null
  const m = /^\s*(\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})*,\d{3}|\d+)(?:\.(\d{1,3}))?\s*([\p{L}.]{1,12})?\s*$/u.exec(input)
  if (!m) return null
  const milli = Number(m[1]!.replace(/,/g, '')) * 1000 + Number((m[2] ?? '').padEnd(3, '0'))
  if (!Number.isSafeInteger(milli) || milli <= 0) return null
  return { qtyMilli: milli, unit: m[3] ? m[3].replace(/\.$/, '') : null }
}

/** ISO first (when it is a real date), else the printed date day-first ("15/08/2025",
 *  "15-08-25", "15.08.2025", "15 Aug 2025", "15-Aug-25"). */
export function dateFromText(iso: string | null | undefined, printed: string | null | undefined, today: string): string | null {
  if (iso && isValidISODate(iso.trim())) return iso.trim()
  if (!printed) return null
  const t = printed.trim()
  if (isValidISODate(t)) return t
  const smart = /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/.test(t) ? parseSmartDate(t, today) : null
  if (smart) return smart
  const m = /^(\d{1,2})(?:st|nd|rd|th)?[\s/-]+([A-Za-z]{3,9})[\s/,-]+(\d{2}|\d{4})$/.exec(t)
  if (m) {
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
    const mo = months.indexOf(m[2]!.slice(0, 3).toLowerCase())
    if (mo < 0) return null
    const y = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3])
    const d = `${y}-${String(mo + 1).padStart(2, '0')}-${m[1]!.padStart(2, '0')}`
    return isValidISODate(d) ? d : null
  }
  return null
}

const GSTIN_SHAPE = /^\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/

/** Upper-cased, spaces dropped; only a GSTIN-shaped value survives. */
export function cleanGstin(raw: string | null | undefined): string | null {
  if (!raw) return null
  const g = raw.replace(/\s+/g, '').toUpperCase()
  return GSTIN_SHAPE.test(g) ? g : null
}

/** "29", "29-Karnataka", "Karnataka (29)", "Karnataka" → "29"; else null. */
export function stateFromText(raw: string | null | undefined): string | null {
  if (!raw) return null
  const t = raw.trim()
  const code = /(?:^|\D)(\d{2})(?:\D|$)/.exec(t)?.[1]
  if (code && stateName(code)) return code
  const word = t.replace(/[^A-Za-z &]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
  if (!word) return null
  for (let c = 1; c <= 99; c++) {
    const k = String(c).padStart(2, '0')
    const n = stateName(k)
    if (n && n.toLowerCase() === word) return k
  }
  return null
}

/** The whole extraction → integers, with a warning for every printed figure that could not be read. */
export function parseExtraction(x: BillExtraction, today: string): ParsedBill {
  const warnings: string[] = []
  const amt = (raw: string | null, what: string): number | null => {
    if (raw == null || !raw.trim()) return null
    const v = amountFromText(raw)
    if (v === null) warnings.push(`${what}: “${raw}” is not a rupee amount the app can read — left blank`)
    return v
  }
  const lines: ParsedBillLine[] = x.lines.map((l, i) => {
    const n = `Line ${i + 1}`
    const q = l.qty ? qtyFromText(l.qty) : null
    if (l.qty && !q) warnings.push(`${n} quantity: “${l.qty}” is not a quantity — left blank`)
    const rate = l.gstRate ? rateFromText(l.gstRate) : null
    if (l.gstRate && rate === null) warnings.push(`${n} GST rate: “${l.gstRate}” is not a percentage — left blank`)
    return {
      index: i,
      description: l.description.trim(),
      hsn: l.hsn ? l.hsn.replace(/\s+/g, '') || null : null,
      qtyMilli: q?.qtyMilli ?? null,
      unit: l.unit?.trim() || q?.unit || null,
      ratePaise: amt(l.rate, `${n} rate`),
      discountPaise: amt(l.discount, `${n} discount`),
      taxablePaise: amt(l.taxable, `${n} taxable value`),
      gstRateBp: rate,
      cgst: amt(l.cgst, `${n} CGST`),
      sgst: amt(l.sgst, `${n} SGST`),
      igst: amt(l.igst, `${n} IGST`),
      cess: amt(l.cess, `${n} cess`),
      amountPaise: amt(l.amount, `${n} amount`)
    }
  })
  const taxSummary: ParsedTaxRow[] = x.taxSummary.map((r, i) => ({
    rateBp: rateFromText(r.rate),
    taxable: amt(r.taxable, `Tax summary row ${i + 1} taxable`),
    cgst: amt(r.cgst, `Tax summary row ${i + 1} CGST`),
    sgst: amt(r.sgst, `Tax summary row ${i + 1} SGST`),
    igst: amt(r.igst, `Tax summary row ${i + 1} IGST`),
    cess: amt(r.cess, `Tax summary row ${i + 1} cess`)
  }))
  const date = dateFromText(x.invoiceDateIso, x.invoiceDate, today)
  if ((x.invoiceDate || x.invoiceDateIso) && !date) warnings.push(`Invoice date: “${x.invoiceDate ?? x.invoiceDateIso}” is not a date the app can read`)
  const gstin = cleanGstin(x.supplier.gstin)
  if (x.supplier.gstin && !gstin && !/GSTIN …/.test(x.supplier.gstin)) warnings.push(`Supplier GSTIN “${x.supplier.gstin}” is not a valid GSTIN shape`)
  const total = amt(x.total, 'Total')
  if (total !== null && total <= 0) warnings.push('The printed total is not positive')
  return {
    documentType: x.documentType,
    supplierName: x.supplier.name?.trim() || null,
    supplierGstin: gstin,
    supplierStateCode: stateFromText(x.supplier.stateCode) ?? (gstin ? gstin.slice(0, 2) : null),
    buyerGstin: cleanGstin(x.buyerGstin),
    invoiceNo: x.invoiceNumber?.trim() || null,
    date,
    dueDate: dateFromText(null, x.dueDate, today),
    placeOfSupply: stateFromText(x.placeOfSupply),
    paymentTerms: x.paymentTerms?.trim() || null,
    currency: x.currency?.trim() || null,
    lines,
    taxSummary,
    roundOff: amt(x.roundOff, 'Round off'),
    total,
    confidence: x.confidence,
    notes: x.notes,
    warnings
  }
}
