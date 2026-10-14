// WP 8.4 — pure rules behind the plain pickers: the account-kind → group map (consistent with the
// WP 5.6 classifier's rule order), the context defaults, the near-duplicate threshold and the
// cited GST rate table.
import { describe, expect, it } from 'vitest'
import { DEFAULT_GROUPS, CASH_BANK_GROUPS } from '../seed'
import { CATEGORIES, expectedClass, NEW_CATEGORY_KINDS } from './categories'
import { ACCOUNT_KINDS, ACCOUNT_KIND_DEFS, categoriesFor, classForKind, groupForKind, INCOME_KINDS, kindFromContext, type KindAnswer } from './accountKinds'
import { NEAR_DUPLICATE_MIN_SCORE, nearDuplicates } from './nearDuplicate'
import { GST_CESS_NOTE, GST_RATE_TABLE, GST_RATE_UNVERIFIED, ratePeriodOn, slabsOn } from '../gst/rateTable'

const byName = new Map(DEFAULT_GROUPS.map((g) => [g.name, g]))
/** The root of a default group (ledgerClass reads cash / bank / party by ancestry). */
function chain(name: string): string[] {
  const out: string[] = []
  let g = byName.get(name)
  while (g) {
    out.push(g.name)
    g = g.parent ? byName.get(g.parent) : undefined
  }
  return out
}
/** ai/ledgerClass.ts's rule order over the default chart, for an untagged ledger. */
function classify(group: string, name: string): string {
  const c = chain(group)
  if (c.includes('Cash-in-Hand')) return 'cash'
  if (c.some((g) => CASH_BANK_GROUPS.includes(g))) return 'bank'
  if (c.includes('Sundry Debtors')) return 'debtor'
  if (c.includes('Sundry Creditors')) return 'creditor'
  const nature = byName.get(group)!.nature
  const e = expectedClass(nature, name, null)
  return e
}

const ANSWERS: KindAnswer[] = [
  { kind: 'customer' }, { kind: 'supplier' }, { kind: 'bank' }, { kind: 'cash' }, { kind: 'loan' }, { kind: 'loan', loanKind: 'gave' },
  ...INCOME_KINDS.map((incomeKind) => ({ kind: 'income' as const, incomeKind })),
  ...NEW_CATEGORY_KINDS.flatMap((expenseKind) => [{ kind: 'expense' as const, expenseKind }, { kind: 'expense' as const, expenseKind, makingCost: true }])
]

describe('account kinds', () => {
  it('every answer lands in a default group whose class is the kind’s class', () => {
    for (const a of ANSWERS) {
      const g = groupForKind(a)
      expect(byName.has(g), `${JSON.stringify(a)} → ${g}`).toBe(true)
      expect(classify(g, 'Test account'), JSON.stringify(a)).toBe(classForKind(a))
    }
  })

  it('names the groups the plan asks for', () => {
    expect(groupForKind({ kind: 'customer' })).toBe('Sundry Debtors')
    expect(groupForKind({ kind: 'supplier' })).toBe('Sundry Creditors')
    expect(groupForKind({ kind: 'expense' })).toBe('Indirect Expenses')
    expect(groupForKind({ kind: 'expense', expenseKind: 'stock_you_sell' })).toBe('Purchase Accounts')
    expect(groupForKind({ kind: 'expense', expenseKind: 'use_for_years' })).toBe('Fixed Assets')
    expect(groupForKind({ kind: 'income' })).toBe('Sales Accounts')
    expect(groupForKind({ kind: 'income', incomeKind: 'other_income' })).toBe('Indirect Incomes')
    expect(groupForKind({ kind: 'bank' })).toBe('Bank Accounts')
    expect(groupForKind({ kind: 'cash' })).toBe('Cash-in-Hand')
    expect(groupForKind({ kind: 'loan' })).toBe('Loans (Liability)')
    expect(groupForKind({ kind: 'loan', loanKind: 'took' })).toBe('Loans (Liability)')
    expect(groupForKind({ kind: 'loan', loanKind: 'gave' })).toBe('Loans & Advances (Asset)')
    expect(ACCOUNT_KINDS).toEqual(['customer', 'supplier', 'expense', 'income', 'bank', 'cash', 'loan', 'other'])
    expect(ACCOUNT_KINDS.filter((k) => ACCOUNT_KIND_DEFS[k].party)).toEqual(['customer', 'supplier'])
  })

  it('pre-picks from the field it was opened from', () => {
    expect(kindFromContext({ field: 'party', side: 'sales' })).toEqual({ kind: 'customer' })
    expect(kindFromContext({ field: 'party', side: 'purchase' })).toEqual({ kind: 'supplier' })
    expect(kindFromContext({ field: 'account', side: 'sales' })).toEqual({ kind: 'income', incomeKind: 'sales' })
    expect(kindFromContext({ field: 'account', side: 'purchase' })).toEqual({ kind: 'expense', expenseKind: 'stock_you_sell' })
    expect(kindFromContext({ field: 'line', voucherKind: 'payment', drCr: 'dr' })).toEqual({ kind: 'expense' })
    expect(kindFromContext({ field: 'line', voucherKind: 'payment', drCr: 'cr' })).toEqual({ kind: 'bank' })
    expect(kindFromContext({ field: 'line', voucherKind: 'receipt', drCr: 'cr' })).toEqual({ kind: 'customer' })
    expect(kindFromContext({ field: 'line', voucherKind: 'contra', drCr: 'dr' })).toEqual({ kind: 'bank' })
    expect(kindFromContext({ field: 'line', voucherKind: 'journal', drCr: 'dr' })).toBeNull()
    expect(kindFromContext({ field: 'none' })).toBeNull()
  })

  it('the category picker lists only categories of its use, each with an icon and a class that fits', () => {
    const exp = categoriesFor('expense')
    const inc = categoriesFor('income')
    expect(exp).toContain('rent')
    expect(exp).toContain('purchases')
    expect(exp).not.toContain('sales')
    expect(inc).toEqual(expect.arrayContaining(['sales', 'service_income', 'discount_received']))
    for (const k of exp) expect(CATEGORIES[k].cls).toBe('expense')
    for (const k of inc) expect(CATEGORIES[k].cls).toBe('income')
    for (const k of [...exp, ...inc]) expect(CATEGORIES[k].icon).toMatch(/^[a-z]+$/)
  })
})

describe('near-duplicate names ("Did you mean Sales?")', () => {
  const EXISTING = [
    { id: 1, name: 'Sales' },
    { id: 2, name: 'Sharma Traders' },
    { id: 3, name: 'ABC Traders' },
    { id: 4, name: 'Shop rent' },
    { id: 5, name: 'Ramesh Kumar & Sons Pvt Ltd' }
  ]
  const names = (q: string): string[] => nearDuplicates(q, EXISTING).map((d) => d.name)

  it('threshold is 50 — a prompt is cheap, a duplicate account is not', () => {
    expect(NEAR_DUPLICATE_MIN_SCORE).toBe(50)
  })
  it('catches the audit’s "Sal", typos, case / punctuation copies and suffixes', () => {
    expect(names('Sal')).toEqual(['Sales'])
    expect(names('sales')[0]).toBe('Sales')
    expect(nearDuplicates('SALES.', EXISTING)[0]).toMatchObject({ id: 1, same: true })
    expect(names('Sarma Traders')).toContain('Sharma Traders')
    expect(names('Sharma Tradres')).toContain('Sharma Traders')
    expect(names('Ramesh Kumar and Sons')).toContain('Ramesh Kumar & Sons Pvt Ltd')
    expect(names('Rent')).toContain('Shop rent')
  })
  it('does not fire for unrelated names or a shared common word', () => {
    expect(names('XYZ Traders')).not.toContain('ABC Traders')
    expect(names('Electricity')).toEqual([])
    expect(names('Sa')).toEqual([]) // two letters is not a prefix worth asking about
    expect(names('!!!')).toEqual([])
  })
  it('WP 10.8: the honorific "ji" and a plural s do not hide a copy ("Sharmaji Store" → Sharma Stores)', () => {
    const shops = [{ id: 9, name: 'Sharma Stores' }, { id: 10, name: 'Verma General Store' }]
    expect(nearDuplicates('Sharmaji Store', shops).map((d) => d.name)).toEqual(['Sharma Stores'])
    expect(nearDuplicates('Sharma ji stores', shops)[0]).toMatchObject({ id: 9, same: false })
    expect(nearDuplicates('Gupta Store', shops)).toEqual([])
  })
  it('lists at most three, best first', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ id: i, name: `Sales ${i}` }))
    expect(nearDuplicates('Sales', many)).toHaveLength(3)
  })
})

describe('GST rate table', () => {
  it('periods are contiguous, each with slabs and sources', () => {
    expect(GST_RATE_TABLE[0]!.from).toBe('2017-07-01')
    for (let i = 0; i < GST_RATE_TABLE.length; i++) {
      const p = GST_RATE_TABLE[i]!
      expect(p.slabs.length).toBeGreaterThan(0)
      expect(p.sources.length).toBeGreaterThan(0)
      for (const s of p.sources) expect(s).toMatch(/Notification No\. \d+\/20\d\d-/)
      expect(new Set(p.slabs.map((s) => s.rate)).size).toBe(p.slabs.length)
      expect(p.slabs.some((s) => s.rate === 0)).toBe(true)
      const next = GST_RATE_TABLE[i + 1]
      if (next) {
        const day = new Date(`${p.to}T00:00:00Z`)
        day.setUTCDate(day.getUTCDate() + 1)
        expect(day.toISOString().slice(0, 10)).toBe(next.from)
      } else expect(p.to).toBeNull()
    }
  })
  it('the 2017 common slabs are 0 / 5 / 12 / 18 / 28; from 22 Sep 2025 0 / 5 / 18', () => {
    expect(slabsOn('2024-04-01').filter((s) => s.common).map((s) => s.rate)).toEqual([0, 5, 12, 18, 28])
    expect(slabsOn('2025-09-21').filter((s) => s.common).map((s) => s.rate)).toEqual([0, 5, 12, 18, 28])
    expect(slabsOn('2025-09-22').filter((s) => s.common).map((s) => s.rate)).toEqual([0, 5, 18])
    expect(slabsOn('2026-01-31').map((s) => s.rate)).toEqual([0, 5, 18, 0.25, 1.5, 3, 28, 40])
    // Notification 19/2025-CT(Rate): Schedule VII (28%) omitted from 1 Feb 2026.
    expect(slabsOn('2026-02-01').map((s) => s.rate)).toEqual([0, 5, 18, 0.25, 1.5, 3, 40])
    expect(ratePeriodOn('2026-02-01').sources.join(' ')).toMatch(/19\/2025-Central Tax \(Rate\)/)
    expect(slabsOn('2026-10-13').some((s) => s.rate === 28)).toBe(false)
    expect(ratePeriodOn('2010-01-01')).toBe(GST_RATE_TABLE[0])
  })
  it('cess is a note with sources, and the unverified list is not empty', () => {
    expect(GST_CESS_NOTE.sources.length).toBeGreaterThan(0)
    expect(GST_RATE_UNVERIFIED.length).toBeGreaterThan(0)
    expect(GST_RATE_UNVERIFIED.join(' ')).toMatch(/HSN/)
    expect(GST_RATE_UNVERIFIED.join(' ')).toMatch(/taxo\.online/)
    expect(GST_RATE_UNVERIFIED.join(' ')).toMatch(/Compensation Cess/)
    expect(GST_CESS_NOTE.note).not.toMatch(/cars|aerated/i)
  })
})
