// Company mode in the renderer (WP 8.1, plan 2026-10-13 §2.1).
//
// The company's mode comes from meta `ui` (read with the company open payload into the session
// store; missing = accountant). On top of it, any user can open the accountant view of a simple
// screen; that choice is remembered PER SCREEN, PER USER, PER COMPANY in localStorage
// (`total-view:<slug>:<userId|->:<screen>` = 'accountant') — a display preference, never in the
// books. The full screen's "Back to simple" clears it.
//
// WP 9.10: the remembered choice is set ONLY by "Always open the full app for this" (the menu next
// to every simple screen's "Accountant view"); a plain "Accountant view" is a one-off — for a
// screen with both views (Home) a session-only override, for a simple flow just the navigation.
// "Back to simple" clears both, for the screen it lands on and the simple flow it came from.
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

/** One-off "Accountant view" choices (this session only, never stored). */
const sessionOverrides = new Set<string>()

/** The REMEMBERED choice only ("Always open the full app for this"). */
export function readRememberedOverride(slug: string | null, userId: number | null | undefined, screen: Screen['name']): boolean {
  try {
    return localStorage.getItem(viewOverrideKey(slug, userId, screen)) === 'accountant'
  } catch {
    return false
  }
}

export function readViewOverride(slug: string | null, userId: number | null | undefined, screen: Screen['name']): boolean {
  return sessionOverrides.has(viewOverrideKey(slug, userId, screen)) || readRememberedOverride(slug, userId, screen)
}

const useViewVersion = create<{ version: number; bump: () => void }>((set) => ({
  version: 0,
  bump: () => set((s) => ({ version: s.version + 1 }))
}))

/**
 * Set (`on`) or clear this user's accountant-view choice for a screen. `remember` = stored in
 * localStorage ("Always open the full app for this"); otherwise a one-off for this session.
 * Clearing removes both.
 */
export function setViewOverride(
  slug: string | null,
  userId: number | null | undefined,
  screen: Screen['name'],
  on: boolean,
  remember = false
): void {
  const key = viewOverrideKey(slug, userId, screen)
  if (on && !remember) sessionOverrides.add(key)
  else sessionOverrides.delete(key)
  try {
    if (on && remember) localStorage.setItem(key, 'accountant')
    else if (!on) localStorage.removeItem(key)
  } catch {
    /* private mode / quota — the choice still applies until the next render */
  }
  useViewVersion.getState().bump()
}

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
  /** "Accountant view" (true; `remember` = "Always open the full app for this") / "Back to
   *  simple" (false, clears both) for this screen. */
  setAccountantView: (on: boolean, remember?: boolean) => void
}

/** The effective view of a screen: company mode + the screen's modes + this user's override. */
export function useScreenView(name: Screen['name']): ScreenViewState {
  const slug = useSession((s) => s.slug)
  const userId = useSession((s) => s.user?.id)
  const companyMode = useMode()
  useViewVersion((s) => s.version)
  const override = readViewOverride(slug, userId, name)
  const setAccountantView = useCallback((on: boolean, remember = false) => setViewOverride(slug, userId, name, on, remember), [slug, userId, name])
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
