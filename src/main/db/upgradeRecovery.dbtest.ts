import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { migrate } from './migrate'
import { runMigrationsWithRecovery } from './connection'

function fixture(): { db: Database.Database; dbPath: string; backupsDir: string; priorVersion: number } {
  const dir = mkdtempSync(join(tmpdir(), 'total-upgrade-'))
  const dbPath = join(dir, 'company.db')
  const backupsDir = join(dir, 'backups')
  mkdirSync(backupsDir)
  const db = new Database(dbPath)
  migrate(db)
  db.prepare("INSERT INTO meta (key, value) VALUES ('upgrade.fixture', 'before')").run()
  const priorVersion = (db.prepare('SELECT MAX(id) AS version FROM migrations').get() as { version: number }).version - 1
  db.prepare('DELETE FROM migrations WHERE id > ?').run(priorVersion)
  return { db, dbPath, backupsDir, priorVersion }
}

describe('migration recovery', () => {
  it('takes a verified snapshot and restores it when a later migration step fails', () => {
    const { db, dbPath, backupsDir, priorVersion } = fixture()
    expect(() => runMigrationsWithRecovery(db, dbPath, backupsDir, (database) => {
      database.prepare("UPDATE meta SET value = 'partially-mutated' WHERE key = 'upgrade.fixture'").run()
      throw new Error('forced migration failure')
    }, priorVersion + 1)).toThrow(/restored from its pre-upgrade snapshot/)
    expect(db.open).toBe(false)

    const restored = new Database(dbPath, { readonly: true })
    expect(restored.prepare("SELECT value FROM meta WHERE key = 'upgrade.fixture'").get()).toMatchObject({ value: 'before' })
    expect((restored.prepare('SELECT MAX(id) AS version FROM migrations').get() as { version: number }).version).toBe(priorVersion)
    restored.close()
    expect(readdirSync(backupsDir).some((file) => file.includes('pre-upgrade'))).toBe(true)
  })

  it('does not snapshot a database already at the requested schema version', () => {
    const { db, dbPath, backupsDir, priorVersion } = fixture()
    const result = runMigrationsWithRecovery(db, dbPath, backupsDir, () => {}, priorVersion)
    expect(result).toBeNull()
    db.close()
  })
})
