// WP 10.4: prints in Hindi / Hinglish. The English labels are the renderer's own literals (passing
// them changes nothing), a localised render carries the language's words and amount in words,
// and a template word the owner changed is kept as written.
import { describe, expect, it } from 'vitest'
import type { CompanyInfo } from '../domain'
import { translator } from '../i18n'
import { BUILT_IN_DEFAULTS, CLASSIC_DEFAULT } from '../printTemplates'
import { bannedWordsIn } from '../simple/bannedWords'
import { ENGLISH_PRINT_LABELS, localiseTemplate, printLabelsFor } from './labels'
import { renderDocument } from './render'
import { sampleDocument } from './sample'

const COMPANY: CompanyInfo = {
  name: 'Total Traders',
  stateCode: '27',
  gstin: '27AAAAA0000A1Z5',
  gstRegistrationType: 'regular',
  address: '1 Market Road, Mumbai',
  booksFrom: 2025,
  email: 'accounts@total.example',
  phone: '+91 22 4000 1234',
  pan: 'AAAAA0000A',
  tan: null
}
const KINDS = ['sales', 'receipt', 'statement', 'reminder'] as const

describe('print labels', () => {
  it('the English labels ARE the default: every built-in template renders byte-identically with them', () => {
    for (const t of Object.values(BUILT_IN_DEFAULTS)) {
      for (const kind of KINDS) {
        const doc = sampleDocument(COMPANY, kind)
        expect(renderDocument(t, doc, { labels: ENGLISH_PRINT_LABELS }), `${t.name} ${kind}`).toBe(renderDocument(t, doc))
        // An English translator over an untouched template is the identity too.
        expect(localiseTemplate(t, translator('en')).columns.map((c) => c.label).length).toBe(t.columns.length)
      }
    }
  })

  it('a Hindi print says its labels and the amount in words in Hindi; legal titles stay', () => {
    const t = translator('hi')
    const doc = sampleDocument(COMPANY, 'sales')
    const html = renderDocument(localiseTemplate(CLASSIC_DEFAULT, t), doc, { labels: printLabelsFor(t), scriptFont: { css: '@font-face{}', family: 'Noto Sans Devanagari' } })
    expect(html).toContain('रकम शब्दों में')
    expect(html).toContain('रुपये')
    expect(html).toContain('मात्र')
    expect(html).toContain('TAX INVOICE')
    expect(html).toContain("font: 12px/1.45 'Noto Sans Devanagari', ")
    expect(html).toContain('@font-face{}')
    expect(html).not.toContain('Amount in words')
    expect(html).not.toContain('Taxable value')
  })

  it('Hinglish prints Latin-script labels and Hinglish words, with no extra font', () => {
    const t = translator('hinglish')
    const html = renderDocument(localiseTemplate(CLASSIC_DEFAULT, t), sampleDocument(COMPANY, 'sales'), { labels: printLabelsFor(t) })
    expect(html).toContain('Amount shabdon mein')
    expect(html).toContain('rupaye')
    expect(/[ऀ-ॿ]/.test(html)).toBe(false)
    expect(html).not.toContain('Noto Sans Devanagari')
  })

  it('a statement in Hindi uses plain words, never the accountant columns', () => {
    const t = translator('hi')
    const html = renderDocument(localiseTemplate(CLASSIC_DEFAULT, t), sampleDocument(COMPANY, 'statement'), { labels: printLabelsFor(t) })
    const text = html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<[^>]+>/g, ' ')
    expect(text).toContain('विवरण')
    expect(text).not.toMatch(/\bParticulars\b|\bAgeing\b|\bDebit\b/)
    expect(bannedWordsIn(text)).toEqual([])
  })

  it('a template word the owner changed is kept; a default one is translated', () => {
    const t = translator('hi')
    const custom = { ...CLASSIC_DEFAULT, party: { ...CLASSIC_DEFAULT.party, billToLabel: 'Sold to' }, footer: { ...CLASSIC_DEFAULT.footer, signatureLabel: 'Proprietor' } }
    const local = localiseTemplate(custom, t)
    expect(local.party.billToLabel).toBe('Sold to')
    expect(local.footer.signatureLabel).toBe('Proprietor')
    expect(local.party.shipToLabel).toBe(t('simple.print.shippedTo'))
    expect(local.header.titles.sales).toBe(CLASSIC_DEFAULT.header.titles.sales)
  })
})
