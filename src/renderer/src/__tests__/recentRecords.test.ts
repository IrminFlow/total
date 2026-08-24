import { beforeEach, describe, expect, it } from 'vitest'
import { readRecentRecords, rememberRecentRecord } from '../lib/recentRecords'

describe('recent records', () => {
  beforeEach(() => localStorage.clear())

  it('keeps records per company, deduplicates and preserves a better label', () => {
    rememberRecentRecord('alpha', { kind: 'voucher', id: 7, label: 'Sales A-007', sub: 'Acme · 24-Aug-26' }, 1)
    rememberRecentRecord('alpha', { kind: 'ledger', id: 3, label: 'Acme', sub: 'Sundry Debtors' }, 2)
    rememberRecentRecord('alpha', { kind: 'voucher', id: 7, label: 'Voucher #7', sub: 'Recently viewed voucher' }, 3)
    expect(readRecentRecords('alpha').map((row) => row.label)).toEqual(['Sales A-007', 'Acme'])
    expect(readRecentRecords('alpha')[0]?.openedAt).toBe(3)
    expect(readRecentRecords('beta')).toEqual([])
  })

  it('caps history to twelve records', () => {
    for (let id = 1; id <= 15; id++) rememberRecentRecord('alpha', { kind: 'item', id, label: `Item ${id}`, sub: 'Stock item' }, id)
    expect(readRecentRecords('alpha')).toHaveLength(12)
    expect(readRecentRecords('alpha')[0]?.id).toBe(15)
  })
})
