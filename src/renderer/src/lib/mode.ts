// Company mode in the renderer (WP 8.1, plan 2026-10-13 §2.1).
//
// The company's mode comes from meta `ui` (read with the company open payload into the session
// store; missing = accountant). On top of it, any user can open the accountant view of a simple
// screen; that choice is remembered PER SCREEN, PER USER, PER COMPANY in localStorage
// (`total-view:<slug>:<userId|->:<screen>` = 'accountant') — a display preference, never in the
// books. The full screen's "Back to simple" clears it.
//
// Users: while a company has no users the key's user part is '-'. When users are created later
// those '-' choices are deliberately NOT carried over to anyone — each signed-in user starts from
// the company's mode and makes their own choices (a display preference; nothing to migrate).

import { useCallback } from 'react'
import { create } from 'zustand'
import type { UiMode } from '@shared/simple/uiMode'
import type { Language } from '@shared/i18n'
import { api } from './client'
import { useLanguage } from './i18n'
import { screenView } from './screens'
import { useSession, useToasts, type Screen } from '../state/stores'

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
 *  without users (the `ui:mode:set` gate). */
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

/**
 * The language control (Settings → How Total looks, both shells): the user's own display
 * language, and — for the owner (anyone in a company without users) — also the company language
 * in meta `ui.language`, which `companyT` uses for what main prints.
 */
export function useLanguageChoice(): { language: Language; setLanguage: (lang: Language) => void; setsCompany: boolean } {
  const [language, setUserLanguage] = useLanguage()
  const setsCompany = useCanSetMode()
  const slug = useSession((s) => s.slug)
  const setUi = useSession((s) => s.setUi)
  const toast = useToasts()
  const setLanguage = (lang: Language): void => {
    setUserLanguage(lang)
    if (!setsCompany || !slug) return
    api.ui.set({ language: lang }).then(setUi, (err: Error) => toast.push('error', err.message))
  }
  return { language, setLanguage, setsCompany }
}

/** Re-reads the open company's mode from main into the session (after a backup restore, which can
 *  bring back books in another mode — or a pre-8.1 backup with no `ui` key, i.e. accountant).
 *  `company:current` is ungated, so this works on a restore that locks the company too. */
export async function refreshUiFromMain(): Promise<void> {
  try {
    const cur = await api.company.current()
    if (cur) useSession.getState().setUi(cur.ui)
  } catch {
    /* keep the current mode; the next open reads it again */
  }
}
