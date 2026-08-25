import { describe, expect, it } from 'vitest'
import {
  bucketByDueDate, monthGrid, monthLabel, monthOf, monthStart, monthTotal, pdcDueDate, shiftMonth
} from './pdcCalendar'

describe('month keys', () => {
  it('rejects anything that is not YYYY-MM', () => {
    expect(() => monthStart('2026-8')).toThrow()
    expect(monthStart('2026-08')).toBe('2026-08-01')
  })

  it('wraps the year in both directions', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12')
    expect(shiftMonth('2026-12', 1)).toBe('2027-01')
    expect(shiftMonth('2026-08', 0)).toBe('2026-08')
  })

  it('reads the month off a date', () => {
    expect(monthOf('2026-08-25')).toBe('2026-08')
    expect(monthLabel('2026-08')).toBe('August 2026')
  })
})

describe('monthGrid', () => {
  it('always returns six weeks of seven days', () => {
    for (const key of ['2026-02', '2026-08', '2024-02']) {
      const grid = monthGrid(key)
      expect(grid).toHaveLength(6)
      for (const week of grid) expect(week).toHaveLength(7)
    }
  })

  it('starts each week on a Sunday', () => {
    for (const week of monthGrid('2026-08')) {
      expect(new Date(`${week[0]!.date}T00:00:00Z`).getUTCDay()).toBe(0)
    }
  })

  it('marks the borrowed neighbouring days as out of month', () => {
    // 1 Aug 2026 is a Saturday, so the first row is 26–31 July then 1 August.
    const first = monthGrid('2026-08')[0]!
    expect(first[0]!.date).toBe('2026-07-26')
    expect(first[0]!.inMonth).toBe(false)
    expect(first[6]!.date).toBe('2026-08-01')
    expect(first[6]!.inMonth).toBe(true)
  })

  it('covers every day of a leap February', () => {
    const days = monthGrid('2024-02').flat().filter((c) => c.inMonth).map((c) => c.date)
    expect(days).toHaveLength(29)
    expect(days.at(-1)).toBe('2024-02-29')
  })
})

describe('pdcDueDate', () => {
  it('prefers the instrument date, which is the day the cheque can be banked', () => {
    expect(pdcDueDate({ date: '2026-06-01', instrumentDate: '2026-09-15' })).toBe('2026-09-15')
  })

  it('falls back to the voucher date when the cheque carries none', () => {
    expect(pdcDueDate({ date: '2026-06-01', instrumentDate: null })).toBe('2026-06-01')
    expect(pdcDueDate({ date: '2026-06-01' })).toBe('2026-06-01')
  })
})

describe('bucketByDueDate', () => {
  const rows = [
    { date: '2026-06-01', instrumentDate: '2026-09-15', amount: 50_000_00 },
    { date: '2026-06-02', instrumentDate: '2026-09-15', amount: 25_000_00 },
    { date: '2026-09-20', instrumentDate: null, amount: 10_000_00 },
    { date: '2026-05-05', instrumentDate: '2026-10-01', amount: 1_00 }
  ]

  it('groups on the due date and totals each day', () => {
    const map = bucketByDueDate(rows)
    expect(map.get('2026-09-15')!.rows).toHaveLength(2)
    expect(map.get('2026-09-15')!.total).toBe(75_000_00)
    expect(map.get('2026-09-20')!.total).toBe(10_000_00)
  })

  it('leaves days with nothing due absent rather than empty', () => {
    expect(bucketByDueDate(rows).has('2026-09-16')).toBe(false)
  })

  it('handles an empty register', () => {
    expect(bucketByDueDate([]).size).toBe(0)
    expect(monthTotal([], '2026-09')).toBe(0)
  })

  it('totals only what falls due inside the month asked for', () => {
    expect(monthTotal(rows, '2026-09')).toBe(85_000_00)
    expect(monthTotal(rows, '2026-10')).toBe(1_00)
    expect(monthTotal(rows, '2026-06')).toBe(0)
  })
})
