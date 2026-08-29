import { describe, expect, it } from 'vitest'
import { dueSchedules, nextRunAfter, scheduleFilename, schedulePeriod } from './reportSchedule'

describe('nextRunAfter', () => {
  it('daily is tomorrow', () => {
    expect(nextRunAfter('daily', '2026-04-01')).toBe('2026-04-02')
  })

  it('weekly is the same weekday next week', () => {
    expect(nextRunAfter('weekly', '2026-04-01')).toBe('2026-04-08')
  })

  it('monthly is the first of next month, not thirty days on', () => {
    expect(nextRunAfter('monthly', '2026-04-17')).toBe('2026-05-01')
    expect(nextRunAfter('monthly', '2026-12-31')).toBe('2027-01-01')
  })

  it('handles February in a leap year without drifting', () => {
    expect(nextRunAfter('monthly', '2028-02-29')).toBe('2028-03-01')
  })
})

describe('dueSchedules', () => {
  const s = (nextRun: string, active = true): { nextRun: string; active: boolean } => ({ nextRun, active })

  it('returns everything due on or before today, oldest first', () => {
    const due = dueSchedules([s('2026-04-10'), s('2026-04-01'), s('2026-05-01')], '2026-04-10')
    expect(due.map((d) => d.nextRun)).toEqual(['2026-04-01', '2026-04-10'])
  })

  it('skips paused schedules', () => {
    expect(dueSchedules([s('2026-01-01', false)], '2026-04-10')).toEqual([])
  })

  it('returns nothing when none are due', () => {
    expect(dueSchedules([s('2026-05-01')], '2026-04-10')).toEqual([])
  })
})

describe('schedulePeriod', () => {
  it('month to date ends on the run date', () => {
    expect(schedulePeriod('mtd', '2026-04-17')).toEqual({ from: '2026-04-01', to: '2026-04-17' })
  })

  it('last full month is the whole previous month', () => {
    expect(schedulePeriod('lastMonth', '2026-04-01')).toEqual({ from: '2026-03-01', to: '2026-03-31' })
    expect(schedulePeriod('lastMonth', '2026-01-15')).toEqual({ from: '2025-12-01', to: '2025-12-31' })
  })

  it('financial year to date starts on 1 April', () => {
    expect(schedulePeriod('fytd', '2026-05-02')).toEqual({ from: '2026-04-01', to: '2026-05-02' })
    // January is still the previous April's financial year.
    expect(schedulePeriod('fytd', '2026-01-02')).toEqual({ from: '2025-04-01', to: '2026-01-02' })
  })

  it('last financial year is the full April-to-March before this one', () => {
    expect(schedulePeriod('lastFy', '2026-05-02')).toEqual({ from: '2025-04-01', to: '2026-03-31' })
  })
})

describe('scheduleFilename', () => {
  it('dates the file, because a folder of files all called the same thing is not evidence', () => {
    expect(scheduleFilename('trialBalance', { from: '2026-04-01', to: '2026-04-30' })).toBe(
      'trial-balance-2026-04-01_2026-04-30'
    )
    expect(scheduleFilename('profitLoss', { from: '2026-04-01', to: '2026-04-30' })).toBe(
      'profit-loss-2026-04-01_2026-04-30'
    )
  })
})
