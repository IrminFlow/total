// Renderer side of i18n (WP 8.2): the user's language and `useT()`.
//
// The language is a per-user display preference in localStorage, never stored in the books:
// with a company user signed in it is kept per company + user (`total-language:<slug>:<userId>`),
// otherwise app-wide for this Mac (`total-language`), which is also the default a signed-in
// user starts from. Simple-mode screens (src/renderer/src/simple/**) get every string from
// `useT()`; accountant screens keep their literal English (they are not migrated in this plan).

import { useCallback } from 'react'
import { create } from 'zustand'
import { normalizeLanguage, translator, type Language, type Translate } from '@shared/i18n'
import { useSession } from '../state/stores'

export const LANGUAGE_KEY = 'total-language'

export function languageStorageKey(slug: string | null, userId: number | null | undefined): string {
  return slug && userId != null ? `${LANGUAGE_KEY}:${slug}:${userId}` : LANGUAGE_KEY
}

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/** The stored language for this user (falls back to the app-wide choice, then English). */
export function storedLanguage(slug: string | null, userId: number | null | undefined): Language {
  const own = read(languageStorageKey(slug, userId))
  return normalizeLanguage(own ?? read(LANGUAGE_KEY))
}

// A version counter so every useLanguage() re-reads after a change.
const useLanguageVersion = create<{ version: number; bump: () => void }>((set) => ({
  version: 0,
  bump: () => set((s) => ({ version: s.version + 1 }))
}))

/** The language in effect for the signed-in user, and a setter that stores it for them. */
export function useLanguage(): [Language, (lang: Language) => void] {
  const slug = useSession((s) => s.slug)
  const userId = useSession((s) => s.user?.id)
  useLanguageVersion((s) => s.version)
  const language = storedLanguage(slug, userId)
  const setLanguage = useCallback(
    (lang: Language) => {
      try {
        localStorage.setItem(languageStorageKey(slug, userId), lang)
      } catch {
        /* private mode / quota — nothing to keep */
      }
      useLanguageVersion.getState().bump()
    },
    [slug, userId]
  )
  return [language, setLanguage]
}

/** `t` bound to the user's language: `const t = useT(); t('simple.nav.home')`. */
export function useT(): Translate {
  const [language] = useLanguage()
  return useCallback<Translate>((key, vars, options) => translator(language)(key, vars, options), [language])
}
