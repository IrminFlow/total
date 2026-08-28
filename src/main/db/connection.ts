import Database from 'better-sqlite3'
import { rmSync } from 'fs'
import { join } from 'path'
import { companyBackupsDir, companyDbPath, ensureCompanyTree, existingCompanyPaths } from '../paths'
import { migrate } from './migrate'
import { backupFileName, backupStamp, quickCheckOk, rollbackRestore, snapshotSync, snapshotTo } from './backup'
import { MIGRATIONS } from './migrations'

export type DB = Database.Database

export { migrate }

function appliedMigrationVersion(db: DB): number {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'migrations'").get()
  if (!table) return 0
  return (db.prepare('SELECT MAX(id) AS version FROM migrations').get() as { version: number | null }).version ?? 0
}

/** Migrate an existing database behind a verified pre-upgrade snapshot. Any thrown migration or
 *  failed quick_check closes the mutated handle and atomically restores the exact old file. */
export function runMigrationsWithRecovery(
  db: DB,
  dbPath: string,
  backupsDir: string,
  migrateFn: (database: DB) => void = migrate,
  targetVersion = MIGRATIONS.length
): string | null {
  const hasSchema = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' LIMIT 1").get()
  const applied = appliedMigrationVersion(db)
  if (!hasSchema || applied >= targetVersion) {
    migrateFn(db)
    return null
  }

  // backupStamp is second-granular. Include an epoch suffix so a crash/retry in the same
  // second cannot collide with the first recovery point and prevent the retry from opening.
  const snapshotPath = join(backupsDir, `${backupStamp()}-${Date.now()}-pre-upgrade-v${applied}-to-v${targetVersion}.db`)
  snapshotSync(db, snapshotPath)
  if (!quickCheckOk(snapshotPath)) {
    throw new Error('Pre-upgrade backup verification failed — migration was not started')
  }
  try {
    migrateFn(db)
    const check = db.pragma('quick_check') as Array<{ quick_check: string }>
    if (check[0]?.quick_check !== 'ok') throw new Error(`post-migration quick_check: ${check[0]?.quick_check ?? 'no result'}`)
    return snapshotPath
  } catch (error) {
    if (db.open) db.close()
    try {
      rollbackRestore(dbPath, snapshotPath)
    } catch (rollbackError) {
      throw new Error(
        `Migration failed and automatic rollback also failed. Recovery snapshot: ${snapshotPath}. ` +
        `Migration error: ${error instanceof Error ? error.message : String(error)}. ` +
        `Rollback error: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
      )
    }
    throw new Error(`Migration failed; the company was restored from its pre-upgrade snapshot: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function openCompanyDbInternal(slug: string, existingOnly: boolean): DB {
  if (existingOnly) existingCompanyPaths(slug)
  else ensureCompanyTree(slug)
  const db = new Database(companyDbPath(slug), existingOnly ? { fileMustExist: true } : undefined)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  db.pragma('foreign_keys = ON')
  // Perf tuning (v0.3): ~64MB page cache and memory-mapped reads keep the hot report
  // queries off the disk; ANALYZE below refreshes planner stats after any new migration.
  db.pragma('cache_size = -64000')
  db.pragma('mmap_size = 268435456')
  try {
    runMigrationsWithRecovery(db, companyDbPath(slug), companyBackupsDir(slug))
    db.exec('ANALYZE')
  } catch (err) {
    // Never leak an open handle on a failed open — on Windows it would also block any
    // later restore/rollback rename of this file (EPERM on open files).
    if (db.open) db.close()
    throw err
  }
  return db
}

/** Create or open a company during an explicit creation/import flow. Existing-company entry
 * points should use openExistingCompanyDb so a missing DB is never silently recreated. */
export function openCompanyDb(slug: string): DB {
  return openCompanyDbInternal(slug, false)
}

/** Open a pre-existing, already path-validated company without creating directories or files. */
export function openExistingCompanyDb(slug: string): DB {
  return openCompanyDbInternal(slug, true)
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

/**
 * WAL-safe snapshot of an already-open company DB into backups/, tagged (e.g. 'open', 'manual',
 * 'auto', 'pre-tally-import', 'pre-restore', 'quit'). Uses better-sqlite3's native online backup
 * so uncheckpointed WAL content is always captured — a raw file copy would not see it. Rotation
 * is deliberately owned by the resilience service after replication: pruning here would erase
 * historic daily/weekly/monthly restore points before the tiered policy can select them.
 */
export async function backupCompany(db: DB, slug: string, tag = 'auto'): Promise<string> {
  const dest = join(companyBackupsDir(slug), backupFileName(tag))
  await snapshotTo(db, dest)
  // Post-write verification (task Q3 #99): a backup that doesn't pass quick_check is worse than
  // no backup — it silently displaces a good one in the pruning window. Remove it and fail loudly
  // (manual backups surface this as an error toast; scheduled ones log it).
  if (!quickCheckOk(dest)) {
    rmSync(dest, { force: true })
    throw new Error('Backup verification failed (quick_check) — the snapshot was discarded')
  }
  return dest
}
