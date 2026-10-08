// The MCP migration (WP 5.7): ai_drafts gains source / origin and the mcp_log table appears. It
// is appended LAST (its number is its position — re-placed when main gains migrations first); an
// existing company upgrades with its books and its existing drafts unchanged (they read 'chat').
import { describe, expect, it } from 'vitest'
import { MIGRATIONS } from './migrations'
import { migrate, schemaVersion } from './migrate'
import { freshPartialDb, TEST_INFO, postSimpleVoucher } from './testdb'
import { seedCompany } from './seed'
import { trialBalance } from '../services/reports'

const M_MCP = MIGRATIONS.findIndex((sql) => sql.includes('CREATE TABLE mcp_log'))

describe('MCP migration — draft source and mcp_log', () => {
  it('is the last migration', () => {
    expect(M_MCP).toBe(MIGRATIONS.length - 1)
    expect(MIGRATIONS.findIndex((sql) => sql.includes('CREATE TABLE ai_drafts'))).toBeLessThan(M_MCP)
  })

  it('upgrades a company with its books unchanged; existing drafts become source chat', () => {
    const db = freshPartialDb(M_MCP)
    seedCompany(db, TEST_INFO)
    postSimpleVoucher(db, { date: '2025-05-01', amount: 123456, kind: 'receipt' })
    db.prepare("INSERT INTO ai_drafts (kind, summary, payload_json) VALUES ('voucher', 's', '{}')").run()
    const before = trialBalance(db, '2026-03-31')
    migrate(db)
    expect(schemaVersion(db)).toBe(MIGRATIONS.length)
    expect(trialBalance(db, '2026-03-31')).toEqual(before)
    expect(db.prepare('SELECT source, origin FROM ai_drafts').get()).toEqual({ source: 'chat', origin: null })
    expect((db.prepare('SELECT COUNT(*) AS n FROM mcp_log').get() as { n: number }).n).toBe(0)
    expect(() => db.prepare("INSERT INTO ai_drafts (kind, summary, payload_json, source) VALUES ('voucher', 's', '{}', 'email')").run()).toThrow(/CHECK/)
    expect(() =>
      db.prepare("INSERT INTO mcp_log (session_id, role, method, ok, masked, pseudonymised) VALUES ('s', 'admin', 'tools/list', 1, 1, 0)").run()
    ).toThrow(/CHECK/)
    expect(db.pragma('foreign_key_check')).toEqual([])
  })
})
