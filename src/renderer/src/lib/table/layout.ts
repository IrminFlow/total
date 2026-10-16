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
/**
 * Smallest width of a NAME column — a flexible text column that can't be hidden (the row's
 * customer / product / account), when it has no `minWidth`: about 16 characters of a body-size
 * name plus the cell padding (to-do §4: names were cut to ~12 characters at 1024 px while the
 * money columns beside them had room). A name column also takes a double share of spare space.
 */
export const NAME_MIN_WIDTH = 152
/** How narrow a kind-default column may shrink when the columns don't fit, before the table
 *  scrolls sideways (never under its header label or `minWidth`). Money keeps room for
 *  ₹99,99,999.00; dates and numbers don't shrink. */
export const KIND_SHRINK_WIDTH: Partial<Record<ColumnKind, number>> = {
  money: 128,
  quantity: 112,
  enum: 104
}
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
  /** A name column (see NAME_MIN_WIDTH): a double share of spare space. */
  name?: boolean
  /** Narrowest it may shrink to when the columns don't fit (absent = `base`, never shrinks). */
  floor?: number
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
    if (kindDefault !== undefined) {
      const base = Math.max(kindDefault, min, header)
      const shrink = KIND_SHRINK_WIDTH[c.kind]
      return { id: c.id, base, flex: false, text, resized: false, ...(shrink !== undefined ? { floor: Math.min(base, Math.max(shrink, min, header)) } : {}) }
    }
    if (text && c.hideable === false) return { id: c.id, base: Math.round(Math.max(c.minWidth ?? NAME_MIN_WIDTH, header)), flex: true, text, resized: false, name: true }
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
    // Shares: 1 per flexible column, 2 per name column (a name needs the room more than a
    // status or note column). Whole pixels, the remainder 1px each from the left.
    const weight = (i: number): number => (specs[i]!.name ? 2 : 1)
    const parts = targets.reduce((a, i) => a + weight(i), 0)
    const unit = Math.floor(spare / parts)
    let rest = spare - unit * parts
    targets.forEach((i) => {
      widths[i]! += unit * weight(i)
    })
    for (let k = 0; rest > 0; k = (k + 1) % targets.length, rest--) widths[targets[k]!]! += 1
  } else if (spare < 0 && Number.isFinite(available) && available > 0) {
    // Too wide: the shrinkable (kind-default) columns give up room first, in proportion to what
    // each can give, down to their floor; only then does the table scroll sideways.
    const room = specs.map((s) => Math.max(0, s.base - (s.floor ?? s.base)))
    const total = room.reduce((a, b) => a + b, 0)
    const take = Math.min(-spare, total)
    if (take > 0) {
      let taken = 0
      room.forEach((r, i) => {
        const cut = Math.floor((take * r) / total)
        widths[i]! -= cut
        taken += cut
      })
      for (let i = 0; taken < take && i < room.length; i++) {
        if (widths[i]! > (specs[i]!.floor ?? specs[i]!.base)) {
          widths[i]! -= 1
          taken++
        }
      }
    }
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
