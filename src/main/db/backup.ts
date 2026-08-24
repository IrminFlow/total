// Path-parameterized, Electron-free backup primitives (dbtest-able; better-sqlite3 objects are
// passed in from callers that already opened them with the Electron ABI).
import Database from 'better-sqlite3'
import { existsSync, readdirSync, statSync, unlinkSync, copyFileSync, renameSync, rmSync } from 'fs'
import { join, basename } from 'path'
import type { DB } from './connection'

export interface BackupInfo {
  file: string
  sizeBytes: number
  mtime: number
  tag: string
}

/** ISO stamp with ':' and '.' replaced by '-', fixed-width (e.g. "2025-08-15T12-34-56"). */
const STAMP_LEN = 19

/** Timestamp segment used in backup filenames: ISO with ':' and '.' replaced by '-'. */
export function backupStamp(now = new Date()): string {
  return now.toISOString().replace(/[:.]/g, '-').slice(0, STAMP_LEN)
}

/**
 * Tag encoded in a backup filename `<stamp>-<tag>.db`. The stamp is a fixed-width ISO
 * timestamp (itself full of hyphens), so the tag is everything after it — not just the
 * segment after the last '-', since tags like 'pre-tally-import' contain hyphens too.
 */
export function tagOf(file: string): string {
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
      return { file: basename(f), sizeBytes: st.size, mtime: st.mtimeMs, tag: tagOf(f) }
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
export function quickCheckOk(path: string): boolean {
  let db: Database.Database
  try {
    db = new Database(path, { readonly: true, fileMustExist: true })
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
 * Reject anything that isn't a healthy, readable Total company database — a corrupted or
 * unrelated file must never be allowed to overwrite a live company DB. Checks both SQLite-level
 * integrity (quick_check) and that it has the shape of a Total company DB (a `meta.company` row).
 */
export function assertValidCompanyDb(path: string): void {
  let check: Database.Database
  try {
    check = new Database(path, { readonly: true, fileMustExist: true })
  } catch {
    throw new Error('That file is not a valid Total backup')
  }
  try {
    const result = check.pragma('quick_check') as Array<{ quick_check: string }>
    if (result[0]?.quick_check !== 'ok') throw new Error('failed quick_check')
    const row = check.prepare("SELECT value FROM meta WHERE key = 'company'").get() as { value: string } | undefined
    if (!row) throw new Error('no company meta row')
    JSON.parse(row.value)
  } catch {
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

export interface RestoreChange {
  what: string
  /** In the books as they stand now. */
  now: string
  /** In the backup that is about to replace them. */
  after: string
  /** True when restoring loses something — the rows a person needs to read first. */
  loses: boolean
}

export interface RestorePreview {
  file: string
  /** Set when the backup cannot be read at all; every other field is then meaningless. */
  problem: string | null
  changes: RestoreChange[]
  /** Vouchers in the books now that are not in the backup — the entries that get typed again. */
  vouchersLost: number
  /** Vouchers in the backup that are not in the books now — deletions the restore undoes. */
  vouchersReturned: number
  /** The lost ones, newest first, capped: a list of ten is read, a list of four hundred is not. */
  sample: { date: string; type: string; number: string; amount: number }[]
}

const SAMPLE_SIZE = 10

/** Vouchers keyed the way a human identifies one, so two databases can be compared without ids. */
function voucherKeys(db: Database.Database): Map<string, { date: string; type: string; number: string; amount: number }> {
  const rows = db
    .prepare(
      `SELECT v.date, vt.name AS type, v.number,
              COALESCE((SELECT SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE 0 END)
                        FROM voucher_lines vl WHERE vl.voucher_id = v.id), 0) AS amount
       FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id
       WHERE v.deleted_at IS NULL`
    )
    .all() as { date: string; type: string; number: string; amount: number }[]
  return new Map(rows.map((r) => [`${r.date}|${r.type}|${r.number}`, r]))
}

function countOf(db: Database.Database, sql: string): number {
  try {
    return (db.prepare(sql).get() as { n: number }).n
  } catch {
    // A table that does not exist in an older backup is a real answer: it held none of those.
    return 0
  }
}

/**
 * What restoring this backup would change, before it changes it (roadmap #246).
 *
 * "This replaces the current books" is true and unactionable. The Backups screen already says how
 * many vouchers would be lost; that number answers "how bad" and not "what". A restore is a
 * one-way door for everything entered since, and the two questions people actually ask on the way
 * through it are which entries disappear and which deletions come back — both of which need the
 * backup and the live books compared row by row, which is what this does.
 *
 * Read-only on both sides. The live database is the caller's open handle; the backup is opened
 * read-only and closed here.
 */
export function restorePreview(live: DB, backupPath: string, file = basename(backupPath)): RestorePreview {
  const empty = (problem: string): RestorePreview => ({
    file,
    problem,
    changes: [],
    vouchersLost: 0,
    vouchersReturned: 0,
    sample: []
  })
  if (!existsSync(backupPath)) return empty('Backup file not found')

  let backup: Database.Database
  try {
    backup = new Database(backupPath, { readonly: true, fileMustExist: true })
  } catch (err) {
    return empty(`Could not open the backup: ${err instanceof Error ? err.message : String(err)}`)
  }

  try {
    const quick = (backup.pragma('quick_check') as Array<{ quick_check: string }>)[0]?.quick_check
    if (quick !== 'ok') return empty(`SQLite reports: ${quick ?? 'no result'}`)

    const liveKeys = voucherKeys(live)
    const backupKeys = voucherKeys(backup)

    const lost = [...liveKeys.entries()].filter(([key]) => !backupKeys.has(key)).map(([, v]) => v)
    const returned = [...backupKeys.keys()].filter((key) => !liveKeys.has(key)).length

    const counts: { what: string; sql: string }[] = [
      { what: 'Vouchers', sql: 'SELECT COUNT(*) AS n FROM vouchers WHERE deleted_at IS NULL' },
      { what: 'Ledgers', sql: 'SELECT COUNT(*) AS n FROM ledgers' },
      { what: 'Stock items', sql: 'SELECT COUNT(*) AS n FROM stock_items' },
      { what: 'Employees', sql: 'SELECT COUNT(*) AS n FROM employees' },
      { what: 'Audit entries', sql: 'SELECT COUNT(*) AS n FROM audit_log' }
    ]

    const changes: RestoreChange[] = counts.map(({ what, sql }) => {
      const now = countOf(live, sql)
      const after = countOf(backup, sql)
      return {
        what,
        now: now.toLocaleString('en-IN'),
        after: after.toLocaleString('en-IN'),
        loses: after < now
      }
    })

    const lastOf = (db: Database.Database): string =>
      ((db.prepare('SELECT MAX(date) AS d FROM vouchers WHERE deleted_at IS NULL').get() as { d: string | null }).d ??
        '—')
    changes.push({
      what: 'Latest entry',
      now: lastOf(live),
      after: lastOf(backup),
      loses: lastOf(backup) < lastOf(live)
    })

    const lockOf = (db: Database.Database): string =>
      ((db.prepare("SELECT value FROM meta WHERE key = 'lock_before'").get() as { value: string } | undefined)?.value ??
        'not locked')
    if (lockOf(live) !== lockOf(backup)) {
      changes.push({ what: 'Books locked up to', now: lockOf(live), after: lockOf(backup), loses: false })
    }

    return {
      file,
      problem: null,
      changes,
      vouchersLost: lost.length,
      vouchersReturned: returned,
      sample: lost.sort((a, b) => b.date.localeCompare(a.date)).slice(0, SAMPLE_SIZE)
    }
  } catch (err) {
    return empty(err instanceof Error ? err.message : String(err))
  } finally {
    backup.close()
  }
}

export interface BackupVerification {
  file: string
  /** SQLite says the file is structurally sound. */
  integrityOk: boolean
  /** It has the shape of a Total company database — the schema opened and migrated cleanly. */
  opensAsCompany: boolean
  /** Vouchers in books (the bin excluded), so "it restored" can be compared against expectation. */
  voucherCount: number
  /** Whether the books in the backup balance. The proof that matters. */
  balanced: boolean
  totalDebit: number
  totalCredit: number
  /** What went wrong, when something did. */
  problem: string | null
}

/**
 * Verify a backup by actually opening it, not by trusting its file size.
 *
 * A backup button that has never been proved is a promise, and a business finds out whether it
 * was true on the worst day of its year. Checking `quick_check` is not enough either: a
 * structurally valid SQLite file can still be a database whose books do not add up, or one from
 * a schema this build can no longer read.
 *
 * So this opens the file read-only, runs the thorough integrity check, confirms it has a company
 * in it, counts the vouchers, and foots the trial balance. If all four hold, the backup will
 * restore into a working set of books — which is the only claim worth making.
 *
 * Read-only throughout, and never touches the live database. Migrations are deliberately NOT
 * run: a backup that needs migrating still restores fine (restoreCompanyDb migrates on reopen),
 * and running them here would write to the backup file itself.
 */
export function verifyBackup(path: string): BackupVerification {
  const file = path.split('/').pop() ?? path
  const fail = (problem: string, partial: Partial<BackupVerification> = {}): BackupVerification => ({
    file,
    integrityOk: false,
    opensAsCompany: false,
    voucherCount: 0,
    balanced: false,
    totalDebit: 0,
    totalCredit: 0,
    problem,
    ...partial
  })

  let db: Database.Database
  try {
    db = new Database(path, { readonly: true, fileMustExist: true })
  } catch (err) {
    return fail(`Could not open the file: ${err instanceof Error ? err.message : String(err)}`)
  }

  // Tracked rather than assumed at each failure point: opening a non-database file succeeds and
  // the pragma is what throws, so a catch that claimed integrityOk would report a text file as
  // structurally sound.
  let integrityOk = false
  try {
    const integrity = (db.pragma('integrity_check') as Array<{ integrity_check: string }>)[0]?.integrity_check
    if (integrity !== 'ok') return fail(`SQLite reports: ${integrity ?? 'no result'}`)
    integrityOk = true

    const company = db.prepare("SELECT value FROM meta WHERE key = 'company'").get() as
      | { value: string }
      | undefined
    if (!company) {
      return fail('The file is a database, but not a Total company database.', { integrityOk })
    }

    const { n } = db
      .prepare('SELECT COUNT(*) AS n FROM vouchers WHERE deleted_at IS NULL')
      .get() as { n: number }

    // Foot the books straight from the lines. Opening balances count: a set of books balances
    // only when the openings and the movement balance together.
    const totals = db
      .prepare(
        `SELECT
           COALESCE((SELECT SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE 0 END)
                     FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
                     WHERE v.deleted_at IS NULL), 0) AS dr,
           COALESCE((SELECT SUM(CASE WHEN vl.dr_cr = 'cr' THEN vl.amount ELSE 0 END)
                     FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
                     WHERE v.deleted_at IS NULL), 0) AS cr`
      )
      .get() as { dr: number; cr: number }

    const balanced = totals.dr === totals.cr
    return {
      file,
      integrityOk: true,
      opensAsCompany: true,
      voucherCount: n,
      balanced,
      totalDebit: totals.dr,
      totalCredit: totals.cr,
      problem: balanced
        ? null
        : `The books in this backup do not balance: debits ${totals.dr} against credits ${totals.cr}.`
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err), { integrityOk })
  } finally {
    db.close()
  }
}
