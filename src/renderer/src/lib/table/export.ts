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
