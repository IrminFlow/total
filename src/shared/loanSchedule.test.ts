import { describe, expect, it } from 'vitest'
import {
  emiFor, generateSchedule, instalmentDate, interestBetween, monthlyInterest, mulDivRound, parseRateMilli, rateMilliText,
  type LoanTerms
} from './loanSchedule'

const base: LoanTerms = {
  principal: 1_00_000_00, // ₹1,00,000
  annualRateMilli: 12_000, // 12 %
  tenureMonths: 12,
  firstDueDate: '2026-05-05',
  method: 'reducing',
  moratoriumMonths: 0,
  moratoriumMode: 'capitalise',
  emiOverride: null
}

describe('EMI formula — worked examples', () => {
  it('₹1,00,000 at 12 % for 12 months → ₹8,884.88 (P·r·(1+r)^n / ((1+r)^n − 1), r = 1 %)', () => {
    expect(emiFor(1_00_000_00, 12_000, 12)).toBe(8_884_88)
  })
  it('₹10,00,000 at 10 % for 240 months → ₹9,650.22', () => {
    expect(emiFor(10_00_000_00, 10_000, 240)).toBe(9_650_22)
  })
  it('zero rate spreads the principal (rounded up)', () => {
    expect(emiFor(1000_00, 0, 3)).toBe(333_34)
  })
})

describe('schedule — reducing balance', () => {
  const s = generateSchedule(base)
  it('first row: interest ₹1,000.00, principal ₹7,884.88, closing ₹92,115.12', () => {
    expect(s.rows[0]).toMatchObject({ seq: 1, dueDate: '2026-05-05', kind: 'emi', opening: 1_00_000_00, interest: 1_000_00, principal: 7_884_88, payment: 8_884_88, closing: 92_115_12 })
  })
  it('second row interest is round_half_up(92,115.12 × 1 %) = ₹921.15', () => {
    expect(s.rows[1]!.interest).toBe(921_15)
  })
  it('twelve rows, principal sums to the loan exactly and the last instalment absorbs the remainder', () => {
    expect(s.rows).toHaveLength(12)
    expect(s.rows.reduce((a, r) => a + r.principal, 0)).toBe(1_00_000_00)
    expect(s.rows.at(-1)!.closing).toBe(0)
    expect(s.rows.slice(0, 11).every((r) => r.payment === 8_884_88)).toBe(true)
    // rounding drift on the last instalment stays within a few paise
    expect(Math.abs(s.rows.at(-1)!.payment - 8_884_88)).toBeLessThan(10)
    expect(s.totalInterest).toBe(s.totalPayment - 1_00_000_00)
  })
  it('every row balances: opening − principal = closing; payment = principal + interest', () => {
    for (const r of s.rows) {
      expect(r.opening - r.principal).toBe(r.closing)
      expect(r.payment).toBe(r.principal + r.interest)
    }
  })
  it('due dates keep the day, clamped to short months', () => {
    expect(instalmentDate('2026-01-31', 1)).toBe('2026-02-28')
    expect(instalmentDate('2026-01-31', 2)).toBe('2026-03-31')
    expect(instalmentDate('2026-11-15', 3)).toBe('2027-02-15')
  })
})

describe('moratorium and prepayment', () => {
  it('capitalised moratorium grows the balance by each month’s interest, then amortises it', () => {
    const s = generateSchedule({ ...base, moratoriumMonths: 2 })
    expect(s.rows[0]).toMatchObject({ kind: 'moratorium', payment: 0, interest: 1_000_00, principal: -1_000_00, closing: 1_01_000_00 })
    expect(s.rows[1]).toMatchObject({ kind: 'moratorium', interest: 1_010_00, closing: 1_02_010_00 })
    expect(s.rows).toHaveLength(14)
    expect(s.emi).toBe(emiFor(1_02_010_00, 12_000, 12))
    expect(s.rows.at(-1)!.closing).toBe(0)
  })
  it('interest-only moratorium pays the interest and leaves principal untouched', () => {
    const s = generateSchedule({ ...base, moratoriumMonths: 1, moratoriumMode: 'interest_only' })
    expect(s.rows[0]).toMatchObject({ kind: 'moratorium', payment: 1_000_00, principal: 0, closing: 1_00_000_00 })
    expect(s.emi).toBe(8_884_88)
  })
  it('a prepayment that reduces tenure keeps the EMI and ends sooner', () => {
    const s = generateSchedule(base, [{ date: '2026-07-20', amount: 30_000_00, effect: 'reduce_tenure' }])
    const pre = s.rows.find((r) => r.kind === 'prepayment')!
    expect(pre).toMatchObject({ dueDate: '2026-07-20', payment: 30_000_00, interest: 0 })
    const emis = s.rows.filter((r) => r.kind === 'emi')
    expect(emis.length).toBeLessThan(12)
    expect(emis.slice(0, -1).every((r) => r.payment === 8_884_88)).toBe(true)
    expect(s.rows.reduce((a, r) => a + r.principal, 0)).toBe(1_00_000_00)
  })
  it('a prepayment that reduces EMI keeps the tenure and recomputes the instalment', () => {
    const s = generateSchedule(base, [{ date: '2026-07-20', amount: 30_000_00, effect: 'reduce_emi' }])
    const emis = s.rows.filter((r) => r.kind === 'emi')
    expect(emis).toHaveLength(12)
    expect(emis[3]!.payment).toBeLessThan(8_884_88)
    expect(s.rows.at(-1)!.closing).toBe(0)
  })
  it('a prepayment inside a capitalised moratorium applies on its date (review case)', () => {
    // ₹1,00,000 @ 12 %, 3-month capitalised moratorium from 5 May, ₹50,000 prepaid on 20 May.
    const s = generateSchedule({ ...base, moratoriumMonths: 3 }, [{ date: '2026-05-20', amount: 50_000_00, effect: 'reduce_emi' }])
    expect(s.rows.slice(0, 4).map((r) => [r.kind, r.dueDate])).toEqual([
      ['moratorium', '2026-05-05'], ['prepayment', '2026-05-20'], ['moratorium', '2026-06-05'], ['moratorium', '2026-07-05']
    ])
    // month 1 interest on 1,00,000; then 1,01,000 − 50,000 = 51,000 earns 510 in month 2
    expect(s.rows[1]).toMatchObject({ opening: 1_01_000_00, closing: 51_000_00 })
    expect(s.rows[2]).toMatchObject({ interest: 510_00, closing: 51_510_00 })
    expect(s.emi).toBe(emiFor(Math.round(51_510_00 * 1.01), 12_000, 12))
    const dates = s.rows.map((r) => r.dueDate)
    expect([...dates].sort()).toEqual(dates)
    expect(s.rows.at(-1)!.closing).toBe(0)
  })

  it('refuses an EMI that does not cover interest', () => {
    expect(() => generateSchedule({ ...base, emiOverride: 500_00 })).toThrow(/does not cover/)
  })
})

describe('flat rate', () => {
  it('₹1,20,000 at 10 % flat over 12 months: ₹12,000 interest, ₹11,000 a month', () => {
    const s = generateSchedule({ ...base, principal: 1_20_000_00, annualRateMilli: 10_000, method: 'flat' })
    expect(s.totalInterest).toBe(12_000_00)
    expect(s.rows.every((r) => r.payment === 11_000_00)).toBe(true)
    expect(s.rows.at(-1)!.closing).toBe(0)
  })
  it('remainders go to the last instalment', () => {
    const s = generateSchedule({ ...base, principal: 1000_01, annualRateMilli: 7_000, tenureMonths: 7, method: 'flat' })
    expect(s.rows.reduce((a, r) => a + r.principal, 0)).toBe(1000_01)
    expect(s.rows.reduce((a, r) => a + r.interest, 0)).toBe(s.totalInterest)
  })
})

describe('helpers', () => {
  it('mulDivRound rounds half up exactly, symmetric for negatives', () => {
    expect(mulDivRound(5, 1, 2)).toBe(3)
    expect(mulDivRound(-5, 1, 2)).toBe(-3)
    expect(mulDivRound(9_000_000_000_000, 60_000, 1_200_000)).toBe(450_000_000_000)
  })
  it('monthly interest of ₹92,115.12 at 12 % is ₹921.15', () => {
    expect(monthlyInterest(92_115_12, 12_000)).toBe(921_15)
  })
  it('interest for a period sums the rows due in it', () => {
    const s = generateSchedule(base)
    expect(interestBetween(s.rows, '2026-05-01', '2026-06-30')).toBe(s.rows[0]!.interest + s.rows[1]!.interest)
  })
  it('rate text round-trips', () => {
    expect(parseRateMilli('10.75')).toBe(10_750)
    expect(parseRateMilli('9 %')).toBe(9_000)
    expect(parseRateMilli('abc')).toBeNull()
    expect(rateMilliText(10_750)).toBe('10.75')
    expect(rateMilliText(9_000)).toBe('9')
  })
})
