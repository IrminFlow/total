import { describe, it, expect } from 'vitest'
import { lockoutMsFor, lockoutMessage, lockoutLabel, MAX_LOCKOUT_MS, FREE_ATTEMPTS } from './lockout'

describe('PIN lockout backoff', () => {
  it('costs a typo nothing', () => {
    for (let fails = 0; fails <= FREE_ATTEMPTS; fails++) expect(lockoutMsFor(fails)).toBe(0)
  })

  it('doubles from thirty seconds', () => {
    expect(lockoutMsFor(5)).toBe(30_000)
    expect(lockoutMsFor(6)).toBe(60_000)
    expect(lockoutMsFor(7)).toBe(120_000)
    expect(lockoutMsFor(8)).toBe(240_000)
  })

  it('never exceeds the cap, however many failures', () => {
    expect(lockoutMsFor(20)).toBe(MAX_LOCKOUT_MS)
    expect(lockoutMsFor(100_000)).toBe(MAX_LOCKOUT_MS)
  })

  it('turns exhausting a four-digit PIN from an afternoon into more than a year', () => {
    // 10,000 candidates. Sum the waits the attacker pays, and compare with the flat 30s-per-five
    // rule this replaced (under 17 hours for the whole keyspace).
    let total = 0
    for (let attempt = 1; attempt <= 10_000; attempt++) total += lockoutMsFor(attempt)
    const flatRule = (10_000 / 5) * 30_000
    expect(flatRule).toBeLessThan(17 * 60 * 60 * 1000)
    expect(total).toBeGreaterThan(365 * 24 * 60 * 60 * 1000)
  })

  it('states the wait in units a person can keep track of', () => {
    expect(lockoutLabel(0)).toBe('now')
    expect(lockoutLabel(30_000)).toBe('30 seconds')
    expect(lockoutLabel(60_000)).toBe('1 minute')
    expect(lockoutLabel(90_000)).toBe('2 minutes')
    expect(lockoutMessage(30_000)).toBe('Too many attempts — wait 30 seconds')
  })
})
