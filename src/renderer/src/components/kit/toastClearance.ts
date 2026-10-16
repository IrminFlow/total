import { useLayoutEffect, type RefObject } from 'react'

/**
 * Where the toast stack has to keep clear of (simple shell only — app.css reads the variables
 * under `[data-shell='simple']`): the sticky Save bar's height (`--t-save-bar-h`) and a docked
 * panel's width (`--t-docked-w`). Each mounted owner reports its element's size; the variable is
 * the largest reported size, removed when the last owner goes. Measured in a LAYOUT effect, so the
 * stack moves before the first paint with the bar (no frame where a toast sits on Save), and kept
 * up to date by a ResizeObserver (a bar that wraps to two rows, a panel being resized).
 */
export type ClearanceVar = '--t-save-bar-h' | '--t-docked-w'

const owners = new Map<ClearanceVar, Map<symbol, number>>()

function apply(name: ClearanceVar): void {
  const sizes = owners.get(name)
  const largest = sizes && sizes.size ? Math.max(...sizes.values()) : 0
  const root = document.documentElement.style
  if (largest > 0) root.setProperty(name, `${Math.ceil(largest)}px`)
  else root.removeProperty(name)
}

/** Current value of a clearance variable in px (0 = not set) — for tests. */
export function clearanceOf(name: ClearanceVar): number {
  const v = document.documentElement.style.getPropertyValue(name)
  return v ? parseFloat(v) : 0
}

export function useToastClearance(
  ref: RefObject<HTMLElement | null>,
  name: ClearanceVar,
  enabled: boolean,
  measure: (el: HTMLElement) => number,
  /** Re-measure when these change (jsdom has no ResizeObserver). */
  deps: readonly unknown[] = []
): void {
  useLayoutEffect(() => {
    const el = ref.current
    if (!enabled || !el) return
    const key = Symbol(name)
    const update = (): void => {
      const size = measure(el)
      let sizes = owners.get(name)
      if (!sizes) owners.set(name, (sizes = new Map()))
      // Not laid out yet (0): leave the CSS fallback in force rather than "no clearance".
      if (size > 0) sizes.set(key, size)
      else sizes.delete(key)
      apply(name)
    }
    update()
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null
    ro?.observe(el)
    window.addEventListener('resize', update) // i18n-technical: event name
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', update) // i18n-technical
      owners.get(name)?.delete(key)
      apply(name)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, name, ...deps])
}
