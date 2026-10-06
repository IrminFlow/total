// Per-column filters by kind + the quick filter across visible text columns.
import { cellText, formatRaw } from './format'
import type { CellValue, ColumnDef, ColumnFilter, ColumnKind } from './types'

/** Which filter shape a column kind takes. */
export function filterTypeFor(kind: ColumnKind): ColumnFilter['type'] {
  switch (kind) {
    case 'money':
    case 'quantity':
    case 'number':
      return 'range'
    case 'date':
      return 'date'
    case 'enum':
      return 'enum'
    default:
      return 'text'
  }
}

const isNil = (v: CellValue): boolean => v === null || v === undefined || v === ''

/** Does one row's cell pass one column filter? */
export function matchesFilter<Row>(col: ColumnDef<Row>, row: Row, f: ColumnFilter): boolean {
  const raw = col.value(row)
  switch (f.type) {
    case 'text': {
      if (f.op === 'empty') return isNil(raw) || String(raw).trim() === ''
      const hay = (isNil(raw) ? '' : col.kind === 'text' ? String(raw) : cellText(col, row)).toLowerCase()
      const needle = f.value.toLowerCase()
      if (f.op === 'equals') return hay.trim() === needle.trim()
      if (f.op === 'startsWith') return hay.startsWith(needle)
      return hay.includes(needle)
    }
    case 'range': {
      if (isNil(raw)) return false
      const n = Number(raw)
      if (f.op === 'eq') return n === f.a
      if (f.op === 'gte') return n >= f.a
      if (f.op === 'lte') return n <= f.a
      const lo = Math.min(f.a, f.b ?? f.a)
      const hi = Math.max(f.a, f.b ?? f.a)
      return n >= lo && n <= hi
    }
    case 'date': {
      if (isNil(raw)) return false
      const d = String(raw)
      if (f.op === 'on') return d === f.a
      if (f.op === 'before') return d < f.a
      if (f.op === 'after') return d > f.a
      const b = f.b ?? f.a
      const lo = f.a < b ? f.a : b
      const hi = f.a < b ? b : f.a
      return d >= lo && d <= hi
    }
    case 'enum':
      if (f.values.length === 0) return true // nothing ticked = no constraint
      return !isNil(raw) && f.values.includes(String(raw))
  }
}

/** True when a filter is structurally valid for a column of `kind` (used when parsing stored state). */
export function isValidFilter(kind: ColumnKind, f: unknown): f is ColumnFilter {
  if (!f || typeof f !== 'object') return false
  const o = f as Record<string, unknown>
  if (o.type !== filterTypeFor(kind)) return false
  switch (o.type) {
    case 'text':
      return ['contains', 'startsWith', 'equals', 'empty'].includes(o.op as string) && typeof o.value === 'string'
    case 'range':
      return (
        ['eq', 'gte', 'lte', 'between'].includes(o.op as string) &&
        Number.isFinite(o.a) &&
        (o.op !== 'between' || Number.isFinite(o.b)) &&
        // money/quantity stay integers — a float operand is corrupt state
        (kind === 'number' || (Number.isInteger(o.a) && (o.b === undefined || Number.isInteger(o.b))))
      )
    case 'date': {
      const iso = (s: unknown): boolean => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
      return ['on', 'before', 'after', 'between'].includes(o.op as string) && iso(o.a) && (o.op !== 'between' || iso(o.b))
    }
    case 'enum':
      return Array.isArray(o.values) && o.values.every((v) => typeof v === 'string')
    default:
      return false
  }
}

/** Columns the quick filter searches: visible text and enum columns. */
export function quickFilterColumns<Row>(columns: readonly ColumnDef<Row>[]): ColumnDef<Row>[] {
  return columns.filter((c) => c.kind === 'text' || c.kind === 'enum')
}

/**
 * Applies every column filter plus the quick filter. `quickColumns` should be the VISIBLE
 * columns (hidden columns don't take part in the quick filter). Quick filter: every
 * whitespace-separated term must appear (case-insensitive) in at least one quick column.
 */
export function filterRows<Row>(
  rows: readonly Row[],
  columns: readonly ColumnDef<Row>[],
  filters: Record<string, ColumnFilter>,
  quick: string,
  quickColumns: readonly ColumnDef<Row>[] = columns
): Row[] {
  const active = Object.entries(filters)
    .map(([id, f]) => ({ col: columns.find((c) => c.id === id), f }))
    .filter((x): x is { col: ColumnDef<Row>; f: ColumnFilter } => !!x.col && x.col.filterable !== false)
  const terms = quick.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const qcols = quickFilterColumns(quickColumns)
  if (active.length === 0 && terms.length === 0) return rows.slice()
  return rows.filter((row) => {
    for (const { col, f } of active) if (!matchesFilter(col, row, f)) return false
    if (terms.length) {
      const texts = qcols.map((c) => cellText(c, row).toLowerCase())
      for (const t of terms) if (!texts.some((s) => s.includes(t))) return false
    }
    return true
  })
}

const TEXT_OPS = { contains: 'contains', startsWith: 'starts with', equals: 'is', empty: 'is empty' } as const
const DATE_OPS = { on: 'on', before: 'before', after: 'after', between: 'between' } as const

/** Human label for a filter chip: "Amount ≥ 1,000.00", "Date between 01-Apr-26 and 30-Apr-26". */
export function describeFilter<Row>(col: ColumnDef<Row>, f: ColumnFilter): string {
  const fmt = (v: CellValue): string => formatRaw(col.kind, v, { decimals: col.decimals, plainZero: true })
  switch (f.type) {
    case 'text':
      return f.op === 'empty' ? `${col.header} is empty` : `${col.header} ${TEXT_OPS[f.op]} “${f.value}”`
    case 'range': {
      const sym = { eq: '=', gte: '≥', lte: '≤', between: '' }[f.op]
      if (f.op === 'between') return `${col.header} ${fmt(f.a)} – ${fmt(f.b ?? f.a)}`
      return `${col.header} ${sym} ${fmt(f.a)}`
    }
    case 'date':
      if (f.op === 'between') return `${col.header} ${fmt(f.a)} – ${fmt(f.b ?? f.a)}`
      return `${col.header} ${DATE_OPS[f.op]} ${fmt(f.a)}`
    case 'enum': {
      const labels = f.values.map((v) => col.options?.find((o) => o.value === v)?.label ?? v)
      return `${col.header}: ${labels.join(', ')}`
    }
  }
}
