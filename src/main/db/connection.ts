import Database from 'better-sqlite3'
import { copyFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { MIGRATIONS } from './migrations'
import { companyBackupsDir, companyDbPath, ensureCompanyTree } from '../paths'

export type DB = Database.Database

export function openCompanyDb(slug: string): DB {
  ensureCompanyTree(slug)
  const db = new Database(companyDbPath(slug))
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}

function migrate(db: DB): void {
  db.exec('CREATE TABLE IF NOT EXISTS migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')
  const appliedRow = db.prepare('SELECT MAX(id) AS max FROM migrations').get() as { max: number | null }
  const applied = appliedRow.max ?? 0
  for (let i = applied; i < MIGRATIONS.length; i++) {
    const sql = MIGRATIONS[i]!
    const run = db.transaction(() => {
      db.exec(sql)
      db.prepare('INSERT INTO migrations (id, applied_at) VALUES (?, ?)').run(i + 1, new Date().toISOString())
    })
    run()
  }
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
