import { describe, it, expect } from 'vitest'
import { budgetVariance, type ActualRow, type BudgetLineRow } from './budgets'

describe('budgetVariance', () => {
  it('sums a monthly line against actuals in that exact month only', () => {
    const lines: BudgetLineRow[] = [
      { targetName: 'Travel', ledgerId: 1, groupId: null, month: '2025-04', amount: 10000 }
    ]
    const actuals: ActualRow[] = [
      { ledgerId: 1, month: '2025-04', amount: 6000 },
      { ledgerId: 1, month: '2025-05', amount: 9000 } // different month — excluded
    ]
    const rows = budgetVariance(lines, actuals, new Map(), '2025-06')
    expect(rows).toEqual([{ targetName: 'Travel', month: '2025-04', budget: 10000, actual: 6000, variance: -4000, pct: 60 }])
  })

  it('sums an annual line as FY-to-date through upToMonth, excluding later months', () => {
    const lines: BudgetLineRow[] = [
      { targetName: 'Travel', ledgerId: 1, groupId: null, month: null, amount: 12000 }
    ]
    const actuals: ActualRow[] = [
      { ledgerId: 1, month: '2025-04', amount: 3000 },
      { ledgerId: 1, month: '2025-05', amount: 4000 },
      { ledgerId: 1, month: '2025-06', amount: 5000 } // after upToMonth — excluded
    ]
    const rows = budgetVariance(lines, actuals, new Map(), '2025-05')
    expect(rows[0]).toMatchObject({ budget: 12000, actual: 7000, variance: -5000 })
  })

  it('rolls up a group line over its descendant ledgers via the descendants map', () => {
    const lines: BudgetLineRow[] = [
      { targetName: 'Indirect Expenses', ledgerId: null, groupId: 100, month: '2025-04', amount: 20000 }
    ]
    const actuals: ActualRow[] = [
      { ledgerId: 1, month: '2025-04', amount: 5000 }, // in the group
      { ledgerId: 2, month: '2025-04', amount: 7000 }, // in the group
      { ledgerId: 3, month: '2025-04', amount: 9000 } // NOT in the group — excluded
    ]
    const groupDescendants = new Map([[100, new Set([1, 2])]])
    const rows = budgetVariance(lines, actuals, groupDescendants, '2025-04')
    expect(rows[0]).toMatchObject({ actual: 12000, budget: 20000, variance: -8000 })
  })

  it('pct is null when budget is 0, regardless of actual', () => {
    const lines: BudgetLineRow[] = [
      { targetName: 'Travel', ledgerId: 1, groupId: null, month: '2025-04', amount: 0 }
    ]
    const actuals: ActualRow[] = [{ ledgerId: 1, month: '2025-04', amount: 500 }]
    const rows = budgetVariance(lines, actuals, new Map(), '2025-04')
    expect(rows[0]!.pct).toBeNull()
    expect(rows[0]!.variance).toBe(500)
  })

  it('pct rounds to the nearest integer percent', () => {
    const lines: BudgetLineRow[] = [
      { targetName: 'Travel', ledgerId: 1, groupId: null, month: '2025-04', amount: 3000 }
    ]
    const actuals: ActualRow[] = [{ ledgerId: 1, month: '2025-04', amount: 1000 }] // 33.33%
    const rows = budgetVariance(lines, actuals, new Map(), '2025-04')
    expect(rows[0]!.pct).toBe(33)
  })
})
