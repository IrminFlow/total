import { useCallback, useState } from 'react'

/**
 * A tab selection that survives a restart.
 *
 * Reopening a screen and finding it back on the first tab is a small tax paid every single time,
 * and the tab someone left a screen on is nearly always the one they want next.
 *
 * Deliberately NOT used by Masters or Settings: those keep their tab in the nav stack (see
 * `Screen` in state/stores.ts) so Escape retraces tabs and other screens can deep-link to one.
 * Persisting the tab there would fight the history.
 *
 * Stored per screen in localStorage. A stored value that is no longer a valid tab — a tab renamed
 * or removed by an update — falls back rather than leaving the screen showing nothing.
 */
export function useStickyTab<T extends string>(
  screen: string,
  tabs: readonly T[],
  fallback: T
): [T, (tab: T) => void] {
  const key = `total-tab-${screen}`

  const [tab, setTab] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key)
      return stored && (tabs as readonly string[]).includes(stored) ? (stored as T) : fallback
    } catch {
      // A locked-down or full localStorage must not take the screen down with it.
      return fallback
    }
  })

  const select = useCallback(
    (next: T) => {
      setTab(next)
      try {
        localStorage.setItem(key, next)
      } catch {
        // Losing the preference is acceptable; losing the click is not.
      }
    },
    [key]
  )

  return [tab, select]
}
