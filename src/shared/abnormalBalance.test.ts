import { describe, expect, it } from 'vitest'
import { abnormalReason, isAbnormalBalance } from './abnormalBalance'

describe('isAbnormalBalance', () => {
  it('flags an asset sitting in credit', () => {
    // A bank account overdrawn in the books but not at the bank is the classic case.
    expect(isAbnormalBalance('asset', -50000)).toBe(true)
    expect(isAbnormalBalance('asset', 50000)).toBe(false)
  })

  it('flags a liability sitting in debit', () => {
    // A supplier left in debit by a payment posted against the wrong name.
    expect(isAbnormalBalance('liability', 50000)).toBe(true)
    expect(isAbnormalBalance('liability', -50000)).toBe(false)
  })

  it('never flags zero', () => {
    for (const nature of ['asset', 'liability', 'income', 'expense'] as const) {
      expect(isAbnormalBalance(nature, 0)).toBe(false)
    }
  })

  it('never flags income or expense, which are flows and not balances', () => {
    // They are netted into the P&L rather than carried, so either side of them is ordinary.
    for (const balance of [-100, 100]) {
      expect(isAbnormalBalance('income', balance)).toBe(false)
      expect(isAbnormalBalance('expense', balance)).toBe(false)
    }
  })
})

describe('abnormalReason', () => {
  it('says which way round the problem is', () => {
    expect(abnormalReason('asset', -1)).toMatch(/asset in credit/)
    expect(abnormalReason('liability', 1)).toMatch(/liability in debit/)
  })

  it('says nothing about a normal balance', () => {
    expect(abnormalReason('asset', 1)).toBeNull()
    expect(abnormalReason('income', 1)).toBeNull()
  })
})
