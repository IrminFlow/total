// Grouping by one column with per-group subtotals, plus footer aggregates.
import { cellText } from './format'
import { compareValues } from './sort'
import type { CellValue, ColumnDef, SortDir } from './types'

/** Default: text/enum/date columns can be grouped; numeric ones can't (unless opted in). */
export function isGroupable<Row>(col: ColumnDef<Row>): boolean {
  return col.groupable ?? (col.kind === 'text' || col.kind === 'enum' || col.kind === 'date')
}

/** Raw aggregate for a column over `rows`, or undefined when the column has none. 'sum' keeps
 *  integers integral (paise stay paise). */
export function aggregate<Row>(col: ColumnDef<Row>, rows: readonly Row[]): CellValue {
  if (!col.aggregate) return undefined
  if (typeof col.aggregate === 'function') return col.aggregate(rows as Row[])
  let sum = 0
  for (const r of rows) {
    const v = col.value(r)
    if (v === null || v === undefined || v === '') continue
    sum += Number(v)
  }
  return sum
}

export function aggregateAll<Row>(columns: readonly ColumnDef<Row>[], rows: readonly Row[]): Record<string, CellValue> {
  const out: Record<string, CellValue> = {}
  for (const c of columns) if (c.aggregate) out[c.id] = aggregate(c, rows)
  return out
}

export const BLANK_GROUP = '(blank)'

export interface RowGroup<Row> {
  key: string
  label: string
  rows: Row[]
  totals: Record<string, CellValue>
}

/**
 * Groups already-sorted rows by `groupCol`. Rows keep their order inside a group; groups are
 * ordered by the group column's raw value (direction `dir`, blanks last).
 */
export function groupRows<Row>(
  rows: readonly Row[],
  groupCol: ColumnDef<Row>,
  aggregateColumns: readonly ColumnDef<Row>[],
  dir: SortDir = 'asc'
): RowGroup<Row>[] {
  const map = new Map<string, { label: string; rows: Row[]; first: CellValue }>()
  for (const row of rows) {
    const label = (groupCol.groupKey ? groupCol.groupKey(row) : cellText(groupCol, row)).trim() || BLANK_GROUP
    let g = map.get(label)
    if (!g) {
      g = { label, rows: [], first: label === BLANK_GROUP ? null : groupCol.value(row) }
      map.set(label, g)
    }
    g.rows.push(row)
  }
  const groups = [...map.values()]
  groups.sort((x, y) => {
    const xn = x.first === null || x.first === undefined || x.first === ''
    const yn = y.first === null || y.first === undefined || y.first === ''
    if (xn || yn) return xn === yn ? 0 : xn ? 1 : -1
    // Groups keyed by groupKey() (e.g. month) sort by their first row's raw value, which is
    // the earliest/least in that bucket when rows are sorted by the same column.
    let c = compareValues(groupCol.kind, x.first as string | number, y.first as string | number)
    if (c === 0) c = compareValues('text', x.label, y.label)
    return dir === 'asc' ? c : -c
  })
  return groups.map((g) => ({ key: g.label, label: g.label, rows: g.rows, totals: aggregateAll(aggregateColumns, g.rows) }))
}
