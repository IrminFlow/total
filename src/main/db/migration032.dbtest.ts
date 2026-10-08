// Migration 032 (WP 4.2): receivables — ledger email / interest terms / credit hold columns, and
// the reminder_log, interest_charges and bill_followups tables. Located by content.
import { describe, it, expect } from 'vitest'
import { migrate } from './migrate'
import { MIGRATIONS } from './migrations'
import { freshPartialDb, TEST_INFO } from './testdb'
import { seedCompany } from './seed'

const M032 = MIGRATIONS.findIndex((sql) => sql.includes('CREATE TABLE reminder_log'))

const cols = (db: ReturnType<typeof freshPartialDb>, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)

describe('migration 032 — receivables', () => {
  it('is migration 032, after 031 (WP 3.8)', () => {
    expect(M032 + 1).toBe(32)
    expect(MIGRATIONS.findIndex((sql) => sql.includes('CREATE TABLE audit_log_new'))).toBeLessThan(M032)
  })

  it('gives existing ledgers no interest, no grace and no hold', () => {
    const db = freshPartialDb(M032)
    seedCompany(db, TEST_INFO)
    db.prepare("INSERT INTO ledgers (name, group_id) VALUES ('Old Party', 1)").run()
    migrate(db)
    expect(db.prepare("SELECT email, interest_rate_bp, interest_grace_days, credit_hold, credit_hold_reason, credit_hold_at FROM ledgers WHERE name = 'Old Party'").get()).toEqual({
      email: null, interest_rate_bp: null, interest_grace_days: 0, credit_hold: 0, credit_hold_reason: null, credit_hold_at: null
    })
    expect(() => db.prepare("UPDATE ledgers SET interest_rate_bp = 10001 WHERE name = 'Old Party'").run()).toThrow(/CHECK/)
    expect(() => db.prepare("UPDATE ledgers SET credit_hold = 2 WHERE name = 'Old Party'").run()).toThrow(/CHECK/)
  })

  it('creates the three tables with their constraints', () => {
    const db = freshPartialDb(M032)
    seedCompany(db, TEST_INFO)
    migrate(db)
    expect(cols(db, 'reminder_log')).toEqual(expect.arrayContaining(['party_ledger_id', 'bucket', 'date', 'document_path', 'channel', 'amount_paise', 'oldest_bill', 'user_name']))
    expect(cols(db, 'interest_charges')).toEqual(expect.arrayContaining(['party_ledger_id', 'bill_voucher_id', 'bill_ref', 'period_from', 'period_to', 'days', 'principal_paise', 'rate_bp', 'interest_paise', 'gst_paise', 'debit_note_voucher_id']))
    expect(cols(db, 'bill_followups')).toEqual(expect.arrayContaining(['party_ledger_id', 'bill_voucher_id', 'bill_ref', 'date', 'note', 'promised_date', 'promised_amount', 'user_name']))
    const party = Number(db.prepare("INSERT INTO ledgers (name, group_id) VALUES ('P', 1)").run().lastInsertRowid)
    expect(() => db.prepare("INSERT INTO reminder_log (party_ledger_id, bucket, date, channel) VALUES (?, 'soft', '2026-01-01', 'email')").run(party)).toThrow(/CHECK/)
    expect(() => db.prepare("INSERT INTO reminder_log (party_ledger_id, bucket, date, channel) VALUES (?, 'gentle', '2026-01-01', 'fax')").run(party)).toThrow(/CHECK/)
    expect(() => db.prepare("INSERT INTO bill_followups (party_ledger_id, bill_ref, date, promised_amount) VALUES (?, 'X', '2026-01-01', 0)").run(party)).toThrow(/CHECK/)
    // A charge needs a real debit note.
    expect(() =>
      db.prepare("INSERT INTO interest_charges (party_ledger_id, bill_ref, period_from, period_to, days, principal_paise, rate_bp, interest_paise, debit_note_voucher_id) VALUES (?, 'X', '2026-01-01', '2026-01-31', 31, 100, 1800, 2, 999)").run(party)
    ).toThrow(/FOREIGN KEY/)
  })
})
