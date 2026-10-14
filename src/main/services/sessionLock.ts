// WP 7.2 — the session lock: after N idle minutes (owner-set, meta `security.autoLockMinutes`,
// default off) the signed-in user is signed out and the PIN screen comes back. Main enforces it
// (ipc.ts `handle`: a due lock is applied before the gate, so a stale renderer cannot keep using
// the session); this module is the pure clock and the setting. Electron-free.
import type { DB } from '../db/connection'
import { writeAudit } from './audit'

export const AUTO_LOCK_KEY = 'security.autoLockMinutes'
/** The choices the setting offers (null = off). */
export const AUTO_LOCK_CHOICES = [1, 5, 10, 15, 30, 60] as const

export function getAutoLockMinutes(db: DB): number | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(AUTO_LOCK_KEY) as { value: string } | undefined
  if (!row) return null
  try {
    const v = JSON.parse(row.value) as unknown
    return typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 24 * 60 ? v : null
  } catch {
    return null
  }
}

/** Set (or clear with null); audited as a 'security' update; unchanged = nothing written. */
export function setAutoLockMinutes(db: DB, minutes: number | null): number | null {
  const before = getAutoLockMinutes(db)
  if (before === minutes) return before
  db.transaction(() => {
    if (minutes === null) db.prepare('DELETE FROM meta WHERE key = ?').run(AUTO_LOCK_KEY)
    else
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(AUTO_LOCK_KEY, JSON.stringify(minutes))
    writeAudit(db, 'security', 0, 'update', { autoLockMinutes: before }, { autoLockMinutes: minutes })
  })()
  return minutes
}

/** The idle clock of one session. */
export class IdleClock {
  private last: number
  constructor(
    private minutes: number | null,
    now = Date.now()
  ) {
    this.last = now
  }

  setMinutes(minutes: number | null, now = Date.now()): void {
    this.minutes = minutes
    this.last = now
  }

  get autoLockMinutes(): number | null {
    return this.minutes
  }

  touch(now = Date.now()): void {
    this.last = now
  }

  /** True once the session has been idle for the set minutes. */
  due(now = Date.now()): boolean {
    return this.minutes !== null && now - this.last >= this.minutes * 60_000
  }

  /** Milliseconds of idleness. */
  idleFor(now = Date.now()): number {
    return now - this.last
  }
}
