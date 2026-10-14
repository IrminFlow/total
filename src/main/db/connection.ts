import Database from 'better-sqlite3'
import { rmSync } from 'fs'
import { basename, join } from 'path'
import { companyAttachmentsDir, companyBackupAttachmentsDir, companyBackupsDir, companyDbPath, ensureCompanyTree } from '../paths'
import { migrate, schemaVersion } from './migrate'
import { backupStamp, pruneBackupsIn, snapshotTo } from './backup'
import { MMAP_SIZE, quickCheckOkAsync } from './checkHost'
import { SYSTEM_AUDIT_USER, writeAudit } from '../services/audit'
import { pruneBackupAttachmentStore, stashSnapshotAttachments, type StashResult } from './attachmentBackup'

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
  // WP 7.1: the map covers the whole file up to SQLite's 2 GB ceiling (was 256 MB). A 100k-voucher
  // company is ~290 MB and a 500k one ~1.4 GB; pages past the map are read one pread at a time
  // into the 64 MB cache, which made a quick_check of the 500k file 28 s instead of ~1–3 s. The map
  // only reserves address space — the pages are the OS file cache, shared, not extra memory.
  db.pragma('cache_size = -64000')
  db.pragma(`mmap_size = ${MMAP_SIZE}`)
  try {
    const before = schemaVersion(db)
    migrate(db)
    // WP 7.1: a full ANALYZE reads every index (~0.5 s at 100k vouchers, seconds at 500k) — run
    // it when a migration just ran or there are no statistics yet; otherwise `PRAGMA optimize`
    // (SQLite's recommended on-open call) re-analyzes only tables whose statistics went stale.
    if (schemaVersion(db) !== before || !hasPlannerStats(db)) db.exec('ANALYZE')
    else db.pragma('optimize = 0x10002')
  } catch (err) {
    // Never leak an open handle on a failed open — on Windows it would also block any
    // later restore/rollback rename of this file (EPERM on open files).
    db.close()
    throw err
  }
  return db
}

/** True when ANALYZE has recorded statistics (sqlite_stat1 exists and holds rows). */
function hasPlannerStats(db: DB): boolean {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'").get()) return false
  return !!db.prepare('SELECT 1 FROM sqlite_stat1 LIMIT 1').get()
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
  // WP 7.1: the same quick_check, run in a worker thread (db/checkHost.ts) so main stays free.
  if (!(await quickCheckOkAsync(dest))) {
    rmSync(dest, { force: true })
    throw new Error('Backup verification failed (quick_check) — the snapshot was discarded')
  }
  // WP 6.4: the snapshot's attachments get a copy in backups/attachments/ (shared by every
  // snapshot), and copies no remaining backup needs go with the pruned ones.
  // A failure there (disk full, a read-only folder) never loses the backup or its audit row: it is
  // recorded on the row instead, like the quit backup does.
  let stash: StashResult = { copied: 0, missing: [] }
  let attachmentsError: string | null = null
  try {
    stash = stashBackupAttachments(slug, dest)
  } catch (err) {
    attachmentsError = err instanceof Error ? err.message : String(err)
  }
  pruneBackupsIn(companyBackupsDir(slug), MAX_BACKUPS)
  try {
    pruneBackupAttachmentStore(companyBackupsDir(slug), companyBackupAttachmentsDir(slug))
  } catch {
    // pruning is housekeeping; the next backup tries again
  }
  // WP 3.8: every backup is in the trail — it is a full copy of the books AND of this audit log
  // (written after the copy, so the row itself lives only in the live file). Automatic backups
  // (open, every 30 min, pre-import, quit) are 'system'; a manual one names the user.
  writeAudit(db, 'backup', 0, 'backup', null, {
    tag, file: basename(dest), ...(stash.copied || stash.missing.length ? { attachmentsCopied: stash.copied, attachmentsMissing: stash.missing.length } : {}),
    ...(attachmentsError ? { attachmentsError } : {})
  }, { user: auditUser })
  return dest
}

/** WP 6.4: copy the attachments a snapshot in backups/ references into backups/attachments/. */
export function stashBackupAttachments(slug: string, snapshotPath: string): StashResult {
  return stashSnapshotAttachments(snapshotPath, companyAttachmentsDir(slug), companyBackupAttachmentsDir(slug))
}
