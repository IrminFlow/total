import Database from 'better-sqlite3'
import { copyFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { companyBackupsDir, companyDbPath, ensureCompanyTree } from '../paths'
import { migrate } from './migrate'

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

/** Snapshot the company DB into backups/ (called on open, before risky operations, and manually). */
export function backupCompany(slug: string, tag = 'auto'): string | null {
  const src = companyDbPath(slug)
  if (!existsSync(src)) return null
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const dest = join(companyBackupsDir(slug), `${stamp}-${tag}.db`)
  copyFileSync(src, dest)
  pruneBackups(slug)
  return dest
}

function pruneBackups(slug: string): void {
  const dir = companyBackupsDir(slug)
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.db'))
    .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  for (const { f } of files.slice(MAX_BACKUPS)) {
    unlinkSync(join(dir, f))
  }
}
