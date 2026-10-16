import { describe, expect, it } from 'vitest'
import { quietWaitMs } from './quietWait'

const base = { scheduledAt: 0, quietMs: 2_000, latestMs: 60_000 }

describe('quietWaitMs (the deferred backup check waits for a quiet moment)', () => {
  it('runs once no IPC call has run for the quiet time', () => {
    expect(quietWaitMs({ ...base, now: 5_000, inFlight: 0, lastActivityAt: 3_000 })).toBe(0)
  })
  it('waits out the rest of the quiet time after the last call', () => {
    expect(quietWaitMs({ ...base, now: 5_000, inFlight: 0, lastActivityAt: 4_500 })).toBe(1_500)
  })
  it('never runs while a call is in flight (polls again)', () => {
    expect(quietWaitMs({ ...base, now: 9_000, inFlight: 1, lastActivityAt: 1_000 })).toBe(100)
  })
  it('runs at the latest bound however busy the app is', () => {
    expect(quietWaitMs({ ...base, now: 60_000, inFlight: 2, lastActivityAt: 59_999 })).toBe(0)
  })
})
