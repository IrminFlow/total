// The migration runner (WP 2.5a): the `-- @foreign-keys-off` marker runs a migration with FK
// enforcement off OUTSIDE its transaction, checks foreign_key_check before committing, and turns
// enforcement back on whatever happened. Unmarked migrations behave exactly as before.
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import type { DB } from './connection'
import { FOREIGN_KEYS_OFF_MARKER, migrate, schemaVersion } from './migrate'

const BASE = [
  `CREATE TABLE parent (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL CHECK (name <> ''));
   CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id));`,
  `INSERT INTO parent (name) VALUES ('a'), ('b');
   INSERT INTO child (id, parent_id) VALUES (1, 1), (2, 2);`
]

/** The 12-step rebuild of `parent` (drops the CHECK), optionally broken between DROP and RENAME. */
const rebuild = (opts: { marker?: boolean; failAfterDrop?: boolean; dangling?: boolean } = {}): string => `${opts.marker === false ? '' : FOREIGN_KEYS_OFF_MARKER}
  CREATE TABLE parent_new (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
  INSERT INTO parent_new (id, name) SELECT id, name FROM parent ${opts.dangling ? 'WHERE id = 1' : ''};
  DROP TABLE parent;
  ${opts.failAfterDrop ? 'INSERT INTO no_such_table VALUES (1);' : ''}
  ALTER TABLE parent_new RENAME TO parent;`

function db(): DB {
  const d = new Database(':memory:')
  d.pragma('foreign_keys = ON')
  migrate(d, BASE)
  return d
}

const fkOn = (d: DB): number => d.pragma('foreign_keys', { simple: true }) as number
const parentSql = (d: DB): string => (d.prepare("SELECT sql FROM sqlite_master WHERE name = 'parent'").get() as { sql: string }).sql

describe('migrate — unmarked migrations (unchanged behaviour)', () => {
  it('applies in order, one transaction each, and records the version', () => {
    const d = db()
    expect(schemaVersion(d)).toBe(2)
    expect(d.prepare('SELECT COUNT(*) AS n FROM child').get()).toEqual({ n: 2 })
    migrate(d, BASE) // idempotent
    expect(schemaVersion(d)).toBe(2)
  })

  it('a failing migration rolls back alone; earlier ones stay; the version stops before it', () => {
    const d = db()
    expect(() => migrate(d, [...BASE, "INSERT INTO parent (name) VALUES ('c'); INSERT INTO parent (name) VALUES ('');"])).toThrow(/CHECK/)
    expect(schemaVersion(d)).toBe(2)
    expect(d.prepare('SELECT COUNT(*) AS n FROM parent').get()).toEqual({ n: 2 })
  })

  it('an unmarked DROP of a referenced parent fails under FK enforcement, exactly as before', () => {
    const d = db()
    expect(() => migrate(d, [...BASE, rebuild({ marker: false })])).toThrow(/FOREIGN KEY/)
    expect(schemaVersion(d)).toBe(2)
    expect(parentSql(d)).toContain('CHECK')
    expect(fkOn(d)).toBe(1)
  })
})

describe('migrate — the -- @foreign-keys-off marker', () => {
  it('runs a table rebuild with FKs off, keeps ids and references, and turns FKs back on', () => {
    const d = db()
    migrate(d, [...BASE, rebuild()])
    expect(schemaVersion(d)).toBe(3)
    expect(parentSql(d)).not.toContain('CHECK')
    expect(d.prepare('SELECT id, name FROM parent ORDER BY id').all()).toEqual([{ id: 1, name: 'a' }, { id: 2, name: 'b' }])
    expect(fkOn(d)).toBe(1)
    expect(d.pragma('foreign_key_check')).toEqual([])
    // References still enforced against the rebuilt table.
    expect(() => d.prepare('INSERT INTO child (id, parent_id) VALUES (3, 99)').run()).toThrow(/FOREIGN KEY/)
  })

  it('a marked migration that leaves a dangling FK is rolled back (foreign_key_check)', () => {
    const d = db()
    expect(() => migrate(d, [...BASE, rebuild({ dangling: true })])).toThrow(/migration 3: foreign_key_check failed \(1 violation\)/)
    expect(schemaVersion(d)).toBe(2)
    expect(parentSql(d)).toContain('CHECK')
    expect(d.prepare('SELECT COUNT(*) AS n FROM parent').get()).toEqual({ n: 2 })
    expect(d.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'parent_new'").get()).toEqual({ n: 0 })
    expect(fkOn(d)).toBe(1)
  })

  it('a failure between DROP and RENAME rolls back to the old schema with FKs back on', () => {
    const d = db()
    expect(() => migrate(d, [...BASE, rebuild({ failAfterDrop: true })])).toThrow(/no such table/)
    expect(schemaVersion(d)).toBe(2)
    expect(parentSql(d)).toContain('CHECK')
    expect(d.prepare('SELECT id FROM parent ORDER BY id').all()).toEqual([{ id: 1 }, { id: 2 }])
    expect(fkOn(d)).toBe(1)
    // The next open retries and succeeds.
    migrate(d, [...BASE, rebuild()])
    expect(schemaVersion(d)).toBe(3)
  })

  it('refuses to run under legacy_alter_table', () => {
    const d = db()
    d.pragma('legacy_alter_table = ON')
    expect(() => migrate(d, [...BASE, rebuild()])).toThrow(/legacy_alter_table/)
    expect(schemaVersion(d)).toBe(2)
    expect(fkOn(d)).toBe(1)
  })

  it('leaves FKs off when the connection had them off', () => {
    const d = new Database(':memory:')
    d.pragma('foreign_keys = OFF') // better-sqlite3 defaults it on
    migrate(d, [...BASE, rebuild()])
    expect(fkOn(d)).toBe(0)
    expect(schemaVersion(d)).toBe(3)
  })

  it('the marker may follow leading whitespace (template-literal migrations)', () => {
    const d = db()
    migrate(d, [...BASE, `\n    ${rebuild()}`])
    expect(parentSql(d)).not.toContain('CHECK')
  })
})
