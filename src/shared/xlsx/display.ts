/**
 * A display-formatted report table (the PDF/CSV shape: cells already "1,23,456.00 Dr") as a typed
 * XLSX sheet — for the scheduled report packs (WP 6.1/6.2). A right-aligned column whose every
 * non-empty cell is a formatPaise amount ("-1,234.50", "500.00 Cr", "–" for zero) becomes an
 * amount column (paise parsed exactly — integer maths, no floats — written as a plain 2-decimal
 * number; signed Dr + / Cr − when the cells carry Dr/Cr). Anything else (ratios, percentages,
 * counts, dates, names) stays text exactly as displayed, so no figure is ever re-interpreted.
 */
import { parseRupees } from '../money'
import type { XlsxColumn, XlsxRow, XlsxSheet } from './writer'

export interface DisplayTable {
  title: string
  columns: { label: string; align?: 'l' | 'r' | 'c' }[]
  rows: { cells: string[]; bold?: boolean }[]
}

const AMOUNT = /^-?\d{1,3}(,\d{2,3})*\.\d{2}( (Dr|Cr))?$/
const ZERO = new Set(['–', '-', ''])

/** "1,23,456.78 Cr" → -12345678; "–" → 0; not an amount → null. */
export function displayAmount(cell: string): number | null {
  const t = cell.trim()
  if (ZERO.has(t)) return 0
  if (!AMOUNT.test(t)) return null
  const [num, side] = t.split(' ')
  const p = parseRupees(num!)
  if (p === null) return null
  return side === 'Cr' ? -Math.abs(p) : side === 'Dr' ? Math.abs(p) : p
}

export function displayTableToSheet(t: DisplayTable, preamble: string[] = []): XlsxSheet {
  const amountCol = t.columns.map((c, i) => {
    if (c.align !== 'r') return false
    const cells = t.rows.map((r) => (r.cells[i] ?? '').trim()).filter((v) => !ZERO.has(v))
    return cells.length > 0 && cells.every((v) => displayAmount(v) !== null)
  })
  const signed = t.columns.map((_c, i) => amountCol[i] && t.rows.some((r) => / (Dr|Cr)$/.test(r.cells[i] ?? '')))
  const columns: XlsxColumn[] = t.columns.map((c, i) => ({
    header: signed[i] ? `${c.label} (Dr + / Cr −)` : c.label,
    kind: amountCol[i] ? 'amount' : 'text'
  }))
  const rows: XlsxRow[] = t.rows.map((r) => ({
    bold: r.bold,
    cells: t.columns.map((_c, i) => {
      const v = r.cells[i] ?? ''
      if (!amountCol[i]) return v || null
      return v.trim() === '' ? null : displayAmount(v)
    })
  }))
  return { name: t.title, columns, rows, preamble: preamble.filter(Boolean) }
}
