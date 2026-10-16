// Path-parameterized, Electron-free backup primitives (dbtest-able; better-sqlite3 objects are
// passed in from callers that already opened them with the Electron ABI).
import Database from 'better-sqlite3-multiple-ciphers'
import { existsSync, readdirSync, statSync, unlinkSync, copyFileSync, renameSync, rmSync } from 'fs'
import { join, basename } from 'path'
import type { DB } from './connection'
import { keyOfHandle, openDb, removeDbFiles } from './encryption'
import { CheckStoppedError, pragmaCheck } from './checkHost'
import { assertNotNewer } from './migrate'
import { preUpgradeOf, PRE_UPGRADE_TAG } from './preUpgrade'
import { AppError } from '@shared/errors'

export interface BackupInfo {
  file: string
  sizeBytes: number
  mtime: number
  tag: string
  /** A pre-upgrade copy (tag 'pre-upgrade'): the schema versions it was taken between. */
  upgrade?: { from: number; to: number }
}

/** ISO stamp with ':' and '.' replaced by '-', fixed-width (e.g. "2025-08-15T12-34-56"). */
const STAMP_LEN = 19

/** Timestamp segment used in backup filenames: the ISO shape with ':' replaced by '-', in LOCAL
 *  time (gate polish: a backup taken at 1 am IST was named after the previous day in UTC). Still
 *  fixed-width and sortable; older UTC-named files keep their names (the list sorts by mtime). */
export function backupStamp(now = new Date()): string {
  const [y, mo, d, h, mi, s] = localStampParts(now)
  return `${y}-${mo}-${d}T${h}-${mi}-${s}`
}

/** The LOCAL date-time parts every backup-file stamp is built from (backupStamp here,
 *  preUpgradeStamp in preUpgrade.ts): year, then month … second zero-padded to two digits. */
export function localStampParts(now: Date): [string, string, string, string, string, string] {
  const p = (n: number): string => String(n).padStart(2, '0')
  return [String(now.getFullYear()), p(now.getMonth() + 1), p(now.getDate()), p(now.getHours()), p(now.getMinutes()), p(now.getSeconds())]
}

/**
 * Tag encoded in a backup filename `<stamp>-<tag>.db`. The stamp is a fixed-width ISO
 * timestamp (itself full of hyphens), so the tag is everything after it — not just the
 * segment after the last '-', since tags like 'pre-tally-import' contain hyphens too.
 */
export function tagOf(file: string): string {
  if (preUpgradeOf(file)) return PRE_UPGRADE_TAG
  const stem = file.endsWith('.db') ? file.slice(0, -3) : file
  if (stem.length > STAMP_LEN + 1 && stem[STAMP_LEN] === '-') return stem.slice(STAMP_LEN + 1)
  // Fallback for anything that doesn't match the expected shape.
  const idx = stem.lastIndexOf('-')
  return idx === -1 ? stem : stem.slice(idx + 1)
}

/**
 * Live (WAL-safe) snapshot of an open database into `dest`, using better-sqlite3's native
 * online backup API. Captures uncheckpointed WAL content, unlike a raw file copy.
 */
export async function snapshotTo(db: DB, dest: string): Promise<void> {
  // WP 7.2: SQLite's online backup cannot write into an unkeyed target from an encrypted source;
  // VACUUM INTO copies with the source's key (the backup is encrypted like the books are).
  // VACUUM INTO refuses a target that exists (a second backup in the same second has the same
  // name; the online backup overwrites it): write beside it and rename over, like the backup API.
  if (keyOfHandle(db)) {
    const tmp = `${dest}.vacuum-tmp`
    removeDbFiles(tmp)
    try {
      snapshotSync(db, tmp)
      renameSync(tmp, dest)
    } catch (err) {
      removeDbFiles(tmp)
      throw err
    }
    return
  }
  await db.backup(dest)
}

/**
 * Synchronous WAL-safe snapshot via `VACUUM INTO`. Used where we can't await (e.g. the
 * before-quit handler) or want a compacted copy (encrypted export).
 * VACUUM INTO cannot take a bound parameter in all better-sqlite3/SQLite builds, so the
 * destination path is escaped and inlined.
 */
export function snapshotSync(db: DB, dest: string): void {
  const escaped = dest.replace(/'/g, "''")
  db.exec(`VACUUM INTO '${escaped}'`)
}

/** List *.db backups in `dir`, newest first. */
export function listBackupsIn(dir: string): BackupInfo[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.db'))
    .map((f) => {
      const st = statSync(join(dir, f))
      const up = preUpgradeOf(f)
      return { file: basename(f), sizeBytes: st.size, mtime: st.mtimeMs, tag: tagOf(f), ...(up ? { upgrade: { from: up.from, to: up.to } } : {}) }
    })
    .sort((a, b) => b.mtime - a.mtime)
}

/** Tags that are safe to prune once there are more than `keep` of them (newest kept). */
const PRUNABLE_TAGS = new Set(['auto', 'open'])

/**
 * Prune old backups in `dir`, keeping the newest `keep` files overall but only ever deleting
 * files tagged 'auto' or 'open'. Manual / pre-restore / pre-tally-import / quit snapshots are
 * never pruned automatically.
 */
export function pruneBackupsIn(dir: string, keep: number): void {
  const all = listBackupsIn(dir)
  let kept = 0
  for (const b of all) {
    if (kept < keep) {
      kept++
      continue
    }
    if (PRUNABLE_TAGS.has(b.tag)) {
      unlinkSync(join(dir, b.file))
    }
  }
}

/**
 * Post-write backup verification (task Q3 #99): true iff the file at `path` opens read-only and
 * passes `PRAGMA quick_check`. Called by backupCompany right after every snapshot, so a backup
 * that was corrupted in flight (full disk, sync-folder interference, ...) fails loudly at write
 * time instead of being discovered at restore time. Never throws.
 */
export function quickCheckOk(path: string, key?: Buffer | null): boolean {
  let db: Database.Database
  try {
    db = openDb(path, { readonly: true, fileMustExist: true, ...(key !== undefined ? { key } : {}) })
  } catch {
    return false
  }
  try {
    const result = db.pragma('quick_check') as Array<{ quick_check: string }>
    return result[0]?.quick_check === 'ok'
  } catch {
    return false
  } finally {
    db.close()
  }
}

/** Meta key stamping the last scheduled full `PRAGMA integrity_check` (task Q3 #99). */
export const INTEGRITY_CHECK_META_KEY = 'integrity.lastFullCheck'

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

export interface WeeklyIntegrityResult {
  /** False when the last full check is under a week old — nothing was run. */
  ran: boolean
  /** Meaningful only when `ran`; true iff `PRAGMA integrity_check` reported 'ok'. */
  ok: boolean
  detail: string | null
}

/**
 * Scheduled full integrity check: runs the thorough `PRAGMA integrity_check` (the per-open check
 * in ipc.ts uses the cheaper quick_check) at most once every 7 days, stamping the run time into
 * `meta` under INTEGRITY_CHECK_META_KEY. Never throws — an unreadable DB reports ok:false.
 */
export function runWeeklyIntegrityCheck(db: DB, now = new Date()): WeeklyIntegrityResult {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(INTEGRITY_CHECK_META_KEY) as
      | { value: string }
      | undefined
    if (row) {
      const last = Date.parse(JSON.parse(row.value) as string)
      if (Number.isFinite(last) && now.getTime() - last < WEEK_MS) {
        return { ran: false, ok: true, detail: null }
      }
    }
    const result = db.pragma('integrity_check') as Array<{ integrity_check: string }>
    const detail = result[0]?.integrity_check ?? 'no result'
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
      INTEGRITY_CHECK_META_KEY,
      JSON.stringify(now.toISOString())
    )
    return { ran: true, ok: detail === 'ok', detail }
  } catch (err) {
    return { ran: true, ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * runWeeklyIntegrityCheck with the `PRAGMA integrity_check` on its own read-only connection in a
 * worker thread (WP 7.1): company:open starts it and does not wait — the result is only logged.
 * Same throttle, same stamp (written when the check finishes, while `db` is still open); a company
 * closed before then simply runs it on its next open. Never rejects.
 */
export async function runWeeklyIntegrityCheckAsync(db: DB, path: string, now = new Date()): Promise<WeeklyIntegrityResult | null> {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(INTEGRITY_CHECK_META_KEY) as
      | { value: string }
      | undefined
    if (row) {
      const last = Date.parse(JSON.parse(row.value) as string)
      if (Number.isFinite(last) && now.getTime() - last < WEEK_MS) {
        return { ran: false, ok: true, detail: null }
      }
    }
    const detail = await pragmaCheck(path, 'integrity_check', keyOfHandle(db))
    if (!db.open) return null
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
      INTEGRITY_CHECK_META_KEY,
      JSON.stringify(now.toISOString())
    )
    return { ran: true, ok: detail === 'ok', detail }
  } catch (err) {
    // Stopped because the file is being restored / removed (stopChecks): no finding, no stamp.
    if (!db.open || err instanceof CheckStoppedError) return null
    return { ran: true, ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Reject anything that isn't a healthy, readable Total company database — a corrupted or
 * unrelated file must never be allowed to overwrite a live company DB. Checks both SQLite-level
 * integrity (quick_check) and that it has the shape of a Total company DB (a `meta.company` row).
 */
export function assertValidCompanyDb(path: string, key?: Buffer | null): void {
  let check: Database.Database
  try {
    check = openDb(path, { readonly: true, fileMustExist: true, ...(key !== undefined ? { key } : {}) })
  } catch {
    throw new Error('That file is not a valid Total backup')
  }
  try {
    const result = check.pragma('quick_check') as Array<{ quick_check: string }>
    if (result[0]?.quick_check !== 'ok') throw new Error('failed quick_check')
    const row = check.prepare("SELECT value FROM meta WHERE key = 'company'").get() as { value: string } | undefined
    if (!row) throw new Error('no company meta row')
    JSON.parse(row.value)
    // Upgrade guard: a backup from a NEWER Total is refused before it replaces the books.
    assertNotNewer(check)
  } catch (err) {
    if (err instanceof AppError && err.code === 'db_newer_version') throw err
    throw new Error('That file is not a valid Total backup')
  } finally {
    check.close()
  }
}

/**
 * Copy `sourcePath` into place at `dbPath` via a same-directory temp file + atomic rename.
 * A same-directory rename is atomic on POSIX, so a crash or error mid-copy can never leave
 * `dbPath` itself corrupted or partially written — it's either the old file or the new one.
 * Also clears any -wal/-shm siblings, since they'd otherwise refer to the now-stale content.
 */
function swapInPlace(sourcePath: string, dbPath: string): void {
  const tempPath = `${dbPath}.swap-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  copyFileSync(sourcePath, tempPath)
  renameSync(tempPath, dbPath)
  rmSync(`${dbPath}-wal`, { force: true })
  rmSync(`${dbPath}-shm`, { force: true })
}

export interface RestoreResult {
  /** Path of the pre-restore safety snapshot taken before the live DB was overwritten. */
  preRestoreSnapshotPath: string
}

/**
 * File-level restore orchestration, Electron-free and dbtest-able. CLOSES `db` before the
 * swap — Windows cannot rename over a file another handle holds open (EPERM), so the handle
 * must die first; on POSIX it's harmless. If validation throws (step 1), `db` is still open
 * and untouched. The caller reopens `dbPath` afterwards and owns the in-memory bookkeeping.
 * Order of operations matters for safety:
 *
 *  1. Validate the chosen backup file BEFORE touching the live DB at all — a corrupted or
 *     unrelated file throws here and `dbPath` is never touched.
 *  2. Checkpoint the live DB's WAL and take a pre-restore safety snapshot, so there's always a
 *     way back even after step 3 below.
 *  3. Atomically swap the backup into place at `dbPath` (see swapInPlace).
 *
 * If this throws, `dbPath` on disk is guaranteed untouched. If it succeeds but the caller then
 * fails to reopen `dbPath` (e.g. the backup predates a schema this build can't migrate from),
 * the caller can roll back with `rollbackRestore(dbPath, result.preRestoreSnapshotPath)`.
 */
export function restoreCompanyDb(db: DB, dbPath: string, backupPath: string, backupsDir: string): RestoreResult {
  if (!existsSync(backupPath)) throw new Error('Backup file not found')

  assertValidCompanyDb(backupPath)

  db.pragma('wal_checkpoint(TRUNCATE)')
  const preRestoreSnapshotPath = join(backupsDir, `${backupStamp()}-pre-restore.db`)
  snapshotSync(db, preRestoreSnapshotPath)

  // Windows: the rename in swapInPlace EPERMs while any handle holds dbPath open.
  db.close()
  swapInPlace(backupPath, dbPath)

  return { preRestoreSnapshotPath }
}

/** Roll `dbPath` back to a previously-taken snapshot (e.g. after a failed restore/reopen). */
export function rollbackRestore(dbPath: string, snapshotPath: string): void {
  swapInPlace(snapshotPath, dbPath)
}
