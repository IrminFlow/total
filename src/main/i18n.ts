// Main-process i18n accessor (WP 8.2): strings main produces for the user — print titles,
// plain error messages from services — come from `companyT(db)`, in the COMPANY's language.
//
// The company language is `language` inside meta `ui` (the plan §2.1 mode object; written by
// Settings → "How Total looks" from WP 8.1 on). A missing / unknown value means English, so
// every existing company and backup keeps today's English output. The user's own display
// language is a renderer setting (renderer lib/i18n.ts) and never reaches the books.
//
// Pure apart from the meta read: takes anything with better-sqlite3's prepare/get shape, so the
// unit test runs without the native module.

import { normalizeLanguage, translator, type Language, type Translate } from '@shared/i18n'

export interface MetaReader {
  prepare(sql: string): { get(...params: unknown[]): unknown }
}

export const UI_META_KEY = 'ui'

export function companyLanguage(db: MetaReader): Language {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(UI_META_KEY) as { value: string } | undefined
    if (!row) return 'en'
    const ui = JSON.parse(row.value) as { language?: unknown } | null
    return normalizeLanguage(ui?.language)
  } catch {
    return 'en'
  }
}

/** `t` bound to the company's language. */
export function companyT(db: MetaReader): Translate {
  return translator(companyLanguage(db))
}
