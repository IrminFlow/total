/**
 * Scheduled reports: when the next run falls, and what period that run covers.
 *
 * The app is offline and has no daemon, so "scheduled" means "written the next time the company
 * is opened on or after the due date". That is stated in the UI rather than implied: a schedule
 * that silently does nothing while the laptop is shut is worse than one that says it catches up.
 *
 * A missed run is not replayed for every date it missed. If a daily schedule has not run for
 * three weeks, the user wants today's report, not twenty-one stale ones — so the next run rolls
 * forward from today, not from the date it was last due.
 */

import { addDays, fyOf } from './dates'

export const SCHEDULE_FREQUENCIES = ['daily', 'weekly', 'monthly'] as const
export type ScheduleFrequency = (typeof SCHEDULE_FREQUENCIES)[number]

export const SCHEDULE_PERIODS = ['mtd', 'lastMonth', 'fytd', 'lastFy'] as const
/** Which range the written report covers, resolved against the run date. */
export type SchedulePeriodKind = (typeof SCHEDULE_PERIODS)[number]

export const SCHEDULE_FORMATS = ['csv', 'xls', 'pdf'] as const
export type ScheduleFormat = (typeof SCHEDULE_FORMATS)[number]

export const SCHEDULE_REPORTS = ['trialBalance', 'profitLoss', 'balanceSheet', 'dayBook', 'outstandings'] as const
export type ScheduleReport = (typeof SCHEDULE_REPORTS)[number]

export const SCHEDULE_REPORT_LABELS: Record<ScheduleReport, string> = {
  trialBalance: 'Trial balance',
  profitLoss: 'Profit & Loss',
  balanceSheet: 'Balance sheet',
  dayBook: 'Day book',
  outstandings: 'Outstandings'
}

export const SCHEDULE_PERIOD_LABELS: Record<SchedulePeriodKind, string> = {
  mtd: 'This month to date',
  lastMonth: 'Last full month',
  fytd: 'This financial year to date',
  lastFy: 'Last financial year'
}

const monthStart = (iso: string): string => `${iso.slice(0, 7)}-01`

/** Last day of the month `iso` falls in, by stepping back one day from the next month's first. */
function monthEnd(iso: string): string {
  const y = Number(iso.slice(0, 4))
  const m = Number(iso.slice(5, 7))
  const nextY = m === 12 ? y + 1 : y
  const nextM = m === 12 ? 1 : m + 1
  return addDays(`${nextY}-${String(nextM).padStart(2, '0')}-01`, -1)
}

/** The next date on or after `after` (exclusive) that this frequency should fire. */
export function nextRunAfter(freq: ScheduleFrequency, after: string): string {
  if (freq === 'daily') return addDays(after, 1)
  if (freq === 'weekly') return addDays(after, 7)
  // Monthly means "the first of next month", not "30 days later": a monthly report that drifts
  // through the calendar stops lining up with the month it is supposed to summarise.
  return addDays(monthEnd(after), 1)
}

/** Everything due on or before today, in due order. */
export function dueSchedules<T extends { nextRun: string; active: boolean }>(schedules: T[], today: string): T[] {
  return schedules.filter((s) => s.active && s.nextRun <= today).sort((a, b) => a.nextRun.localeCompare(b.nextRun))
}

/** The date range a run covers, resolved against the day it actually runs. */
export function schedulePeriod(kind: SchedulePeriodKind, runDate: string): { from: string; to: string } {
  switch (kind) {
    case 'mtd':
      return { from: monthStart(runDate), to: runDate }
    case 'lastMonth': {
      const endOfLast = addDays(monthStart(runDate), -1)
      return { from: monthStart(endOfLast), to: endOfLast }
    }
    case 'fytd':
      return { from: fyOf(runDate).from, to: runDate }
    case 'lastFy': {
      const fy = fyOf(runDate)
      const prevEnd = addDays(fy.from, -1)
      return { from: fyOf(prevEnd).from, to: prevEnd }
    }
  }
}

/** `trial-balance-2026-04-01_2026-04-30` — dated in the name because a folder of reports all
 *  called "trial-balance" is a folder nobody can use as evidence. */
export function scheduleFilename(report: ScheduleReport, period: { from: string; to: string }): string {
  const slug = SCHEDULE_REPORT_LABELS[report]
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${slug}-${period.from}_${period.to}`
}
