import { describe, it, expect } from 'vitest'
import { identifies, panOfGstin, suggestPairs, type SuggestMember } from './suggest'
import { ageBalance } from './ageing'

const A: SuggestMember = {
  slug: 'alpha', name: 'Alpha Pvt Ltd', gstin: '27AAACA1234A1Z5', pan: null,
  ledgers: [
    { id: 11, name: 'Beta Traders', groupName: 'Sundry Debtors', nature: 'asset', gstin: '29AAACB5678B1Z2', pan: null },
    { id: 12, name: 'Sales', groupName: 'Sales Accounts', nature: 'income', gstin: null, pan: null }
  ]
}
const B: SuggestMember = {
  slug: 'beta', name: 'Beta Traders', gstin: '29AAACB5678B1Z2', pan: 'AAACB5678B',
  ledgers: [{ id: 21, name: 'Alpha (supplier)', groupName: 'Sundry Creditors', nature: 'liability', gstin: null, pan: 'AAACA1234A' }]
}

describe('pair suggestions', () => {
  it('matches GSTIN, PAN (also inside a GSTIN) and, last, the name', () => {
    expect(panOfGstin('27AAACA1234A1Z5')).toBe('AAACA1234A')
    expect(identifies(A.ledgers[0]!, B)).toBe('gstin')
    expect(identifies(B.ledgers[0]!, A)).toBe('pan')
    expect(identifies({ ...A.ledgers[0]!, gstin: null }, B)).toBe('name')
    expect(identifies(A.ledgers[1]!, B)).toBeNull()
  })
  it('suggests one ledger pair with the kinds still open, the weaker reason wins, existing pairs are left out', () => {
    const s = suggestPairs([A, B], [])
    expect(s.map((x) => [x.memberA, x.ledgerAId, x.memberB, x.ledgerBId, x.kinds, x.reason])).toEqual([
      ['alpha', 11, 'beta', 21, ['receivable_payable', 'sales_purchase'], 'pan']
    ])
    const again = suggestPairs([A, B], [{ memberA: 'beta', ledgerAId: 21, memberB: 'alpha', ledgerBId: 11, kind: 'receivable_payable' }])
    expect(again.map((x) => x.kinds)).toEqual([['sales_purchase']])
  })
  it('never matches on a member company’s own GSTIN / PAN, and lists name-only matches last', () => {
    // Alpha's ledger carries Alpha's OWN PAN (e.g. a branch) — it does not identify Beta even if Beta shared it.
    const own = { ...A.ledgers[0]!, gstin: null, pan: 'AAACA1234A', name: 'Branch' }
    expect(identifies(own, { name: 'X', gstin: null, pan: 'AAACA1234A' }, A)).toBeNull()
    const C: SuggestMember = { slug: 'gamma', name: 'Gamma', gstin: null, pan: null, ledgers: [{ id: 31, name: 'Alpha Pvt Ltd', groupName: 'Sundry Creditors', nature: 'liability', gstin: null, pan: null }] }
    const A2: SuggestMember = { ...A, ledgers: [...A.ledgers, { id: 13, name: 'Gamma', groupName: 'Sundry Debtors', nature: 'asset', gstin: null, pan: null }] }
    expect(suggestPairs([A2, C, B], []).map((x) => x.reason)).toEqual(['pan', 'name'])
  })
  it('needs a ledger on both sides and ignores P&L ledgers', () => {
    expect(suggestPairs([A, { ...B, ledgers: [] }], [])).toEqual([])
  })
})

describe('ageing of an inter-company balance', () => {
  it('attributes the balance to the latest same-side movements', () => {
    const m = [
      { date: '2025-04-01', amount: 1000 }, // opening
      { date: '2025-12-01', amount: 500 },
      { date: '2026-02-20', amount: 300 },
      { date: '2026-03-01', amount: -900 }
    ]
    // balance 900 = 300 (39 days) + 500 (120 days) + 100 of the opening (364 days)
    expect(ageBalance(m, '2026-03-31')).toEqual([0, 300, 0, 500, 100])
    expect(ageBalance([{ date: '2026-03-30', amount: -50 }], '2026-03-31')).toEqual([-50, 0, 0, 0, 0])
    expect(ageBalance([], '2026-03-31')).toEqual([0, 0, 0, 0, 0])
  })
})
