// Renderer side of i18n (WP 8.2): the user's language and `useT()`.
//
// The language is a per-user display preference in localStorage, never stored in the books:
// with a company user signed in it is kept per company + user (`total-language:<slug>:<userId>`),
// otherwise app-wide for this Mac (`total-language`), which is also the default a signed-in
// user starts from. Simple-mode screens (src/renderer/src/simple/**) get every string from
// `useT()`; accountant screens keep their literal English (they are not migrated in this plan).
//
// Perf (to-do, after #135): only `en` is in the startup bundle. `hi` / `hinglish` are their own
// chunks (dynamic imports below). main.tsx awaits `preloadCatalogues()` BEFORE the first render
// for every language stored on this Mac (app-wide or any user's; the OS suggestion when nothing
// is stored — the wizard's start-in-Hindi rule), so a Hindi user never sees English first; a
// switch to a language not loaded yet keeps the old one until its chunk arrives
// (`useLanguagePending` lets a picker say "loading"). Never import '@shared/i18n/all' here.

import { useCallback, useEffect, useMemo } from 'react'
import { create } from 'zustand'
import {
  isCatalogueLoaded, normalizeLanguage, registerCatalogue, translator, type Catalogue, type Language, type Translate
} from '@shared/i18n'
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

/** WP 10.4: has anyone chosen a language on this Mac yet (app-wide, or for this user)? */
export function hasStoredLanguage(slug: string | null = null, userId: number | null | undefined = null): boolean {
  return read(languageStorageKey(slug, userId)) != null || read(LANGUAGE_KEY) != null
}

/** WP 10.4: the language the operating system suggests — Hindi for a hi / hi-IN locale, else
 *  null (English needs no suggestion). The PRIMARY locale only (Hindi listed second is not a choice). Only the first-run wizard uses it, before anything is
 *  stored, so an existing user's screens never change language on their own. */
export function osLanguage(locale: string | undefined = typeof navigator === 'undefined' ? undefined : navigator.language): Language | null {
  return /^hi(?:[-_]|$)/i.test(locale ?? '') ? 'hi' : null
}

// A version counter so every useLanguage() re-reads after a change (a choice or a chunk loaded);
// `pending` = a chosen language whose catalogue is still loading.
const useLanguageVersion = create<{ version: number; pending: Language | null; bump: () => void }>((set) => ({
  version: 0,
  pending: null,
  bump: () => set((s) => ({ version: s.version + 1 }))
}))

type LazyLanguage = Exclude<Language, 'en'>
const defaultLoaders: Record<LazyLanguage, () => Promise<Catalogue>> = {
  hi: () => import('@shared/i18n/catalogues/hi').then((m) => m.hi),
  hinglish: () => import('@shared/i18n/catalogues/hinglish').then((m) => m.hinglish)
}
let loaders = { ...defaultLoaders }
const inflight = new Map<Language, Promise<void>>()

/** Tests only: replace a catalogue's loader (null = the real dynamic import). */
export function setCatalogueLoaderForTests(lang: LazyLanguage, loader: (() => Promise<Catalogue>) | null): void {
  loaders = { ...loaders, [lang]: loader ?? defaultLoaders[lang] }
  inflight.delete(lang)
}

/** Loads (once) and registers `lang`'s catalogue; resolves at once when it is there already.
 *  A failed load is not cached (the next call tries again); `t()` shows English meanwhile. */
export function loadCatalogue(lang: Language): Promise<void> {
  if (lang === 'en' || isCatalogueLoaded(lang)) return Promise.resolve()
  let running = inflight.get(lang)
  if (!running) {
    running = loaders[lang]()
      .then((catalogue) => {
        registerCatalogue(lang, catalogue)
        useLanguageVersion.getState().bump()
      })
      .finally(() => inflight.delete(lang))
    inflight.set(lang, running)
  }
  return running
}

/** Every language that may be on screen first: each stored choice (app-wide and every user's on
 *  this Mac — a sign-in must not flash English either), plus the OS suggestion while no app-wide
 *  choice is stored — the wizard's own condition (`hasStoredLanguage()` with no user), so a
 *  wizard that starts in Hindi beside a user's stored English does not flash English first. */
export function languagesToPreload(): Language[] {
  const found = new Set<Language>()
  let appWide = false
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key !== LANGUAGE_KEY && !key?.startsWith(`${LANGUAGE_KEY}:`)) continue
      if (key === LANGUAGE_KEY) appWide = true
      found.add(normalizeLanguage(localStorage.getItem(key)))
    }
  } catch {
    /* no storage: English */
  }
  if (!appWide) {
    const os = osLanguage()
    if (os) found.add(os)
  }
  found.delete('en')
  return [...found]
}

/** The bound on how long the first paint waits for a catalogue (then English shows, and the
 *  screen switches when the chunk arrives). Loading a local chunk takes a few ms. */
export const PRELOAD_TIMEOUT_MS = 2000

/** Before the first render (main.tsx): load the catalogues `languagesToPreload` names, waiting
 *  at most `timeoutMs`. Never rejects. Marks `total:catalogues` for scripts/perf-launch.mjs. */
export async function preloadCatalogues(timeoutMs: number = PRELOAD_TIMEOUT_MS): Promise<Language[]> {
  const langs = languagesToPreload()
  if (!langs.length) return langs
  const started = typeof performance !== 'undefined' ? performance.now() : 0
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    Promise.allSettled(langs.map(loadCatalogue)),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    })
  ])
  clearTimeout(timer)
  try {
    performance.measure('total:catalogues', { start: started, end: performance.now() })
  } catch {
    /* old engines / jsdom without measure options */
  }
  return langs
}

/** A language a component shows OTHER than the user's own (the reminder panel's language chips):
 *  loads its catalogue (once — `loadCatalogue`) and re-renders when it arrives. Returns whether
 *  it is there; while it is not, `t()` / `translator(lang)` would give English, so the caller
 *  keeps what it showed and says "Loading the language…" (never English text under a Hindi /
 *  Hinglish label). A cached catalogue is ready on the first render. */
export function useCatalogue(lang: Language): boolean {
  useLanguageVersion((s) => s.version)
  const ready = isCatalogueLoaded(lang)
  useEffect(() => {
    if (!ready) loadCatalogue(lang).catch(() => {})
  }, [lang, ready])
  return ready
}

/** The language in effect for the signed-in user, and a setter that stores it for them.
 *  Choosing a language whose catalogue is not loaded keeps the current one on screen until it
 *  is (see `useLanguagePending`). */
export function useLanguage(): [Language, (lang: Language) => void] {
  const slug = useSession((s) => s.slug)
  const userId = useSession((s) => s.user?.id)
  useLanguageVersion((s) => s.version)
  const language = storedLanguage(slug, userId)
  const ready = isCatalogueLoaded(language)
  useEffect(() => {
    // Stored but not preloaded (e.g. a timed-out first paint): load it now; English meanwhile.
    if (!ready) loadCatalogue(language).catch(() => {})
  }, [language, ready])
  const setLanguage = useCallback(
    (lang: Language) => {
      const store = (): void => {
        try {
          localStorage.setItem(languageStorageKey(slug, userId), lang)
        } catch {
          /* private mode / quota — nothing to keep */
        }
        useLanguageVersion.getState().bump()
      }
      if (isCatalogueLoaded(lang)) {
        useLanguageVersion.setState({ pending: null })
        store()
        return
      }
      useLanguageVersion.setState({ pending: lang })
      const done = (): void => {
        // A later choice wins: only the language still pending is stored.
        if (useLanguageVersion.getState().pending !== lang) return
        useLanguageVersion.setState({ pending: null })
        store()
      }
      // A chunk that fails to load still stores the choice: English shows, the next start retries.
      loadCatalogue(lang).then(done, done)
    },
    [slug, userId]
  )
  return [language, setLanguage]
}

/** The language a picker just chose whose catalogue is still loading (null otherwise) — the
 *  picker shows a short "loading" note only then (a cached chunk switches at once). */
export function useLanguagePending(): Language | null {
  return useLanguageVersion((s) => s.pending)
}

/** `t` bound to the user's language: `const t = useT(); t('simple.nav.home')`. */
export function useT(): Translate {
  const [language] = useLanguage()
  // A new `t` once the catalogue arrives (a late load after a timed-out first paint), so memos
  // keyed on `t` (kit labels, column lists) re-run instead of keeping the English fallback.
  const loaded = isCatalogueLoaded(language)
  return useMemo<Translate>(() => translator(language), [language, loaded])
}
