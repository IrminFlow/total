// WP 5.3 — the pure drafting helpers: amounts as people type them (money.ts), dates as people
// say them (dates.ts), and name resolution with disambiguation (aiResolve.ts).
import { describe, expect, it } from 'vitest'
import { parseAmountText } from './money'
import { resolveDateText } from './dates'
import { editDistance, normaliseName, resolveName, scoreName, type ResolveCandidate } from './aiResolve'

describe('parseAmountText (money.ts)', () => {
  it('reads plain, grouped and symbol-prefixed rupees into paise', () => {
    expect(parseAmountText('45000')).toBe(4_500_000)
    expect(parseAmountText('45,000')).toBe(4_500_000)
    expect(parseAmountText('1,20,000.50')).toBe(12_000_050)
    expect(parseAmountText('₹ 2,500')).toBe(250_000)
    expect(parseAmountText('Rs. 45000/-')).toBe(4_500_000)
    expect(parseAmountText('INR 1,000')).toBe(100_000)
    expect(parseAmountText('500 rupees')).toBe(50_000)
  })

  it('reads lakh / crore / thousand shorthand with exact integer maths', () => {
    expect(parseAmountText('1.5 lakh')).toBe(15_000_000)
    expect(parseAmountText('1.5L')).toBe(15_000_000)
    expect(parseAmountText('2 lakhs')).toBe(20_000_000)
    expect(parseAmountText('3 lac')).toBe(30_000_000)
    expect(parseAmountText('2 crore')).toBe(2_000_000_000)
    expect(parseAmountText('1.25cr')).toBe(1_250_000_000)
    expect(parseAmountText('45k')).toBe(4_500_000)
    expect(parseAmountText('1.234 lakh')).toBe(12_340_000)
    // 0.1 + 0.2 style float traps never arise: 0.3 lakh is exactly ₹30,000.00
    expect(parseAmountText('0.3 lakh')).toBe(3_000_000)
  })

  it('refuses what is not one non-negative amount on whole paise', () => {
    for (const bad of ['', 'ten', '-500', '1.005', '1..5', '12 34', '5 dozen', '1,,000', '1000,', '1.5 lakh rupees extra']) {
      expect(parseAmountText(bad), bad).toBeNull()
    }
  })
})

describe('resolveDateText (dates.ts) — against the working date, never the model', () => {
  const ctx = '2026-10-08' // a Thursday
  it('relative days', () => {
    expect(resolveDateText('today', ctx)?.date).toBe('2026-10-08')
    expect(resolveDateText('Yesterday', ctx)?.date).toBe('2026-10-07')
    expect(resolveDateText('tomorrow', ctx)?.date).toBe('2026-10-09')
    expect(resolveDateText('day before yesterday', ctx)?.date).toBe('2026-10-06')
    expect(resolveDateText('3 days ago', ctx)?.date).toBe('2026-10-05')
    expect(resolveDateText('2 weeks ago', ctx)?.date).toBe('2026-09-24')
  })

  it('weekdays: bare = on or before, "last" = strictly before', () => {
    expect(resolveDateText('last Friday', ctx)?.date).toBe('2026-10-02')
    expect(resolveDateText('friday', ctx)?.date).toBe('2026-10-02')
    expect(resolveDateText('monday', ctx)?.date).toBe('2026-10-05')
    expect(resolveDateText('thursday', ctx)?.date).toBe('2026-10-08')
    expect(resolveDateText('last thursday', ctx)?.date).toBe('2026-10-01')
    expect(resolveDateText('last thu', ctx)?.date).toBe('2026-10-01')
  })

  it('day + month (financial-year rule without a year), explicit years, month edges', () => {
    expect(resolveDateText('15 aug', ctx)?.date).toBe('2026-08-15')
    expect(resolveDateText('15th of August', ctx)?.date).toBe('2026-08-15')
    expect(resolveDateText('Aug 15', ctx)?.date).toBe('2026-08-15')
    expect(resolveDateText('10 feb', ctx)?.date).toBe('2027-02-10')
    expect(resolveDateText('15 aug 2025', ctx)?.date).toBe('2025-08-15')
    expect(resolveDateText('end of last month', ctx)?.date).toBe('2026-09-30')
    expect(resolveDateText('start of the month', ctx)?.date).toBe('2026-10-01')
    expect(resolveDateText('end of last month', '2026-01-10')?.date).toBe('2025-12-31')
    expect(resolveDateText('end of this month', '2028-02-03')?.date).toBe('2028-02-29')
  })

  it('ISO and the date field forms; refuses nonsense', () => {
    expect(resolveDateText('2025-07-31', ctx)).toEqual({ date: '2025-07-31', how: 'as given' })
    expect(resolveDateText('7/4', ctx)?.date).toBe('2026-04-07')
    expect(resolveDateText('07-04-2025', ctx)?.date).toBe('2025-04-07')
    for (const bad of ['', 'someday', '31 feb', '2025-02-30', 'next blue moon']) expect(resolveDateText(bad, ctx), bad).toBeNull()
  })
})

describe('resolveName (aiResolve.ts)', () => {
  const parties: ResolveCandidate[] = [
    { id: 1, name: 'Umbrella Retail', keys: ['27AABCD1234E1Z8'], detail: 'Sundry Debtors' },
    { id: 2, name: 'Silverline Traders', keys: ['27AABCE5678F1ZH'] },
    { id: 3, name: 'Krishna Enterprises', keys: ['29AABCF9012G1ZQ'] },
    { id: 4, name: 'Krishna Electricals Pvt Ltd' },
    { id: 5, name: 'Bharat Steel Suppliers' }
  ]

  it('normalises names', () => {
    expect(normaliseName('M/s. Krishna Electricals Pvt. Ltd.')).toBe('krishna electricals')
    expect(normaliseName('Laptop 14"')).toBe('laptop 14')
    expect(normaliseName('Sales A/c')).toBe('sales')
    expect(normaliseName('Tom & Jerry Co.')).toBe('tom and jerry')
    expect(editDistance('umbrela', 'umbrella')).toBe(1)
    expect(scoreName('umb ret', 'umbrella retail')).toBeGreaterThanOrEqual(70)
  })

  it('exact names, identifiers, prefixes and small typos resolve — with the reason', () => {
    expect(resolveName('Umbrella Retail', parties)).toMatchObject({ status: 'match', id: 1, why: 'exact name' })
    expect(resolveName('umbrella retail.', parties)).toMatchObject({ status: 'match', id: 1 })
    expect(resolveName('27 AABCD1234E1Z8', parties)).toMatchObject({ status: 'match', id: 1, why: 'its identifier is 27 AABCD1234E1Z8' })
    expect(resolveName('Umbrella', parties)).toMatchObject({ status: 'match', id: 1 })
    expect(resolveName('Umbrela Retail', parties)).toMatchObject({ status: 'match', id: 1, why: 'the closest name (a small spelling difference)' })
    expect(resolveName('bharat steel', parties)).toMatchObject({ status: 'match', id: 5 })
  })

  it('several close candidates → ambiguous, listing them (never a silent pick)', () => {
    const r = resolveName('Krishna', parties)
    expect(r.status).toBe('ambiguous')
    expect(r.status === 'ambiguous' && r.candidates.map((c) => c.id).sort()).toEqual([3, 4])
    const twins = resolveName('Acme', [{ id: 8, name: 'Acme' , detail: 'Pune' }, { id: 9, name: 'ACME', detail: 'Delhi' }, { id: 10, name: 'Acme Corp' }])
    // Names differing only in case are twins: the user is asked, "Acme Corp" is not offered.
    expect(twins.status === 'ambiguous' && twins.candidates.map((c) => c.id)).toEqual([8, 9])
    expect(resolveName('Acme Corp', [{ id: 8, name: 'Acme' }, { id: 10, name: 'Acme Corp' }])).toMatchObject({ status: 'match', id: 10 })
    const dupes = resolveName('acme traders', [{ id: 8, name: 'Acme Traders.' }, { id: 9, name: 'ACME TRADERS (Pune)' }, { id: 11, name: 'Acme-Traders' }])
    expect(dupes.status).toBe('ambiguous')
  })

  it('nothing close → none, with hints', () => {
    expect(resolveName('Zebra Logistics', parties)).toEqual({ status: 'none', closest: [] })
    expect(resolveName('', parties).status).toBe('none')
  })

  it('a shared identifier is ambiguous; an HSN code is a weak key', () => {
    const items: ResolveCandidate[] = [
      { id: 1, name: 'Laptop 14"', keys: ['LAP14'], secondary: ['8471'] },
      { id: 2, name: 'Wireless Mouse', secondary: ['8471'] },
      { id: 3, name: 'Office Chair', secondary: ['9401'] }
    ]
    expect(resolveName('Laptop 14', items)).toMatchObject({ status: 'match', id: 1 })
    expect(resolveName('lap14', items)).toMatchObject({ status: 'match', id: 1 })
    expect(resolveName('9401', items)).toMatchObject({ status: 'match', id: 3, why: 'its code is 9401' })
    expect(resolveName('8471', items).status).toBe('ambiguous')
  })
})
