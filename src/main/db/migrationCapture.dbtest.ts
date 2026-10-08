// The capture migration (WP 5.4, 045): ai_drafts.source gains 'capture' next to WP 5.5's 'assistant' (rebuilt for the CHECK,
// every existing draft kept as it was) and the capture_items queue appears. Appended LAST — its
// number is its position (re-placed when main gains migrations first).
import { describe, expect, it } from 'vitest'
import { MIGRATIONS } from './migrations'
import { migrate, schemaVersion } from './migrate'
import { freshPartialDb, TEST_INFO, postSimpleVoucher } from './testdb'
import { seedCompany } from './seed'
import { trialBalance } from '../services/reports'

const M_CAPTURE = MIGRATIONS.findIndex((sql) => sql.includes('CREATE TABLE capture_items'))

describe('capture migration — capture_items and the capture draft source', () => {
  it('is the last migration and a table rebuild (foreign keys off)', () => {
    expect(M_CAPTURE).toBe(MIGRATIONS.length - 1)
    expect(MIGRATIONS[M_CAPTURE]!.startsWith('-- @foreign-keys-off')).toBe(true)
  })

  it('upgrades a company with its books, drafts and MCP log links unchanged', () => {
    const db = freshPartialDb(M_CAPTURE)
    seedCompany(db, TEST_INFO)
    postSimpleVoucher(db, { date: '2025-05-01', amount: 123456, kind: 'receipt' })
    const d = Number(
      db.prepare("INSERT INTO ai_drafts (kind, summary, payload_json, status, unrequested, source, origin) VALUES ('voucher', 's', '{}', 'superseded', 1, 'inbox', 'drop.json')").run().lastInsertRowid
    )
    db.prepare("INSERT INTO mcp_log (session_id, role, method, ok, masked, pseudonymised, draft_id) VALUES ('s', 'viewer', 'tools/call', 1, 1, 0, ?)").run(d)
    const before = trialBalance(db, '2026-03-31')
    migrate(db)
    expect(schemaVersion(db)).toBe(MIGRATIONS.length)
    expect(trialBalance(db, '2026-03-31')).toEqual(before)
    expect(db.prepare('SELECT id, status, unrequested, source, origin FROM ai_drafts').get()).toEqual({ id: d, status: 'superseded', unrequested: 1, source: 'inbox', origin: 'drop.json' })
    db.prepare("INSERT INTO ai_drafts (kind, summary, payload_json, source) VALUES ('voucher', 'bill', '{}', 'capture')").run()
    db.prepare("INSERT INTO ai_drafts (kind, summary, payload_json, source) VALUES ('voucher', '2b', '{}', 'assistant')").run()
    expect(() => db.prepare("INSERT INTO ai_drafts (kind, summary, payload_json, source) VALUES ('voucher', 's', '{}', 'email')").run()).toThrow(/CHECK/)
    // mcp_log still points at the rebuilt table.
    db.pragma('foreign_keys = ON')
    expect(db.pragma('foreign_key_check')).toEqual([])
    db.prepare('DELETE FROM ai_drafts WHERE id = ?').run(d)
    expect(db.prepare('SELECT draft_id FROM mcp_log').get()).toEqual({ draft_id: null })
    expect(() =>
      db.prepare("INSERT INTO capture_items (file_name, mime, size, sha256, stored_path, origin, status) VALUES ('a.pdf', 'application/pdf', 1, 'x', 'p', 'picker', 'sent')").run()
    ).toThrow(/CHECK/)
    const id = db.prepare("INSERT INTO capture_items (file_name, mime, size, sha256, stored_path, origin) VALUES ('a.pdf', 'application/pdf', 1, 'x', 'p', 'folder')").run().lastInsertRowid
    expect(db.prepare('SELECT status, pages, attempts FROM capture_items WHERE id = ?').get(id)).toEqual({ status: 'queued', pages: 1, attempts: 0 })
  })
})
