import { describe, it, expect } from 'vitest'
import { depositDueDate, lateDeductionInterest, lateDeductionOnPayment, lateDepositInterest, monthsOrPart } from './tdsInterest'

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

  it('late deduction on payment: each covered bill from its own deductible date (hand-worked)', () => {
    expect(lateDeductionOnPayment(80000, 4000000, '2025-06-01', undefined)).toBeNull()
    // ₹800 TDS on a ₹40,000 bill deductible 10 May, deducted 1 Jun: 2 months × 1% = ₹16.
    expect(lateDeductionOnPayment(80000, 4000000, '2025-06-01', [{ voucherId: 1, deductibleOn: '2025-05-10', basePaise: 4000000 }]))
      .toMatchObject({ deductibleOn: '2025-05-10', months: 2, interestPaise: 1600 })
    // ₹2,100 on ₹1,05,000 deducted 5 Aug covering ₹25,000 + ₹80,000 both deductible 10 Jun:
    // ₹500 × 3% = ₹15, ₹1,600 × 3% = ₹48 → ₹63.
    const r = lateDeductionOnPayment(210000, 10500000, '2025-08-05', [
      { voucherId: 1, deductibleOn: '2025-06-10', basePaise: 2500000 },
      { voucherId: 2, deductibleOn: '2025-06-10', basePaise: 8000000 }
    ])!
    expect(r.interestPaise).toBe(6300)
    expect(r.parts.map((p) => p.tdsPaise)).toEqual([50000, 160000])
    // Only part of the base was late (the rest an advance): the share follows the base.
    expect(lateDeductionOnPayment(100000, 5000000, '2025-06-01', [{ voucherId: 1, deductibleOn: '2025-05-10', basePaise: 4000000 }])!.parts[0]!.tdsPaise).toBe(80000)
  })
})
