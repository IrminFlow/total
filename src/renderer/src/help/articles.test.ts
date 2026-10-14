// WP 10.3: the help articles — every simple screen's helpKey (and every section's) has an English
// article; Hindi falls back to English per article; no banned word in an English article (the
// glossary's plain words only); no raw HTML; every link resolves to a registry screen, another
// article or an allowed government page; search finds by title and body, in en and hi.
import { describe, expect, it } from 'vitest'
import { bannedWordsIn } from '@shared/simple/bannedWords'
import { SCREENS, SECTION_HELP, helpKeyFor } from '../lib/screens'
import { HELP, HELP_ARTICLE_IDS, HELP_FILES, createHelpIndex } from './articles'
import { linksIn, parseInline, parseMarkdown } from './markdown'
import { resolveHelpLink } from './links'

describe('help articles (WP 10.3)', () => {
  it('ships at least 12 English articles, one per id, each with a title and a summary', () => {
    expect(HELP_ARTICLE_IDS.length).toBeGreaterThanOrEqual(12)
    expect([...HELP.ids.en].sort()).toEqual([...HELP_ARTICLE_IDS].sort())
    for (const id of HELP_ARTICLE_IDS) {
      const a = HELP.article(id, 'en')!
      expect(a.title, id).toBeTruthy()
      expect(a.summary.length, id).toBeGreaterThan(20)
    }
    // Every file in en/ is a known article (no orphan file the panel would never list).
    expect(Object.keys(HELP_FILES.en).map((p) => p.replace(/^.*\//, '').replace(/\.md$/, '')).sort()).toEqual([...HELP_ARTICLE_IDS].sort())
  })

  it('every simple screen and every section has a help article in English', () => {
    for (const d of SCREENS.filter((s) => s.modes.includes('simple'))) {
      expect(d.helpKey, d.name).toBeDefined()
      expect(HELP.article(d.helpKey!, 'en'), `${d.name} → ${d.helpKey}`).not.toBeNull()
    }
    for (const [section, id] of Object.entries(SECTION_HELP)) expect(HELP.article(id, 'en'), section).not.toBeNull()
    expect(helpKeyFor({ name: 'simple-section', section: 'money' })).toBe('money-in-out')
    expect(helpKeyFor({ name: 'gateway' })).toBe('getting-started')
    expect(helpKeyFor({ name: 'simple-taxes' })).toBe('gst')
    // A full-app screen opened from a simple section gets that section's article.
    expect(helpKeyFor({ name: 'company-info' })).toBe('settings')
  })

  it('Hindi falls back to English per article; a Hindi article wins when there is one', () => {
    expect(HELP.article('gst', 'hi')!.lang).toBe(HELP.ids.hi.includes('gst') ? 'hi' : 'en')
    const idx = createHelpIndex(
      { './en/gst.md': '# GST in plain words\n\nEnglish body about tax.', './en/backups.md': '# Backups\n\nKeep a copy.' },
      { './hi/gst.md': '# जीएसटी\n\nकर के बारे में।', './hi/backups.md': '   ' }
    )
    expect(idx.article('gst', 'hi')).toMatchObject({ lang: 'hi', title: 'जीएसटी' })
    expect(idx.article('gst', 'en')).toMatchObject({ lang: 'en', title: 'GST in plain words' })
    expect(idx.article('gst', 'hinglish')).toMatchObject({ lang: 'en' })
    // An empty Hindi file is not a translation.
    expect(idx.article('backups', 'hi')).toMatchObject({ lang: 'en', title: 'Backups' })
    // Search covers both languages; the hit is shown in the reader's language.
    expect(idx.search('कर', 'en').map((h) => h.article.id)).toEqual(['gst'])
    expect(idx.search('tax', 'hi')[0]).toMatchObject({ article: { id: 'gst', lang: 'hi' } })
    expect(idx.article('nope', 'en')).toBeNull()
  })

  it('no English article uses a banned word, and none holds raw HTML', () => {
    for (const [path, raw] of Object.entries(HELP_FILES.en)) {
      expect(bannedWordsIn(raw), path).toEqual([])
      expect(/<\/?[a-zA-Z!][^>]*>/.test(raw), `${path}: raw HTML`).toBe(false)
    }
  })

  it('every link in every article resolves (screen, article or an allowed government page)', () => {
    for (const lang of ['en', 'hi'] as const) {
      for (const a of HELP.list(lang)) {
        for (const href of linksIn(a.blocks)) {
          const r = resolveHelpLink(href)
          expect(r.kind, `${a.id} (${lang}): ${href}`).not.toBe('invalid')
        }
      }
    }
    // Spot checks: the kinds, and what is refused.
    expect(resolveHelpLink('total://screen/simple-sell')).toEqual({ kind: 'screen', screen: { name: 'simple-sell' } })
    expect(resolveHelpLink('total://screen/simple-section?section=money')).toEqual({ kind: 'screen', screen: { name: 'simple-section', section: 'money' } })
    expect(resolveHelpLink('total://screen/simple-stock?filter=low')).toEqual({ kind: 'screen', screen: { name: 'simple-stock', filter: 'low' } })
    expect(resolveHelpLink('total://screen/settings?tab=backups')).toEqual({ kind: 'screen', screen: { name: 'settings', tab: 'backups' } })
    expect(resolveHelpLink('total://help/gst')).toEqual({ kind: 'help', id: 'gst' })
    expect(resolveHelpLink('https://www.gst.gov.in')).toEqual({ kind: 'external', url: 'https://www.gst.gov.in' })
    for (const bad of ['total://screen/nope', 'total://screen/simple-person', 'total://screen/simple-section?section=x', 'total://screen/simple-sell?id=3', 'total://help/nope', 'https://example.com', 'javascript:alert(1)']) {
      expect(resolveHelpLink(bad).kind, bad).toBe('invalid')
    }
  })

  it('search finds by title and by body', () => {
    expect(HELP.search('backup')[0]!.article.id).toBe('backups')
    expect(HELP.search('bank statement')[0]!.article.id).toBe('bank-statement')
    expect(HELP.search('GSTR-3B').map((h) => h.article.id)).toContain('gst')
    // A word only in the body (the overdraft line of the day-one article).
    expect(HELP.search('overdraft').map((h) => h.article.id)).toContain('day-one')
    expect(HELP.search('zzzz')).toEqual([])
    expect(HELP.search('')).toEqual([])
  })
})

describe('the help markdown (safe subset)', () => {
  it('parses headings, paragraphs, lists, bold and links — and keeps anything else as text', () => {
    const blocks = parseMarkdown('# T\n\nA **bold** [link](total://help/gst) line\nwrapped.\n\n- one\n- two\n\n1. first\n2. second\n\n<b>x</b>')
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'para', 'list', 'list', 'para'])
    expect(blocks[1]).toEqual({
      kind: 'para',
      children: [
        { kind: 'text', text: 'A ' },
        { kind: 'bold', children: [{ kind: 'text', text: 'bold' }] },
        { kind: 'text', text: ' ' },
        { kind: 'link', href: 'total://help/gst', children: [{ kind: 'text', text: 'link' }] },
        { kind: 'text', text: ' line wrapped.' }
      ]
    })
    expect(blocks[2]).toMatchObject({ kind: 'list', ordered: false })
    expect(blocks[3]).toMatchObject({ kind: 'list', ordered: true })
    // HTML is just characters.
    expect(blocks[4]).toEqual({ kind: 'para', children: [{ kind: 'text', text: '<b>x</b>' }] })
    expect(parseInline('**unclosed and [broken](')).toEqual([{ kind: 'text', text: '**unclosed and [broken](' }])
  })
})
