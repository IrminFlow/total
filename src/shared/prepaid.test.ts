import { describe, it, expect } from 'vitest'
import { amortiseOverMonths, expiredBy, unexpiredOn } from './prepaid'

describe('spreading a payment over the months it belongs to', () => {
  it('splits an annual premium across twelve months', () => {
    const rows = amortiseOverMonths({ amountPaise: 12_000_00, from: '2026-04-01', to: '2027-03-31', basis: 'month' })
    expect(rows).toHaveLength(12)
    expect(rows[0]!.month).toBe('2026-04')
    expect(rows[0]!.amountPaise).toBe(1_000_00)
  })

  it('always sums to what was paid, however awkwardly it divides', () => {
    const rows = amortiseOverMonths({ amountPaise: 10_000_00, from: '2026-04-01', to: '2027-03-31', basis: 'month' })
    expect(rows.reduce((s, r) => s + r.amountPaise, 0)).toBe(10_000_00)
    // The remainder lands on the last month rather than leaving a balance that never clears.
    expect(rows[11]!.amountPaise).not.toBe(rows[0]!.amountPaise)
    expect(rows[11]!.unexpiredPaise).toBe(0)
  })

  it('weights by days when the period starts mid-month', () => {
    const rows = amortiseOverMonths({ amountPaise: 12_000_00, from: '2026-04-15', to: '2027-04-14', basis: 'day' })
    expect(rows).toHaveLength(13)
    expect(rows[0]!.days).toBe(16) // 15 April to 30 April inclusive
    expect(rows[0]!.amountPaise).toBeLessThan(rows[1]!.amountPaise)
    expect(rows.reduce((s, r) => s + r.amountPaise, 0)).toBe(12_000_00)
  })

  it('runs the unexpired balance down to zero', () => {
    const rows = amortiseOverMonths({ amountPaise: 12_000_00, from: '2026-04-01', to: '2027-03-31', basis: 'month' })
    for (const r of rows) expect(r.unexpiredPaise).toBe(12_000_00 - r.cumulativePaise)
    expect(rows[rows.length - 1]!.unexpiredPaise).toBe(0)
  })

  it('a period inside one month is one row', () => {
    const rows = amortiseOverMonths({ amountPaise: 5_000_00, from: '2026-04-05', to: '2026-04-20', basis: 'day' })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.amountPaise).toBe(5_000_00)
  })

  it('refuses a period that ends before it starts, and an amount of nothing', () => {
    expect(() => amortiseOverMonths({ amountPaise: 100, from: '2026-05-01', to: '2026-04-01', basis: 'month' })).toThrow('ends before')
    expect(() => amortiseOverMonths({ amountPaise: 0, from: '2026-04-01', to: '2026-05-01', basis: 'month' })).toThrow('nothing to spread')
  })

  it('says what has expired and what is still an asset on a date', () => {
    const rows = amortiseOverMonths({ amountPaise: 12_000_00, from: '2026-04-01', to: '2027-03-31', basis: 'month' })
    expect(expiredBy(rows, '2026-06-30')).toBe(3_000_00)
    expect(unexpiredOn(rows, 12_000_00, '2026-06-30')).toBe(9_000_00)
    // A date part-way through a month has not expired that month yet.
    expect(expiredBy(rows, '2026-06-15')).toBe(2_000_00)
  })
})
