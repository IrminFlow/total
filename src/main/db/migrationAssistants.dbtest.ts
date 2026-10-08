// The assistants migration (WP 5.5): assistant_marks and gst2b_statements. Appended LAST (its
// number is its position — re-placed when main gains migrations first); an existing company
// upgrades with its books unchanged and both tables empty.
import { describe, expect, it } from 'vitest'
import { MIGRATIONS } from './migrations'
import { migrate, schemaVersion } from './migrate'
import { freshPartialDb, TEST_INFO, postSimpleVoucher } from './testdb'
import { seedCompany } from './seed'
import { trialBalance } from '../services/reports'

const M = MIGRATIONS.findIndex((sql) => sql.includes('CREATE TABLE assistant_marks'))

describe('assistants migration — marks and stored 2B statements', () => {
  it('is the last migration', () => {
    expect(M).toBe(MIGRATIONS.length - 1)
    expect(MIGRATIONS.findIndex((sql) => sql.includes('CREATE TABLE mcp_log'))).toBeLessThan(M)
  })

  it('upgrades a company with its books unchanged; the checks hold', () => {
    const db = freshPartialDb(M)
    seedCompany(db, TEST_INFO)
    postSimpleVoucher(db, { date: '2025-05-01', amount: 123456, kind: 'receipt' })
    const before = trialBalance(db, '2026-03-31')
    migrate(db)
    expect(schemaVersion(db)).toBe(MIGRATIONS.length)
    expect(trialBalance(db, '2026-03-31')).toEqual(before)
    expect((db.prepare('SELECT COUNT(*) AS n FROM assistant_marks').get() as { n: number }).n).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS n FROM gst2b_statements').get() as { n: number }).n).toBe(0)
    db.prepare("INSERT INTO assistant_marks (assistant, scope, item_key, status) VALUES ('close', '2025-05', 'lock', 'done')").run()
    expect(() => db.prepare("INSERT INTO assistant_marks (assistant, scope, item_key, status) VALUES ('close', '2025-05', 'lock', 'na')").run()).toThrow(/UNIQUE|PRIMARY/)
    expect(() => db.prepare("INSERT INTO assistant_marks (assistant, scope, item_key, status) VALUES ('other', '', 'k', 'done')").run()).toThrow(/CHECK/)
    expect(() => db.prepare("INSERT INTO assistant_marks (assistant, scope, item_key, status) VALUES ('anomaly', '', 'k', 'maybe')").run()).toThrow(/CHECK/)
    db.prepare("INSERT INTO gst2b_statements (period, json_text) VALUES ('052025', '{}')").run()
    expect(() => db.prepare("INSERT INTO gst2b_statements (period, json_text) VALUES ('052025', '{}')").run()).toThrow(/UNIQUE/)
    expect(() => db.prepare("INSERT INTO gst2b_statements (period, json_text) VALUES ('2025-05', '{}')").run()).toThrow(/CHECK/)
  })
})
