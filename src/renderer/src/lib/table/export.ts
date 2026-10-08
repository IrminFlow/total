// The CURRENT view → the display-formatted cells lib/reportExport.ts (printReport/csvReport) takes.
import { plainRupees } from '@shared/money'
import type { ReportColumn as PdfColumn, ReportRow as PdfRow } from '../client'
import type { XlsxColumn, XlsxRow, XlsxSheet } from '@shared/xlsx/writer'
import { aggregateText, cellText, columnAlign, columnLabel, rowDecimals, rowUnit } from './format'
import type { TableModel } from './pipeline'
import type { CellValue, ColumnDef } from './types'

/** Money cells in an export: as displayed ("1,234.00 Dr") or a plain signed decimal ("-1234.00"). */
export type MoneyExportFormat = 'display' | 'plain'

export interface TableExport {
  columns: PdfColumn[]
  rows: PdfRow[]
  /** CSV header (column labels). */
  header: string[]
  /** CSV body — the same cells as `rows`. */
  csvRows: string[][]
}

/**
 * Builds export rows for a model: visible columns in order, rows in current sort/filter order,
 * group header rows (bold, with subtotals) when grouping, and a bold ruled totals row when any
 * visible column aggregates. Pass a model built WITHOUT collapsed groups so collapsed rows still
 * export. `totalsLabel` lands in the first visible non-aggregate column.
 */
export function buildTableExport<Row>(
  model: TableModel<Row, ColumnDef<Row>>,
  opts: {
    totalsLabel?: string
    includeTotals?: boolean
    /**
     * How money cells are written. 'display' (default) is the on-screen text — "1,234.00",
     * "1,234.00 Dr", "–" for zero. 'plain' is a signed decimal a spreadsheet reads as a number:
     * "1234.00", "-1234.00" (signed columns stay dr-positive), "0.00"; no value stays ''.
     */
    moneyFormat?: MoneyExportFormat
  } = {}
): TableExport {
  const cols = model.columns
  const plain = opts.moneyFormat === 'plain'
  const columns: PdfColumn[] = cols.map((c) => {
    const a = columnAlign(c)
    return { label: columnLabel(c), align: a === 'right' ? 'r' : a === 'center' ? 'c' : 'l' }
  })
  const labelCol = Math.max(
    0,
    cols.findIndex((c) => !c.aggregate)
  )
  const plainMoney = (v: CellValue): string => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? '' : plainRupees(Number(v)))
  const aggCell = (c: ColumnDef<Row>, v: CellValue): string => (plain && c.kind === 'money' ? plainMoney(v) : aggregateText(c, v))
  const cell = (c: ColumnDef<Row>, row: Row): string => (plain && c.kind === 'money' ? plainMoney(c.value(row)) : cellText(c, row))
  const summaryCells = (totals: Record<string, CellValue>, label: string): string[] =>
    cols.map((c, i) => (c.aggregate ? aggCell(c, totals[c.id]) : i === labelCol ? label : ''))

  const rows: PdfRow[] = []
  for (const item of model.items) {
    if (item.type === 'group') rows.push({ cells: summaryCells(item.totals, `${item.label} (${item.count})`), bold: true })
    else rows.push({ cells: cols.map((c) => cell(c, item.row)), indent: model.items[0]?.type === 'group' ? 1 : undefined })
  }
  const hasAgg = cols.some((c) => c.aggregate)
  if (hasAgg && opts.includeTotals !== false) {
    rows.push({ cells: summaryCells(model.totals, opts.totalsLabel ?? 'Total'), bold: true, rule: true })
  }
  return { columns, rows, header: columns.map((c) => c.label), csvRows: rows.map((r) => r.cells) }
}

/**
 * Fits an export under the PDF row cap (lib/reportExport's PDF_ROW_LIMIT) WITHOUT silently
 * dropping rows: when it is over, the body is cut to fit, the totals row (which always covers the
 * whole view) is kept, and `note` says exactly what was left out — the caller puts it in the PDF
 * footer and a toast. CSV never goes through this.
 */
export function capExportForPdf(ex: TableExport, limit: number): { export: TableExport; truncated: boolean; note: string | null } {
  if (ex.rows.length <= limit) return { export: ex, truncated: false, note: null }
  const last = ex.rows[ex.rows.length - 1]
  const totals = last?.rule ? last : null
  const body = totals ? ex.rows.slice(0, -1) : ex.rows
  const keep = Math.max(0, limit - (totals ? 1 : 0))
  const rows = [...body.slice(0, keep), ...(totals ? [totals] : [])]
  const fmt = (n: number): string => n.toLocaleString('en-IN')
  const note =
    `PDF shows the first ${fmt(keep)} of ${fmt(body.length)} lines (the PDF limit is ${fmt(limit)})` +
    (totals ? '; the totals cover all lines' : '') +
    '. Export CSV for every line.'
  return { export: { ...ex, rows, csvRows: rows.map((r) => r.cells) }, truncated: true, note }
}

/**
 * The CURRENT view as a typed XLSX sheet (WP 6.3): money columns are numbers in paise (written as
 * rupees with a ₹ format), dates are real dates, quantities are numbers with the unit's decimals
 * (a fixed unit goes into the header; a per-row unit gets its own "… unit" column). Group and
 * totals rows are bold. Enum and text columns export their display text.
 */
export function buildTableXlsx<Row>(
  model: TableModel<Row, ColumnDef<Row>>,
  opts: { name: string; preamble?: string[]; totalsLabel?: string; includeTotals?: boolean }
): XlsxSheet {
  const cols = model.columns
  const columns: XlsxColumn[] = []
  /** One entry per output column; `unitOf` marks the extra per-row unit column. */
  const out: { col: ColumnDef<Row>; unitOf?: true }[] = []
  for (const c of cols) {
    const label = columnLabel(c)
    if (c.kind === 'money') columns.push({ header: c.signed ? `${label} (Dr + / Cr −)` : label, kind: 'money' })
    else if (c.kind === 'quantity') {
      const unit = typeof c.unit === 'string' && c.unit ? ` (${c.unit})` : ''
      columns.push({ header: label + unit, kind: 'qty', decimals: typeof c.decimals === 'number' ? c.decimals : 3 })
    } else if (c.kind === 'date') columns.push({ header: label, kind: 'date' })
    else if (c.kind === 'number') columns.push({ header: label, kind: 'number' })
    else columns.push({ header: label, kind: 'text' })
    out.push({ col: c })
    if (c.kind === 'quantity' && typeof c.unit === 'function') {
      columns.push({ header: `${label} unit`, kind: 'text', width: 8 })
      out.push({ col: c, unitOf: true })
    }
  }
  const labelCol = Math.max(0, out.findIndex((o) => !o.unitOf && !o.col.aggregate))
  const typed = (c: ColumnDef<Row>, v: CellValue, row: Row | null): string | number | null => {
    if (v === null || v === undefined || v === '') return null
    if (c.kind === 'money' || c.kind === 'quantity' || c.kind === 'number') return Number.isFinite(Number(v)) ? Number(v) : String(v)
    if (c.kind === 'date') return String(v)
    return row ? cellText(c, row) : aggregateText(c, v)
  }
  const summary = (totals: Record<string, CellValue>, label: string): XlsxRow => ({
    bold: true,
    cells: out.map((o, i) => (o.unitOf ? null : o.col.aggregate ? typed(o.col, totals[o.col.id] ?? null, null) : i === labelCol ? label : null))
  })
  const rows: XlsxRow[] = []
  for (const item of model.items) {
    if (item.type === 'group') {
      rows.push(summary(item.totals, `${item.label} (${item.count})`))
      continue
    }
    const qtyDecimals: Record<number, number> = {}
    const cells = out.map((o, i) => {
      if (o.unitOf) return rowUnit(o.col, item.row) || null
      if (o.col.kind === 'quantity') {
        const d = rowDecimals(o.col, item.row)
        if (d !== undefined) qtyDecimals[i] = d
      }
      return typed(o.col, o.col.value(item.row), item.row)
    })
    rows.push({ cells, qtyDecimals })
  }
  if (cols.some((c) => c.aggregate) && opts.includeTotals !== false) rows.push(summary(model.totals, opts.totalsLabel ?? 'Total'))
  return { name: opts.name, columns, rows, preamble: opts.preamble }
}
