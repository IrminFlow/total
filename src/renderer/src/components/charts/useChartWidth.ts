import { useLayoutEffect, useRef, useState } from 'react'

/**
 * Width of the element behind `ref`, kept current with a ResizeObserver so charts redraw at the
 * real pixel width (crisp strokes, no viewBox stretching). Falls back to `fallback` where there
 * is no ResizeObserver (jsdom) or before the first layout.
 */
export function useChartWidth<T extends HTMLElement>(fallback = 320): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null)
  const [width, setWidth] = useState(fallback)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (): void => {
      const w = Math.floor(el.getBoundingClientRect().width)
      if (w > 0) setWidth(w)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, width]
}
