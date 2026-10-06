// The CURRENT view → the display-formatted cells lib/reportExport.ts (printReport/csvReport) takes.
import type { ReportColumn as PdfColumn, ReportRow as PdfRow } from '../client'
import { aggregateText, cellText, columnAlign } from './format'
import type { TableModel } from './pipeline'
import type { CellValue, ColumnDef } from './types'

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
  opts: { totalsLabel?: string; includeTotals?: boolean } = {}
): TableExport {
  const cols = model.columns
  const columns: PdfColumn[] = cols.map((c) => {
    const a = columnAlign(c)
    return { label: c.header, align: a === 'right' ? 'r' : a === 'center' ? 'c' : 'l' }
  })
  const labelCol = Math.max(
    0,
    cols.findIndex((c) => !c.aggregate)
  )
  const summaryCells = (totals: Record<string, CellValue>, label: string): string[] =>
    cols.map((c, i) => (c.aggregate ? aggregateText(c, totals[c.id]) : i === labelCol ? label : ''))

  const rows: PdfRow[] = []
  for (const item of model.items) {
    if (item.type === 'group') rows.push({ cells: summaryCells(item.totals, `${item.label} (${item.count})`), bold: true })
    else rows.push({ cells: cols.map((c) => cellText(c, item.row)), indent: model.items[0]?.type === 'group' ? 1 : undefined })
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
