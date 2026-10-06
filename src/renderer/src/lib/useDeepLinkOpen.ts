import { useEffect, useRef } from 'react'

/**
 * Deep link into a master list (search results → Masters › Stock items with `itemId`): once
 * `rows` contains the row with `id`, call `open(row)` — exactly once, so closing the editor
 * doesn't immediately reopen it. Kept out of Masters.tsx so that screen only needs one call.
 */
export function useDeepLinkOpen<Row extends { id: number }>(rows: readonly Row[], id: number | undefined, open: (row: Row) => void): void {
  const done = useRef(false)
  const openRef = useRef(open)
  openRef.current = open
  useEffect(() => {
    if (done.current || id == null) return
    const target = rows.find((r) => r.id === id)
    if (target) {
      done.current = true
      openRef.current(target)
    }
  }, [rows, id])
}
