/**
 * The file side of "these books are open somewhere else" (roadmap #259; the rule itself is
 * `src/shared/deviceLock.ts`).
 *
 * Written into the company folder, so it travels with the books through exactly the sync client
 * that causes the problem — which is the point: the second machine has to be able to see the
 * first machine's claim, and the only channel the two share is the folder itself.
 *
 * Nothing here ever refuses to open a company. It reports, the caller decides, and the user can
 * always continue: a lock file is evidence about another machine, and evidence about another
 * machine is exactly the kind of thing that is sometimes wrong.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { hostname } from 'os'
import { join } from 'path'
import { companyDir } from './paths'
import { lockVerdict, parseDeviceLock, HEARTBEAT_MS, type DeviceLock, type LockVerdict } from '@shared/deviceLock'

export function lockPath(slug: string): string {
  return join(companyDir(slug), 'open.lock')
}

function self(): { host: string; pid: number } {
  return { host: hostname(), pid: process.pid }
}

/** Read the current claim on `slug`, or null when the file is missing or unreadable. */
export function readLock(slug: string): DeviceLock | null {
  const path = lockPath(slug)
  if (!existsSync(path)) return null
  try {
    return parseDeviceLock(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return null
  }
}

/** Who holds these books, from this machine's point of view. */
export function inspectLock(slug: string, now = Date.now()): LockVerdict {
  return lockVerdict(readLock(slug), self(), now)
}

/** Stake or refresh this machine's claim. Best-effort: a read-only folder must not block opening. */
export function claimLock(slug: string, userName: string | null, startedAt?: string): void {
  const now = new Date().toISOString()
  const lock: DeviceLock = {
    ...self(),
    startedAt: startedAt ?? now,
    heartbeatAt: now,
    userName
  }
  try {
    writeFileSync(lockPath(slug), JSON.stringify(lock), 'utf8')
  } catch {
    // A folder we cannot write to is a folder where this feature simply does not run.
  }
}

/** Drop our claim on close. Never throws — a stale lock is survivable, a crash on quit is not. */
export function releaseLock(slug: string): void {
  try {
    const held = readLock(slug)
    // Only ever remove our OWN claim: on a shared folder, deleting somebody else's would be
    // precisely the corruption this exists to prevent.
    if (held && held.host === self().host && held.pid === self().pid) rmSync(lockPath(slug), { force: true })
  } catch {
    // ignore
  }
}

/**
 * Keep the claim warm while a company is open. Returns the timer so the caller can stop it;
 * `unref` so a lingering interval can never hold the app open at quit.
 */
export function startHeartbeat(getSlug: () => string | null, getUserName: () => string | null): NodeJS.Timeout {
  const timer = setInterval(() => {
    const slug = getSlug()
    if (slug) claimLock(slug, getUserName())
  }, HEARTBEAT_MS)
  timer.unref?.()
  return timer
}
