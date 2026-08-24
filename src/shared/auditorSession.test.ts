import { describe, it, expect } from 'vitest'
import { auditorExpiry, auditorMinutesLeft, auditorSessionExpired, auditorTimeLeftLabel } from './auditorSession'

const start = Date.parse('2026-08-24T10:00:00.000Z')
const session = { startedAt: new Date(start).toISOString(), expiresAt: auditorExpiry(start, 2), grantedBy: 'Priya' }

describe('auditor session', () => {
  it('ends exactly the stated number of hours later', () => {
    expect(session.expiresAt).toBe('2026-08-24T12:00:00.000Z')
  })

  it('is live before its end and dead at it', () => {
    expect(auditorSessionExpired(session, start + 60_000)).toBe(false)
    // At the instant it expires, not a second after: an off-by-one here is an auditor session
    // that outlives its own clock.
    expect(auditorSessionExpired(session, Date.parse(session.expiresAt))).toBe(true)
    expect(auditorSessionExpired(session, start + 3 * 3600_000)).toBe(true)
  })

  it('counts down in whole minutes and never below zero', () => {
    expect(auditorMinutesLeft(session, start)).toBe(120)
    expect(auditorMinutesLeft(session, start + 119.9 * 60_000)).toBe(0)
    expect(auditorMinutesLeft(session, start + 10 * 3600_000)).toBe(0)
  })

  it('labels the time left the way a person would say it', () => {
    expect(auditorTimeLeftLabel(session, start)).toBe('2 h 0 m left')
    expect(auditorTimeLeftLabel(session, start + 100 * 60_000)).toBe('20 m left')
    expect(auditorTimeLeftLabel(session, start + 200 * 60_000)).toBe('ended')
  })
})
