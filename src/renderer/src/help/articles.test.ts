// WP 10.3: the help articles — every simple screen's helpKey (and every section's) has an English
// article; Hindi falls back to English per article; no banned word in an English article (the
// glossary's plain words only); no raw HTML; every link resolves to a registry screen, another
// article or an allowed government page; search finds by title and body, in en and hi.
import { describe, expect, it } from 'vitest'
import { bannedWordsIn } from '@shared/simple/bannedWords'
import { SCREENS, SECTION_HELP, helpKeyFor } from '../lib/screens'
import { HELP as LAZY_HELP, HELP_ARTICLE_IDS, HELP_FILES as EN_ONLY, createHelpIndex, isHelpLanguageLoaded, loadHelpLanguage, loadHelpLanguages } from './articles'
import { HI_FILES } from './hiFiles'
import { HINGLISH_FILES } from './hinglishFiles'
import { linksIn, parseInline, parseMarkdown } from './markdown'
import { resolveHelpLink } from './links'
import { en } from '@shared/i18n/catalogues/en'
import { STATEMENT_EXTENSIONS } from '@shared/simple/bank'

// #146: Hindi / Hinglish are lazy chunks in the app; the tests read all three sets directly.
const HELP_FILES = { ...EN_ONLY, hi: HI_FILES, hinglish: HINGLISH_FILES }
const HELP = createHelpIndex(HELP_FILES.en, HELP_FILES.hi, HELP_FILES.hinglish)

describe('lazy translations (#146)', () => {
  it('the app index answers in English until a language lands, then in that language', async () => {
    // (This must run before anything else loads the chunks in this file's module instance.)
    expect(isHelpLanguageLoaded('en')).toBe(true)
    expect(isHelpLanguageLoaded('hi')).toBe(false)
    expect(LAZY_HELP.article('gst', 'hi')).toMatchObject({ id: 'gst', lang: 'en' })
    expect(LAZY_HELP.ids.hi).toEqual([])
    await loadHelpLanguage('hi')
    expect(isHelpLanguageLoaded('hi')).toBe(true)
    expect(isHelpLanguageLoaded('hinglish')).toBe(false)
    expect(LAZY_HELP.article('gst', 'hi')).toMatchObject({ id: 'gst', lang: 'hi' })
    expect(LAZY_HELP.article('gst', 'hinglish')).toMatchObject({ lang: 'en' })
    await loadHelpLanguages()
    expect(LAZY_HELP.article('gst', 'hinglish')).toMatchObject({ lang: 'hinglish' })
    expect(LAZY_HELP.ids).toEqual(HELP.ids)
  })
})

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
          // Per screen: every parameter is one that screen knows (nothing dropped).
          expect(r.kind === 'screen' ? (r.dropped ?? []) : [], `${a.id} (${lang}): ${href}`).toEqual([])
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
    for (const bad of ['total://screen/nope', 'total://screen/simple-person', 'total://screen/simple-section?section=x', 'total://screen/simple-section', 'total://help/nope', 'https://example.com', 'javascript:alert(1)']) {
      expect(resolveHelpLink(bad).kind, bad).toBe('invalid')
    }
  })

  it('the bank texts promise only the statement files Bank reads (review: no PDF while there is no PDF reader)', () => {
    const pdf = (STATEMENT_EXTENSIONS as readonly string[]).includes('pdf')
    if (!pdf) {
      expect(en['simple.empty.bank']).not.toMatch(/PDF/)
      expect(en['assist.howto.bank']).not.toMatch(/PDF/)
      const raw = HELP_FILES.en['./en/bank-statement.md']!
      for (const line of raw.split('\n').filter((l) => /PDF/.test(l))) expect(line).toMatch(/PDF statements cannot be read yet/)
    }
  })

  it('search finds by title and by body', () => {
    expect(HELP.search('backup')[0]!.article.id).toBe('backups')
    expect(HELP.search('bank statement')[0]!.article.id).toBe('bank-statement')
    expect(HELP.search('GSTR-3B').map((h) => h.article.id)).toContain('gst')
    // A word only in the body (the overdraft line of the day-one article).
    expect(HELP.search('overdraft').map((h) => h.article.id)).toContain('day-one')
    expect(HELP.search('zzzz')).toEqual([])
    // Review: Devanagari words keep their vowel signs (\p{M}) — "बिल" was split into single
    // letters and found nothing; Latin accents are ignored; a partial word finds the article.
    const idx = createHelpIndex(
      { './en/make-a-bill.md': '# Make a bill\n\nSell to a café customer.', './en/gst.md': '# GST\n\nTax.' },
      { './hi/make-a-bill.md': '# बिल बनाएँ\n\nग्राहक को बिल दें, उधार या नकद।' }
    )
    expect(idx.search('बिल', 'hi').map((h) => h.article.id)).toEqual(['make-a-bill'])
    expect(idx.search('उधार', 'hi').map((h) => h.article.id)).toEqual(['make-a-bill'])
    expect(idx.search('ग्राहक', 'en').map((h) => h.article.id)).toEqual(['make-a-bill'])
    expect(idx.search('cafe', 'en').map((h) => h.article.id)).toEqual(['make-a-bill'])
    expect(idx.search('custom', 'en').map((h) => h.article.id)).toEqual(['make-a-bill'])
    // The app's own word for credit sales (the "Paid how?" choice) finds Make a bill.
    expect(HELP.search('udhaar')[0]!.article.id).toBe('make-a-bill')
    expect(HELP.search('')).toEqual([])
  })
})

describe('help in Hindi and Hinglish (WP 10.4)', () => {
  // The six most used + WP 7.3's Windows article.
  const HINGLISH_SIX = ['getting-started', 'make-a-bill', 'record-a-purchase', 'money-in-out', 'bank-statement', 'gst', 'windows']
  const linkTargets = (raw: string): string[] => [...raw.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]!).sort()

  it('every article is in Hindi; the six most used (and Windows) are in Hinglish; the rest fall back to English', () => {
    expect([...HELP.ids.hi].sort()).toEqual([...HELP_ARTICLE_IDS].sort())
    expect([...HELP.ids.hinglish].sort()).toEqual([...HINGLISH_SIX].sort())
    for (const id of HELP_ARTICLE_IDS) {
      expect(HELP.article(id, 'hi')!.lang, id).toBe('hi')
      expect(HELP.article(id, 'hinglish')!.lang, id).toBe(HINGLISH_SIX.includes(id) ? 'hinglish' : 'en')
    }
  })

  it('translations keep every link of the English article, no banned word, the right script, no raw HTML', () => {
    for (const lang of ['hi', 'hinglish'] as const) {
      for (const [path, raw] of Object.entries(HELP_FILES[lang])) {
        const id = path.replace(/^.*\//, '').replace(/\.md$/, '')
        expect(linkTargets(raw), `${lang}/${id} links`).toEqual(linkTargets(HELP_FILES.en[`./en/${id}.md`]!))
        expect(bannedWordsIn(raw), `${lang}/${id}`).toEqual([])
        expect(/<\/?[a-zA-Z!][^>]*>/.test(raw), `${lang}/${id}: raw HTML`).toBe(false)
        if (lang === 'hinglish') expect(/[\u0900-\u097F]/.test(raw), `${id}: Devanagari in Hinglish`).toBe(false)
        else expect(/[\u0900-\u097F]/.test(raw), `${id}: Hindi in Devanagari`).toBe(true)
      }
    }
    for (const lang of ['hinglish'] as const) {
      for (const a of HELP.list(lang)) {
        for (const href of linksIn(a.blocks)) {
          const r = resolveHelpLink(href)
          expect(r.kind, `${a.id} (${lang}): ${href}`).not.toBe('invalid')
          expect(r.kind === 'screen' ? (r.dropped ?? []) : [], `${a.id} (${lang}): ${href}`).toEqual([])
        }
      }
    }
  })

  it('search finds Hindi and Hinglish words and shows the reader’s language', () => {
    const hits = HELP.search('उधार', 'hi')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.article.lang).toBe('hi')
    expect(HELP.search('बैंक', 'hi').map((h) => h.article.id)).toContain('bank-statement')
    expect(HELP.search('GST', 'hinglish')[0]!.article).toMatchObject({ id: 'gst', lang: 'hinglish' })
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
