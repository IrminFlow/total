// WP 8.2: the plain-language glossary — lookups, and no banned word in what simple mode shows.
import { describe, expect, it } from 'vitest'
import { GLOSSARY, explain, glossaryEntry, plain, type GlossaryEntry } from './glossary'
import { bannedWordsIn } from './bannedWords'

const entries = Object.entries(GLOSSARY) as [string, GlossaryEntry][]

describe('glossary', () => {
  it('plain() and explain() look up by id, term or alias, case-insensitively', () => {
    expect(plain('ledger')).toBe('Account')
    expect(plain('Sundry Debtors')).toBe('Customers who owe you')
    expect(plain('sundry debtors', 'hi')).toBe('लेना बाकी')
    expect(plain('Contra', 'hinglish')).toBe('Move money') // no Hinglish word: English
    expect(plain('ITC')).toBe('GST on purchases you can claim')
    expect(plain('Input tax credit')).toBe('GST on purchases you can claim')
    expect(explain('godown')).toMatch(/place where you keep stock/)
    expect(glossaryEntry('BOM')?.plain).toBe('Recipe / Materials needed')
  })

  it('an unknown term returns itself from plain() and null from explain()', () => {
    expect(plain('Widget')).toBe('Widget')
    expect(explain('Widget')).toBeNull()
  })

  it('no term or alias points at two entries', () => {
    const seen = new Map<string, string>()
    for (const [id, e] of entries) {
      for (const name of new Set([id, e.term, ...(e.aliases ?? [])].map((n) => n.toLowerCase()))) {
        expect(seen.get(name) ?? id, `"${name}" is in ${seen.get(name)} and ${id}`).toBe(id)
        seen.set(name, id)
      }
    }
  })

  it('every entry has a plain word and a one-sentence explanation ending in a full stop', () => {
    for (const [id, e] of entries) {
      expect(e.plain.trim(), id).not.toBe('')
      expect(e.explain, id).toMatch(/[.]$/)
      expect(e.explain.split(/(?<=[.!?])\s+(?=[A-Z])/), `${id} explains in one sentence`).toHaveLength(1)
      expect(e.sources.length, id).toBeGreaterThan(0)
    }
  })

  it('plain words and explanations use no banned word except the entry’s own term', () => {
    const offenders: string[] = []
    for (const [id, e] of entries) {
      const own = [e.term, ...(e.aliases ?? [])]
      for (const text of [e.plain, e.explain]) {
        const words = bannedWordsIn(text, own)
        if (words.length) offenders.push(`${id}: ${words.join(', ')} — "${text}"`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('follows the precision rules: prepared, never filed by Total; Dr/Cr is never money in / out', () => {
    expect(explain('GSTR-1')).toMatch(/prepares/)
    expect(explain('GSTR-3B')).toMatch(/Total prepares it, you file it/)
    expect(plain('Dr / Cr')).not.toMatch(/money/i)
    expect(explain('ITC')).toMatch(/confirms/)
  })
})
