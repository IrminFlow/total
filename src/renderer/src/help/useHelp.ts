// #148: the help articles in a language, loading its lazy chunk on first use. Returns whether the
// language (or, with `all`, every language — search covers them all) has landed; the index itself
// is `HELP`, which answers in English until then. Components re-render when a chunk lands.
import { useEffect, useSyncExternalStore } from 'react'
import type { Language } from '@shared/i18n'
import { LAZY_HELP_LANGUAGES, helpVersion, isHelpLanguageLoaded, loadHelpLanguage, loadHelpLanguages, subscribeHelp } from './articles'

export function useHelpLanguage(lang: Language, all = false): boolean {
  useSyncExternalStore(subscribeHelp, helpVersion, helpVersion)
  const ready = all ? LAZY_HELP_LANGUAGES.every(isHelpLanguageLoaded) : isHelpLanguageLoaded(lang)
  useEffect(() => {
    if (ready) return
    ;(all ? loadHelpLanguages() : loadHelpLanguage(lang)).catch(() => {
      /* offline bundle: a failed chunk keeps the English articles on screen */
    })
  }, [lang, all, ready])
  return ready
}
