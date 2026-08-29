import { describe, it, expect } from 'vitest'
import { addMonthsISO, amortise, computeEmi, instalmentsBetween, outstandingOn } from './loan'

describe('the EMI', () => {
  it('matches a bank amortisation sheet', () => {
    // ₹5,00,000 at 12% p.a. over 24 months is ₹23,536.74 — the standard textbook figure.
    expect(computeEmi(5_00_000_00, 1200, 24)).toBe(23_536_74)
  })

  it('an interest-free loan is simply the principal divided, rounded up so it clears', () => {
    expect(computeEmi(10_000_00, 0, 3)).toBe(3_333_34)
  })
})

describe('the amortisation schedule', () => {
  const terms = { principalPaise: 5_00_000_00, annualRateBp: 1200, months: 24, firstInstalmentDate: '2026-05-10' }

  it('ends at exactly zero, however the EMI divides', () => {
    const s = amortise(terms)
    expect(s.rows).toHaveLength(24)
    expect(s.rows[23]!.closingPaise).toBe(0)
  })

  it('repays exactly what was borrowed', () => {
    const s = amortise(terms)
    expect(s.rows.reduce((t, r) => t + r.principalPaise, 0)).toBe(terms.principalPaise)
  })

  it('the last instalment differs from the rest, and says so', () => {
    const s = amortise(terms)
    expect(s.finalInstalmentPaise).not.toBe(s.emiPaise)
    expect(Math.abs(s.finalInstalmentPaise - s.emiPaise)).toBeLessThan(100_00)
  })

  it('shifts from interest to principal as the loan runs', () => {
    const s = amortise(terms)
    expect(s.rows[0]!.interestPaise).toBeGreaterThan(s.rows[23]!.interestPaise)
    expect(s.rows[0]!.principalPaise).toBeLessThan(s.rows[23]!.principalPaise)
    // The first month's interest is one twelfth of 12% of the whole principal.
    expect(s.rows[0]!.interestPaise).toBe(5_000_00)
  })

  it('every row balances: opening less principal is closing, and the EMI is its two parts', () => {
    for (const r of amortise(terms).rows) {
      expect(r.closingPaise).toBe(r.openingPaise - r.principalPaise)
      expect(r.emiPaise).toBe(r.principalPaise + r.interestPaise)
      expect(Number.isInteger(r.interestPaise)).toBe(true)
    }
  })

  it('honours the EMI the bank stated rather than recomputing it', () => {
    const s = amortise({ ...terms, emiPaise: 23_540_00 })
    expect(s.emiStated).toBe(true)
    expect(s.rows[0]!.emiPaise).toBe(23_540_00)
    expect(s.rows[s.rows.length - 1]!.closingPaise).toBe(0)
  })

  it('a generous stated EMI clears the loan early rather than overshooting into a negative balance', () => {
    const s = amortise({ ...terms, emiPaise: 50_000_00 })
    expect(s.rows.length).toBeLessThan(24)
    expect(s.rows[s.rows.length - 1]!.closingPaise).toBe(0)
  })

  it('refuses an instalment that never repays anything', () => {
    expect(() => amortise({ ...terms, emiPaise: 1_000_00 })).toThrow('never repays')
  })

  it('a single-instalment loan is principal plus one month of interest', () => {
    const s = amortise({ principalPaise: 1_00_000_00, annualRateBp: 1200, months: 1, firstInstalmentDate: '2026-05-01' })
    expect(s.rows).toHaveLength(1)
    expect(s.rows[0]!.principalPaise).toBe(1_00_000_00)
    expect(s.rows[0]!.interestPaise).toBe(1_000_00)
  })

  it('refuses a loan with no principal', () => {
    expect(() => amortise({ ...terms, principalPaise: 0 })).toThrow('needs a principal')
  })
})

describe('due dates', () => {
  it('runs monthly from the first instalment', () => {
    const s = amortise({ principalPaise: 1_00_000_00, annualRateBp: 900, months: 3, firstInstalmentDate: '2026-05-10' })
    expect(s.rows.map((r) => r.dueDate)).toEqual(['2026-05-10', '2026-06-10', '2026-07-10'])
  })

  it('a loan due on the 31st is due at the end of a short month, not in the next one', () => {
    expect(addMonthsISO('2026-01-31', 1)).toBe('2026-02-28')
    expect(addMonthsISO('2026-01-31', 3)).toBe('2026-04-30')
  })

  it('crosses a year end', () => {
    expect(addMonthsISO('2026-11-15', 3)).toBe('2027-02-15')
  })
})

describe('reading the schedule', () => {
  const s = amortise({ principalPaise: 1_00_000_00, annualRateBp: 1200, months: 12, firstInstalmentDate: '2026-04-05' })

  it('picks out the instalments in a period', () => {
    const q1 = instalmentsBetween(s, '2026-04-01', '2026-06-30')
    expect(q1).toHaveLength(3)
  })

  it('says what is still owed on a date', () => {
    expect(outstandingOn(s, 1_00_000_00, '2026-03-31')).toBe(1_00_000_00)
    expect(outstandingOn(s, 1_00_000_00, '2027-03-31')).toBe(0)
  })
})
