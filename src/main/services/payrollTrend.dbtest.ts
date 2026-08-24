import { describe, it, expect } from 'vitest'
import { commitRun, payrollTrend, saveEmployee } from './payroll'
import { seededDb } from '../db/testdb'

/**
 * Payroll over time.
 *
 * The figure that matters is employer cost — gross plus the employer's own PF and ESI — because
 * that is what actually left the business. Gross alone understates it by roughly a seventh, and
 * that gap is exactly what someone budgeting a hire needs to see.
 */
function hire(db: ReturnType<typeof seededDb>, name: string, basic: number): number {
  return saveEmployee(db, {
    name,
    code: null,
    designation: null,
    joined: '2026-01-01',
    pan: null,
    uan: null,
    esicNo: null,
    basic,
    hra: Math.round(basic * 0.4),
    special: 0,
    pfEnabled: true,
    esiEnabled: true,
    ptEnabled: true,
    ptState: 'MH',
    active: true
  }).id
}

const fullMonth = (ids: number[]): { employeeId: number; payableDays: number }[] =>
  ids.map((employeeId) => ({ employeeId, payableDays: 31 }))

describe('payrollTrend', () => {
  it('is empty until something has been run', () => {
    expect(payrollTrend(seededDb())).toEqual([])
  })

  it('reports one point per committed run, oldest first', () => {
    const db = seededDb()
    const a = hire(db, 'Asha', 3000000)
    commitRun(db, '2026-05', fullMonth([a]))
    commitRun(db, '2026-04', fullMonth([a]))
    commitRun(db, '2026-06', fullMonth([a]))

    expect(payrollTrend(db).map((p) => p.month)).toEqual(['2026-04', '2026-05', '2026-06'])
  })

  it('counts everyone the run actually paid', () => {
    // A run pays every ACTIVE employee; the days list only overrides payable days for some of
    // them. An inactive employee is not paid and must not be counted.
    const db = seededDb()
    const a = hire(db, 'Asha', 3000000)
    hire(db, 'Also Paid', 3000000)
    const gone = hire(db, 'Left Last Year', 3000000)
    saveEmployee(
      db,
      {
        name: 'Left Last Year', code: null, designation: null, joined: '2026-01-01',
        pan: null, uan: null, esicNo: null, basic: 3000000, hra: 1200000, special: 0,
        pfEnabled: true, esiEnabled: true, ptEnabled: true, ptState: 'MH', active: false
      },
      gone
    )
    commitRun(db, '2026-05', fullMonth([a]))

    expect(payrollTrend(db)[0]!.headcount).toBe(2)
  })

  it('reports employer cost as gross plus the employer’s own contributions', () => {
    // The whole point: gross is what the payslip says, employer cost is what the business paid.
    const db = seededDb()
    const a = hire(db, 'Asha', 3000000)
    commitRun(db, '2026-05', fullMonth([a]))

    const [point] = payrollTrend(db)
    expect(point!.employerCost).toBe(point!.gross + point!.employerContributions)
    expect(point!.employerContributions).toBeGreaterThan(0)
    expect(point!.employerCost).toBeGreaterThan(point!.gross)
  })

  it('nets to what the employee actually received', () => {
    const db = seededDb()
    const a = hire(db, 'Asha', 3000000)
    commitRun(db, '2026-05', fullMonth([a]))

    const [point] = payrollTrend(db)
    // Gross minus what was withheld from the employee is what they took home.
    expect(point!.net).toBe(point!.gross - point!.employeeDeductions)
  })

  it('divides cost by the people it covered', () => {
    const db = seededDb()
    const ids = [hire(db, 'A', 3000000), hire(db, 'B', 3000000)]
    commitRun(db, '2026-05', fullMonth(ids))

    const [point] = payrollTrend(db)
    expect(point!.headcount).toBe(2)
    expect(point!.costPerHead).toBe(Math.round(point!.employerCost / 2))
  })

  it('keeps only the most recent months when asked', () => {
    const db = seededDb()
    const a = hire(db, 'Asha', 3000000)
    for (const m of ['2026-01', '2026-02', '2026-03']) commitRun(db, m, fullMonth([a]))

    expect(payrollTrend(db, 2).map((p) => p.month)).toEqual(['2026-02', '2026-03'])
  })
})
