import { useEffect, useRef, useState } from 'react'
import { isAnyModalOpen } from './modalRegistry'

/** Stack of mounted keyboard lists — only the topmost enabled list responds to ↑↓↵, so an
 *  overlay's list doesn't fight the screen's list underneath it. */
let keyNavSeq = 0
const keyNavStack: number[] = []

export function useKeyNav(
  count: number,
  onEnter: (index: number) => void,
  enabled = true
): {
  active: number
  setActive: (i: number) => void
} {
  const [active, setActive] = useState(0)
  const countRef = useRef(count)
  countRef.current = count
  const activeRef = useRef(active)
  activeRef.current = active
  const onEnterRef = useRef(onEnter)
  onEnterRef.current = onEnter
  const idRef = useRef(0)
  useEffect(() => {
    if (active >= count && count > 0) setActive(count - 1)
  }, [count, active])
  useEffect(() => {
    if (!enabled) return
    const id = ++keyNavSeq
    idRef.current = id
    keyNavStack.push(id)
    const isTop = (): boolean => keyNavStack[keyNavStack.length - 1] === id
    const onKey = (e: KeyboardEvent): void => {
      if (!isTop()) return
      // While any Modal is up it owns the keyboard — a screen's list behind it must not
      // move its selection (or fire Enter) from keys aimed at the dialog.
      if (isAnyModalOpen()) return
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActive((a) => Math.min(countRef.current - 1, a + 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((a) => Math.max(0, a - 1))
      } else if (e.key === 'Enter') {
        // Side-effect outside the state updater — updaters can run twice under StrictMode.
        if (countRef.current > 0) onEnterRef.current(activeRef.current)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      const i = keyNavStack.indexOf(id)
      if (i >= 0) keyNavStack.splice(i, 1)
    }
  }, [enabled])
  // Keep the active row visible as the selection moves. Rows follow the `.kbar-row` +
  // `data-active` convention; the last match wins because overlays render after the screen.
  useEffect(() => {
    if (enabled && keyNavStack[keyNavStack.length - 1] !== idRef.current) return
    const rows = document.querySelectorAll<HTMLElement>('.kbar-row[data-active="true"]')
    rows[rows.length - 1]?.scrollIntoView({ block: 'nearest' })
  }, [active, enabled])
  return { active, setActive }
}
