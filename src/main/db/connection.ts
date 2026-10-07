import Database from 'better-sqlite3'
import { rmSync } from 'fs'
import { basename, join } from 'path'
import { companyBackupsDir, companyDbPath, ensureCompanyTree } from '../paths'
import { migrate } from './migrate'
import { backupStamp, pruneBackupsIn, quickCheckOk, snapshotTo } from './backup'
import { SYSTEM_AUDIT_USER, writeAudit } from '../services/audit'

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

const MAX_BACKUPS = 20

/**
 * WAL-safe snapshot of an already-open company DB into backups/, tagged (e.g. 'open', 'manual',
 * 'auto', 'pre-tally-import', 'pre-restore', 'quit'). Uses better-sqlite3's native online backup
 * so uncheckpointed WAL content is always captured — a raw file copy would not see it.
 */
export async function backupCompany(db: DB, slug: string, tag = 'auto', auditUser: string = SYSTEM_AUDIT_USER): Promise<string> {
  const dest = join(companyBackupsDir(slug), `${backupStamp()}-${tag}.db`)
  await snapshotTo(db, dest)
  // Post-write verification (task Q3 #99): a backup that doesn't pass quick_check is worse than
  // no backup — it silently displaces a good one in the pruning window. Remove it and fail loudly
  // (manual backups surface this as an error toast; scheduled ones log it).
  if (!quickCheckOk(dest)) {
    rmSync(dest, { force: true })
    throw new Error('Backup verification failed (quick_check) — the snapshot was discarded')
  }
  pruneBackupsIn(companyBackupsDir(slug), MAX_BACKUPS)
  // WP 3.8: every backup is in the trail — it is a full copy of the books AND of this audit log
  // (written after the copy, so the row itself lives only in the live file). Automatic backups
  // (open, every 30 min, pre-import, quit) are 'system'; a manual one names the user.
  writeAudit(db, 'backup', 0, 'backup', null, { tag, file: basename(dest) }, { user: auditUser })
  return dest
}
