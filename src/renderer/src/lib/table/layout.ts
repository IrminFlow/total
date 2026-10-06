// Column width model and grouped header bands. Pure: the DataTable measures its scroll
// container and asks this module for integer pixel widths, so the browser never has to share
// out spare pixels itself (fractional sharing is what drew hairline seams between cells).
import type { ColumnDef, ColumnKind } from './types'

/** Default widths (px) for columns without an explicit `width`. Text columns are flexible. */
export const KIND_DEFAULT_WIDTH: Partial<Record<ColumnKind, number>> = {
  money: 150,
  quantity: 130,
  date: 104,
  number: 96,
  enum: 130
}
/** Smallest width a flexible (text, no `width`) column starts at when it has no `minWidth`. */
export const FLEX_MIN_WIDTH = 120
/** Header cell horizontal padding (12px each side, `.ledger-table th`). */
const HEADER_PADDING = 24
/** Room for the sort arrow that appears next to the label of a sorted column. */
const SORT_ARROW = 13

// Approximate advance widths of IBM Plex Sans semibold at the header's 10.5px, upper-cased, plus
// its 0.08em letter-spacing. An estimate on purpose (no DOM measuring): it only has to be a
// little generous so a default width never truncates its own label.
const NARROW = new Set([' ', '.', ',', ':', ';', '!', '|', "'", 'I', 'J', '1', '(', ')', '/', '-'])
const WIDE = new Set(['M', 'W', '%', '&', '@', '—', '₹'])
function charWidth(ch: string): number {
  if (NARROW.has(ch)) return 4.6
  if (WIDE.has(ch)) return 10.4
  return 7.9
}

/** Estimated px width of a header label (upper-cased as rendered). */
export function estimateLabelWidth(label: string): number {
  let w = 0
  for (const ch of label.toUpperCase()) w += charWidth(ch)
  return Math.ceil(w)
}

/** Narrowest header that shows `label` untruncated, with its padding and (if sortable) the sort arrow. */
export function headerMinWidth(label: string, sortable = true): number {
  return estimateLabelWidth(label) + HEADER_PADDING + (sortable ? SORT_ARROW : 0)
}

export interface ColumnWidthSpec {
  id: string
  /** Width before any spare space is shared out (px, integer). */
  base: number
  /** Takes a share of spare space (a text column with no explicit or user width). */
  flex: boolean
  /** A text column — the fallback recipient of spare space when no column is flexible. */
  text: boolean
  /** The user resized it: it keeps that width while another column can take the spare space. */
  resized: boolean
}

/**
 * Starting width per visible column: a user-resized width wins, then the column's `width`, then
 * the kind default widened to fit the header label; flexible text columns start at
 * max(minWidth ?? 120, header label). Every width respects `minWidth`.
 */
export function columnWidthSpecs<Row>(
  columns: readonly ColumnDef<Row>[],
  userWidths: Record<string, number | undefined> = {}
): ColumnWidthSpec[] {
  return columns.map((c) => {
    const min = c.minWidth ?? 0
    const header = headerMinWidth(c.header, c.sortable !== false)
    const text = c.kind === 'text'
    const user = userWidths[c.id]
    if (user !== undefined) return { id: c.id, base: Math.round(Math.max(user, min)), flex: false, text, resized: true }
    if (c.width !== undefined) return { id: c.id, base: Math.round(Math.max(c.width, min)), flex: false, text, resized: false }
    const kindDefault = KIND_DEFAULT_WIDTH[c.kind]
    if (kindDefault !== undefined) return { id: c.id, base: Math.max(kindDefault, min, header), flex: false, text, resized: false }
    return { id: c.id, base: Math.round(Math.max(c.minWidth ?? FLEX_MIN_WIDTH, header)), flex: true, text, resized: false }
  })
}

/** Where spare space goes when no column is flexible: the last text column the user hasn't
 *  resized, else the last column they haven't resized, else the last column. */
function fallbackTarget(specs: readonly ColumnWidthSpec[]): number {
  for (let i = specs.length - 1; i >= 0; i--) if (specs[i]!.text && !specs[i]!.resized) return i
  for (let i = specs.length - 1; i >= 0; i--) if (!specs[i]!.resized) return i
  return specs.length - 1
}

/**
 * Final integer widths. `available` is the scroll container's inner width; `fixed` the px taken
 * by non-data columns (expander, action cells). When there is spare space it goes, in whole
 * pixels, to the flexible columns (equal shares, the remainder 1px each from the left) — or,
 * when none is flexible, all to the last text column (see fallbackTarget). When the columns
 * don't fit (or `available` is unknown, 0) the base widths stand and the table scrolls sideways.
 * `total` is the exact table width: the column widths plus `fixed`.
 */
export function layoutColumnWidths(specs: readonly ColumnWidthSpec[], available: number, fixed = 0): { widths: number[]; total: number } {
  const widths = specs.map((s) => s.base)
  const used = widths.reduce((a, b) => a + b, 0) + fixed
  const spare = Math.floor(available) - used
  if (spare > 0 && specs.length > 0) {
    let targets = specs.flatMap((s, i) => (s.flex ? [i] : []))
    if (targets.length === 0) targets = [fallbackTarget(specs)]
    const share = Math.floor(spare / targets.length)
    const rest = spare - share * targets.length
    targets.forEach((i, k) => {
      widths[i]! += share + (k < rest ? 1 : 0)
    })
  }
  return { widths, total: widths.reduce((a, b) => a + b, 0) + fixed }
}

/** A run of adjacent visible columns under one header band (`group: null` = no band). */
export interface HeaderBand {
  group: string | null
  /** Index of the run's first column among the visible columns. */
  start: number
  span: number
  ids: string[]
}

/**
 * Splits the visible columns (in view order) into contiguous band runs. A group whose columns
 * are split by reordering shows one band per contiguous stretch; hidden columns simply don't
 * count. Returns [] when no visible column has a group (no band row is rendered).
 */
export function headerBands<Row>(columns: readonly Pick<ColumnDef<Row>, 'id' | 'group'>[]): HeaderBand[] {
  if (!columns.some((c) => c.group)) return []
  const bands: HeaderBand[] = []
  columns.forEach((c, i) => {
    const g = c.group ?? null
    const last = bands[bands.length - 1]
    if (last && last.group === g) {
      last.span++
      last.ids.push(c.id)
    } else bands.push({ group: g, start: i, span: 1, ids: [c.id] })
  })
  return bands
}
