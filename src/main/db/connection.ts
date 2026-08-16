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
  migrate(db)
  db.exec('ANALYZE')
  return db
}

/** Close a company DB, first letting SQLite fold fresh ANALYZE-style stats into the schema
 *  (`PRAGMA optimize` is the documented cheap pre-close hook). Failures never block the close. */
export function closeCompanyDb(db: DB): void {
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
  pruneBackupsIn(companyBackupsDir(slug), MAX_BACKUPS)
  return dest
}
