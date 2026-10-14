// WP 10.5: the simple shell's window-size rules, in one place.
//
//   < 1200 px wide   the simple sidebar shows icons only (labels on hover / focus, and always as
//                    the button's accessible name).
//   < 1600 px wide   Help, Ask Total and the AI drawer open OVER the screen's right edge instead
//                    of docking beside it (plan §7 WP 10.5: "the AI panel does not dock by
//                    default under 1600 px") — at 1024–1440 px a docked 400 px panel left the
//                    screen too narrow for its own buttons.
//
// Widths are CSS pixels, so a 125 % zoom on a 1280 px window (= 1024 CSS px) collapses too.
import { useSyncExternalStore } from 'react'

export const SIMPLE_NAV_COLLAPSE_BELOW = 1200
export const SIMPLE_DOCK_FROM = 1600

const noop = (): void => undefined

/** A media query's current answer, kept live. False where matchMedia is missing (jsdom). */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return noop
      const mql = window.matchMedia(query)
      mql.addEventListener('change', onChange)
      return () => mql.removeEventListener('change', onChange)
    },
    () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false),
    () => false
  )
}

/** The simple sidebar is icons-only (window narrower than 1200 px). */
export function useSimpleNavCollapsed(): boolean {
  return useMediaQuery(`(max-width: ${SIMPLE_NAV_COLLAPSE_BELOW - 0.02}px)`)
}

/** The simple shell's panels open over the screen (window narrower than 1600 px). */
export function useSimplePanelsOverlay(): boolean {
  return useMediaQuery(`(max-width: ${SIMPLE_DOCK_FROM - 0.02}px)`)
}
