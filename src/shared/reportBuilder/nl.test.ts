import { describe, expect, it } from 'vitest'
import { parseReportQuestion, reportRequestSchema, requestToModel, type NameLookup } from './nl'
import { reportModelSchema } from './model'

const NAMES: Record<string, { id: number; name: string }[]> = {
  group: [
    { id: 1, name: 'Sales Accounts' },
    { id: 2, name: 'Indirect Expenses' },
    { id: 3, name: 'Direct Expenses' }
  ],
  ledger: [
    { id: 10, name: 'Rent' },
    { id: 11, name: 'Rent Deposit' },
    { id: 12, name: 'Acme Traders' },
    { id: 13, name: 'Acme Exports' }
  ],
  party: [
    { id: 12, name: 'Acme Traders' },
    { id: 13, name: 'Acme Exports' }
  ],
  item: [{ id: 30, name: 'Widget' }]
}
const lookup: NameLookup = (kind, name) => {
  const n = name.toLowerCase()
  const all = NAMES[kind] ?? []
  const exact = all.filter((x) => x.name.toLowerCase() === n)
  return exact.length ? exact : all.filter((x) => x.name.toLowerCase().includes(n))
}
const WORKING = { from: '2026-04-01', to: '2027-03-31' }

describe('requestToModel', () => {
  it('resolves names to ids and produces a valid report-builder model', () => {
    const r = requestToModel({ title: 'Rent by month', source: 'accounts', dimensions: [{ key: 'month' }], measures: ['net'], ledgers: ['rent'], period: { kind: 'relative', rule: 'fyToDate' } }, lookup)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.model.filters.ledgerIds).toEqual([10]) // exact name wins over "Rent Deposit"
    expect(r.model.period).toEqual({ kind: 'relative', rule: 'fyToDate' })
    expect(reportModelSchema.safeParse(r.model).success).toBe(true)
    expect(r.resolved).toEqual([{ kind: 'ledger', asked: 'rent', id: 10, name: 'Rent' }])
  })

  it('reports unknown and ambiguous names instead of guessing', () => {
    const r = requestToModel({ title: 'x', source: 'accounts', measures: ['net'], parties: ['Acme', 'Nobody'] }, lookup)
    expect(r).toEqual({ ok: false, problems: ['“Acme” matches several parties: Acme Traders, Acme Exports — use the exact name', 'No party called “Nobody”'] })
  })

  it('a single partial match is asked about, never picked', () => {
    const r = requestToModel({ title: 'x', source: 'accounts', measures: ['net'], parties: ['Traders'] }, lookup)
    expect(r).toEqual({ ok: false, problems: ['No party called “Traders” — did you mean “Acme Traders”? Use the exact name'] })
  })

  it('rejects a model the builder would refuse (the WP 6.1 rules apply)', () => {
    const bad = requestToModel({ title: 'x', source: 'inventory', dimensions: [{ key: 'ledger' }], measures: ['debit'] }, lookup)
    expect(bad.ok).toBe(false)
    if (bad.ok) return
    expect(bad.problems.join(' ')).toMatch(/Ledger is not available for stock/)
    const balance = requestToModel({ title: 'x', source: 'accounts', dimensions: [{ key: 'party' }], measures: ['balance'] }, lookup)
    expect(balance.ok).toBe(false)
    const range = requestToModel({ title: 'x', source: 'accounts', measures: ['net'], period: { kind: 'range', from: '2026-05-01' } }, lookup)
    expect(range).toEqual({ ok: false, problems: ['A range period needs from and to'] })
  })

  it('top N sorts by the first measure, descending', () => {
    const r = requestToModel({ title: 'Top', source: 'accounts', dimensions: [{ key: 'party' }], measures: ['taxable'], voucherKinds: ['sales'], topN: 5 }, lookup)
    expect(r.ok && r.model.sort).toEqual({ by: 'taxable', dir: 'desc' })
    expect(r.ok && r.model.topN).toBe(5)
  })

  it('the request schema is what the model produces (rejects unknown keys of the vocabulary)', () => {
    expect(reportRequestSchema.safeParse({ title: 'x', source: 'accounts', measures: ['revenue'] }).success).toBe(false)
    expect(reportRequestSchema.safeParse({ title: 'x', source: 'accounts', measures: ['net'] }).success).toBe(true)
  })
})

describe('parseReportQuestion (deterministic phrases)', () => {
  const model = (q: string) => {
    const req = parseReportQuestion(q, WORKING)
    if (!req) return null
    const r = requestToModel(req, lookup)
    if (!r.ok) throw new Error(r.problems.join('; '))
    return { req, model: r.model }
  }

  it('sales by month', () => {
    const m = model('Sales by month')!
    expect(m.model).toMatchObject({ source: 'accounts', dimensions: [{ key: 'month' }], measures: ['taxable'], chart: 'line' })
    expect(m.model.filters.voucherKinds).toEqual(['sales'])
    expect(m.req.title).toBe('Sales by month')
  })

  it('top 10 customers by sales this year', () => {
    const m = model('top 10 customers by sales this year')!
    expect(m.model).toMatchObject({ dimensions: [{ key: 'party' }], measures: ['taxable'], topN: 10, sort: { by: 'taxable', dir: 'desc' }, period: { kind: 'relative', rule: 'fyToDate' } })
  })

  it('expenses by ledger last quarter (groups resolved by name)', () => {
    const m = model('expenses by ledger last quarter')!
    expect(m.model).toMatchObject({ dimensions: [{ key: 'ledger' }], measures: ['net'], period: { kind: 'relative', rule: 'lastQuarter' } })
    expect(m.model.filters.groupIds).toEqual([2, 3])
  })

  it('GST on purchases by month; quantities sold by item; sales in July', () => {
    expect(model('GST on purchases by month')!.model).toMatchObject({ measures: ['taxable', 'cgst', 'sgst', 'igst', 'cess'], filters: { voucherKinds: ['purchase'] } })
    expect(model('quantities sold by item')!.model).toMatchObject({ source: 'inventory', dimensions: [{ key: 'item' }], measures: ['qtyOut', 'value'] })
    expect(model('sales in July')!.model.period).toEqual({ kind: 'range', from: '2026-07-01', to: '2026-07-31' })
    expect(model('sales in january')!.model.period).toEqual({ kind: 'range', from: '2027-01-01', to: '2027-01-31' })
  })

  it('closing balances drop dimensions a balance cannot use; nonsense gives null', () => {
    expect(model('closing balances by party')!.model.dimensions).toEqual([]) // party dropped: a balance is per ledger
    expect(model('closing balances')!.model.dimensions).toEqual([{ key: 'ledger' }])
    expect(parseReportQuestion('what is the weather', WORKING)).toBeNull()
  })

  it('every phrase the screen offers maps to a valid model', () => {
    for (const q of ['Sales by month', 'Top 10 customers by sales this year', 'Expenses by ledger last quarter', 'GST on purchases by month', 'Quantities sold by item', 'profit by month', 'how many vouchers by voucher type', 'tds by month'])
      expect(model(q), q).not.toBeNull()
  })
})
