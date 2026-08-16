import { describe, it, expect } from 'vitest'
import { mergeByName, type ConsolidateCompanyInput } from './consolidate'

describe('mergeByName', () => {
  it('merges ledgers that appear in every company by name', () => {
    const input: ConsolidateCompanyInput[] = [
      { company: 'Alpha', rows: [{ group: 'Cash-in-Hand', name: 'Cash', dr: 10000, cr: 0 }] },
      { company: 'Beta', rows: [{ group: 'Cash-in-Hand', name: 'Cash', dr: 5000, cr: 0 }] }
    ]
    const rows = mergeByName(input)
    expect(rows).toEqual([
      { name: 'Cash', group: 'Cash-in-Hand', perCompany: [10000, 5000], total: 15000 }
    ])
  })

  it('merges names case-insensitively and trims whitespace', () => {
    const input: ConsolidateCompanyInput[] = [
      { company: 'Alpha', rows: [{ group: 'Sales Accounts', name: 'Sales', dr: 0, cr: 20000 }] },
      { company: 'Beta', rows: [{ group: 'Sales Accounts', name: '  SALES  ', dr: 0, cr: 8000 }] }
    ]
    const rows = mergeByName(input)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.name).toBe('Sales')
    expect(rows[0]!.perCompany).toEqual([-20000, -8000])
    expect(rows[0]!.total).toBe(-28000)
  })

  it('fills a null cell where a company has no row for that name', () => {
    const input: ConsolidateCompanyInput[] = [
      { company: 'Alpha', rows: [{ group: 'Sundry Debtors', name: 'Acme Corp', dr: 4000, cr: 0 }] },
      { company: 'Beta', rows: [] }
    ]
    const rows = mergeByName(input)
    expect(rows).toEqual([
      { name: 'Acme Corp', group: 'Sundry Debtors', perCompany: [4000, null], total: 4000 }
    ])
  })

  it('sums duplicate names within a single company before merging', () => {
    const input: ConsolidateCompanyInput[] = [
      {
        company: 'Alpha',
        rows: [
          { group: 'Indirect Expenses', name: 'Rent', dr: 1000, cr: 0 },
          { group: 'Indirect Expenses', name: 'rent', dr: 500, cr: 0 }
        ]
      }
    ]
    const rows = mergeByName(input)
    expect(rows).toEqual([{ name: 'Rent', group: 'Indirect Expenses', perCompany: [1500], total: 1500 }])
  })

  it('computes totals row-wise, ignoring null cells', () => {
    const input: ConsolidateCompanyInput[] = [
      { company: 'Alpha', rows: [{ group: 'Direct Expenses', name: 'Freight', dr: 300, cr: 0 }] },
      { company: 'Beta', rows: [{ group: 'Direct Expenses', name: 'Freight', dr: 700, cr: 0 }] },
      { company: 'Gamma', rows: [] }
    ]
    const rows = mergeByName(input)
    expect(rows[0]!.perCompany).toEqual([300, 700, null])
    expect(rows[0]!.total).toBe(1000)
  })

  it('sorts rows alphabetically by display name', () => {
    const input: ConsolidateCompanyInput[] = [
      {
        company: 'Alpha',
        rows: [
          { group: 'g', name: 'Zebra', dr: 1, cr: 0 },
          { group: 'g', name: 'Apple', dr: 1, cr: 0 }
        ]
      }
    ]
    const rows = mergeByName(input)
    expect(rows.map((r) => r.name)).toEqual(['Apple', 'Zebra'])
  })

  it('returns an empty array for no companies', () => {
    expect(mergeByName([])).toEqual([])
  })
})
