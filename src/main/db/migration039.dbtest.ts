// Migration 039 (WP 6.4): bulk_batches / bulk_batch_records, attachments, party_notes. Located by
// content and asserted LAST — after 036 AI, 037 report builder and 038 import wizard.
import { describe, expect, it } from 'vitest'
import { MIGRATIONS } from './migrations'
import { seededDb } from './testdb'

const M039 = MIGRATIONS.findIndex((sql) => sql.includes('CREATE TABLE bulk_batches'))
const cols = (db: ReturnType<typeof seededDb>, t: string): string[] => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name)

describe('migration 039 — bulk edit, attachments, party notes', () => {
  it('follows 038 (import wizard); the WP 5.2 chat-panel (040) and WP 6.5 consolidation (041) migrations come after it', () => {
    const m038 = MIGRATIONS.findIndex((sql) => sql.includes('CREATE TABLE import_batches'))
    expect(M039).toBe(m038 + 1)
    expect(M039).toBe(MIGRATIONS.length - 3)
    expect(MIGRATIONS.findIndex((sql) => sql.includes('ALTER TABLE ai_threads ADD COLUMN pinned'))).toBe(MIGRATIONS.findIndex((sql) => sql.includes('CREATE TABLE consolidation_groups')) - 1)
  })

  it('creates the tables with their constraints', () => {
    const db = seededDb()
    expect(cols(db, 'attachments')).toEqual(['id', 'entity', 'entity_id', 'file_name', 'mime', 'size', 'sha256', 'stored_path', 'added_by', 'added_at'])
    expect(cols(db, 'party_notes')).toEqual(['id', 'ledger_id', 'kind', 'text', 'due_date', 'done_at', 'created_by', 'created_at'])
    expect(cols(db, 'bulk_batch_records')).toEqual(expect.arrayContaining(['batch_id', 'entity', 'entity_id', 'status', 'before_json', 'after_audit_id', 'undo_audit_id']))
    const ins = (entity: string, sha: string): unknown =>
      db.prepare("INSERT INTO attachments (entity, entity_id, file_name, mime, size, sha256, stored_path) VALUES (?, 1, 'a.pdf', 'application/pdf', 1, ?, 'x')").run(entity, sha)
    expect(() => ins('company', 'a'.repeat(64))).toThrow(/CHECK/)
    expect(() => ins('voucher', 'short')).toThrow(/CHECK/)
    const cash = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
    expect(() => db.prepare("INSERT INTO party_notes (ledger_id, kind, text, due_date) VALUES (?, 'note', 'x', '2026-01-01')").run(cash)).toThrow(/CHECK/)
    expect(() => db.prepare("INSERT INTO party_notes (ledger_id, kind, text) VALUES (?, 'task', '  ')").run(cash)).toThrow(/CHECK/)
    expect(() => db.prepare("INSERT INTO bulk_batches (target, change_json, summary, status) VALUES ('voucher', '{}', 's', 'gone')").run()).toThrow(/CHECK/)
  })
})
