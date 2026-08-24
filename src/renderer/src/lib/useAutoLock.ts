import { useCallback, useEffect, useRef } from 'react'
import { api } from './client'
import { useSession, useToasts } from '../state/stores'
import { useKeyLayer } from './keyboard'

/**
 * Lock the books when nobody is at the machine, and immediately on request.
 *
 * A laptop left open on a counter shows every customer's balance, every supplier's price and
 * every salary in the payroll. The lock screen already exists and is one click away, which means
 * it protects nothing at the moment it matters: when someone walks away without thinking about
 * it.
 *
 * Only active when the company actually has users. A single-user company has no lock screen to
 * fall back to, and locking one would strand its owner behind a PIN they never set.
 */

/** Idle minutes before the books lock. 0 means never. */
export const AUTO_LOCK_OPTIONS = [0, 5, 15, 30, 60] as const
export type AutoLockMinutes = (typeof AUTO_LOCK_OPTIONS)[number]

/** Activity that counts as "someone is here". Deliberately not `mousemove`: a nudged desk or a
 *  sleeping cat should not keep an unattended machine unlocked all afternoon. */
const ACTIVITY_EVENTS = ['keydown', 'mousedown', 'wheel', 'touchstart'] as const

export function useAutoLock(minutes: number): void {
  const { user, setUser, setLocked } = useSession()
  const toast = useToasts()
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const lockNow = useCallback(
    async (reason: 'idle' | 'panic'): Promise<void> => {
      // Nothing to lock: without users there is no lock screen to fall back to, and locking
      // would strand the owner behind a PIN they never set.
      if (!user) return
      try {
        await api.auth.logout()
        setUser(null)
        setLocked(true)
        if (reason === 'idle') toast.push('info', 'Locked after a period of inactivity')
      } catch (err) {
        toast.push('error', (err as Error).message)
      }
    },
    [user, setUser, setLocked, toast]
  )

  // Ctrl/Cmd+Shift+L locks immediately, from any screen. On the nav layer rather than a screen's,
  // because the one moment it is needed is the moment nobody is thinking about which screen they
  // are on.
  useKeyLayer('nav', (e) => {
    if (!((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'l')) return false
    e.preventDefault()
    void lockNow('panic')
    return true
  })

  useEffect(() => {
    if (!user || minutes <= 0) return

    const reset = (): void => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => void lockNow('idle'), minutes * 60_000)
    }
    reset()
    for (const ev of ACTIVITY_EVENTS) window.addEventListener(ev, reset, { passive: true })
    return () => {
      if (timer.current) clearTimeout(timer.current)
      for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, reset)
    }
  }, [user, minutes, lockNow])
}
