// WP 8.2: t() (interpolation, plurals, select, fallback), catalogue key parity across en / hi /
// hinglish, and the banned-word lint over the simple-mode namespaces.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CATALOGUES, LANGUAGES, configureI18n, en, normalizeLanguage, t, translator, type MessageKey } from './index'
import { MessageSyntaxError, formatMessage, messageVariables, parseMessage } from './format'
import { bannedWordsIn } from '../simple/bannedWords'

afterEach(() => configureI18n({ dev: false, report: () => undefined }))

describe('formatMessage (ICU-lite)', () => {
  it('interpolates named variables; numbers print as-is', () => {
    expect(formatMessage('Hello {name}, {n} left', { name: 'Ramesh', n: 3 }, 'en').text).toBe('Hello Ramesh, 3 left')
  })

  it('plural: exact =N first, then the CLDR category, # is the number', () => {
    const msg = '{count, plural, =0 {No bills} one {# bill} other {# bills}}'
    expect(formatMessage(msg, { count: 0 }, 'en').text).toBe('No bills')
    expect(formatMessage(msg, { count: 1 }, 'en').text).toBe('1 bill')
    expect(formatMessage(msg, { count: 7 }, 'en').text).toBe('7 bills')
  })

  it('plural rules follow the language: Hindi treats 0 as "one", English as "other"', () => {
    const msg = '{n, plural, one {one-form} other {other-form}}'
    expect(formatMessage(msg, { n: 0 }, 'hi').text).toBe('one-form')
    expect(formatMessage(msg, { n: 0 }, 'en').text).toBe('other-form')
    expect(formatMessage(msg, { n: 0 }, 'hinglish').text).toBe('other-form')
  })

  it('select picks the matching branch, else other; branches nest and # reaches through', () => {
    const msg = '{how, select, cash {Cash} other {Bank}}'
    expect(formatMessage(msg, { how: 'cash' }, 'en').text).toBe('Cash')
    expect(formatMessage(msg, { how: 'upi' }, 'en').text).toBe('Bank')
    const nested = '{n, plural, one {{kind, select, a {# A} other {# B}}} other {# many}}'
    expect(formatMessage(nested, { n: 1, kind: 'a' }, 'en').text).toBe('1 A')
    expect(formatMessage(nested, { n: 4, kind: 'a' }, 'en').text).toBe('4 many')
  })

  it('missing variables render empty and are reported', () => {
    const r = formatMessage('Owes {amount} since {date}', { amount: '₹5' }, 'en')
    expect(r.text).toBe('Owes ₹5 since ')
    expect(r.missingVars).toEqual(['date'])
  })

  it('rejects broken syntax', () => {
    expect(() => parseMessage('unclosed {name')).toThrow(MessageSyntaxError)
    expect(() => parseMessage('stray } brace')).toThrow(MessageSyntaxError)
    expect(() => parseMessage('{n, plural, one {x}}')).toThrow(/other/)
    expect(() => parseMessage('{n, number}')).toThrow(/Unknown argument type/)
  })

  it('lists variables', () => {
    expect(messageVariables('{a} {n, plural, one {{b}} other {#}}')).toEqual(['a', 'b', 'n'])
  })
})

describe('t()', () => {
  it('English by default, with variables', () => {
    expect(t('simple.home.gstDue', { amount: '₹2,688.00', date: '20 Nov' })).toBe('GST to pay: ₹2,688.00 by 20 Nov')
    expect(t('common.bills', { count: 2 })).toBe('2 bills')
  })

  it('a translated key uses the language; an untranslated one falls back to English per key', () => {
    expect(t('simple.home.moneyIn', undefined, 'hi')).toBe('पैसे आए')
    expect(t('simple.home.moneyIn', undefined, 'hinglish')).toBe('Paise aaye')
    expect(t('simple.sell.makeBill', undefined, 'hi')).toBe('Make a bill')
    expect(translator('hinglish')('simple.sell.makeBill')).toBe('Make a bill')
  })

  it('an unknown key never shows raw in production; dev shows it and reports once', () => {
    const report = vi.fn()
    const bogus = 'simple.nope' as MessageKey
    configureI18n({ dev: false, report })
    expect(t(bogus)).toBe('')
    expect(t(bogus, undefined, 'en', { fallback: 'Fallback' })).toBe('Fallback')
    expect(report).not.toHaveBeenCalled()

    configureI18n({ dev: true, report })
    expect(t(bogus)).toBe('simple.nope')
    t(bogus)
    t(bogus)
    expect(report.mock.calls.filter(([p]) => p.kind === 'unknown-key')).toHaveLength(1)
  })

  it('dev reports untranslated keys and missing variables once each', () => {
    const report = vi.fn()
    configureI18n({ dev: true, report })
    t('simple.sell.makeBill', undefined, 'hi')
    t('simple.sell.makeBill', undefined, 'hi')
    t('simple.home.gstDue', { amount: '₹1' })
    t('simple.home.gstDue', { amount: '₹1' })
    const kinds = report.mock.calls.map(([p]) => p.kind)
    expect(kinds).toEqual(['untranslated', 'missing-var'])
  })

  it('normalizeLanguage maps anything unknown to English', () => {
    expect(normalizeLanguage('hi')).toBe('hi')
    expect(normalizeLanguage('fr')).toBe('en')
    expect(normalizeLanguage(null)).toBe('en')
  })
})

describe('catalogues', () => {
  const enKeys = Object.keys(en)

  it('every en value parses', () => {
    for (const key of enKeys) expect(() => parseMessage(en[key as MessageKey]), key).not.toThrow()
  })

  it('key parity: hi / hinglish only use keys that exist in en, with the same variables', () => {
    const enSet = new Set(enKeys)
    for (const lang of LANGUAGES) {
      if (lang === 'en') continue
      for (const [key, value] of Object.entries(CATALOGUES[lang])) {
        expect(enSet.has(key), `${lang} has ${key}, which en does not`).toBe(true)
        expect(messageVariables(value!), `${lang} ${key} variables`).toEqual(messageVariables(en[key as MessageKey]))
      }
    }
  })

  it('no empty values; keys are dotted and namespaced', () => {
    for (const key of enKeys) {
      expect(en[key as MessageKey].trim(), key).not.toBe('')
      expect(key).toMatch(/^[a-z]+(\.[A-Za-z0-9]+)+$/)
    }
  })

  it('the simple-mode namespaces (common / simple / errors) carry no banned word in any language', () => {
    const offenders: string[] = []
    for (const lang of LANGUAGES) {
      for (const [key, value] of Object.entries(CATALOGUES[lang])) {
        if (!/^(common|simple|errors)\./.test(key)) continue
        const words = bannedWordsIn(value!)
        if (words.length) offenders.push(`${lang} ${key}: ${words.join(', ')} — "${value}"`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('the banned-word check catches every word on the plan §1 list', () => {
    expect(bannedWordsIn('Pick a ledger and a voucher type')).toEqual(['voucher', 'ledger'])
    expect(bannedWordsIn('Journal, Contra, Dr and Cr, Particulars, Narration')).toEqual(['journal', 'contra', 'Dr/Cr', 'particulars', 'narration'])
    expect(bannedWordsIn('Sundry Debtors group, ITC set-off, ageing, BRS, godown, BOM, SOA')).toEqual([
      'sundry',
      'group',
      'ITC',
      'set-off',
      'ageing',
      'BRS',
      'godown',
      'BOM',
      'SOA'
    ])
    expect(bannedWordsIn('Money in, credit, dry goods, GST, GSTIN, HSN, TDS')).toEqual([])
  })

  it('the shared chrome converted to t() keeps its 0.10 English wording', () => {
    expect(en['palette.placeholder']).toBe('Type a command, or search the books — name, number, GSTIN, amount…')
    expect(en['palette.searching']).toBe('Searching…')
    expect(en['palette.empty']).toBe('No commands or matches')
  })
})
