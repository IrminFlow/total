// Table platform — pure types shared by the sort/filter/group/view-state logic in lib/table and the
// React layer in components/table. Nothing here imports React or touches the DOM.

/**
 * What a column holds. The kind decides the comparator, the filter operators, the default
 * alignment/format, and whether a footer aggregate makes sense.
 *
 *   text      string                      case-insensitive, numeric-aware ("Inv 9" < "Inv 10")
 *   money     integer paise               formatted via @shared/money formatPaise
 *   quantity  integer thousandths (milli) formatted with integer math (formatMilli)
 *   date      ISO 'YYYY-MM-DD' string     formatted via @shared/dates toDisplayDate
 *   number    plain JS number (counts…)   never use for amounts
 *   enum      string drawn from `options` filter = one-of
 */
export type ColumnKind = 'text' | 'money' | 'quantity' | 'date' | 'number' | 'enum'

/** Raw cell value an accessor returns. null/undefined = "no value" (sorts last, matches "is empty"). */
export type CellValue = string | number | null | undefined

export type Align = 'left' | 'right' | 'center'

export interface EnumOption {
  value: string
  label: string
}

/**
 * A column definition, free of React. The component layer (components/table/types.ts) extends
 * this with an optional `cell` renderer.
 */
export interface ColumnDef<Row> {
  /** Stable id — persisted in saved views, so never rename casually. */
  id: string
  /** Header label (also used for exports, the column chooser and filter chips). */
  header: string
  kind: ColumnKind
  /** Raw value: money → paise, quantity → milli, date → ISO, enum → option value. */
  value: (row: Row) => CellValue
  /** Display/export/quick-filter text. Defaults to the kind's formatter applied to `value`. */
  text?: (row: Row) => string
  /** Default: right for money/quantity/number, left otherwise. */
  align?: Align
  /** Enum columns: the selectable values (and their labels). */
  options?: EnumOption[]
  /** Money: render signed paise as "1,234.00 Dr" / "Cr" (like <Money signed />). */
  signed?: boolean
  /** Quantity: decimals shown (0–3). Default 3. A function picks them per row (mixed-unit
   *  columns, e.g. `(r) => r.unitDecimals`); aggregates then use `aggregateDecimals`. */
  decimals?: number | ((row: Row) => number)
  /** Quantity: unit appended to the number ("12.500 kg"). A function picks it per row. */
  unit?: string | ((row: Row) => string)
  /** Quantity: decimals for footer/group aggregates when `decimals` is per-row. Default 3. */
  aggregateDecimals?: number
  /**
   * Header band label. Adjacent visible columns with the same `group` share a spanning band
   * row above the header ("Portal" over its number/date/value columns). Exports prefix it:
   * "Portal · Invoice no.".
   */
  group?: string
  sortable?: boolean // default true
  filterable?: boolean // default true
  hideable?: boolean // default true
  groupable?: boolean // default true for text/enum/date, false otherwise
  /** Starts hidden in the default view. */
  defaultHidden?: boolean
  /**
   * Default width in px. Without one, money/quantity/date/number/enum columns get a kind default
   * (widened to fit the header label) and text columns are flexible: they start at `minWidth`
   * and share the space left over (see lib/table/widths.ts).
   */
  width?: number
  /** Smallest width in px — a flexible column never shrinks below it; resizing stops at it. */
  minWidth?: number
  /**
   * Footer aggregate. 'sum' adds the raw values (integers stay integers — money stays paise).
   * A function receives the rows in scope (all filtered rows for the footer, a group's rows for
   * its subtotal) and returns the raw value to render with the column's formatter, or null.
   */
  aggregate?: 'sum' | ((rows: Row[]) => CellValue)
  /** Group key override (e.g. a date column grouped by month). Defaults to the column's text. */
  groupKey?: (row: Row) => string
  /** Extra classes for body cells (e.g. 'text-muted'). */
  className?: string
  /** Extra classes for the header cell. */
  headerClassName?: string
}

export type SortDir = 'asc' | 'desc'

export interface SortKey {
  id: string
  dir: SortDir
}

export type TextOp = 'contains' | 'startsWith' | 'equals' | 'empty'
export type RangeOp = 'eq' | 'gte' | 'lte' | 'between'
export type DateOp = 'on' | 'before' | 'after' | 'between'

/** A per-column filter. Range values are raw (paise / milli / number); dates are ISO. */
export type ColumnFilter =
  | { type: 'text'; op: TextOp; value: string }
  | { type: 'range'; op: RangeOp; a: number; b?: number }
  | { type: 'date'; op: DateOp; a: string; b?: string }
  | { type: 'enum'; values: string[] }

export type Density = 'comfortable' | 'compact'

export const VIEW_STATE_VERSION = 1

/**
 * Everything about how a table is shown, serialisable to JSON. The quick-filter text and
 * collapsed groups are deliberately NOT part of it — they're transient per visit.
 */
export interface ViewState {
  v: typeof VIEW_STATE_VERSION
  /** Every known column id, in display order. */
  order: string[]
  hidden: string[]
  /** User-resized widths in px. */
  widths: Record<string, number>
  /** Primary first. */
  sort: SortKey[]
  filters: Record<string, ColumnFilter>
  groupBy: string | null
  density: Density
}
