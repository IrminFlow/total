import { describe, expect, it } from 'vitest'
import {
  applicableKinds,
  highlightSegments,
  isEmptyQuery,
  parseAmountSpec,
  parseDateSpec,
  parseFySpec,
  parseMoneyValue,
  parseSearchQuery,
  removeToken,
  snippet,
  tokenize
} from './searchQuery'

const OPTS = { today: '2026-10-07', fyStartYear: 2026 }
const p = (s: string): ReturnType<typeof parseSearchQuery> => parseSearchQuery(s, OPTS)

describe('tokenize', () => {
  it('splits words, quoted phrases and key:"quoted values"', () => {
    expect(tokenize('acme  "office rent"  party:"umbrella retail" amt:>5000').map((t) => [t.key, t.value, t.quoted])).toEqual([
      [null, 'acme', false],
      [null, 'office rent', true],
      ['party', 'umbrella retail', true],
      ['amt', '>5000', false]
    ])
  })

  it('treats an unterminated quote as running to the end', () => {
    expect(tokenize('foo "bar baz').map((t) => t.value)).toEqual(['foo', 'bar baz'])
  })

  it('drops empty quotes and surrounding whitespace', () => {
    expect(tokenize('  ""   x  ')).toHaveLength(1)
    expect(tokenize('')).toEqual([])
  })
})

describe('parseMoneyValue', () => {
  it('parses plain, decimal, rupee-symbol and Indian-grouped amounts into paise', () => {
    expect(parseMoneyValue('5000')).toBe(500000)
    expect(parseMoneyValue('2,500.50')).toBe(250050)
    expect(parseMoneyValue('₹1,234')).toBe(123400)
    expect(parseMoneyValue('1,40,50,613')).toBe(14050613_00)
    expect(parseMoneyValue('.5')).toBe(50)
  })

  it('understands k / L / cr suffixes with integer math', () => {
    expect(parseMoneyValue('5k')).toBe(5_000_00)
    expect(parseMoneyValue('1.5L')).toBe(1_50_000_00)
    expect(parseMoneyValue('2cr')).toBe(2_00_00_000_00)
    expect(parseMoneyValue('3lakh')).toBe(3_00_000_00)
  })

  it('rejects non-money shapes', () => {
    for (const bad of ['', 'abc', '12a', '-5', '5,', ',5', '1,,000', '1.234', 'INV-12', '2026-04-01', '5,.5', '₹', '1e5']) {
      expect(parseMoneyValue(bad), bad).toBeNull()
    }
  })
})

describe('parseAmountSpec', () => {
  it('exact', () => {
    expect(parseAmountSpec('5000')).toEqual({ range: { min: 500000, max: 500000 }, label: 'Amount ₹5,000' })
    expect(parseAmountSpec('=5000')?.range).toEqual({ min: 500000, max: 500000 })
  })

  it('comparators — strict bounds move by one paisa', () => {
    expect(parseAmountSpec('>50000')).toEqual({ range: { min: 5000001, max: null }, label: 'Amount > ₹50,000' })
    expect(parseAmountSpec('>=50000')).toEqual({ range: { min: 5000000, max: null }, label: 'Amount ≥ ₹50,000' })
    expect(parseAmountSpec('<500')).toEqual({ range: { min: null, max: 49999 }, label: 'Amount < ₹500' })
    expect(parseAmountSpec('<=500')).toEqual({ range: { min: null, max: 50000 }, label: 'Amount ≤ ₹500' })
  })

  it('ranges, open-ended ranges and swapped bounds', () => {
    expect(parseAmountSpec('1000..5000')).toEqual({ range: { min: 100000, max: 500000 }, label: 'Amount ₹1,000 – ₹5,000' })
    expect(parseAmountSpec('5000..1000')?.range).toEqual({ min: 100000, max: 500000 })
    expect(parseAmountSpec('1000..')?.range).toEqual({ min: 100000, max: null })
    expect(parseAmountSpec('..1000')?.range).toEqual({ min: null, max: 100000 })
    expect(parseAmountSpec('1,40,50,613..2cr')?.range).toEqual({ min: 14050613_00, max: 2_00_00_000_00 })
  })

  it('rejects garbage', () => {
    for (const bad of ['abc', '..', '>', '>abc', '1..2..3', '1000..x', '<0', '>=-5']) expect(parseAmountSpec(bad), bad).toBeNull()
  })
})

describe('parseDateSpec', () => {
  it('ISO day and month', () => {
    expect(parseDateSpec('2026-04-12', OPTS)).toEqual({ range: { from: '2026-04-12', to: '2026-04-12' }, label: '12 Apr 2026' })
    expect(parseDateSpec('2026-04', OPTS)).toEqual({ range: { from: '2026-04-01', to: '2026-04-30' }, label: 'April 2026' })
    expect(parseDateSpec('2028-02', OPTS)?.range).toEqual({ from: '2028-02-01', to: '2028-02-29' })
  })

  it('DD-MM-YYYY, DD/MM/YY and the DD-MMM-YY display format', () => {
    expect(parseDateSpec('12-04-2026', OPTS)?.range).toEqual({ from: '2026-04-12', to: '2026-04-12' })
    expect(parseDateSpec('12/04/26', OPTS)?.range).toEqual({ from: '2026-04-12', to: '2026-04-12' })
    expect(parseDateSpec('12.04.2026', OPTS)?.range).toEqual({ from: '2026-04-12', to: '2026-04-12' })
    expect(parseDateSpec('12-Apr-26', OPTS)?.range).toEqual({ from: '2026-04-12', to: '2026-04-12' })
    expect(parseDateSpec('5-april-2026', OPTS)?.range).toEqual({ from: '2026-04-05', to: '2026-04-05' })
  })

  it('bare months resolve into the working FY (Apr–Dec start year, Jan–Mar next year)', () => {
    expect(parseDateSpec('apr', OPTS)).toEqual({ range: { from: '2026-04-01', to: '2026-04-30' }, label: 'April 2026' })
    expect(parseDateSpec('January', OPTS)?.range).toEqual({ from: '2027-01-01', to: '2027-01-31' })
    expect(parseDateSpec('sept', OPTS)?.range.from).toBe('2026-09-01')
    expect(parseDateSpec('apr', { today: '2026-10-07', fyStartYear: 2025 })?.range.from).toBe('2025-04-01')
  })

  it('month + year in several spellings', () => {
    for (const s of ['apr-2026', 'apr2026', 'APR-26', 'april-2026', '04-2026']) {
      expect(parseDateSpec(s, OPTS)?.range, s).toEqual({ from: '2026-04-01', to: '2026-04-30' })
    }
  })

  it('calendar year, today, yesterday', () => {
    expect(parseDateSpec('2026', OPTS)?.range).toEqual({ from: '2026-01-01', to: '2026-12-31' })
    expect(parseDateSpec('today', OPTS)?.range).toEqual({ from: '2026-10-07', to: '2026-10-07' })
    expect(parseDateSpec('yesterday', OPTS)?.range).toEqual({ from: '2026-10-06', to: '2026-10-06' })
  })

  it('ranges of any atoms, open ends and swapped order', () => {
    expect(parseDateSpec('2026-04-01..2026-04-30', OPTS)).toEqual({
      range: { from: '2026-04-01', to: '2026-04-30' },
      label: '1 Apr 2026 – 30 Apr 2026'
    })
    expect(parseDateSpec('apr..jun', OPTS)?.range).toEqual({ from: '2026-04-01', to: '2026-06-30' })
    expect(parseDateSpec('jun..apr', OPTS)?.range).toEqual({ from: '2026-04-01', to: '2026-06-30' })
    expect(parseDateSpec('2026-05..', OPTS)?.range).toEqual({ from: '2026-05-01', to: null })
    expect(parseDateSpec('..2026-05', OPTS)?.range).toEqual({ from: null, to: '2026-05-31' })
  })

  it('comparators', () => {
    expect(parseDateSpec('>2026-04-30', OPTS)?.range).toEqual({ from: '2026-05-01', to: null })
    expect(parseDateSpec('>=apr', OPTS)?.range).toEqual({ from: '2026-04-01', to: null })
    expect(parseDateSpec('<2026-04-01', OPTS)?.range).toEqual({ from: null, to: '2026-03-31' })
    expect(parseDateSpec('<=apr', OPTS)?.range).toEqual({ from: null, to: '2026-04-30' })
  })

  it('rejects invalid dates and gibberish', () => {
    for (const bad of ['2026-02-30', '2026-13', '31-02-2026', 'foo', 'abc-2026', '..', '1..2..3', '32-01-2026', '', '>x', '12-xyz-26']) {
      expect(parseDateSpec(bad, OPTS), bad).toBeNull()
    }
  })
})

describe('parseFySpec', () => {
  it('start year, short year, and YYYY-YY / YYYY-YYYY labels', () => {
    expect(parseFySpec('2026')).toEqual({ range: { from: '2026-04-01', to: '2027-03-31' }, label: 'FY 2026-27' })
    expect(parseFySpec('26')?.range.from).toBe('2026-04-01')
    expect(parseFySpec('2026-27')?.range.to).toBe('2027-03-31')
    expect(parseFySpec('2026-2027')?.range.to).toBe('2027-03-31')
    expect(parseFySpec('2099-00')?.range.from).toBe('2099-04-01')
  })

  it('rejects mismatched end years and junk', () => {
    expect(parseFySpec('2026-28')).toBeNull()
    expect(parseFySpec('abc')).toBeNull()
    expect(parseFySpec('202')).toBeNull()
  })
})

describe('parseSearchQuery', () => {
  it('plain free text is lower-cased into terms', () => {
    const q = p('Acme Traders')
    expect(q.terms).toEqual([
      { text: 'acme', phrase: false, amount: null },
      { text: 'traders', phrase: false, amount: null }
    ])
    expect(q.chips).toEqual([])
    expect(q.unknown).toEqual([])
  })

  it('quoted phrase stays one term and never doubles as an amount', () => {
    const q = p('"Office Rent" "5000"')
    expect(q.terms).toEqual([
      { text: 'office rent', phrase: true, amount: null },
      { text: '5000', phrase: true, amount: null }
    ])
  })

  it('a bare number also matches amounts, with an "or amount" chip', () => {
    const q = p('1,40,50,613')
    expect(q.terms).toEqual([{ text: '1,40,50,613', phrase: false, amount: 14050613_00 }])
    expect(q.chips).toEqual([{ key: 'bare-amount', label: 'or amount ₹1,40,50,613', raw: '1,40,50,613' }])
  })

  it('amount, date and fy tokens become filters with chips', () => {
    const q = p('amt:>=50000 date:apr fy:2026')
    expect(q.amounts).toEqual([{ min: 5000000, max: null }])
    expect(q.dates).toEqual([
      { from: '2026-04-01', to: '2026-04-30' },
      { from: '2026-04-01', to: '2027-03-31' }
    ])
    expect(q.chips.map((c) => c.label)).toEqual(['Amount ≥ ₹50,000', 'April 2026', 'FY 2026-27'])
    expect(q.terms).toEqual([])
  })

  it('keys are case-insensitive and have aliases', () => {
    const q = p('AMT:100 Amount:200 On:2026-04 GST:27aap SAC:9983 Under:debtors num:5')
    expect(q.amounts).toHaveLength(2)
    expect(q.dates).toHaveLength(1)
    expect(q.gstins).toEqual(['27AAP'])
    expect(q.hsns).toEqual(['9983'])
    expect(q.groups).toEqual(['debtors'])
    expect(q.numbers).toEqual(['5'])
  })

  it('type: resolves aliases to kinds, keeps raw values, and accepts comma lists', () => {
    const q = p('type:sales type:cn,jv type:"Sales GST"')
    expect(q.types).toEqual(['sales', 'cn', 'jv', 'sales gst'])
    expect(q.typeKinds).toEqual(['sales', 'credit_note', 'journal'])
    expect(q.chips.map((c) => c.label)).toEqual(['Type: Sales', 'Type: Credit note or Journal', 'Type: sales gst'])
  })

  it('no:, gstin:, pan:, hsn:, group:, party: values', () => {
    const q = p('no:INV-12 gstin:27aapfu0939f1zv pan:aapfu0939f hsn:8471 group:sundry party:"Umbrella Retail"')
    expect(q.numbers).toEqual(['inv-12'])
    expect(q.gstins).toEqual(['27AAPFU0939F1ZV'])
    expect(q.pans).toEqual(['AAPFU0939F'])
    expect(q.hsns).toEqual(['8471'])
    expect(q.groups).toEqual(['sundry'])
    expect(q.parties).toEqual(['umbrella retail'])
    expect(q.chips.map((c) => c.key)).toEqual(['no', 'gstin', 'pan', 'hsn', 'group', 'party'])
    expect(q.chips.find((c) => c.key === 'party')?.raw).toBe('party:"Umbrella Retail"')
  })

  it('in: restricts kinds (singular/plural, comma or pipe lists, repeated tokens widen)', () => {
    expect(p('in:ledgers acme').kinds).toEqual(['ledger'])
    expect(p('in:items|vouchers x').kinds).toEqual(['item', 'voucher'])
    expect(p('in:voucher in:ledger x').kinds).toEqual(['ledger', 'voucher'])
    expect(p('x').kinds).toBeNull()
  })

  it('malformed / unknown tokens are kept as free text and reported, never thrown', () => {
    const q = p('amt:abc date:31-02-2026 colour:red in:planets type: fy:20x x')
    expect(q.unknown).toEqual(['amt:abc', 'date:31-02-2026', 'colour:red', 'in:planets', 'type:', 'fy:20x'])
    expect(q.terms.map((t) => t.text)).toEqual(['amt:abc', 'date:31-02-2026', 'colour:red', 'in:planets', 'type:', 'fy:20x', 'x'])
    expect(q.amounts).toEqual([])
    expect(q.dates).toEqual([])
  })

  it('non-key colons (times, URLs) are free text but not flagged unknown', () => {
    const q = p('10:30 http://x.test')
    expect(q.unknown).toEqual(['http://x.test'])
    expect(q.terms.map((t) => t.text)).toEqual(['10:30', 'http://x.test'])
  })

  it('handles pathological input without throwing', () => {
    for (const s of ['', '   ', ':', '""', '"', 'a:', ':b', '%_\\', 'amt:..', 'date:..', '₹', '"""', 'x'.repeat(5000), 'amt:"', 'party:"']) {
      expect(() => p(s)).not.toThrow()
    }
    expect(p('%_').terms[0]?.text).toBe('%_')
  })

  it('defaults to today when no options are given', () => {
    expect(() => parseSearchQuery('date:apr')).not.toThrow()
    expect(parseSearchQuery('date:apr').dates).toHaveLength(1)
  })
})

describe('isEmptyQuery / applicableKinds', () => {
  it('empty and in:-only queries have nothing to search', () => {
    expect(isEmptyQuery(p(''))).toBe(true)
    expect(isEmptyQuery(p('in:ledgers'))).toBe(true)
    expect(isEmptyQuery(p('x'))).toBe(false)
    expect(isEmptyQuery(p('amt:5'))).toBe(false)
  })

  it('voucher-only filters exclude ledgers and items; gstin/pan exclude items', () => {
    expect(applicableKinds(p('acme'))).toEqual(['ledger', 'item', 'voucher'])
    expect(applicableKinds(p('amt:5000'))).toEqual(['voucher'])
    expect(applicableKinds(p('date:apr'))).toEqual(['voucher'])
    expect(applicableKinds(p('type:sales'))).toEqual(['voucher'])
    expect(applicableKinds(p('party:x'))).toEqual(['voucher'])
    expect(applicableKinds(p('gstin:27'))).toEqual(['ledger', 'voucher'])
    expect(applicableKinds(p('hsn:8471'))).toEqual(['ledger', 'item', 'voucher'])
    expect(applicableKinds(p('group:sundry in:items'))).toEqual(['item'])
    expect(applicableKinds(p('amt:5 in:ledgers'))).toEqual([])
  })
})

describe('removeToken', () => {
  it('drops exactly one raw token', () => {
    expect(removeToken('acme amt:>5000 date:apr', 'amt:>5000')).toBe('acme date:apr')
    expect(removeToken('party:"a b" x', 'party:"a b"')).toBe('x')
    expect(removeToken('x', 'missing')).toBe('x')
  })
})

describe('snippet', () => {
  const long = 'Being the payment received against invoice INV-1234 for the supply of office chairs and steel filing cabinets'
  it('returns short text unchanged and collapses whitespace', () => {
    expect(snippet('a   b', 'a')).toBe('a b')
  })
  it('windows around the match with ellipses', () => {
    const s = snippet(long, 'steel', 40)
    expect(s).toContain('steel')
    expect(s.startsWith('…')).toBe(true)
    expect(s.length).toBeLessThanOrEqual(42)
  })
  it('falls back to the head', () => {
    expect(snippet(long, 'zzz', 20)).toBe('Being the payment r…')
    expect(snippet(long, null, 20).endsWith('…')).toBe(true)
  })
})

describe('highlightSegments', () => {
  it('marks case-insensitive matches, longest first, non-overlapping', () => {
    expect(highlightSegments('Acme Traders', ['acme'])).toEqual([
      { text: 'Acme', match: true },
      { text: ' Traders', match: false }
    ])
    expect(highlightSegments('aaa', ['a', 'aa'])).toEqual([
      { text: 'aa', match: true },
      { text: 'a', match: true }
    ])
    expect(highlightSegments('xyz', [])).toEqual([{ text: 'xyz', match: false }])
    expect(highlightSegments('', ['a'])).toEqual([{ text: '', match: false }])
  })
})
