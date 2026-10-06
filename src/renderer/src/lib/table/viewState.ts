// Serialisable view state with a versioned schema and safe parsing.
import { isValidFilter } from './filter'
import { isGroupable } from './group'
import { VIEW_STATE_VERSION, type ColumnDef, type ColumnFilter, type Density, type SortKey, type ViewState } from './types'

/** Overrides a screen can give for its default view (everything else derives from the columns). */
export type ViewDefaults = Partial<Omit<ViewState, 'v'>>

/** The default view for a column set: declared order, `defaultHidden` columns hidden. */
export function defaultView<Row>(columns: readonly ColumnDef<Row>[], overrides: ViewDefaults = {}): ViewState {
  const base: ViewState = {
    v: VIEW_STATE_VERSION,
    order: columns.map((c) => c.id),
    hidden: columns.filter((c) => c.defaultHidden && c.hideable !== false).map((c) => c.id),
    widths: {},
    sort: [],
    filters: {},
    groupBy: null,
    density: 'comfortable'
  }
  // Overrides go through reconcile too, so a typo'd id in a screen's defaults can't leak in.
  return reconcileView({ ...base, ...overrides, v: VIEW_STATE_VERSION }, columns)
}

/**
 * Brings a (structurally valid) view in line with the CURRENT columns: unknown ids are dropped,
 * columns added since the view was saved appear at their declared position (after the column
 * that precedes them in the definition), unhideable columns are forced visible, filters must
 * match their column's kind, and the group-by column must still be groupable.
 */
export function reconcileView<Row>(view: ViewState, columns: readonly ColumnDef<Row>[]): ViewState {
  const byId = new Map(columns.map((c) => [c.id, c]))
  const order = view.order.filter((id, i, arr) => byId.has(id) && arr.indexOf(id) === i)
  // Insert new columns after their nearest declared predecessor that is already placed.
  columns.forEach((c, declIndex) => {
    if (order.includes(c.id)) return
    let at = 0
    for (let j = declIndex - 1; j >= 0; j--) {
      const k = order.indexOf(columns[j]!.id)
      if (k >= 0) {
        at = k + 1
        break
      }
    }
    order.splice(at, 0, c.id)
  })
  const known = new Set(view.order)
  const hidden = new Set(view.hidden.filter((id) => byId.has(id) && byId.get(id)!.hideable !== false))
  // A column new to this stored view takes its default visibility.
  for (const c of columns) if (!known.has(c.id) && c.defaultHidden && c.hideable !== false) hidden.add(c.id)

  const widths: Record<string, number> = {}
  for (const [id, w] of Object.entries(view.widths)) {
    const col = byId.get(id)
    if (col && Number.isFinite(w) && w > 0) widths[id] = Math.max(col.minWidth ?? 48, Math.round(w))
  }
  const seen = new Set<string>()
  const sort = view.sort.filter((k) => {
    const col = byId.get(k.id)
    if (!col || col.sortable === false || seen.has(k.id)) return false
    seen.add(k.id)
    return true
  })
  const filters: Record<string, ColumnFilter> = {}
  for (const [id, f] of Object.entries(view.filters)) {
    const col = byId.get(id)
    if (col && col.filterable !== false && isValidFilter(col.kind, f)) filters[id] = f
  }
  const g = view.groupBy ? byId.get(view.groupBy) : undefined
  return {
    v: VIEW_STATE_VERSION,
    order,
    hidden: order.filter((id) => hidden.has(id)),
    widths,
    sort,
    filters,
    groupBy: g && isGroupable(g) ? g.id : null,
    density: view.density === 'compact' ? 'compact' : 'comfortable'
  }
}

const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')

/**
 * Parses untrusted stored state (a JSON string or an already-parsed value). Anything corrupt,
 * from a different schema version, or the wrong shape falls back to `fallback`; individual bad
 * fields fall back to the fallback's value for that field. Always returns a reconciled view.
 */
export function parseViewState<Row>(raw: unknown, columns: readonly ColumnDef<Row>[], fallback: ViewState): ViewState {
  let obj: unknown = raw
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw)
    } catch {
      return reconcileView(fallback, columns)
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return reconcileView(fallback, columns)
  const o = obj as Record<string, unknown>
  if (o.v !== VIEW_STATE_VERSION) return reconcileView(fallback, columns) // unknown/old schema
  const sort: SortKey[] = Array.isArray(o.sort)
    ? o.sort.filter(
        (k): k is SortKey =>
          !!k && typeof k === 'object' && typeof (k as SortKey).id === 'string' && ['asc', 'desc'].includes((k as SortKey).dir)
      )
    : fallback.sort
  const widths: Record<string, number> = {}
  if (o.widths && typeof o.widths === 'object' && !Array.isArray(o.widths)) {
    for (const [k, w] of Object.entries(o.widths as Record<string, unknown>)) if (typeof w === 'number') widths[k] = w
  }
  const filters: Record<string, ColumnFilter> =
    o.filters && typeof o.filters === 'object' && !Array.isArray(o.filters)
      ? (o.filters as Record<string, ColumnFilter>) // per-filter validation happens in reconcile
      : fallback.filters
  const view: ViewState = {
    v: VIEW_STATE_VERSION,
    order: isStrArr(o.order) ? o.order : fallback.order,
    hidden: isStrArr(o.hidden) ? o.hidden : fallback.hidden,
    widths,
    sort,
    filters,
    groupBy: typeof o.groupBy === 'string' ? o.groupBy : null,
    density: (o.density === 'compact' || o.density === 'comfortable' ? o.density : fallback.density) as Density
  }
  return reconcileView(view, columns)
}

/** The visible columns, in view order. */
export function visibleColumns<C extends { id: string }>(columns: readonly C[], view: ViewState): C[] {
  const byId = new Map(columns.map((c) => [c.id, c]))
  const hidden = new Set(view.hidden)
  const out: C[] = []
  for (const id of view.order) {
    const c = byId.get(id)
    if (c && !hidden.has(id)) out.push(c)
  }
  // Defensive: a column missing from `order` (unreconciled view) still shows, at the end.
  for (const c of columns) if (!view.order.includes(c.id) && !hidden.has(c.id)) out.push(c)
  return out
}

/** Moves column `id` to sit at `toIndex` in the order (index in the FULL order). */
export function moveColumn(view: ViewState, id: string, toIndex: number): ViewState {
  const from = view.order.indexOf(id)
  if (from < 0) return view
  const order = view.order.slice()
  order.splice(from, 1)
  order.splice(Math.max(0, Math.min(order.length, toIndex)), 0, id)
  return { ...view, order }
}

/** Moves `id` to just before (or after) `targetId`. */
export function moveColumnTo(view: ViewState, id: string, targetId: string, after = false): ViewState {
  if (id === targetId) return view
  const without = view.order.filter((x) => x !== id)
  const t = without.indexOf(targetId)
  if (t < 0) return view
  without.splice(after ? t + 1 : t, 0, id)
  return { ...view, order: without }
}

/** Equality on the persisted shape — used to tell whether the current view differs from a saved one. */
export function sameView(a: ViewState, b: ViewState): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** A header cell's horizontal extent, for drag-to-reorder hit testing. */
export interface ColumnRect {
  id: string
  left: number
  right: number
}

/**
 * Where a header dragged to pointer x would drop: before/after the column under x (nearest edge
 * past the ends). Returns null when the drop would not move anything.
 */
export function columnDropTarget(rects: readonly ColumnRect[], draggedId: string, x: number): { id: string; after: boolean } | null {
  if (rects.length === 0) return null
  let hit = rects.find((r) => x >= r.left && x < r.right)
  if (!hit) hit = x < rects[0]!.left ? rects[0]! : rects[rects.length - 1]!
  const after = x >= (hit.left + hit.right) / 2
  if (hit.id === draggedId) return null
  const ids = rects.map((r) => r.id)
  const from = ids.indexOf(draggedId)
  const to = ids.indexOf(hit.id)
  // Dropping on the near edge of an adjacent column is a no-op.
  if ((after && to === from - 1) || (!after && to === from + 1)) return null
  return { id: hit.id, after }
}
