import { describe, expect, it } from 'vitest'
import { CASH_PAYMENT_LIMIT, CASH_RECEIPT_LIMIT, CLAUSES, clauseSpec, extract, limitOn } from './form3cd'

describe('limitOn', () => {
  it('serves the ₹20,000 limit for a year before the Finance Act 2017 halved it', () => {
    // A pack produced for an old year has to use that year's limit, or every payment between
    // ₹10,000 and ₹20,000 is reported as a disallowance that never happened.
    expect(limitOn(CASH_PAYMENT_LIMIT, '2016-06-01').limit).toBe(20_000_00)
  })

  it('serves ₹10,000 from 1 April 2017', () => {
    expect(limitOn(CASH_PAYMENT_LIMIT, '2017-04-01').limit).toBe(10_000_00)
    expect(limitOn(CASH_PAYMENT_LIMIT, '2026-08-01').limit).toBe(10_000_00)
  })

  it('serves the earliest entry for a date before the history starts', () => {
    expect(limitOn(CASH_RECEIPT_LIMIT, '2010-01-01').limit).toBe(2_00_000_00)
  })
})

describe('CLAUSES', () => {
  it('cites an authority for every clause, because that is the point of the pack', () => {
    expect(CLAUSES.every((c) => c.authority.length > 0 && c.asks.length > 0)).toBe(true)
  })

  it('has no duplicate clause numbers', () => {
    expect(new Set(CLAUSES.map((c) => c.clause)).size).toBe(CLAUSES.length)
  })

  it('marks the clauses that need a human judgement as such', () => {
    // 21(d) can list every cash payment over the limit but cannot know which went through an
    // account-payee instrument.
    expect(clauseSpec('21(d)').source).toBe('booksWithJudgement')
    expect(clauseSpec('22').source).toBe('books')
  })
})

describe('extract', () => {
  it('carries the clause metadata so a caller only supplies data', () => {
    const e = extract('22', ['Supplier', 'Interest'], [{ cells: ['Ram & Co', '1,200.00'] }], { caveats: ['Not deductible when paid.'] })
    expect(e.title).toContain('MSMED')
    expect(e.authority).toContain('Section 23')
    expect(e.rows).toHaveLength(1)
    expect(e.total).toBeNull()
  })

  it('refuses a clause it has no spec for, rather than inventing a heading', () => {
    expect(() => extract('99', [], [])).toThrow(/no form 3cd clause spec/i)
  })
})
