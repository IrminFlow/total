/// <reference types="vite/client" />
// WP 10.3: the offline help — markdown articles under ./en (+ ./hi translations, WP 10.4), bundled
// at BUILD time by Vite's import.meta.glob (no runtime file access, no network). An article's id
// is its file name; its title is the first "# " heading and its summary the first paragraph.
// Hindi (./hi, all articles) and Hinglish (./hinglish, WP 10.4: the most-used ones) fall back to
// English per article (a missing or empty file); the panel says so. Search covers the title and
// body of every language loaded so far (a search loads them all — `loadHelpLanguages`).
import type { Language } from '@shared/i18n'
import { blocksText, inlineText, parseMarkdown, type Block } from './markdown'

const EN_FILES = import.meta.glob('./en/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
// Hindi / Hinglish are lazy chunks (one per language, hiFiles.ts / hinglishFiles.ts): until one
// lands its readers get the English article (never blank), and `HELP` re-reads once it has.

/** A language with its own help files. */
export type HelpLanguage = 'en' | 'hi' | 'hinglish'

/** Every article, in the order the help panel lists them. */
export const HELP_ARTICLE_IDS = [
  'getting-started',
  'make-a-bill',
  'record-a-purchase',
  'money-in-out',
  'returns',
  'bank-statement',
  'stock-and-count',
  'made-goods',
  'people-and-reminders',
  'reports',
  'gst',
  'day-one',
  'backups',
  'accountant-view',
  'settings',
  'keyboard-shortcuts',
  // WP 7.3: what differs on Windows (keys, the data folder, SmartScreen, file names).
  'windows'
] as const
export type HelpArticleId = (typeof HELP_ARTICLE_IDS)[number]

export const isHelpArticleId = (s: string): s is HelpArticleId => (HELP_ARTICLE_IDS as readonly string[]).includes(s)

export interface HelpArticle {
  id: HelpArticleId
  /** The language the text is in (a Hindi / Hinglish reader may get 'en' — the fallback). */
  lang: HelpLanguage
  title: string
  summary: string
  /** The article without its title heading. */
  blocks: Block[]
  /** Title + body as plain text (search). */
  text: string
}

export interface HelpSearchHit {
  article: HelpArticle
  snippet: string
  score: number
}

function parseArticle(id: HelpArticleId, lang: HelpLanguage, raw: string): HelpArticle | null {
  const all = parseMarkdown(raw)
  const head = all[0]
  if (!head || head.kind !== 'heading' || head.level !== 1) return null
  const blocks = all.slice(1)
  const first = blocks.find((b) => b.kind === 'para')
  const title = inlineText(head.children).trim()
  if (!title) return null
  return { id, lang, title, summary: first && first.kind === 'para' ? inlineText(first.children) : '', blocks, text: `${title}\n${blocksText(blocks)}` }
}

const fileId = (path: string): string => path.replace(/^.*\//, '').replace(/\.md$/, '')

/** Search words: lower case; Latin accents dropped (café = cafe); Devanagari vowel signs and
 *  virama (\p{M}) kept INSIDE the word — splitting on them broke "बिल" into single letters. */
export const words = (s: string): string[] =>
  s
    .normalize('NFD')
    .replace(/(\p{Script=Latin})\p{M}+/gu, '$1')
    .normalize('NFC')
    .toLowerCase()
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter((w) => [...w].length >= 2)

export interface HelpIndex {
  /** The article in `lang` (English when not translated); null for an unknown id. */
  article: (id: string, lang?: Language) => HelpArticle | null
  list: (lang?: Language) => HelpArticle[]
  search: (query: string, lang?: Language, limit?: number) => HelpSearchHit[]
  /** Ids with a file in each language (tests). */
  ids: { en: string[]; hi: string[]; hinglish: string[] }
}

/** Build the index from file contents keyed by path (`./en/<id>.md`). Pure — tests pass fixtures. */
export function createHelpIndex(enFiles: Record<string, string>, hiFiles: Record<string, string>, hinglishFiles: Record<string, string> = {}): HelpIndex {
  const load = (files: Record<string, string>, lang: HelpLanguage): Map<HelpArticleId, HelpArticle> => {
    const m = new Map<HelpArticleId, HelpArticle>()
    for (const [path, raw] of Object.entries(files)) {
      const id = fileId(path)
      if (!isHelpArticleId(id) || !raw.trim()) continue
      const a = parseArticle(id, lang, raw)
      if (a) m.set(id, a)
    }
    return m
  }
  const en = load(enFiles, 'en')
  const hi = load(hiFiles, 'hi')
  const hinglish = load(hinglishFiles, 'hinglish')
  const article = (id: string, lang: Language = 'en'): HelpArticle | null => {
    if (!isHelpArticleId(id)) return null
    return (lang === 'hi' ? hi.get(id) : lang === 'hinglish' ? hinglish.get(id) : undefined) ?? en.get(id) ?? null
  }
  const list = (lang: Language = 'en'): HelpArticle[] => HELP_ARTICLE_IDS.map((id) => article(id, lang)).filter((a): a is HelpArticle => !!a)
  const search = (query: string, lang: Language = 'en', limit = 8): HelpSearchHit[] => {
    const q = [...new Set(words(query))]
    if (!q.length) return []
    const hits: HelpSearchHit[] = []
    for (const id of HELP_ARTICLE_IDS) {
      const versions = [en.get(id), hi.get(id), hinglish.get(id)].filter((a): a is HelpArticle => !!a)
      if (!versions.length) continue
      let score = 0
      for (const w of q) {
        const stem = w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w
        let best = 0
        for (const v of versions) {
          const title = words(v.title)
          const body = words(v.text)
          const inTitle = title.some((t) => t === w || t === stem || t.startsWith(stem))
          const count = body.filter((t) => t === w || t === stem || (stem.length >= 4 && t.startsWith(stem))).length
          best = Math.max(best, (inTitle ? 6 : 0) + Math.min(count, 5))
        }
        score += best
      }
      if (score <= 0) continue
      const shown = article(id, lang)!
      hits.push({ article: shown, snippet: snippetFor(shown, q), score })
    }
    return hits.sort((a, b) => b.score - a.score || HELP_ARTICLE_IDS.indexOf(a.article.id) - HELP_ARTICLE_IDS.indexOf(b.article.id)).slice(0, limit)
  }
  return { article, list, search, ids: { en: [...en.keys()], hi: [...hi.keys()], hinglish: [...hinglish.keys()] } }
}

/** The first sentence of the article that mentions a query word (else its summary), ≤ 160 chars. */
function snippetFor(a: HelpArticle, q: string[]): string {
  const sentences = blocksText(a.blocks)
    .split(/(?<=[.!?])\s+|\n/)
    .map((s) => s.trim())
    .filter(Boolean)
  const found = sentences.find((s) => {
    const w = words(s)
    return q.some((x) => w.some((y) => y === x || (x.length >= 4 && y.startsWith(x.replace(/s$/, '')))))
  })
  const s = found ?? a.summary
  return s.length > 160 ? `${s.slice(0, 157).trimEnd()}…` : s
}

/** The non-English languages with their own help files (each its own chunk). */
export const LAZY_HELP_LANGUAGES = ['hi', 'hinglish'] as const
export type LazyHelpLanguage = (typeof LAZY_HELP_LANGUAGES)[number]

const loaded: Partial<Record<LazyHelpLanguage, Record<string, string>>> = {}
const pending = new Map<LazyHelpLanguage, Promise<void>>()
const listeners = new Set<() => void>()
let version = 0
let current: HelpIndex = createHelpIndex(EN_FILES, {}, {})

const isLazy = (lang: Language | string): lang is LazyHelpLanguage => (LAZY_HELP_LANGUAGES as readonly string[]).includes(lang)

/** True once `lang`'s articles are in the index (English always is). */
export const isHelpLanguageLoaded = (lang: Language | string): boolean => !isLazy(lang) || !!loaded[lang]

/** Load one language's articles (a no-op for English or once loaded); listeners hear when it lands. */
export function loadHelpLanguage(lang: Language | string): Promise<void> {
  if (!isLazy(lang) || loaded[lang]) return Promise.resolve()
  const running = pending.get(lang)
  if (running) return running
  const p = (lang === 'hi' ? import('./hiFiles').then((m) => m.HI_FILES) : import('./hinglishFiles').then((m) => m.HINGLISH_FILES))
    .then((files) => {
      loaded[lang] = files
      current = createHelpIndex(EN_FILES, loaded.hi ?? {}, loaded.hinglish ?? {})
      version++
      for (const l of listeners) l()
    })
    .finally(() => pending.delete(lang))
  pending.set(lang, p)
  return p
}

/** Every language (search covers them all). */
export const loadHelpLanguages = (): Promise<void> => Promise.all(LAZY_HELP_LANGUAGES.map(loadHelpLanguage)).then(() => undefined)

/** For useSyncExternalStore: a number that changes whenever a language lands. */
export const helpVersion = (): number => version
export function subscribeHelp(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** The app's help: English bundled in the entry, Hindi / Hinglish as they load. */
export const HELP: HelpIndex = {
  article: (id, lang) => current.article(id, lang),
  list: (lang) => current.list(lang),
  search: (query, lang, limit) => current.search(query, lang, limit),
  get ids() {
    return current.ids
  }
}

/** The English files (tests lint them; the translations are imported from hiFiles / hinglishFiles). */
export const HELP_FILES = { en: EN_FILES }
