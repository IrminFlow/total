// i18n (WP 8.2): `t(key, vars, lang)` over flat catalogues, ICU-lite syntax (format.ts).
//
// - `en` is complete and the source of every key (catalogues/en.ts); `hi` and `hinglish` are
//   stubs until Phase 10 and fall back to `en` PER KEY.
// - A key that is not in `en` (only possible through an untyped string) never shows raw in
//   production: it renders as '' (or the caller's `fallback`). In dev it renders the key so it is
//   visible, and every problem is reported once through the handler (configureI18n).
// - Pure: no DOM, no Electron. The renderer binds the user's language with `useT()`
//   (renderer lib/i18n.ts); main reads the company's language (main/i18n.ts).
// - Money and Indian digit grouping stay in money.ts: pass amounts in already formatted.

import { en, type MessageKey } from './catalogues/en'
import { hi } from './catalogues/hi'
import { hinglish } from './catalogues/hinglish'
import { formatMessage, MessageSyntaxError, type MessageVars } from './format'

export type { MessageKey } from './catalogues/en'
export type { MessageVars } from './format'
export { en } from './catalogues/en'

export const LANGUAGES = ['en', 'hi', 'hinglish'] as const
export type Language = (typeof LANGUAGES)[number]
export const DEFAULT_LANGUAGE: Language = 'en'

export const CATALOGUES: Record<Language, Partial<Record<MessageKey, string>>> = { en, hi, hinglish }

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value)
}

/** Any stored / sent value → a supported language ('en' for anything unknown). */
export function normalizeLanguage(value: unknown): Language {
  return isLanguage(value) ? value : DEFAULT_LANGUAGE
}

export type I18nProblem =
  | { kind: 'unknown-key'; key: string; lang: Language }
  | { kind: 'untranslated'; key: string; lang: Language }
  | { kind: 'missing-var'; key: string; lang: Language; vars: string[] }
  | { kind: 'syntax'; key: string; lang: Language; message: string }

interface I18nConfig {
  /** Dev build: unknown keys render as the key, and problems are reported. */
  dev: boolean
  /** Where problems go (once per distinct problem). Default: console.warn, except
   *  'untranslated' (expected while hi / hinglish are stubs). */
  report: (problem: I18nProblem) => void
}

const defaultReport = (p: I18nProblem): void => {
  if (p.kind === 'untranslated') return
  console.warn(`[i18n] ${p.kind}: ${p.key} (${p.lang})`, p)
}

let config: I18nConfig = { dev: false, report: defaultReport }
const reported = new Set<string>()

/** Called once at startup by each process (renderer main.tsx, main index.ts). */
export function configureI18n(next: Partial<I18nConfig>): void {
  config = { ...config, ...next }
  reported.clear()
}

function report(problem: I18nProblem): void {
  if (!config.dev) return
  const id = `${problem.kind}|${problem.lang}|${problem.key}`
  if (reported.has(id)) return
  reported.add(id)
  config.report(problem)
}

export interface TOptions {
  /** Shown instead of '' when the key is unknown in production. */
  fallback?: string
}

export type Translate = (key: MessageKey, vars?: MessageVars, options?: TOptions) => string

function render(key: MessageKey, message: string, vars: MessageVars | undefined, lang: Language): string | null {
  try {
    const { text, missingVars } = formatMessage(message, vars, lang)
    if (missingVars.length) report({ kind: 'missing-var', key, lang, vars: missingVars })
    return text
  } catch (e) {
    if (!(e instanceof MessageSyntaxError)) throw e
    report({ kind: 'syntax', key, lang, message })
    return null
  }
}

/** Translates `key` in `lang` (default English), falling back to `en` per key. */
export function t(key: MessageKey, vars?: MessageVars, lang: Language = DEFAULT_LANGUAGE, options?: TOptions): string {
  const own = lang === 'en' ? undefined : CATALOGUES[lang][key]
  if (own != null) {
    const text = render(key, own, vars, lang)
    if (text != null) return text
  } else if (lang !== 'en') {
    report({ kind: 'untranslated', key, lang })
  }
  const base = (en as Record<string, string>)[key]
  if (base == null) {
    report({ kind: 'unknown-key', key, lang })
    return options?.fallback ?? (config.dev ? String(key) : '')
  }
  // English text is rendered with English plural rules (a Hindi plural rule on an English
  // sentence would pick the wrong branch for 0).
  const text = render(key, base, vars, 'en')
  if (text != null) return text
  return options?.fallback ?? (config.dev ? String(key) : '')
}

/** A `t` bound to one language (what `useT()` and the main-side accessor return). */
export function translator(lang: Language): Translate {
  return (key, vars, options) => t(key, vars, lang, options)
}
