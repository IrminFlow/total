import type { ReactNode } from 'react'
import type { ColumnDef } from '../../lib/table'
import type { ExplainInput } from '../../lib/explain'

/** A DataTable column: the pure ColumnDef plus an optional React cell renderer. */
export interface TableColumn<Row> extends ColumnDef<Row> {
  /** Custom cell content. Sorting/filtering/export still use `value` / `text`. */
  cell?: (row: Row) => ReactNode
  /**
   * WP 5.2 "Explain this": while the assistant is on, an explainable cell shows a small AI action
   * on hover that asks the assistant to explain the figure from its source. Money columns are
   * explainable by default (the figure = the row's name, the column, the value and the row's
   * voucherId / ledgerId / itemId). `false` opts a column out; a function adds or overrides the
   * source for a row (`{ groupName }`, `{ ledgerId }`, `{ asOn }` …) or returns null for none.
   */
  explainable?: boolean | ((row: Row) => Partial<ExplainInput> | null)
}

/** Keeps column arrays typed against a row without repeating the generic on every entry. */
export function defineColumns<Row>(columns: TableColumn<Row>[]): TableColumn<Row>[] {
  return columns
}
