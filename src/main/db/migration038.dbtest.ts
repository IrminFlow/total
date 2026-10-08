// Migration 038 (WP 6.3): import_templates, import_batches, import_batch_items. Located by
// content, never by index (032–037 landed first; this one is last).
import { describe, expect, it } from 'vitest'
import { MIGRATIONS } from './migrations'
import { freshDb, freshPartialDb, seededDb } from './testdb'
import { migrate } from './migrate'

const M038 = MIGRATIONS.findIndex((sql) => sql.includes('CREATE TABLE import_batches'))

const columns = (db: ReturnType<typeof freshDb>, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)

describe('migration 038 — import wizard tables', () => {
  it('exists, once, last, after the report builder (037)', () => {
    expect(M038).toBeGreaterThan(MIGRATIONS.findIndex((sql) => sql.includes('CREATE TABLE report_packs')))
    expect(M038).toBe(MIGRATIONS.length - 1)
    expect(MIGRATIONS.filter((sql) => sql.includes('CREATE TABLE import_batches'))).toHaveLength(1)
  })

  it('creates the three tables with their columns', () => {
    const db = freshDb()
    expect(columns(db, 'import_templates')).toEqual([
      'id', 'name', 'profile_id', 'target', 'header_signature', 'mapping_json', 'options_json', 'created_at', 'updated_at', 'last_used_at'
    ])
    expect(columns(db, 'import_batches')).toEqual([
      'id', 'source', 'profile_id', 'file_name', 'status', 'options_json', 'summary_json', 'error_count', 'created_at', 'created_by', 'undone_at', 'undo_summary_json', 'last_audit_id'
    ])
    expect(columns(db, 'import_batch_items')).toEqual(['id', 'batch_id', 'entity', 'entity_id', 'action', 'before_json', 'source_line', 'source_key', 'undone_at'])
  })

  it('enforces its checks and keys', () => {
    const db = seededDb()
    const b = Number(db.prepare("INSERT INTO import_batches (source) VALUES ('generic')").run().lastInsertRowid)
    expect(() => db.prepare("UPDATE import_batches SET status = 'gone' WHERE id = ?").run(b)).toThrow(/CHECK/)
    expect(() => db.prepare("INSERT INTO import_batch_items (batch_id, entity, entity_id, action) VALUES (?, 'ledger', 1, 'delete')").run(b)).toThrow(/CHECK/)
    expect(() => db.prepare("INSERT INTO import_batch_items (batch_id, entity, entity_id, action) VALUES (999, 'ledger', 1, 'create')").run()).toThrow(/FOREIGN KEY/)
    db.prepare("INSERT INTO import_templates (name, profile_id, target, mapping_json) VALUES ('Mine', 'generic:ledgers', 'ledgers', '{}')").run()
    expect(() => db.prepare("INSERT INTO import_templates (name, profile_id, target, mapping_json) VALUES ('Mine', 'generic:ledgers', 'ledgers', '{}')").run()).toThrow(/UNIQUE/)
    // The same name under another profile is fine.
    db.prepare("INSERT INTO import_templates (name, profile_id, target, mapping_json) VALUES ('Mine', 'zoho:items', 'items', '{}')").run()
  })

  it('applies on top of a company migrated up to the migration before it, data untouched', () => {
    const db = freshPartialDb(M038)
    db.prepare("INSERT INTO meta (key, value) VALUES ('probe', 'kept')").run()
    migrate(db)
    expect(db.prepare("SELECT value FROM meta WHERE key = 'probe'").get()).toEqual({ value: 'kept' })
    expect(db.prepare('SELECT COUNT(*) AS n FROM import_batches').get()).toEqual({ n: 0 })
  })
})
