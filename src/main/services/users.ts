import type { DB } from '../db/connection'
import { hashPin, verifyPin } from './authcrypt'
import { writeAudit } from './audit'
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

/**
 * Consecutive-failure throttle, per user id, persisted in the `meta` table under
 * `auth.fails.<userId>` (task Q1 #93) — restarting the app no longer resets the lockout the way
 * the old in-memory Map did. Reset (row deleted) on a successful login.
 */
const MAX_FAILS = 5
const LOCKOUT_MS = 30_000

interface ThrottleState {
  fails: number
  /** Epoch ms until which login attempts are refused; 0 = not locked out. */
  until: number
}

function throttleKey(userId: number): string {
  return `auth.fails.${userId}`
}

function readThrottle(db: DB, userId: number): ThrottleState | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(throttleKey(userId)) as
    | { value: string }
    | undefined
  if (!row) return null
  try {
    const parsed = JSON.parse(row.value) as Partial<ThrottleState>
    if (typeof parsed.fails !== 'number' || typeof parsed.until !== 'number') return null
    return { fails: parsed.fails, until: parsed.until }
  } catch {
    return null
  }
}

function writeThrottle(db: DB, userId: number, state: ThrottleState): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    throttleKey(userId),
    JSON.stringify(state)
  )
}

function clearThrottle(db: DB, userId: number): void {
  db.prepare('DELETE FROM meta WHERE key = ?').run(throttleKey(userId))
}

export const AUTH_THROTTLE_MESSAGE = 'Too many attempts — wait 30 seconds'

/** True while `userId` is inside the lockout window. Exported so EVERY PIN-verification surface
 *  (auth:login here, company:delete in companyDelete.ts) consumes the same persisted throttle —
 *  a brute-force loop must not be able to sidestep the lockout by picking a different channel
 *  (v0.3 review F3). */
export function isAuthThrottled(db: DB, userId: number, now = Date.now()): boolean {
  const state = readThrottle(db, userId)
  return state !== null && state.until > now
}

/** Record one failed PIN attempt against `userId`: bumps the persisted consecutive-failure
 *  counter (locking out at MAX_FAILS) and writes the 'login_failed' audit row. */
export function recordAuthFailure(db: DB, userId: number, now = Date.now()): void {
  const fails = (readThrottle(db, userId)?.fails ?? 0) + 1
  writeThrottle(db, userId, { fails, until: fails >= MAX_FAILS ? now + LOCKOUT_MS : 0 })
  writeAudit(db, 'user', userId, 'login_failed', null, null)
}

/** Reset the failure counter after a successful PIN verification. */
export function clearAuthFailures(db: DB, userId: number): void {
  clearThrottle(db, userId)
}

/** Verify `pin` for `userId`. Throws 'Wrong PIN' on mismatch (or unknown/inactive user), or the
 *  throttle message after 5 consecutive failures — in which case verifyPin isn't even called.
 *  Every failed attempt is audited (entity 'user', action 'login_failed', before/after null);
 *  successes are audited as action 'login'. */
export function login(db: DB, userId: number, pin: string): LoginResult {
  const now = Date.now()
  if (isAuthThrottled(db, userId, now)) {
    throw new Error(AUTH_THROTTLE_MESSAGE)
  }

  const row = db
    .prepare('SELECT id, name, pin_hash AS pinHash, role, active FROM users WHERE id = ?')
    .get(userId) as { id: number; name: string; pinHash: string; role: Role; active: number } | undefined

  const ok = row && row.active ? verifyPin(pin, row.pinHash) : false
  if (!row || !row.active || !ok) {
    recordAuthFailure(db, userId, now)
    throw new Error('Wrong PIN')
  }

  clearAuthFailures(db, userId)
  writeAudit(db, 'user', row.id, 'login', null, { name: row.name, role: row.role })
  return { id: row.id, name: row.name, role: row.role }
}
