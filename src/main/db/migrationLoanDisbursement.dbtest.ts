// To-do §4 / WP 4.4 — loan_vouchers' kind CHECK gains 'disbursement'. A rebuild: every row is
// kept as it was, the index comes back, unknown kinds are still refused.
import { describe, expect, it } from 'vitest'
import { MIGRATIONS } from './migrations'
import { migrate, schemaVersion } from './migrate'
import { freshPartialDb, TEST_INFO } from './testdb'
import { seedCompany } from './seed'

// Found by its content, never by position.
const M = MIGRATIONS.findIndex((sql) => sql.includes('CREATE TABLE loan_vouchers_new'))

describe('loan_vouchers disbursement migration', () => {
  it('was last when added (the tax-fact snapshot columns follow it), a plain rebuild (foreign keys stay on)', () => {
    expect(M).toBe(MIGRATIONS.findIndex((sql) => sql.includes('snap_tax_facts')) - 1)
    expect(MIGRATIONS[M]!.trimStart().startsWith('-- @foreign-keys-off')).toBe(false)
  })

  it('keeps every row, accepts a disbursement, still refuses an unknown kind', () => {
    const db = freshPartialDb(M)
    seedCompany(db, TEST_INFO)
    const vt = (db.prepare("SELECT id FROM voucher_types WHERE kind = 'payment' LIMIT 1").get() as { id: number }).id
    const v = (n: string): number => Number(db.prepare("INSERT INTO vouchers (voucher_type_id, date, number) VALUES (?, '2026-05-05', ?)").run(vt, n).lastInsertRowid)
    const ins = db.prepare('INSERT INTO loan_vouchers (voucher_id, loan_id, seq, kind) VALUES (?, ?, ?, ?)')
    ins.run(v('1'), 7, 1, 'emi')
    ins.run(v('2'), 7, 2, 'prepayment')
    expect(() => ins.run(v('3'), 7, 0, 'disbursement')).toThrow(/CHECK/)
    const before = db.prepare('SELECT * FROM loan_vouchers ORDER BY voucher_id').all()
    migrate(db)
    expect(schemaVersion(db)).toBe(MIGRATIONS.length)
    expect(db.prepare('SELECT * FROM loan_vouchers ORDER BY voucher_id').all()).toEqual(before)
    db.prepare('INSERT INTO loan_vouchers (voucher_id, loan_id, seq, kind) VALUES (?, ?, ?, ?)').run(v('4'), 7, 0, 'disbursement')
    expect(() => db.prepare('INSERT INTO loan_vouchers (voucher_id, loan_id, seq, kind) VALUES (?, ?, ?, ?)').run(v('5'), 7, 0, 'fee')).toThrow(/CHECK/)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'loan_vouchers' AND name = 'idx_loan_vouchers_loan'").get()).toBeTruthy()
    // purging the voucher still drops its link
    db.prepare('DELETE FROM vouchers WHERE number = ?').run('1')
    expect(db.prepare('SELECT COUNT(*) AS n FROM loan_vouchers').get()).toEqual({ n: 2 })
  })
})
