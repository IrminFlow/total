import type { DB } from './connection'
import { MIGRATIONS } from './migrations'
import { backfillAuditChain } from './auditHash'

/** Apply any not-yet-applied numbered migrations, in order, inside a transaction each. Idempotent. */
export function migrate(db: DB): void {
  db.exec('CREATE TABLE IF NOT EXISTS migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')
  const appliedRow = db.prepare('SELECT MAX(id) AS max FROM migrations').get() as { max: number | null }
  const applied = appliedRow.max ?? 0
  for (let i = applied; i < MIGRATIONS.length; i++) {
    const sql = MIGRATIONS[i]!
    const run = db.transaction(() => {
      db.exec(sql)
      if (i + 1 === 19) backfillAuditChain(db)
      db.prepare('INSERT INTO migrations (id, applied_at) VALUES (?, ?)').run(i + 1, new Date().toISOString())
    })
    run()
  }
}
