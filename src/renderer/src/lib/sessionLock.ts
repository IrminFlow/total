// WP 7.2 — the session lock in the renderer. Main decides (it signs the session out on ⌘L and after
// the owner's idle minutes, and refuses every call until the PIN); this hook only follows it:
//   - ⌘L asks main to lock now (a business without people gets a privacy screen — its passphrase
//     when it has one, else a plain Unlock);
//   - main's lock event (and any call refused with `session_locked`) shows the PIN screen;
//   - real input (keys, pointer, wheel) tells main the session is in use, at most every 30 s —
//     background refreshes never do, so an unattended screen still locks.
import { useEffect } from 'react'
import { create } from 'zustand'
import { api, IpcError, type LockKind } from './client'
import { useSession, useToasts } from '../state/stores'
import { useT } from './i18n'

/** Fired by `call` (client.ts) when main refuses a call because the session is locked. */
export const SESSION_LOCKED_EVENT = 'total:session-locked'

const ACTIVITY_EVERY_MS = 30_000

/** Why the PIN screen is showing (the simple lock screen says "locked because nothing was done")
 *  and what it asks for (WP 7.2 follow-up: a business without people gets the passphrase or a
 *  plain Unlock; null = not told — the lock screen asks company:current). */
export const useLockReason = create<{
  reason: 'manual' | 'idle' | null
  kind: LockKind | null
  set: (reason: 'manual' | 'idle' | null, kind?: LockKind | null) => void
}>((set) => ({
  reason: null,
  kind: null,
  set: (reason, kind = null) => set({ reason, kind })
}))

function showLocked(reason: 'manual' | 'idle' | null, kind: LockKind | null = null): void {
  const s = useSession.getState()
  if (!s.slug || s.locked) return
  useLockReason.getState().set(reason, kind)
  s.setUser(null)
  s.setLocked(true)
}

/** WP 7.2 follow-up: unlock a business without people (passphrase when it has one). Throws the
 *  structured error (wrong / throttled passphrase) for the lock screen to show. */
export async function unlockNoPeople(passphrase?: string): Promise<void> {
  await api.session.unlock(passphrase)
  useLockReason.getState().set(null)
  useSession.getState().setLocked(false)
}

/** Lock now (⌘L, the header's Lock in a simple company). */
export async function lockNow(onNoUsers: () => void): Promise<void> {
  const s = useSession.getState()
  if (!s.slug || s.locked) return
  try {
    const r = await api.session.lock()
    showLocked('manual', r.kind ?? null)
  } catch (err) {
    if (err instanceof IpcError && err.code === 'lock_needs_people') onNoUsers()
    else if (err instanceof IpcError && err.code === 'session_locked') showLocked(null)
  }
}

export function useSessionLock(): void {
  const t = useT()
  const toast = useToasts()

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'l') {
        const s = useSession.getState()
        if (!s.slug || s.locked) return
        e.preventDefault()
        void lockNow(() => toast.push('info', t('errors.security.lockPrivacyOnly')))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [t, toast])

  useEffect(() => {
    const unsub = window.total?.onSessionLocked?.((e) => showLocked(e.reason, e.kind ?? null))
    const onRefused = (): void => showLocked(null)
    window.addEventListener(SESSION_LOCKED_EVENT, onRefused)
    return () => {
      unsub?.()
      window.removeEventListener(SESSION_LOCKED_EVENT, onRefused)
    }
  }, [])

  useEffect(() => {
    let last = 0
    const onInput = (): void => {
      const s = useSession.getState()
      // A business without people has no user, and its screen lock (WP 7.2 follow-up) runs on the
      // same idle clock — so activity is sent whenever a business is open and unlocked.
      if (!s.slug || s.locked) return
      const now = Date.now()
      if (now - last < ACTIVITY_EVERY_MS) return
      last = now
      void api.session.activity().catch(() => {})
    }
    const opts = { capture: true, passive: true } as const
    window.addEventListener('keydown', onInput, opts)
    window.addEventListener('pointerdown', onInput, opts)
    window.addEventListener('wheel', onInput, opts)
    return () => {
      window.removeEventListener('keydown', onInput, opts)
      window.removeEventListener('pointerdown', onInput, opts)
      window.removeEventListener('wheel', onInput, opts)
    }
  }, [])
}
