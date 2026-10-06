// Layout maths for row virtualisation with a mix of fixed-height rows and variable-height
// extras (expanded detail rows). Pure: the DataTable feeds it heights, it answers "where is item
// i" and "which item is at y".

export interface RowLayout {
  /** offsets[i] = top of item i (px from the start of the body); offsets[n] = total height. */
  offsets: Float64Array
  /** rowIndex[i] = number of <tr>s (items + detail rows) before item i — for aria-rowindex. */
  rowIndex: Int32Array
  total: number
}

/**
 * Prefix sums over items. `extra(i)` is the height of whatever renders under item i (its
 * expanded detail row), or 0. O(n) — cheap enough to rebuild for 50k items when heights change.
 */
export function buildRowLayout(count: number, rowHeight: number, extra?: (i: number) => number): RowLayout {
  const offsets = new Float64Array(count + 1)
  const rowIndex = new Int32Array(count + 1)
  let y = 0
  let r = 0
  for (let i = 0; i < count; i++) {
    offsets[i] = y
    rowIndex[i] = r
    const e = extra ? extra(i) : 0
    y += rowHeight + e
    r += e > 0 ? 2 : 1
  }
  offsets[count] = y
  rowIndex[count] = r
  return { offsets, rowIndex, total: y }
}

/** Index of the item whose block (row + detail) contains y (clamped to [0, n-1]); binary search. */
export function itemAt(layout: RowLayout, y: number): number {
  const n = layout.offsets.length - 1
  if (n <= 0) return 0
  if (y <= 0) return 0
  if (y >= layout.total) return n - 1
  let lo = 0
  let hi = n - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (layout.offsets[mid]! <= y) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** The [start, end) item window covering [scrollY, scrollY + viewport) plus `overscan` items each side. */
export function visibleRange(layout: RowLayout, scrollY: number, viewport: number, overscan: number): [number, number] {
  const n = layout.offsets.length - 1
  if (n <= 0) return [0, 0]
  const first = itemAt(layout, Math.max(0, scrollY))
  const last = itemAt(layout, Math.max(0, scrollY + viewport - 1))
  return [Math.max(0, first - overscan), Math.min(n, last + 1 + overscan)]
}

/**
 * New scrollTop that brings item i's own row (not its detail) fully into view under a sticky
 * header of `header` px, or `current` when it already is.
 */
export function scrollTopFor(layout: RowLayout, i: number, rowHeight: number, current: number, viewport: number, header: number): number {
  const top = header + layout.offsets[i]!
  if (top < current + header) return Math.max(0, top - header)
  if (top + rowHeight > current + viewport) return top + rowHeight - viewport
  return current
}
