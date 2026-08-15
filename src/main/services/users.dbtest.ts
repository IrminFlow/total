import { describe, it, expect } from 'vitest'
import { freshDb } from '../db/testdb'
import { usersExist, listUsers, listLoginNames, saveUser, deactivateUser, login } from './users'

describe('users service', () => {
  it('usersExist flips from false to true on the first saveUser', () => {
    const db = freshDb()
    expect(usersExist(db)).toBe(false)
    saveUser(db, { name: 'Priya', role: 'accountant', pin: '1234' })
    expect(usersExist(db)).toBe(true)
  })

  it('the first user is always forced to owner, regardless of the requested role', () => {
    const db = freshDb()
    const first = saveUser(db, { name: 'Priya', role: 'viewer', pin: '1111' })
    expect(first.role).toBe('owner')

    // A second user keeps whatever role was requested — only the bootstrap user is forced.
    const second = saveUser(db, { name: 'Rahul', role: 'viewer', pin: '2222' })
    expect(second.role).toBe('viewer')

    const names = listUsers(db).map((u) => u.name).sort()
    expect(names).toEqual(['Priya', 'Rahul'])
  })

  // ipc.ts's users:save handler auto-authenticates the caller as this bootstrap owner (a
  // sessionUser assignment that lives in ipc.ts's Electron-side module state, so it isn't
  // reachable from this DB-only test). What *is* testable here — and what that auto-login
  // depends on — is that the bootstrap saveUser() return carries everything needed to build a
  // session (`{ id, name, role }`) straight off the returned row, with no extra lookup.
  it("the bootstrap saveUser() return has everything ipc.ts needs to build a session", () => {
    const db = freshDb()
    const first = saveUser(db, { name: 'Priya', role: 'viewer', pin: '1111' })
    expect(first).toMatchObject({ id: expect.any(Number), name: 'Priya', role: 'owner' })
    // And login() with the same PIN authenticates as that exact user — proof the id round-trips.
    expect(login(db, first.id, '1111')).toEqual({ id: first.id, name: 'Priya', role: 'owner' })
  })

  it('creating a user without a PIN is rejected', () => {
    const db = freshDb()
    expect(() => saveUser(db, { name: 'NoPin', role: 'accountant' })).toThrow('PIN is required')
  })

  it('updating a user without a PIN keeps the existing hash (login still works with the old PIN)', () => {
    const db = freshDb()
    const user = saveUser(db, { name: 'Priya', role: 'owner', pin: '1234' })
    saveUser(db, { name: 'Priya S', role: 'owner' }, user.id)
    const result = login(db, user.id, '1234')
    expect(result.name).toBe('Priya S')
  })

  it('refuses to deactivate the last active owner', () => {
    const db = freshDb()
    const owner = saveUser(db, { name: 'Priya', role: 'owner', pin: '1234' })
    expect(() => deactivateUser(db, owner.id)).toThrow('Cannot deactivate the last active owner')

    // Adding a second owner makes the first one deactivatable.
    const owner2 = saveUser(db, { name: 'Rahul', role: 'owner', pin: '5678' })
    expect(() => deactivateUser(db, owner.id)).not.toThrow()
    expect(listUsers(db).find((u) => u.id === owner.id)?.active).toBe(false)

    // Now owner2 is the last active owner.
    expect(() => deactivateUser(db, owner2.id)).toThrow('Cannot deactivate the last active owner')
  })

  it('deactivated users are dropped from the login picker but stay in the full list', () => {
    const db = freshDb()
    const owner = saveUser(db, { name: 'Priya', role: 'owner', pin: '1234' })
    saveUser(db, { name: 'Rahul', role: 'accountant', pin: '5678' })
    const target = listUsers(db).find((u) => u.name === 'Rahul')!
    deactivateUser(db, target.id)

    expect(listLoginNames(db).map((u) => u.name)).toEqual(['Priya'])
    expect(listUsers(db).map((u) => u.name).sort()).toEqual(['Priya', 'Rahul'])
    void owner
  })

  it('login round-trips a correct PIN, rejects a wrong one, and throttles after 5 consecutive fails', () => {
    const db = freshDb()
    const user = saveUser(db, { name: 'Priya', role: 'owner', pin: '4242' })

    const result = login(db, user.id, '4242')
    expect(result).toEqual({ id: user.id, name: 'Priya', role: 'owner' })

    for (let i = 0; i < 4; i++) {
      expect(() => login(db, user.id, '0000')).toThrow('Wrong PIN')
    }
    // 5th consecutive failure — still a plain 'Wrong PIN'.
    expect(() => login(db, user.id, '0000')).toThrow('Wrong PIN')

    // 6th attempt is throttled — even with the *correct* PIN, since verifyPin is never reached.
    expect(() => login(db, user.id, '4242')).toThrow('Too many attempts — wait 30 seconds')
  })

  it('login throws Wrong PIN for an unknown user id', () => {
    const db = freshDb()
    expect(() => login(db, 999, '1234')).toThrow('Wrong PIN')
  })
})
