import { describe, expect, it } from 'vitest'
import { earlyDiscount, groupPicksBySupplier, payByDate, planBucket, weekEnd } from './planning'

describe('payment planning buckets', () => {
  // 7 Oct 2026 is a Wednesday.
  const TODAY = '2026-10-07'
  it('this week ends on Sunday', () => {
    expect(weekEnd(TODAY)).toBe('2026-10-11')
    expect(weekEnd('2026-10-11')).toBe('2026-10-11')
    expect(weekEnd('2026-10-12')).toBe('2026-10-18')
  })
  it('overdue / this week / next week / later', () => {
    expect(planBucket('2026-10-06', TODAY)).toBe('overdue')
    expect(planBucket('2026-10-07', TODAY)).toBe('this_week')
    expect(planBucket('2026-10-11', TODAY)).toBe('this_week')
    expect(planBucket('2026-10-12', TODAY)).toBe('next_week')
    expect(planBucket('2026-10-18', TODAY)).toBe('next_week')
    expect(planBucket('2026-10-19', TODAY)).toBe('later')
  })
})

describe('pay-by date', () => {
  it('the earlier of the terms due date and the s.15 deadline', () => {
    expect(payByDate('2026-09-01', '2026-10-31', '2026-09-16')).toBe('2026-09-16')
    expect(payByDate('2026-09-01', '2026-09-10', '2026-09-16')).toBe('2026-09-10')
    expect(payByDate('2026-09-01', null, null)).toBe('2026-09-01')
    expect(payByDate('2026-09-01', null, '2026-09-16')).toBe('2026-09-01')
  })
})

describe('early-payment discount', () => {
  it('2 % within 10 days of the bill', () => {
    expect(earlyDiscount(1_000_000, '2026-10-01', { bp: 200, days: 10 }, '2026-10-07')).toEqual({ by: '2026-10-11', bp: 200, paise: 20_000, available: true })
    expect(earlyDiscount(1_000_000, '2026-10-01', { bp: 200, days: 10 }, '2026-10-12')?.available).toBe(false)
  })
  it('none without terms', () => {
    expect(earlyDiscount(1_000_000, '2026-10-01', null, '2026-10-07')).toBeNull()
    expect(earlyDiscount(1_000_000, '2026-10-01', { bp: 0, days: 10 }, '2026-10-07')).toBeNull()
  })
})

describe('ticked bills → one payment per supplier', () => {
  it('groups by supplier, keeps pick order, merges a bill picked twice, drops zeros', () => {
    expect(
      groupPicksBySupplier([
        { ledgerId: 7, number: 'B-1', amount: 1000 },
        { ledgerId: 9, number: 'X-4', amount: 500 },
        { ledgerId: 7, number: 'B-2', amount: 250 },
        { ledgerId: 7, number: 'B-1', amount: 100 },
        { ledgerId: 9, number: 'X-5', amount: 0 }
      ])
    ).toEqual([
      { partyLedgerId: 7, amount: 1350, bills: [{ name: 'B-1', amount: 1100 }, { name: 'B-2', amount: 250 }] },
      { partyLedgerId: 9, amount: 500, bills: [{ name: 'X-4', amount: 500 }] }
    ])
  })
})
