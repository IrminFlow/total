import { useEffect, useRef } from 'react'

/**
 * Screen-level unsaved-changes guard. A screen (or editor) calls `useUnsavedGuard(dirty)`;
 * while any mounted caller is dirty, in-app navigation (useNav's go/back/home — see stores.ts)
 * first asks the user to confirm discarding, and closing the window is blocked by beforeunload.
 *
 * Modals guard their own dismissal via the Modal `dirty` prop instead — this hook covers
 * whole-screen navigation underneath them.
 */

const guards = new Set<symbol>()

export function useUnsavedGuard(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return
    const token = Symbol('unsaved')
    guards.add(token)
    return () => {
      guards.delete(token)
    }
  }, [dirty])
}

/** A restored durable draft starts clean even though its form is populated. Any subsequent
 * fingerprint change is guarded; a brand-new form keeps its ordinary content-based rule. */
export function useDraftAwareUnsavedGuard(draftId: number | undefined, ordinaryDirty: boolean, fingerprint: string): void {
  const initial = useRef(fingerprint)
  useUnsavedGuard(draftId ? fingerprint !== initial.current : ordinaryDirty)
}

export function hasUnsavedChanges(): boolean {
  return guards.size > 0
}

// Block accidental window close while something is dirty (Electron shows the native prompt).
window.addEventListener('beforeunload', (e) => {
  if (guards.size > 0) e.preventDefault()
})
