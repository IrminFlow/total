// Safe copy before an upgrade (plan item "downgrade guard + safe copy before an upgrade"):
// before openCompanyDb applies one or more migrations to an EXISTING company file, the file as it
// is goes to `<company>/backups/pre-upgrade-<from>-to-<to>-<YYYYMMDD-HHMMSS>.db` — the backup
// service's VACUUM INTO snapshot (an encrypted business gets an encrypted copy, with its key),
// written beside the target, quick-checked, fsynced and renamed into place like WP 7.2's
// conversions. A copy that cannot be written fails the open (`db_upgrade_copy_failed`) — the
// file is never migrated without one. The newest copy of each of the PRE_UPGRADE_KEEP most
// recent source versions is kept (prunePreUpgradeCopies).
// Electron-free (the caller passes the folder and a logger), so dbtests drive it on paths.
import { existsSync, readdirSync, renameSync, statSync } from 'fs'
import { join } from 'path'
import type { DB } from './connection'
import { keyOfHandle, removeDbFiles } from './encryption'
import { localStampParts, quickCheckOk, snapshotSync } from './backup'
import { fsyncDir, fsyncFile } from '../services/dbEncryption'
import { AppError } from '@shared/errors'

/** How many source versions a company keeps a pre-upgrade copy of (the newest copy of each). */
export const PRE_UPGRADE_KEEP = 2

export const PRE_UPGRADE_TAG = 'pre-upgrade'

const NAME = /^pre-upgrade-(\d+)-to-(\d+)-(\d{8}-\d{6})\.db$/

/** The `from` / `to` schema versions of a pre-upgrade copy's file name (null for any other file). */
export function preUpgradeOf(file: string): { from: number; to: number; stamp: string } | null {
  const m = NAME.exec(file)
  return m ? { from: Number(m[1]), to: Number(m[2]), stamp: m[3]! } : null
}

/** Local-time `YYYYMMDD-HHMMSS`. */
export function preUpgradeStamp(now = new Date()): string {
  const [y, mo, d, h, mi, s] = localStampParts(now)
  return `${y}${mo}${d}-${h}${mi}${s}`
}

export const UPGRADE_COPY_FAILED_MESSAGE = 'Total could not make a safe copy before upgrading the books; free some disk space and try again'

type Logger = (level: 'info' | 'warn' | 'error', event: string, data?: Record<string, unknown>) => void

/**
 * Write the pre-upgrade copy of the open (not yet migrated) handle `db` into `backupsDir`.
 * Throws `db_upgrade_copy_failed` (nothing left behind) when it cannot be written or checked.
 */
export function writePreUpgradeCopy(db: DB, backupsDir: string, from: number, to: number, opts: { now?: Date; log?: Logger } = {}): string {
  const dest = join(backupsDir, `pre-upgrade-${from}-to-${to}-${preUpgradeStamp(opts.now)}.db`)
  const tmp = `${dest}.vacuum-tmp`
  try {
    removeDbFiles(tmp)
    snapshotSync(db, tmp) // VACUUM INTO: WAL-safe, keyed with the source's key when it has one
    fsyncFile(tmp)
    if (!quickCheckOk(tmp, keyOfHandle(db))) throw new Error('the copy did not pass quick_check')
    renameSync(tmp, dest)
    fsyncDir(backupsDir)
  } catch (err) {
    try {
      removeDbFiles(tmp)
    } catch {
      // nothing more to clean
    }
    const reason = err instanceof Error ? err.message : String(err)
    opts.log?.('error', 'pre-upgrade-copy-failed', { from, to, error: reason })
    throw new AppError('db_upgrade_copy_failed', UPGRADE_COPY_FAILED_MESSAGE, { params: { from, to } })
  }
  opts.log?.('info', 'pre-upgrade-copy', { from, to, file: dest })
  return dest
}

/** Keep the newest pre-upgrade copy of each of the `keep` most recent `from` versions in
 *  `backupsDir` (newest by the stamp in the name, then mtime); delete the rest. Returns the
 *  deleted file names. Never throws. Counted by version, not by file: an upgrade that fails
 *  midway leaves the file at a half-upgraded version, and every retry takes another copy from
 *  that version — by file count those retries pushed out the only copy at the version the
 *  previous Total can still open. */
export function prunePreUpgradeCopies(backupsDir: string, keep = PRE_UPGRADE_KEEP, log?: Logger): string[] {
  if (!existsSync(backupsDir)) return []
  const removed: string[] = []
  try {
    const copies = readdirSync(backupsDir)
      .map((f) => ({ f, info: preUpgradeOf(f) }))
      .filter((c): c is { f: string; info: NonNullable<ReturnType<typeof preUpgradeOf>> } => c.info !== null)
      .map((c) => ({ ...c, mtime: statSync(join(backupsDir, c.f)).mtimeMs }))
      .sort((a, b) => (a.info.stamp === b.info.stamp ? b.mtime - a.mtime : a.info.stamp < b.info.stamp ? 1 : -1))
    const versions = new Set<number>()
    const doomed = copies.filter((c) => {
      if (versions.has(c.info.from) || versions.size >= keep) return true
      versions.add(c.info.from)
      return false
    })
    for (const c of doomed) {
      try {
        removeDbFiles(join(backupsDir, c.f))
        removed.push(c.f)
      } catch (err) {
        log?.('warn', 'pre-upgrade-prune-failed', { file: c.f, error: err instanceof Error ? err.message : String(err) })
      }
    }
  } catch (err) {
    log?.('warn', 'pre-upgrade-prune-failed', { error: err instanceof Error ? err.message : String(err) })
  }
  if (removed.length) log?.('info', 'pre-upgrade-pruned', { files: removed })
  return removed
}
