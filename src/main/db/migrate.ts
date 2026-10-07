import type { DB } from './connection'
import { MIGRATIONS } from './migrations'

/**
 * A migration whose SQL STARTS with this marker runs with foreign-key enforcement off — the
 * SQLite 12-step table-rebuild procedure (https://sqlite.org/lang_altertable.html#otheralter):
 * `PRAGMA foreign_keys` is a silent no-op inside a transaction, so the runner turns it off
 * BEFORE opening the migration's transaction, runs `PRAGMA foreign_key_check` before committing
 * (any orphan aborts the migration — it rolls back and throws), and turns enforcement back on
 * afterwards whatever happened. Unmarked migrations run exactly as before.
 */
export const FOREIGN_KEYS_OFF_MARKER = '-- @foreign-keys-off'

/** The schema version: the highest applied migration number (0 = none). */
export function schemaVersion(db: DB): number {
  db.exec('CREATE TABLE IF NOT EXISTS migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')
  const row = db.prepare('SELECT MAX(id) AS max FROM migrations').get() as { max: number | null }
  return row.max ?? 0
}

/** Apply any not-yet-applied numbered migrations, in order, inside a transaction each. Idempotent.
 *  `migrations` is injectable for the runner's own tests; the app always uses MIGRATIONS. */
export function migrate(db: DB, migrations: readonly string[] = MIGRATIONS): void {
  const applied = schemaVersion(db)
  for (let i = applied; i < migrations.length; i++) {
    const sql = migrations[i]!
    const fkOff = sql.trimStart().startsWith(FOREIGN_KEYS_OFF_MARKER)
    if (fkOff) {
      // A rebuild under legacy ALTER semantics would leave references pointing at the old name.
      const legacy = db.pragma('legacy_alter_table', { simple: true }) as number
      if (legacy !== 0) throw new Error(`migration ${i + 1}: PRAGMA legacy_alter_table must be 0`)
    }
    const fkWasOn = fkOff && (db.pragma('foreign_keys', { simple: true }) as number) === 1
    if (fkOff) db.pragma('foreign_keys = OFF') // outside the transaction, where it takes effect
    try {
      db.transaction(() => {
        db.exec(sql)
        if (fkOff) {
          const bad = db.pragma('foreign_key_check') as unknown[]
          if (bad.length > 0) {
            throw new Error(`migration ${i + 1}: foreign_key_check failed (${bad.length} violation${bad.length === 1 ? '' : 's'})`)
          }
        }
        db.prepare('INSERT INTO migrations (id, applied_at) VALUES (?, ?)').run(i + 1, new Date().toISOString())
      })()
    } finally {
      if (fkWasOn) db.pragma('foreign_keys = ON')
    }
  }
}
