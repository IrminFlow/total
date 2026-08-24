// deadlineCountdown — the Gateway compliance tile's phrasing.
import { describe, expect, it } from 'vitest'
import type { Deadline } from '@shared/compliance'
import { deadlineCountdown } from '../lib/deadlineCountdown'

const d = (date: string): Deadline =>
  ({ kind: 'gst', form: 'GSTR-3B', title: 'Monthly summary return', date }) as Deadline

describe('deadlineCountdown', () => {
  it('due today', () => {
    expect(deadlineCountdown(d('2026-08-16'), '2026-08-16')).toBe('GSTR-3B due today')
  })

  it('overdue still reads as due today (never negative days)', () => {
    expect(deadlineCountdown(d('2026-08-10'), '2026-08-16')).toBe('GSTR-3B due today')
  })

  it('tomorrow', () => {
    expect(deadlineCountdown(d('2026-08-17'), '2026-08-16')).toBe('GSTR-3B tomorrow')
  })

  it('in N days', () => {
    expect(deadlineCountdown(d('2026-08-21'), '2026-08-16')).toBe('GSTR-3B in 5 days')
  })

  it('counts calendar days across a month boundary', () => {
    expect(deadlineCountdown(d('2026-09-02'), '2026-08-30')).toBe('GSTR-3B in 3 days')
  })
})
