// rows + columns + view → what the table shows. One pure function so the DataTable, its
// export, and tests all agree on exactly the same rows.
import { filterRows } from './filter'
import { aggregateAll, groupRows } from './group'
import { sortRows } from './sort'
import type { CellValue, ColumnDef, ViewState } from './types'
import { visibleColumns } from './viewState'

export type DisplayItem<Row> =
  | { type: 'row'; row: Row; /** index into `TableModel.rows` */ index: number }
  | { type: 'group'; key: string; label: string; count: number; collapsed: boolean; totals: Record<string, CellValue> }

export interface TableModel<Row, C extends ColumnDef<Row> = ColumnDef<Row>> {
  /** Visible columns in view order. */
  columns: C[]
  /** Filtered + sorted rows (ungrouped order when not grouping, grouped order when grouping). */
  rows: Row[]
  /** What renders, top to bottom: group headers (with subtotals) and data rows. */
  items: DisplayItem<Row>[]
  /** Footer aggregates over all filtered rows, keyed by column id. */
  totals: Record<string, CellValue>
  /** Row count before any filter. */
  totalCount: number
}

export function buildTableModel<Row, C extends ColumnDef<Row>>(
  allRows: readonly Row[],
  columns: readonly C[],
  view: ViewState,
  opts: { quick?: string; collapsed?: ReadonlySet<string> } = {}
): TableModel<Row, C> {
  const visible = visibleColumns(columns, view)
  const filtered = filterRows(allRows, columns, view.filters, opts.quick ?? '', visible)
  const sorted = sortRows(filtered, columns, view.sort)
  const aggCols = columns.filter((c) => c.aggregate)
  const totals = aggregateAll(aggCols, sorted)
  const groupCol = view.groupBy ? columns.find((c) => c.id === view.groupBy) : undefined
  if (!groupCol) {
    return {
      columns: visible,
      rows: sorted,
      items: sorted.map((row, index) => ({ type: 'row', row, index })),
      totals,
      totalCount: allRows.length
    }
  }
  const dir = view.sort.find((k) => k.id === groupCol.id)?.dir ?? 'asc'
  const groups = groupRows(sorted, groupCol, aggCols, dir)
  const rows: Row[] = []
  const items: DisplayItem<Row>[] = []
  for (const g of groups) {
    const collapsed = opts.collapsed?.has(g.key) ?? false
    items.push({ type: 'group', key: g.key, label: g.label, count: g.rows.length, collapsed, totals: g.totals })
    for (const row of g.rows) {
      const index = rows.length
      rows.push(row)
      if (!collapsed) items.push({ type: 'row', row, index })
    }
  }
  return { columns: visible, rows, items, totals, totalCount: allRows.length }
}
