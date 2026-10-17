import type Database from 'better-sqlite3-multiple-ciphers'
import { keyOfHandle, openDb } from './encryption'
import { rmSync } from 'fs'
import { basename, join } from 'path'
import { companyAttachmentsDir, companyBackupAttachmentsDir, companyBackupsDir, companyDbPath, ensureCompanyTree } from '../paths'
import { assertNotNewer, migrate, schemaVersion } from './migrate'
import { MIGRATIONS } from './migrations'
import { prunePreUpgradeCopies, writePreUpgradeCopy } from './preUpgrade'
import { log } from '../log'
import { backupStamp, pruneBackupsIn, snapshotTo } from './backup'
import { MMAP_SIZE, quickCheckOkAsync } from './checkHost'
import { testSynchronous } from './testPragmas'
import { SYSTEM_AUDIT_USER, writeAudit } from '../services/audit'
import { pruneBackupAttachmentStore, stashSnapshotAttachments, type StashResult } from './attachmentBackup'

export type DB = Database.Database

export { migrate }

// WP 7.3: the test-only synchronous pragma (vitest workers with a scratch data dir only).
export { testSynchronous }

export interface OpenCompanyOptions {
  /** Write the pre-upgrade copy before migrating an existing file (default true). The restore
   *  path passes false: the file it reopens IS a backup, still in the backups folder. */
  preUpgradeCopy?: boolean
}

export function openCompanyDb(slug: string, opts: OpenCompanyOptions = {}): DB {
  ensureCompanyTree(slug)
  // WP 7.2: an encrypted company opens with the key unlocked for its folder (db_locked otherwise).
  const db = openDb(companyDbPath(slug))
  // Upgrade guard: a file from a NEWER Total is refused before anything (even the journal mode)
  // is written to it — db_newer_version. Protects files from 1.0 on (0.11.0 cannot be changed).
  let fileVersion: number
  try {
    fileVersion = assertNotNewer(db)
  } catch (err) {
    db.close()
    throw err
  }
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
  // WP 7.3: test runs only (a scratch TOTAL_DATA_DIR is required) may trade crash durability for
  // speed — see testSynchronous(). Real books always keep the build default (NORMAL in WAL mode).
  const sync = testSynchronous(process.env)
  if (sync) db.pragma(`synchronous = ${sync}`)
  try {
    const before = schemaVersion(db)
    // Safe copy before an upgrade: an EXISTING file about to be migrated is copied first (a new
    // file — version 0 — or a current one takes none); no copy, no migration.
    const upgrading = fileVersion > 0 && fileVersion < MIGRATIONS.length
    if (upgrading && opts.preUpgradeCopy !== false) writePreUpgradeCopy(db, companyBackupsDir(slug), fileVersion, MIGRATIONS.length, { log })
    migrate(db)
    if (upgrading) prunePreUpgradeCopies(companyBackupsDir(slug), undefined, log)
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

/** meta key: the names of open backups still waiting for their quick_check verdict (JSON array;
 *  services/backupOpen.ts writes it). */
export const OPEN_BACKUP_UNVERIFIED_KEY = 'backup.openUnverified'

export function unverifiedOpenBackups(db: DB): string[] {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(OPEN_BACKUP_UNVERIFIED_KEY) as { value: string } | undefined
  if (!row) return []
  try {
    const v = JSON.parse(row.value) as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** Where a backup tagged `tag` taken now goes. */
export const backupDestFor = (slug: string, tag: string): string => join(companyBackupsDir(slug), `${backupStamp()}-${tag}.db`)

/**
 * WAL-safe snapshot of an already-open company DB into backups/, tagged (e.g. 'open', 'manual',
 * 'auto', 'pre-tally-import', 'pre-restore', 'quit'). Uses better-sqlite3's native online backup
 * so uncheckpointed WAL content is always captured — a raw file copy would not see it.
 */
export async function backupCompany(db: DB, slug: string, tag = 'auto', auditUser: string = SYSTEM_AUDIT_USER): Promise<string> {
  const dest = backupDestFor(slug, tag)
  await snapshotTo(db, dest)
  // Post-write verification (task Q3 #99): a backup that doesn't pass quick_check is worse than
  // no backup — it silently displaces a good one in the pruning window. Remove it and fail loudly
  // (manual backups surface this as an error toast; scheduled ones log it).
  // WP 7.1: the same quick_check, run in a worker thread (db/checkHost.ts) so main stays free.
  if (!(await quickCheckOkAsync(dest, keyOfHandle(db)))) {
    rmSync(dest, { force: true })
    throw new Error('Backup verification failed (quick_check) — the snapshot was discarded')
  }
  stashAndAuditBackup(db, slug, dest, tag, auditUser, { beforeAudit: () => pruneCompanyBackups(slug, db) })
  return dest
}

/** The rest of a backup once its snapshot is written: the snapshot's attachments copied into
 *  backups/attachments/ (shared by every snapshot) and the audit row. A failure copying the
 *  attachments (disk full, a read-only folder) never loses the backup or its audit row: it is
 *  recorded on the row instead, like the quit backup does. `beforeAudit` runs between the two
 *  (backupCompany prunes there, as it always did). WP 3.8: every backup is in the trail — it is a
 *  full copy of the books AND of this audit log (written after the copy, so the row itself lives
 *  only in the live file). Automatic backups (open, every 30 min, pre-import, quit) are 'system';
 *  a manual one names the user. */
export function stashAndAuditBackup(db: DB, slug: string, dest: string, tag: string, auditUser: string = SYSTEM_AUDIT_USER, opts: { beforeAudit?: () => void } = {}): void {
  let stash: StashResult = { copied: 0, missing: [] }
  let attachmentsError: string | null = null
  try {
    stash = stashBackupAttachments(slug, dest)
  } catch (err) {
    attachmentsError = err instanceof Error ? err.message : String(err)
  }
  opts.beforeAudit?.()
  writeAudit(db, 'backup', 0, 'backup', null, {
    tag, file: basename(dest), ...(stash.copied || stash.missing.length ? { attachmentsCopied: stash.copied, attachmentsMissing: stash.missing.length } : {}),
    ...(attachmentsError ? { attachmentsError } : {})
  }, { user: auditUser })
}

/** Keep the newest MAX_BACKUPS (only automatic ones are ever removed), and drop the attachment
 *  copies no remaining backup needs. Run only after a backup that just passed its quick_check —
 *  a copy that did not (or has not yet) must never push a good one out of the window. */
export function pruneCompanyBackups(slug: string, db?: DB): void {
  // PR #175 review: open backups still waiting for their verdict do not take a slot.
  pruneBackupsIn(companyBackupsDir(slug), MAX_BACKUPS, new Set(db ? unverifiedOpenBackups(db) : []))
  try {
    pruneBackupAttachmentStore(companyBackupsDir(slug), companyBackupAttachmentsDir(slug))
  } catch {
    // pruning is housekeeping; the next backup tries again
  }
}

/** WP 6.4: copy the attachments a snapshot in backups/ references into backups/attachments/. */
export function stashBackupAttachments(slug: string, snapshotPath: string): StashResult {
  return stashSnapshotAttachments(snapshotPath, companyAttachmentsDir(slug), companyBackupAttachmentsDir(slug))
}
