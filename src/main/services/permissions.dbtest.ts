import { describe, it, expect } from 'vitest'
import { freshDb } from '../db/testdb'
import { saveUser, listUsers, login, recordAuthFailure, authThrottleRemainingMs, clearAuthFailures } from './users'
import { permitsChannel } from '@shared/permissions'

describe('permissions finer than three roles', () => {
  it('remembers what a user may not reach, and carries it into the session', () => {
    const db = freshDb()
    saveUser(db, { name: 'Owner', role: 'owner', pin: '1111' })
    const clerk = saveUser(db, { name: 'Clerk', role: 'accountant', pin: '2222', denied: ['payroll', 'exports'] })

    expect(clerk.denied).toEqual(['exports', 'payroll'])
    const session = login(db, clerk.id, '2222')
    expect(session.denied).toEqual(['exports', 'payroll'])

    // What the session then means, at the boundary that enforces it.
    expect(permitsChannel(session.denied, 'payroll:run')).toBe(false)
    expect(permitsChannel(session.denied, 'export:csv')).toBe(false)
    expect(permitsChannel(session.denied, 'voucher:save')).toBe(true)
  })

  it('never denies the first owner anything', () => {
    // They are the only account; an owner locked out of settings could never grant themselves back.
    const db = freshDb()
    const first = saveUser(db, { name: 'Owner', role: 'owner', pin: '1111', denied: ['settings'] })
    expect(first.denied).toEqual([])
  })

  it('drops nonsense that reaches the column from outside', () => {
    const db = freshDb()
    saveUser(db, { name: 'Owner', role: 'owner', pin: '1111' })
    const user = saveUser(db, { name: 'Clerk', role: 'accountant', pin: '2222' })
    db.prepare("UPDATE users SET denied_json = '[\"payroll\",\"whatever\",42]' WHERE id = ?").run(user.id)
    expect(listUsers(db).find((u) => u.id === user.id)!.denied).toEqual(['payroll'])

    db.prepare("UPDATE users SET denied_json = 'not json' WHERE id = ?").run(user.id)
    expect(listUsers(db).find((u) => u.id === user.id)!.denied).toEqual([])
  })

  it('keeps denials when the PIN is changed and when it is not', () => {
    const db = freshDb()
    saveUser(db, { name: 'Owner', role: 'owner', pin: '1111' })
    const clerk = saveUser(db, { name: 'Clerk', role: 'accountant', pin: '2222', denied: ['payroll'] })
    const renamed = saveUser(db, { name: 'Clerk 2', role: 'accountant', denied: ['payroll'] }, clerk.id)
    expect(renamed.denied).toEqual(['payroll'])
    const repinned = saveUser(db, { name: 'Clerk 2', role: 'accountant', pin: '3333', denied: ['payroll'] }, clerk.id)
    expect(repinned.denied).toEqual(['payroll'])
  })
})

describe('PIN throttling, persisted', () => {
  it('lengthens the wait with each failure and forgets it all on a success', () => {
    const db = freshDb()
    const user = saveUser(db, { name: 'Owner', role: 'owner', pin: '1111' })
    const now = Date.parse('2026-04-01T10:00:00Z')

    for (let i = 0; i < 4; i++) recordAuthFailure(db, user.id, now)
    expect(authThrottleRemainingMs(db, user.id, now)).toBe(0)

    recordAuthFailure(db, user.id, now)
    expect(authThrottleRemainingMs(db, user.id, now)).toBe(30_000)

    // Waiting it out and failing again costs twice as long, which is what makes a script hopeless.
    const later = now + 31_000
    recordAuthFailure(db, user.id, later)
    expect(authThrottleRemainingMs(db, user.id, later)).toBe(60_000)

    clearAuthFailures(db, user.id)
    expect(authThrottleRemainingMs(db, user.id, later)).toBe(0)
  })

  it('survives the app being restarted, since it lives in the database', () => {
    const db = freshDb()
    const user = saveUser(db, { name: 'Owner', role: 'owner', pin: '1111' })
    const now = Date.now()
    for (let i = 0; i < 6; i++) recordAuthFailure(db, user.id, now)
    // A fresh process reading the same rows sees the same lockout.
    expect(authThrottleRemainingMs(db, user.id, now)).toBeGreaterThan(30_000)
    expect(() => login(db, user.id, '1111')).toThrow(/Too many attempts/)
  })
})
