import { describe, it, expect } from 'vitest'
import { depositDueDate, lateDeductionInterest, lateDepositInterest, monthsOrPart } from './tdsInterest'

describe('TDS interest (indicative)', () => {
  it('due date: 7th of the next month; March deductions by 30 April', () => {
    expect(depositDueDate('2025-05-10')).toBe('2025-06-07')
    expect(depositDueDate('2025-12-31')).toBe('2026-01-07')
    expect(depositDueDate('2026-03-15')).toBe('2026-04-30')
  })

  it('months or part of a month, both ends counted', () => {
    expect(monthsOrPart('2025-01-25', '2025-02-08')).toBe(2)
    expect(monthsOrPart('2025-01-05', '2025-01-20')).toBe(1)
    expect(monthsOrPart('2025-01-05', '2025-01-05')).toBe(0)
    expect(monthsOrPart('2025-11-30', '2026-01-02')).toBe(3)
  })

  it('late deposit: 1.5% per month from deduction to payment, nothing when paid on time', () => {
    expect(lateDepositInterest(100000, '2025-05-10', '2025-06-07')).toMatchObject({ interestPaise: 0, months: 0, dueDate: '2025-06-07' })
    // ₹1,000 deducted 10 May, paid 8 June: May + June = 2 months x 1.5% = ₹30.
    expect(lateDepositInterest(100000, '2025-05-10', '2025-06-08')).toMatchObject({ interestPaise: 3000, months: 2 })
    // Editable rate.
    expect(lateDepositInterest(100000, '2025-05-10', '2025-06-08', 100).interestPaise).toBe(2000)
  })

  it('late deduction: 1% per month from when deductible to when deducted', () => {
    expect(lateDeductionInterest(100000, '2025-05-10', '2025-05-10').interestPaise).toBe(0)
    expect(lateDeductionInterest(100000, '2025-05-10', '2025-07-01')).toMatchObject({ months: 3, interestPaise: 3000 })
  })
})
