// Migration 036 (WP 5.1): the AI tables, at their assigned number; 032–035 are no-op placeholders
// held for the Phase 4 branches, and an existing company upgrades without touching its books.
import { describe, expect, it } from 'vitest'
import { MIGRATIONS } from './migrations'
import { schemaVersion } from './migrate'
import { freshPartialDb, TEST_INFO, postSimpleVoucher } from './testdb'
import { seedCompany } from './seed'
import { trialBalance } from '../services/reports'
import { migrate } from './migrate'

const M036 = MIGRATIONS.findIndex((sql) => sql.includes('CREATE TABLE ai_threads'))

describe('migration 036 — AI agent tables', () => {
  it('is migration 036', () => {
    expect(M036 + 1).toBe(36)
  })

  it('032–035 are comment-only placeholders until their branches merge', () => {
    for (const i of [31, 32, 33, 34]) {
      const sql = MIGRATIONS[i]!
      if (/reserved/.test(sql)) expect(sql.replace(/--[^\n]*/g, '').trim()).toBe('')
    }
  })

  it('upgrades a company from 031 with its books unchanged, and the AI tables empty', () => {
    const db = freshPartialDb(31)
    seedCompany(db, TEST_INFO)
    postSimpleVoucher(db, { date: '2025-05-01', amount: 123456, kind: 'receipt' })
    const before = trialBalance(db, '2026-03-31')
    migrate(db)
    expect(schemaVersion(db)).toBe(MIGRATIONS.length)
    expect(trialBalance(db, '2026-03-31')).toEqual(before)
    for (const t of ['ai_threads', 'ai_messages', 'ai_drafts', 'ai_memory', 'ai_usage', 'ai_outbound_log', 'ai_pseudonyms']) {
      expect((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n, t).toBe(0)
    }
    expect(db.pragma('foreign_key_check')).toEqual([])
  })

  it('cascades: deleting a thread removes its messages; drafts and usage keep their rows', () => {
    const db = freshPartialDb(MIGRATIONS.length)
    db.prepare("INSERT INTO ai_threads (id, title) VALUES (1, 't')").run()
    db.prepare("INSERT INTO ai_messages (thread_id, role, content) VALUES (1, 'user', 'q')").run()
    db.prepare("INSERT INTO ai_drafts (thread_id, kind, summary, payload_json) VALUES (1, 'voucher', 's', '{}')").run()
    db.prepare("INSERT INTO ai_usage (thread_id, day, provider, model) VALUES (1, '2025-01-01', 'mock', 'm')").run()
    db.prepare('DELETE FROM ai_threads WHERE id = 1').run()
    expect((db.prepare('SELECT COUNT(*) AS n FROM ai_messages').get() as { n: number }).n).toBe(0)
    expect(db.prepare('SELECT thread_id FROM ai_drafts').get()).toEqual({ thread_id: null })
    expect(db.prepare('SELECT thread_id FROM ai_usage').get()).toEqual({ thread_id: null })
    expect(() => db.prepare("INSERT INTO ai_messages (thread_id, role) VALUES (999, 'user')").run()).toThrow(/FOREIGN KEY/)
    expect(() => db.prepare("INSERT INTO ai_drafts (kind, summary, payload_json) VALUES ('invoice', 's', '{}')").run()).toThrow(/CHECK/)
  })
})
