import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { listScrollTop, rowWindow, VIRTUALIZE_THRESHOLD, type RowWindow } from '@shared/virtualWindow'

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
/**
 * The element that actually scrolls, starting from the one the list was attached to.
 *
 * Some screens give their table its own scroll box (the Trial Balance does). Most do not: the
 * table sits in the page and the Shell's main element scrolls. Walking up to find the real
 * scroller is what lets those screens virtualize without being re-laid-out first, and a layout
 * change to a dense screen is a much bigger risk than the scroll listener this saves.
 */
function scrollParent(node: HTMLElement): HTMLElement {
  let el: HTMLElement | null = node
  while (el) {
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null
    const overflow = `${style?.overflowY ?? ''} ${style?.overflow ?? ''}`
    if (/(auto|scroll|overlay)/.test(overflow) && el.scrollHeight > el.clientHeight + 1) return el
    el = el.parentElement
  }
  // No scrolling ancestor found (jsdom, or a list shorter than the window): treat the list's own
  // box as the viewport, which renders everything and is the safe answer.
  return node
}

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

  const measure = useCallback((n: HTMLElement): { scrollTop: number; viewportHeight: number } => {
    const container = scrollParent(n)
    if (container === n) return { scrollTop: n.scrollTop, viewportHeight: n.clientHeight }
    // How far the list's first row sits below the top of the scrolling box's content.
    const top = n.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
    return {
      scrollTop: listScrollTop(container.scrollTop, top),
      viewportHeight: container.clientHeight
    }
  }, [])

  // Layout effect, not effect: the first measurement has to happen before paint, or a long list
  // renders its unmeasured first screenful and then visibly jumps.
  useLayoutEffect(() => {
    if (!node) return
    setMetrics(measure(node))
  }, [node, count, measure])

  useEffect(() => {
    if (!node || !virtualized) return
    const container = scrollParent(node)
    const read = (): void => {
      // One update per animation frame: a scroll fires far more often than the screen repaints,
      // and setState per event is how a virtualized list ends up slower than the plain one.
      if (frame.current !== null) return
      frame.current = requestAnimationFrame(() => {
        frame.current = null
        setMetrics(measure(node))
      })
    }
    container.addEventListener('scroll', read, { passive: true })
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(read) : null
    observer?.observe(container)
    if (container !== node) observer?.observe(node)
    return () => {
      container.removeEventListener('scroll', read)
      observer?.disconnect()
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      frame.current = null
    }
  }, [node, virtualized, measure])

  const win = virtualized
    ? rowWindow({ count, rowHeight, scrollTop: metrics.scrollTop, viewportHeight: metrics.viewportHeight })
    : { start: 0, end: count, padTop: 0, padBottom: 0 }

  return { scrollRef, window: win, virtualized }
}
