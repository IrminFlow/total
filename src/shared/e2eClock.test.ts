import { describe, expect, it } from 'vitest'
import { e2eClockOffset, e2eTodayFromEnv } from './e2eClock'

describe('e2e clock (scripted runs only)', () => {
  it('is honoured only with a scratch data dir, unpackaged, and a well-formed day', () => {
    expect(e2eTodayFromEnv({ TOTAL_E2E_TODAY: '2027-04-05', TOTAL_DATA_DIR: '/tmp/x' }, false)).toBe('2027-04-05')
    expect(e2eTodayFromEnv({ TOTAL_E2E_TODAY: '2027-04-05', TOTAL_DATA_DIR: '/tmp/x' }, true)).toBeNull()
    expect(e2eTodayFromEnv({ TOTAL_E2E_TODAY: '2027-04-05' }, false)).toBeNull()
    expect(e2eTodayFromEnv({ TOTAL_E2E_TODAY: '5 April', TOTAL_DATA_DIR: '/tmp/x' }, false)).toBeNull()
    expect(e2eTodayFromEnv({ TOTAL_DATA_DIR: '/tmp/x' }, false)).toBeNull()
  })

  it('moves the local date to the given day and keeps the time of day', () => {
    const now = new Date(2026, 9, 16, 23, 45, 12)
    const shifted = new Date(now.getTime() + e2eClockOffset('2027-04-05', now))
    expect([shifted.getFullYear(), shifted.getMonth() + 1, shifted.getDate()]).toEqual([2027, 4, 5])
    expect([shifted.getHours(), shifted.getMinutes(), shifted.getSeconds()]).toEqual([23, 45, 12])
  })
})
