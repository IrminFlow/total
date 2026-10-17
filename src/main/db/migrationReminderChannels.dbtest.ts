// PR #148 — reminder_log's channel CHECK gains 'whatsapp' and 'sms' (the simple People screen's
// ways, logged as 'phone' before). A table rebuild: every row is kept as it was (ids included),
// the index comes back, the old channels and the CHECK on unknown ones still hold, and the next
// id follows the old rows.
import { describe, expect, it } from 'vitest'
import { MIGRATIONS } from './migrations'
import { migrate, schemaVersion } from './migrate'
import { freshPartialDb, TEST_INFO } from './testdb'
import { seedCompany } from './seed'

// Found by its content, never by position: the voucher text index is appended after it.
const M = MIGRATIONS.findIndex((sql) => sql.includes('CREATE TABLE reminder_log_new'))

describe('reminder_log whatsapp / sms migration', () => {
  it('comes right before the voucher text index, a rebuild with foreign keys off', () => {
    expect(M).toBe(MIGRATIONS.findIndex((sql) => sql.includes('CREATE VIRTUAL TABLE voucher_fts')) - 1)
    expect(MIGRATIONS[M]!.startsWith('-- @foreign-keys-off')).toBe(true)
  })

  it('keeps the AUTOINCREMENT high-water mark: a deleted reminder’s id is never reissued (its audit row names it)', () => {
    const db = freshPartialDb(M)
    seedCompany(db, TEST_INFO)
    const party = Number(db.prepare("INSERT INTO ledgers (name, group_id) SELECT 'Ramesh', id FROM groups WHERE name = 'Sundry Debtors'").run().lastInsertRowid)
    const ins = db.prepare("INSERT INTO reminder_log (party_ledger_id, bucket, date, channel) VALUES (?, 'gentle', '2026-05-01', ?)")
    for (let i = 0; i < 3; i++) ins.run(party, 'pdf')
    db.prepare('DELETE FROM reminder_log WHERE id = 3').run()
    migrate(db)
    expect(Number(ins.run(party, 'sms').lastInsertRowid)).toBe(4)
  })

  it('an empty reminder_log with deleted rows behind it keeps its mark too', () => {
    const db = freshPartialDb(M)
    seedCompany(db, TEST_INFO)
    const party = Number(db.prepare("INSERT INTO ledgers (name, group_id) SELECT 'Ramesh', id FROM groups WHERE name = 'Sundry Debtors'").run().lastInsertRowid)
    const ins = db.prepare("INSERT INTO reminder_log (party_ledger_id, bucket, date, channel) VALUES (?, 'gentle', '2026-05-01', ?)")
    ins.run(party, 'pdf')
    ins.run(party, 'pdf')
    db.prepare('DELETE FROM reminder_log').run()
    migrate(db)
    expect(Number(ins.run(party, 'whatsapp').lastInsertRowid)).toBe(3)
  })

  it('keeps every row, adds the two channels, still refuses an unknown one', () => {
    const db = freshPartialDb(M)
    seedCompany(db, TEST_INFO)
    const party = Number(db.prepare("INSERT INTO ledgers (name, group_id) SELECT 'Ramesh', id FROM groups WHERE name = 'Sundry Debtors'").run().lastInsertRowid)
    const ins = db.prepare("INSERT INTO reminder_log (party_ledger_id, bucket, date, amount_paise, oldest_bill, max_overdue_days, document_path, channel, user_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Asha')")
    ins.run(party, 'gentle', '2026-05-01', 12_000, '1', 10, '/x/r.pdf', 'pdf')
    ins.run(party, 'firm', '2026-06-01', 12_000, '1', 41, null, 'phone')
    ins.run(party, 'final', '2026-07-01', 12_000, '1', 71, null, 'other')
    expect(() => ins.run(party, 'gentle', '2026-07-02', 1, null, 0, null, 'whatsapp')).toThrow(/CHECK/)
    const before = db.prepare('SELECT * FROM reminder_log ORDER BY id').all()
    migrate(db)
    expect(schemaVersion(db)).toBe(MIGRATIONS.length)
    expect(db.prepare('SELECT * FROM reminder_log ORDER BY id').all()).toEqual(before)
    const w = Number(ins.run(party, 'gentle', '2026-08-01', 1, null, 0, null, 'whatsapp').lastInsertRowid)
    ins.run(party, 'gentle', '2026-08-02', 1, null, 0, null, 'sms')
    expect(w).toBe(4)
    expect(() => ins.run(party, 'gentle', '2026-08-03', 1, null, 0, null, 'fax')).toThrow(/CHECK/)
    expect(() => ins.run(party, 'soft', '2026-08-03', 1, null, 0, null, 'sms')).toThrow(/CHECK/)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'reminder_log'").all()).toEqual([{ name: 'idx_reminder_log_party' }])
    expect(db.pragma('foreign_key_check')).toEqual([])
    // Its FK still cascades with the party.
    db.prepare('DELETE FROM ledgers WHERE id = ?').run(party)
    expect(db.prepare('SELECT COUNT(*) AS n FROM reminder_log').get()).toEqual({ n: 0 })
  })
})
