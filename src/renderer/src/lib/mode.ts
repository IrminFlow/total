// Company mode in the renderer (WP 8.1, plan 2026-10-13 §2.1).
//
// The company's mode comes from meta `ui` (read with the company open payload into the session
// store; missing = accountant). On top of it, any user can open the accountant view of a simple
// screen; that choice is remembered PER SCREEN, PER USER, PER COMPANY in localStorage
// (`total-view:<slug>:<userId|->:<screen>` = 'accountant') — a display preference, never in the
// books. The full screen's "Back to simple" clears it.

import { useCallback } from 'react'
import { create } from 'zustand'
import type { UiMode } from '@shared/simple/uiMode'
import { screenView } from './screens'
import { useSession, type Screen } from '../state/stores'

export const VIEW_KEY = 'total-view'

export function viewOverrideKey(slug: string | null, userId: number | null | undefined, screen: Screen['name']): string {
  return `${VIEW_KEY}:${slug ?? '-'}:${userId ?? '-'}:${screen}`
}

export function readViewOverride(slug: string | null, userId: number | null | undefined, screen: Screen['name']): boolean {
  try {
    return localStorage.getItem(viewOverrideKey(slug, userId, screen)) === 'accountant'
  } catch {
    return false
  }
}

const useViewVersion = create<{ version: number; bump: () => void }>((set) => ({
  version: 0,
  bump: () => set((s) => ({ version: s.version + 1 }))
}))

/** The open company's mode (meta `ui`; missing = accountant). */
export function useMode(): UiMode {
  return useSession((s) => s.ui.mode)
}

/** Whether the signed-in user may change the company's mode: the owner, or anyone in a company
 *  without users (the `ui:set` gate). */
export function useCanSetMode(): boolean {
  const user = useSession((s) => s.user)
  return !user || user.role === 'owner'
}

export interface ScreenViewState {
  /** The shell this screen shows in. */
  view: UiMode
  companyMode: UiMode
  /** The user picked "Accountant view" for this screen. */
  override: boolean
  /** "Accountant view" (true) / "Back to simple" (false) for this screen. */
  setAccountantView: (on: boolean) => void
}

/** The effective view of a screen: company mode + the screen's modes + this user's override. */
export function useScreenView(name: Screen['name']): ScreenViewState {
  const slug = useSession((s) => s.slug)
  const userId = useSession((s) => s.user?.id)
  const companyMode = useMode()
  useViewVersion((s) => s.version)
  const override = readViewOverride(slug, userId, name)
  const setAccountantView = useCallback(
    (on: boolean) => {
      try {
        const key = viewOverrideKey(slug, userId, name)
        if (on) localStorage.setItem(key, 'accountant')
        else localStorage.removeItem(key)
      } catch {
        /* private mode / quota — the choice still applies until the next render */
      }
      useViewVersion.getState().bump()
    },
    [slug, userId, name]
  )
  return { view: screenView(companyMode, name, override), companyMode, override, setAccountantView }
}
