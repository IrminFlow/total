/**
 * Two machines, one set of books (roadmap #259).
 *
 * The app already warns when the data folder looks synced, and the warning is easy to dismiss and
 * easy to forget. What it cannot see is the case that actually corrupts a SQLite database: the
 * same company open on the office desktop and the accountant's laptop at once, both writing,
 * Dropbox merging the file underneath them. SQLite's own locking is useless here — it is per
 * machine, and the two machines never see each other's locks.
 *
 * So the company folder carries a small JSON file that says who has it open, refreshed on a
 * heartbeat. A heartbeat that is still warm belongs to a live session somewhere; a cold one is
 * what a crash leaves behind, and must not lock anyone out of their own books forever.
 *
 * Pure: the verdict is decided here, the file is read and written in main.
 */

export interface DeviceLock {
  /** Machine name — what the second user needs to hear ("open on RECEPTION-PC"). */
  host: string
  /** Process id, so the same machine relaunching after a crash recognises its own stale lock. */
  pid: number
  /** ISO, when the session started. */
  startedAt: string
  /** ISO, refreshed on the heartbeat. */
  heartbeatAt: string
  /** Who was signed in, when anyone was. */
  userName: string | null
}

/** How often a live session rewrites its heartbeat. */
export const HEARTBEAT_MS = 30_000

/**
 * How long a heartbeat stays believable. Three missed beats: long enough that a laptop sleeping
 * for a moment or a slow sync round-trip does not evict a live session, short enough that a
 * crashed one is out of the way before anybody phones for help.
 */
export const STALE_AFTER_MS = HEARTBEAT_MS * 3

export type LockVerdict =
  /** No lock file: nobody has it. */
  | { kind: 'free' }
  /** Our own lock — the same machine and process, e.g. reopening the company we already have. */
  | { kind: 'ours' }
  /** A warm heartbeat belonging to someone else. Opening now is the corruption case. */
  | { kind: 'held'; lock: DeviceLock; secondsSinceBeat: number }
  /** A cold heartbeat: a crash, a hard power-off, or a machine that never came back. */
  | { kind: 'stale'; lock: DeviceLock; secondsSinceBeat: number }

/** Re-validated on read: the file lives in a folder any sync client can rewrite. */
export function parseDeviceLock(raw: unknown): DeviceLock | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Partial<DeviceLock>
  if (typeof value.host !== 'string' || typeof value.pid !== 'number') return null
  if (typeof value.heartbeatAt !== 'string') return null
  return {
    host: value.host,
    pid: value.pid,
    startedAt: typeof value.startedAt === 'string' ? value.startedAt : value.heartbeatAt,
    heartbeatAt: value.heartbeatAt,
    userName: typeof value.userName === 'string' ? value.userName : null
  }
}

export function lockVerdict(
  lock: DeviceLock | null,
  self: { host: string; pid: number },
  nowMs: number
): LockVerdict {
  if (!lock) return { kind: 'free' }
  if (lock.host === self.host && lock.pid === self.pid) return { kind: 'ours' }

  const beat = Date.parse(lock.heartbeatAt)
  // An unparseable heartbeat is treated as ancient rather than as fresh: refusing to open on the
  // strength of a timestamp nobody can read would strand the books behind a corrupt lock file.
  const age = Number.isFinite(beat) ? nowMs - beat : Number.POSITIVE_INFINITY
  const secondsSinceBeat = Number.isFinite(age) ? Math.max(0, Math.round(age / 1000)) : -1
  return age > STALE_AFTER_MS ? { kind: 'stale', lock, secondsSinceBeat } : { kind: 'held', lock, secondsSinceBeat }
}

/** What to tell the second person. Names the machine, because that is what they act on. */
export function lockMessage(verdict: LockVerdict): string | null {
  if (verdict.kind === 'free' || verdict.kind === 'ours') return null
  const who = verdict.lock.userName ? `${verdict.lock.userName} on ${verdict.lock.host}` : verdict.lock.host
  if (verdict.kind === 'held') {
    return `These books are open on ${who} right now. Opening them here as well can corrupt them — close them there first.`
  }
  return `These books were left open on ${who} and have not been heard from for ${
    verdict.secondsSinceBeat < 0 ? 'a while' : `${Math.round(verdict.secondsSinceBeat / 60)} minutes`
  }. That is usually a crash. If they are genuinely closed there, it is safe to continue.`
}
