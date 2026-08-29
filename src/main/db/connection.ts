import Database from 'better-sqlite3'
import { rmSync } from 'fs'
import { join } from 'path'
import { companyBackupsDir, companyDbPath, ensureCompanyTree } from '../paths'
import { migrate } from './migrate'
import { backupStamp, pruneBackupsIn, quickCheckOk, snapshotTo } from './backup'

export type DB = Database.Database

export { migrate }

export function openCompanyDb(slug: string): DB {
  ensureCompanyTree(slug)
  const db = new Database(companyDbPath(slug))
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  db.pragma('foreign_keys = ON')
  // Perf tuning (v0.3): ~64MB page cache and memory-mapped reads keep the hot report
  // queries off the disk; ANALYZE below refreshes planner stats after any new migration.
  db.pragma('cache_size = -64000')
  db.pragma('mmap_size = 268435456')
  try {
    migrate(db)
    db.exec('ANALYZE')
  } catch (err) {
    // Never leak an open handle on a failed open — on Windows it would also block any
    // later restore/rollback rename of this file (EPERM on open files).
    db.close()
    throw err
  }
  return db
}

/** Close a company DB, first letting SQLite fold fresh ANALYZE-style stats into the schema
 *  (`PRAGMA optimize` is the documented cheap pre-close hook). Failures never block the close. */
export function closeCompanyDb(db: DB): void {
  if (!db.open) return // restoreCompanyDb closes the handle itself before swapping files
  try {
    db.pragma('optimize')
  } catch {
    // stats refresh is best-effort
  }
  db.close()
}

/** Default only; the per-company setting lives in meta. See services/config.ts. */
const MAX_BACKUPS = 20
const MIN_BACKUPS = 5

/**
 * How many backups this company keeps.
 *
 * Anything outside the sane range falls back to the default rather than being honoured: a stored
 * 1 would mean the next open overwrites the only copy, which is not a backup policy but a mirror,
 * and the one thing backups exist to survive is a mistake noticed later.
 */
function backupKeepOf(db: DB): number {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'backup.keep'").get() as { value: string } | undefined
    const parsed = row ? (JSON.parse(row.value) as unknown) : null
    return typeof parsed === 'number' && Number.isInteger(parsed) && parsed >= MIN_BACKUPS && parsed <= 200
      ? parsed
      : MAX_BACKUPS
  } catch {
    return MAX_BACKUPS
  }
}

/**
 * WAL-safe snapshot of an already-open company DB into backups/, tagged (e.g. 'open', 'manual',
 * 'auto', 'pre-tally-import', 'pre-restore', 'quit'). Uses better-sqlite3's native online backup
 * so uncheckpointed WAL content is always captured — a raw file copy would not see it.
 */
export async function backupCompany(db: DB, slug: string, tag = 'auto'): Promise<string> {
  const dest = join(companyBackupsDir(slug), `${backupStamp()}-${tag}.db`)
  await snapshotTo(db, dest)
  // Post-write verification (task Q3 #99): a backup that doesn't pass quick_check is worse than
  // no backup — it silently displaces a good one in the pruning window. Remove it and fail loudly
  // (manual backups surface this as an error toast; scheduled ones log it).
  if (!quickCheckOk(dest)) {
    rmSync(dest, { force: true })
    throw new Error('Backup verification failed (quick_check) — the snapshot was discarded')
  }
  // Read per company rather than using the constant: a business that opens its books four times
  // a day burns through twenty in a week, and one that opens weekly keeps five months in the same
  // twenty. The constant is only the default.
  //
  // Read inline rather than through services/config so the db layer keeps no dependency on the
  // service layer — this is one row, and the alternative is an import cycle waiting to happen.
  pruneBackupsIn(companyBackupsDir(slug), backupKeepOf(db))
  return dest
}
