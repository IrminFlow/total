import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { rowWindow, VIRTUALIZE_THRESHOLD, type RowWindow } from '@shared/virtualWindow'

export { VIRTUALIZE_THRESHOLD }

/**
 * Row virtualization for the report tables.
 *
 * A trial balance on a real chart of accounts is tens of thousands of rows; one <tr> each puts
 * that many nodes in the document, and the cost is not the first paint but everything after it —
 * every keystroke, every hover, every re-render walks them.
 *
 * The window is rendered between two spacer rows whose heights add up to the rows that are not
 * there, so the scrollbar is the size it should be and the browser's own scrolling still works.
 * Spacers are <tr> with a single <td colSpan>, never CSS transforms: a transformed <tbody> breaks
 * table layout, and the whole point is to keep these as real tables.
 *
 * Below VIRTUALIZE_THRESHOLD rows nothing is windowed at all — a short report keeps find-in-page
 * working on every row, which is worth more than the handful of nodes it would save.
 */
export function useVirtualRows(
  count: number,
  rowHeight: number
): {
  scrollRef: (node: HTMLElement | null) => void
  window: RowWindow
  virtualized: boolean
} {
  const [node, setNode] = useState<HTMLElement | null>(null)
  const [metrics, setMetrics] = useState({ scrollTop: 0, viewportHeight: 0 })
  const frame = useRef<number | null>(null)

  const scrollRef = useCallback((n: HTMLElement | null) => setNode(n), [])
  const virtualized = count >= VIRTUALIZE_THRESHOLD

  // Layout effect, not effect: the first measurement has to happen before paint, or a long list
  // renders its unmeasured first screenful and then visibly jumps.
  useLayoutEffect(() => {
    if (!node) return
    setMetrics({ scrollTop: node.scrollTop, viewportHeight: node.clientHeight })
  }, [node, count])

  useEffect(() => {
    if (!node || !virtualized) return
    const read = (): void => {
      // One update per animation frame: a scroll fires far more often than the screen repaints,
      // and setState per event is how a virtualized list ends up slower than the plain one.
      if (frame.current !== null) return
      frame.current = requestAnimationFrame(() => {
        frame.current = null
        setMetrics({ scrollTop: node.scrollTop, viewportHeight: node.clientHeight })
      })
    }
    node.addEventListener('scroll', read, { passive: true })
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(read) : null
    observer?.observe(node)
    return () => {
      node.removeEventListener('scroll', read)
      observer?.disconnect()
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      frame.current = null
    }
  }, [node, virtualized])

  const win = virtualized
    ? rowWindow({ count, rowHeight, scrollTop: metrics.scrollTop, viewportHeight: metrics.viewportHeight })
    : { start: 0, end: count, padTop: 0, padBottom: 0 }

  return { scrollRef, window: win, virtualized }
}
