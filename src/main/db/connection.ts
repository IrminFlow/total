import Database from 'better-sqlite3'
import { join } from 'path'
import { companyBackupsDir, companyDbPath, ensureCompanyTree } from '../paths'
import { migrate } from './migrate'
import { backupStamp, pruneBackupsIn, snapshotTo } from './backup'

export type DB = Database.Database

export { migrate }

export function openCompanyDb(slug: string): DB {
  ensureCompanyTree(slug)
  const db = new Database(companyDbPath(slug))
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
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
  pruneBackupsIn(companyBackupsDir(slug), MAX_BACKUPS)
  return dest
}
