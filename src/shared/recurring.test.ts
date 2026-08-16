import { describe, it, expect } from 'vitest'
import { nextDueAfter, dueTemplates, type DueLike } from './recurring'

describe('nextDueAfter', () => {
  it('monthly: plain next month-anniversary', () => {
    expect(nextDueAfter('monthly', { dayOfMonth: 5 }, '2026-04-05')).toBe('2026-05-05')
  })

  it('monthly: clamps day 31 to 30 Apr', () => {
    expect(nextDueAfter('monthly', { dayOfMonth: 31 }, '2026-03-31')).toBe('2026-04-30')
  })

  it('monthly: clamps day 31 to 28 Feb in a non-leap year', () => {
    expect(nextDueAfter('monthly', { dayOfMonth: 31 }, '2026-01-31')).toBe('2026-02-28')
  })

  it('monthly: clamps day 31 to 29 Feb in a leap year', () => {
    expect(nextDueAfter('monthly', { dayOfMonth: 31 }, '2028-01-31')).toBe('2028-02-29')
  })

  it('monthly: rolls over the year boundary', () => {
    expect(nextDueAfter('monthly', { dayOfMonth: 15 }, '2026-12-15')).toBe('2027-01-15')
  })

  it('monthly: throws without a dayOfMonth', () => {
    expect(() => nextDueAfter('monthly', {}, '2026-01-01')).toThrow()
  })

  it('weekly: steps exactly 7 days when `after` already falls on the target weekday', () => {
    // 2026-08-17 is a Monday (weekday 1).
    expect(nextDueAfter('weekly', { weekday: 1 }, '2026-08-17')).toBe('2026-08-24')
  })

  it('weekly: finds the nearest matching weekday when `after` is off-cycle', () => {
    // 2026-08-17 (Mon) -> next Friday (weekday 5) is 2026-08-21.
    expect(nextDueAfter('weekly', { weekday: 5 }, '2026-08-17')).toBe('2026-08-21')
  })

  it('weekly: throws without a weekday', () => {
    expect(() => nextDueAfter('weekly', {}, '2026-01-01')).toThrow()
  })
})

describe('dueTemplates', () => {
  const t = (nextDue: string, active = true): DueLike => ({ nextDue, active })

  it('lists every overdue-or-due template, sorted by next_due ascending', () => {
    const templates = [t('2026-08-20'), t('2026-08-10'), t('2026-08-15')]
    expect(dueTemplates(templates, '2026-08-20').map((x) => x.nextDue)).toEqual([
      '2026-08-10',
      '2026-08-15',
      '2026-08-20'
    ])
  })

  it('excludes templates not yet due', () => {
    const templates = [t('2026-08-10'), t('2026-09-01')]
    expect(dueTemplates(templates, '2026-08-20').map((x) => x.nextDue)).toEqual(['2026-08-10'])
  })

  it('excludes inactive templates even if overdue', () => {
    const templates = [t('2026-08-01', false), t('2026-08-10', true)]
    expect(dueTemplates(templates, '2026-08-20').map((x) => x.nextDue)).toEqual(['2026-08-10'])
  })
})
