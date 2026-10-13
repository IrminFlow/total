// WP 8.2: the main-side accessor reads the company's language from meta `ui` (missing → en).
import { describe, expect, it } from 'vitest'
import { companyLanguage, companyT, type MetaReader } from './i18n'

function fakeDb(meta: Record<string, string>): MetaReader {
  return {
    prepare: (sql: string) => ({
      get: (key: unknown) => {
        expect(sql).toBe('SELECT value FROM meta WHERE key = ?')
        const value = meta[String(key)]
        return value == null ? undefined : { value }
      }
    })
  }
}

describe('companyLanguage', () => {
  it('missing ui meta, a ui without language, broken JSON or an unknown language → English', () => {
    expect(companyLanguage(fakeDb({}))).toBe('en')
    expect(companyLanguage(fakeDb({ ui: JSON.stringify({ mode: 'simple' }) }))).toBe('en')
    expect(companyLanguage(fakeDb({ ui: '{not json' }))).toBe('en')
    expect(companyLanguage(fakeDb({ ui: JSON.stringify({ language: 'fr' }) }))).toBe('en')
  })

  it('reads ui.language and binds t to it', () => {
    const db = fakeDb({ ui: JSON.stringify({ mode: 'simple', language: 'hi' }) })
    expect(companyLanguage(db)).toBe('hi')
    expect(companyT(db)('simple.home.moneyIn')).toBe('पैसे आए')
    expect(companyT(db)('simple.sell.billOfSupply')).toBe('Bill of supply') // untranslated → en
    expect(companyT(fakeDb({}))('errors.chooseCustomer')).toBe('Choose a customer.')
  })
})
