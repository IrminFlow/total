// Stable, kind-aware multi-column sorting.
import type { CellValue, ColumnDef, ColumnKind, SortDir, SortKey } from './types'

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

const isNil = (v: CellValue): v is null | undefined => v === null || v === undefined || v === ''

/** Compares two non-null raw values of one kind, ascending. */
export function compareValues(kind: ColumnKind, a: string | number, b: string | number): number {
  switch (kind) {
    case 'money':
    case 'quantity':
    case 'number': {
      const x = Number(a)
      const y = Number(b)
      return x < y ? -1 : x > y ? 1 : 0
    }
    case 'date':
      // ISO 'YYYY-MM-DD' compares chronologically as a plain string.
      return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0
    default:
      return collator.compare(String(a), String(b))
  }
}

/** Returns a new array sorted by `keys` (primary first). Stable: ties keep input order.
 *  Nulls/empties always sort last, whatever the direction. Unknown/unsortable ids are ignored. */
export function sortRows<Row>(rows: readonly Row[], columns: readonly ColumnDef<Row>[], keys: readonly SortKey[]): Row[] {
  const active = keys
    .map((k) => ({ col: columns.find((c) => c.id === k.id), dir: k.dir }))
    .filter((k): k is { col: ColumnDef<Row>; dir: SortDir } => !!k.col && k.col.sortable !== false)
  if (active.length === 0) return rows.slice()
  // Decorate once — accessors may be non-trivial and the comparator runs n log n times.
  const decorated = rows.map((row, index) => ({ row, index, vals: active.map((k) => k.col.value(row)) }))
  decorated.sort((x, y) => {
    for (let i = 0; i < active.length; i++) {
      const a = x.vals[i]
      const b = y.vals[i]
      const an = isNil(a)
      const bn = isNil(b)
      if (an || bn) {
        if (an && bn) continue
        return an ? 1 : -1 // nulls last in both directions
      }
      const c = compareValues(active[i]!.col.kind, a as string | number, b as string | number)
      if (c !== 0) return active[i]!.dir === 'asc' ? c : -c
    }
    return x.index - y.index
  })
  return decorated.map((d) => d.row)
}

/**
 * Header-click transition. Plain click: this column becomes the only sort key, cycling
 * asc → desc → none. Shift-click: add/cycle this column as an extra key, keeping the others
 * (asc → desc → removed).
 */
export function toggleSort(keys: readonly SortKey[], id: string, multi: boolean): SortKey[] {
  const existing = keys.find((k) => k.id === id)
  const next: SortDir | null = !existing ? 'asc' : existing.dir === 'asc' ? 'desc' : null
  if (!multi) {
    // From a multi-key sort, a plain click collapses to this column alone, starting fresh.
    if (keys.length > 1) return [{ id, dir: 'asc' }]
    return next ? [{ id, dir: next }] : []
  }
  if (!existing) return [...keys, { id, dir: 'asc' }]
  if (!next) return keys.filter((k) => k.id !== id)
  return keys.map((k) => (k.id === id ? { id, dir: next } : k))
}
