// Its own file: installing the shifted clock replaces this worker's global Date for good.
import { describe, expect, it } from 'vitest'
import { e2eClockOffsetMs, fileTimeMs, installE2eClock } from './e2eClock'

describe('installE2eClock', () => {
  it('without a day nothing changes', () => {
    const RealDate = Date
    installE2eClock(null)
    installE2eClock('not a day')
    expect(Date).toBe(RealDate)
    expect(e2eClockOffsetMs()).toBeNull()
    expect(fileTimeMs(1234)).toBe(1234)
  })

  it('shifts now, leaves explicit dates, keeps instanceof and Date() working', () => {
    const RealDate = Date
    const native = new RealDate(2020, 0, 1)
    installE2eClock('2031-07-09')
    installE2eClock('2040-01-01') // idempotent: the first day stays
    const now = new Date()
    expect([now.getFullYear(), now.getMonth() + 1, now.getDate()]).toEqual([2031, 7, 9])
    expect(Math.abs(Date.now() - now.getTime())).toBeLessThan(5_000)
    expect(new Date('2026-10-16T00:00:00Z').toISOString()).toBe('2026-10-16T00:00:00.000Z')
    expect(new Date(0).getTime()).toBe(0)
    expect(Date.UTC(2026, 0, 1)).toBe(RealDate.UTC(2026, 0, 1))
    expect(Date.parse('2026-01-01T00:00:00Z')).toBe(RealDate.parse('2026-01-01T00:00:00Z'))
    expect(native instanceof Date).toBe(true)
    expect(now instanceof RealDate).toBe(true)
    expect(typeof (Date as unknown as () => string)()).toBe('string')
    expect((Date as unknown as () => string)()).toContain('2031')
    class Sub extends Date {}
    expect(new Sub() instanceof Sub).toBe(true)
    expect(new Sub().getFullYear()).toBe(2031)
    const offset = e2eClockOffsetMs()!
    expect(offset).toBeGreaterThan(0)
    expect(fileTimeMs(1000)).toBe(1000 + offset)
  })
})
