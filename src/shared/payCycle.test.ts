import { describe, it, expect } from 'vitest'
import {
  PAY_CYCLES,
  cycleContaining,
  cycleShare,
  cycleStatutory,
  cyclesInMonth,
  daysInMonthOf,
  payableDaysInCycle,
  proratedPayableDays,
  type PayCycle
} from './payCycle'

/** Months of every length the Gregorian calendar has, so nothing here depends on 30 or 31. */
const MONTHS = { feb28: '2026-02', feb29: '2028-02', apr30: '2026-04', jan31: '2026-01' }

/** Pay-week boundaries a real company might have: a Monday, a Saturday, a Thursday, one set
 *  years before the month being paid, and one set inside the month itself. */
const ANCHORS = ['2024-01-01', '2025-12-27', '2026-01-01', '2026-02-05', '2019-04-04']

/**
 * Walk a month's cycles the way the service does — each one deducting the difference between its
 * cumulative share and everything the month's earlier cycles already took.
 */
function runMonth(
  cycle: PayCycle,
  month: string,
  anchor: string,
  monthlyTotalAt: (index: number) => number
): { deductions: number[]; total: number } {
  const periods = cyclesInMonth(cycle, month, anchor)
  const deductions: number[] = []
  let already = 0
  periods.forEach((p, i) => {
    const share = cycleShare(periods, p.key)!
    const d = cycleStatutory(monthlyTotalAt(i), share, already)
    deductions.push(d)
    already += d
  })
  return { deductions, total: already }
}

describe('the month a cycle belongs to', () => {
  it('gives a monthly cycle exactly one period, the whole calendar month', () => {
    for (const month of Object.values(MONTHS)) {
      const [p, ...rest] = cyclesInMonth('monthly', month, '2024-01-01')
      expect(rest).toEqual([])
      expect(p!.from).toBe(`${month}-01`)
      expect(p!.days).toBe(daysInMonthOf(month))
      expect(p!.key).toBe(month)
      expect(p!.statutoryMonth).toBe(month)
    }
  })

  it('puts a weekly period that straddles a month end in the month its LAST day falls in', () => {
    // 29 Jan – 4 Feb is paid on 4 February, and February's ECR is where it has to appear.
    const straddling = cycleContaining('weekly', '2026-01-30', '2026-01-01')
    expect([straddling.from, straddling.to]).toEqual(['2026-01-29', '2026-02-04'])
    expect(straddling.statutoryMonth).toBe('2026-02')

    // …so January's list stops before it, and February's list opens with it.
    const jan = cyclesInMonth('weekly', '2026-01', '2026-01-01')
    const feb = cyclesInMonth('weekly', '2026-02', '2026-01-01')
    expect(jan.map((p) => p.to)).toEqual(['2026-01-07', '2026-01-14', '2026-01-21', '2026-01-28'])
    expect(feb[0]).toMatchObject({ from: '2026-01-29', to: '2026-02-04' })
  })

  it('gives a month five weekly cycles when the boundary falls that way', () => {
    // Anchored on 26 Dec 2025, January 2026 closes five pay weeks: 1, 8, 15, 22 and 29 January.
    const jan = cyclesInMonth('weekly', '2026-01', '2025-12-26')
    expect(jan).toHaveLength(5)
    expect(jan.map((p) => p.to)).toEqual([
      '2026-01-01', '2026-01-08', '2026-01-15', '2026-01-22', '2026-01-29'
    ])
    // Five weeks is 35 days of weight in a 31-day month, which is exactly why the apportionment
    // cannot be a fixed fraction of the month.
    expect(cycleShare(jan, jan[4]!.key)!.totalDays).toBe(35)
    expect(cycleShare(jan, jan[4]!.key)!.isLast).toBe(true)
  })

  it('never leaves a gap or an overlap between one month’s cycles and the next’s', () => {
    for (const cycle of ['fortnightly', 'weekly'] as const) {
      for (const anchor of ANCHORS) {
        const months = ['2025-12', '2026-01', '2026-02', '2026-03']
        const all = months.flatMap((m) => cyclesInMonth(cycle, m, anchor))
        for (let i = 1; i < all.length; i++) {
          expect(daysInMonthOf(all[i]!.from.slice(0, 7))).toBeGreaterThan(0)
          // each period starts the day after the previous one ended
          expect(all[i]!.from).toBe(cycleContaining(cycle, all[i]!.to, anchor).from)
          expect(new Date(all[i]!.from).getTime() - new Date(all[i - 1]!.to).getTime()).toBe(86_400_000)
        }
      }
    }
  })

  it('finds the period containing a date, and that period knows its own share', () => {
    const p = cycleContaining('fortnightly', '2026-06-20', '2026-01-01')
    expect(p.days).toBe(14)
    expect(p.from <= '2026-06-20' && '2026-06-20' <= p.to).toBe(true)
    const periods = cyclesInMonth('fortnightly', p.statutoryMonth, '2026-01-01')
    expect(cycleShare(periods, p.key)).not.toBeNull()
  })

  it('returns null for a period that is not one of the month’s cycles', () => {
    const periods = cyclesInMonth('weekly', '2026-01', '2026-01-01')
    expect(cycleShare(periods, '2026-05-04')).toBeNull()
  })
})

describe('a month’s deductions add up to the month’s figure', () => {
  const PF = 1_800_00
  const ODD = 1_357_11 // a figure no fraction of a month divides evenly

  it('sums to EXACTLY the monthly total for every cycle, month length and anchor', () => {
    for (const cycle of PAY_CYCLES) {
      for (const month of Object.values(MONTHS)) {
        for (const anchor of ANCHORS) {
          for (const monthly of [PF, ODD, 1, 208_33, 0]) {
            const { deductions, total } = runMonth(cycle, month, anchor, () => monthly)
            expect(total, `${cycle} ${month} anchor ${anchor} total ${monthly}`).toBe(monthly)
            expect(deductions.reduce((s, d) => s + d, 0)).toBe(monthly)
            expect(deductions.every((d) => Number.isInteger(d))).toBe(true)
          }
        }
      }
    }
  })

  it('spreads the month roughly evenly rather than dumping it on one cycle', () => {
    const { deductions } = runMonth('weekly', '2026-01', '2026-01-01', () => 1_800_00)
    expect(deductions).toHaveLength(4)
    expect(deductions).toEqual([450_00, 450_00, 450_00, 450_00])
  })

  it('lands the whole rounding remainder on the month’s last cycle, not in mid-air', () => {
    // Five weeks: a third of a rupee per week cannot be paid, so week five carries the crumbs.
    const { deductions, total } = runMonth('weekly', '2026-01', '2025-12-26', () => 100_01)
    expect(total).toBe(100_01)
    expect(deductions).toEqual([20_00, 20_00, 20_01, 20_00, 20_00])
  })
})

describe('the running true-up', () => {
  it('absorbs a mid-month rise in the monthly figure in the cycles that are left', () => {
    // Week 1 is paid believing the month owes ₹1,000. A late attendance entry lifts it to ₹1,800.
    const { deductions, total } = runMonth('weekly', '2026-01', '2026-01-01', (i) => (i === 0 ? 1_000_00 : 1_800_00))
    expect(deductions[0]).toBe(250_00) // a quarter of what was believed at the time
    expect(total).toBe(1_800_00) // …and the month still lands on the truth
    expect(deductions.slice(1).reduce((s, d) => s + d, 0)).toBe(1_550_00)
  })

  it('absorbs a mid-month fall the same way, without touching what was already paid', () => {
    const { deductions, total } = runMonth('weekly', '2026-01', '2026-01-01', (i) => (i < 2 ? 1_800_00 : 900_00))
    expect(deductions[0]).toBe(450_00)
    expect(deductions[1]).toBe(450_00)
    expect(total).toBe(900_00)
  })

  it('returns a NEGATIVE true-up — a refund — rather than clamping it to zero', () => {
    const periods = cyclesInMonth('weekly', '2026-01', '2026-01-01')
    // Three weeks were paid on a ₹1,800 month; the employee then went on unpaid leave and the
    // month's real PF is ₹200. Week four must hand ₹1,150 back, not deduct nothing.
    const share = cycleShare(periods, periods[3]!.key)!
    expect(cycleStatutory(200_00, share, 1_350_00)).toBe(-1_150_00)

    // The same holds mid-month, where the target is a rounded fraction rather than the whole.
    const third = cycleShare(periods, periods[2]!.key)!
    expect(cycleStatutory(200_00, third, 900_00)).toBeLessThan(0)
  })

  it('cannot create or lose a paisa however the monthly figure wanders', () => {
    const wander = [3_333_33, 1_00, 9_999_99, 4_444_44, 2_222_22]
    for (const anchor of ANCHORS) {
      const { total } = runMonth('weekly', '2026-01', anchor, (i) => wander[i % wander.length]!)
      expect(total).toBe(wander[cyclesInMonth('weekly', '2026-01', anchor).length - 1]!)
    }
  })

  it('deducts nothing when a month somehow has no cycles at all', () => {
    expect(cycleStatutory(1_800_00, { cumulativeDays: 0, totalDays: 0, isLast: false, index: 0, count: 0 }, 0)).toBe(0)
  })
})

describe('payable days inside a cycle', () => {
  const week = cycleContaining('weekly', '2026-01-07', '2026-01-01') // 01–07 Jan

  it('pays a full cycle when the employee was there for all of it', () => {
    expect(payableDaysInCycle(week, null, null)).toBe(7)
    expect(payableDaysInCycle(week, '2020-06-01', null)).toBe(7)
  })

  it('pays a mid-cycle joiner from the day they joined', () => {
    expect(payableDaysInCycle(week, '2026-01-05', null)).toBe(3) // 5, 6, 7
    expect(payableDaysInCycle(week, '2026-01-07', null)).toBe(1)
  })

  it('pays a mid-cycle leaver to their last day', () => {
    expect(payableDaysInCycle(week, null, '2026-01-03')).toBe(3)
    expect(payableDaysInCycle(week, '2026-01-02', '2026-01-03')).toBe(2)
  })

  it('pays ZERO for a cycle entirely before someone joined, never a negative', () => {
    expect(payableDaysInCycle(week, '2026-02-01', null)).toBe(0)
    expect(payableDaysInCycle(week, '2026-01-08', null)).toBe(0)
  })

  it('pays ZERO for a cycle entirely after someone left', () => {
    expect(payableDaysInCycle(week, null, '2025-12-31')).toBe(0)
  })

  it('is 0 when the leaving day precedes the joining day', () => {
    expect(payableDaysInCycle(week, '2026-01-06', '2026-01-02')).toBe(0)
  })
})

describe('prorating the month’s attendance into a cycle', () => {
  it('gives a monthly cycle the whole month', () => {
    const periods = cyclesInMonth('monthly', '2026-01', '2024-01-01')
    const share = cycleShare(periods, '2026-01')!
    expect(proratedPayableDays(26, share, periods[0]!.days)).toBe(26)
  })

  it('rounds to the half day the attendance register itself records', () => {
    const periods = cyclesInMonth('weekly', '2026-01', '2026-01-01')
    const share = cycleShare(periods, periods[0]!.key)!
    expect(share.totalDays).toBe(28)
    expect(proratedPayableDays(26, share, 7)).toBe(6.5)
    expect(proratedPayableDays(0, share, 7)).toBe(0)
  })

  it('is 0 rather than NaN when the month has no cycles', () => {
    expect(proratedPayableDays(31, { cumulativeDays: 0, totalDays: 0, isLast: true, index: 0, count: 0 }, 7)).toBe(0)
  })

  it('sums to the month exactly when the cumulative target is what is prorated', () => {
    // How the service splits days: each cycle takes the difference between its cumulative target
    // and the previous one, so 31 days over four weeks is 8 + 7.5 + 8 + 7.5, never 4 × 7.75 = 32.
    for (const month of Object.values(MONTHS)) {
      for (const anchor of ANCHORS) {
        const periods = cyclesInMonth('weekly', month, anchor)
        const monthPayable = daysInMonthOf(month)
        let previous = 0
        let assigned = 0
        for (const p of periods) {
          const share = cycleShare(periods, p.key)!
          const target = share.isLast
            ? monthPayable
            : proratedPayableDays(monthPayable, share, share.cumulativeDays)
          assigned += target - previous
          previous = target
        }
        expect(assigned, `${month} anchor ${anchor}`).toBe(monthPayable)
      }
    }
  })
})
