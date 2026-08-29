import { describe, expect, it } from 'vitest'
import { groupTrialBalance } from './tbGroups'
import type { TrialBalanceRow } from './reports'

const row = (over: Partial<TrialBalanceRow> & { ledgerId: number; ledgerName: string }): TrialBalanceRow => ({
  groupName: 'Sundry Debtors',
  topGroupName: 'Current Assets',
  nature: 'asset',
  debit: 0,
  credit: 0,
  opening: 0,
  movementDebit: 0,
  movementCredit: 0,
  ...over
})

describe('groupTrialBalance', () => {
  it('subtotals equal the sum of exactly the rows shown under them', () => {
    const sections = groupTrialBalance(
      [
        row({ ledgerId: 1, ledgerName: 'Ram', debit: 100_00, movementDebit: 100_00 }),
        row({ ledgerId: 2, ledgerName: 'Shyam', debit: 250_00, movementDebit: 250_00 }),
        row({ ledgerId: 3, ledgerName: 'HDFC', groupName: 'Bank Accounts', debit: 900_00 })
      ],
      'group'
    )
    expect(sections.map((s) => s.name)).toEqual(['Bank Accounts', 'Sundry Debtors'])
    const debtors = sections.find((s) => s.name === 'Sundry Debtors')!
    expect(debtors.totals.debit).toBe(350_00)
    expect(debtors.totals.debit).toBe(debtors.rows.reduce((s, r) => s + r.debit, 0))
  })

  it('folds to the primary group when asked, which is the level a balance sheet reads at', () => {
    const sections = groupTrialBalance(
      [
        row({ ledgerId: 1, ledgerName: 'Ram', debit: 100_00 }),
        row({ ledgerId: 3, ledgerName: 'HDFC', groupName: 'Bank Accounts', debit: 900_00 })
      ],
      'topGroup'
    )
    expect(sections).toHaveLength(1)
    expect(sections[0]!.name).toBe('Current Assets')
    expect(sections[0]!.totals.debit).toBe(1000_00)
  })

  it('never loses a row whose primary group is unknown', () => {
    const sections = groupTrialBalance(
      [row({ ledgerId: 1, ledgerName: 'Odd', groupName: 'Suspense A/c', topGroupName: undefined, debit: 5_00 })],
      'topGroup'
    )
    expect(sections).toHaveLength(1)
    expect(sections[0]!.name).toBe('Suspense A/c')
    expect(sections[0]!.rows).toHaveLength(1)
  })

  it('every input row appears exactly once across the sections', () => {
    const rows = [
      row({ ledgerId: 1, ledgerName: 'A' }),
      row({ ledgerId: 2, ledgerName: 'B', groupName: 'Bank Accounts' }),
      row({ ledgerId: 3, ledgerName: 'C', groupName: 'Sales Accounts', topGroupName: 'Sales Accounts' })
    ]
    const sections = groupTrialBalance(rows, 'group')
    expect(sections.reduce((n, s) => n + s.rows.length, 0)).toBe(rows.length)
  })

  it('sorts ledgers inside a section by name', () => {
    const sections = groupTrialBalance(
      [row({ ledgerId: 1, ledgerName: 'Zeta' }), row({ ledgerId: 2, ledgerName: 'Alpha' })],
      'group'
    )
    expect(sections[0]!.rows.map((r) => r.ledgerName)).toEqual(['Alpha', 'Zeta'])
  })

  it('an empty trial balance produces no sections rather than an empty one', () => {
    expect(groupTrialBalance([], 'group')).toEqual([])
  })

  it('carries a ledger with only an opening balance into its section total', () => {
    const sections = groupTrialBalance([row({ ledgerId: 1, ledgerName: 'Old', opening: 750_00, debit: 750_00 })], 'group')
    expect(sections[0]!.totals.opening).toBe(750_00)
    expect(sections[0]!.totals.movementDebit).toBe(0)
  })
})
