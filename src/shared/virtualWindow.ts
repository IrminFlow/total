/**
 * The arithmetic behind row virtualization.
 *
 * A trial balance on a real chart of accounts is tens of thousands of rows, and rendering one
 * <tr> each puts the same number of DOM nodes in the document — the screen takes seconds to
 * appear and every keystroke afterwards is slow. Only the rows inside the scroll viewport (plus a
 * little overscan) need to exist; the rest are two spacer rows of the right height.
 *
 * Kept pure and here rather than inside the hook so the edges can be tested: an empty list, a
 * list shorter than the viewport, a scroll position past the end (which happens when a filter
 * shrinks the list while it is scrolled down), and a zero-height container during first paint.
 */

export interface RowWindow {
  /** First rendered row index, inclusive. */
  start: number
  /** Last rendered row index, EXCLUSIVE — slice(start, end). */
  end: number
  /** Height in pixels of the spacer above the rendered rows. */
  padTop: number
  /** Height in pixels of the spacer below them. */
  padBottom: number
}

export interface RowWindowInput {
  count: number
  rowHeight: number
  scrollTop: number
  viewportHeight: number
  /** Extra rows rendered either side, so a fast scroll does not show blank bands. */
  overscan?: number
}

export function rowWindow({ count, rowHeight, scrollTop, viewportHeight, overscan = 8 }: RowWindowInput): RowWindow {
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 }

  // Before the first layout pass the container reports zero height. Rendering nothing then would
  // leave the screen blank until a scroll event that may never come (a short list never scrolls),
  // so an unmeasured viewport renders the first screenful and lets the measured pass correct it.
  const height = viewportHeight > 0 ? viewportHeight : rowHeight * 30

  const first = Math.floor(Math.max(0, scrollTop) / rowHeight)
  const visible = Math.ceil(height / rowHeight) + 1
  const start = Math.max(0, Math.min(count - 1, first - overscan))
  const end = Math.min(count, start + visible + overscan * 2)

  return {
    start,
    end,
    padTop: start * rowHeight,
    padBottom: (count - end) * rowHeight
  }
}

/** Whether a list is long enough to be worth windowing at all. Below this the spacer rows and the
 *  scroll listener cost more than the DOM nodes they save, and a short report should keep the
 *  browser's own find-in-page working on every row. */
export const VIRTUALIZE_THRESHOLD = 300

/**
 * Where the list starts inside the thing that scrolls.
 *
 * `rowWindow` wants a scroll position measured from the top of the LIST. When the list has its own
 * scroll container those are the same number. When it does not — a report that scrolls with the
 * page, which is most of them — the container's scrollTop counts a header, a filter bar and a
 * summary strip that sit above the first row, and using it unadjusted renders the wrong window:
 * the list appears blank at the top and the rows arrive late on the way down.
 */
export function listScrollTop(containerScrollTop: number, listTopWithinContainer: number): number {
  return Math.max(0, containerScrollTop - listTopWithinContainer)
}
