import type { ReactNode } from 'react'
import type { ColumnDef } from '../../lib/table'

/** A DataTable column: the pure ColumnDef plus an optional React cell renderer. */
export interface TableColumn<Row> extends ColumnDef<Row> {
  /** Custom cell content. Sorting/filtering/export still use `value` / `text`. */
  cell?: (row: Row) => ReactNode
}

/** Keeps column arrays typed against a row without repeating the generic on every entry. */
export function defineColumns<Row>(columns: TableColumn<Row>[]): TableColumn<Row>[] {
  return columns
}
