// The AI migration (WP 5.1): the AI tables, appended as the LAST migration (its number is its
// position — renumbered whenever main gains migrations first). An existing company upgrades
// without touching its books.
import { describe, expect, it } from 'vitest'
import { MIGRATIONS } from './migrations'
import { migrate, schemaVersion } from './migrate'
import { freshPartialDb, TEST_INFO, postSimpleVoucher } from './testdb'
import { seedCompany } from './seed'
import { trialBalance } from '../services/reports'

const M_AI = MIGRATIONS.findIndex((sql) => sql.includes('CREATE TABLE ai_threads'))

describe('AI migration — agent tables', () => {
  it('exists and is the last migration', () => {
    expect(M_AI).toBeGreaterThan(30)
    expect(M_AI).toBe(MIGRATIONS.length - 1)
  })

  it('upgrades a company from the previous schema with its books unchanged and the AI tables empty', () => {
    const db = freshPartialDb(M_AI)
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
