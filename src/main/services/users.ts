import type { DB } from '../db/connection'
import { hashPin, verifyPin } from './authcrypt'
import type { Role } from './roles'

export type { Role }

export interface User {
  id: number
  name: string
  role: Role
  active: boolean
  createdAt: string
}

export interface UserInput {
  name: string
  role: Role
  /** Required when creating a user; omit on update to keep the existing PIN hash. */
  pin?: string
  active?: boolean
}

export interface LoginResult {
  id: number
  name: string
  role: Role
}

interface UserRow {
  id: number
  name: string
  role: Role
  active: number
  createdAt: string
}

/** True once at least one user row exists for this company — the signal that the app is
 *  PIN-locked and IPC calls need a signed-in session. Callers should cache this (see ipc.ts's
 *  `current.usersExist`) rather than calling it on every request. */
export function usersExist(db: DB): boolean {
  const row = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }
  return row.n > 0
}

function toUser(row: UserRow): User {
  return { id: row.id, name: row.name, role: row.role, active: !!row.active, createdAt: row.createdAt }
}

/** All users (active and inactive), for the owner-only management screen. */
export function listUsers(db: DB): User[] {
  const rows = db
    .prepare('SELECT id, name, role, active, created_at AS createdAt FROM users ORDER BY name COLLATE NOCASE')
    .all() as UserRow[]
  return rows.map(toUser)
}

/** Active users only, for the lock-screen picker — no PIN hashes, obviously. */
export function listLoginNames(db: DB): { id: number; name: string; role: Role }[] {
  return db
    .prepare("SELECT id, name, role FROM users WHERE active = 1 ORDER BY name COLLATE NOCASE")
    .all() as { id: number; name: string; role: Role }[]
}

export function getUser(db: DB, id: number): User {
  const row = db
    .prepare('SELECT id, name, role, active, created_at AS createdAt FROM users WHERE id = ?')
    .get(id) as UserRow | undefined
  if (!row) throw new Error('User not found')
  return toUser(row)
}

/**
 * Create (no `id`) or update (`id`) a user. The very first user ever created for a company is
 * always forced to role 'owner', regardless of what was requested — there's no one else around
 * to have granted them anything else, and the app would otherwise start with zero owners.
 */
export function saveUser(db: DB, input: UserInput, id?: number): User {
  if (id === undefined) {
    if (!input.pin) throw new Error('PIN is required')
    const bootstrap = !usersExist(db)
    const role: Role = bootstrap ? 'owner' : input.role
    const pinHash = hashPin(input.pin)
    const result = db
      .prepare('INSERT INTO users (name, pin_hash, role, active) VALUES (?, ?, ?, ?)')
      .run(input.name, pinHash, role, input.active === false ? 0 : 1)
    return getUser(db, Number(result.lastInsertRowid))
  }

  getUser(db, id) // 404s if missing
  if (input.pin) {
    const pinHash = hashPin(input.pin)
    db.prepare('UPDATE users SET name = ?, role = ?, active = ?, pin_hash = ? WHERE id = ?').run(
      input.name,
      input.role,
      input.active === false ? 0 : 1,
      pinHash,
      id
    )
  } else {
    db.prepare('UPDATE users SET name = ?, role = ?, active = ? WHERE id = ?').run(
      input.name,
      input.role,
      input.active === false ? 0 : 1,
      id
    )
  }
  return getUser(db, id)
}

/** Soft-deactivate a user. Refused if this would leave the company with zero active owners. */
export function deactivateUser(db: DB, id: number): void {
  const user = getUser(db, id)
  if (!user.active) return
  if (user.role === 'owner') {
    const row = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND active = 1").get() as {
      n: number
    }
    if (row.n <= 1) throw new Error('Cannot deactivate the last active owner')
  }
  db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(id)
}

/** Consecutive-failure throttle, per user id, in memory only (resets on app restart). */
const throttle = new Map<number, { fails: number; until: number }>()
const MAX_FAILS = 5
const LOCKOUT_MS = 30_000

/** Verify `pin` for `userId`. Throws 'Wrong PIN' on mismatch (or unknown/inactive user), or the
 *  throttle message after 5 consecutive failures — in which case verifyPin isn't even called. */
export function login(db: DB, userId: number, pin: string): LoginResult {
  const now = Date.now()
  const state = throttle.get(userId)
  if (state && state.until > now) {
    throw new Error('Too many attempts — wait 30 seconds')
  }

  const row = db
    .prepare('SELECT id, name, pin_hash AS pinHash, role, active FROM users WHERE id = ?')
    .get(userId) as { id: number; name: string; pinHash: string; role: Role; active: number } | undefined

  const ok = row && row.active ? verifyPin(pin, row.pinHash) : false
  if (!row || !row.active || !ok) {
    const fails = (state?.fails ?? 0) + 1
    throttle.set(userId, { fails, until: fails >= MAX_FAILS ? now + LOCKOUT_MS : 0 })
    throw new Error('Wrong PIN')
  }

  throttle.delete(userId)
  return { id: row.id, name: row.name, role: row.role }
}
