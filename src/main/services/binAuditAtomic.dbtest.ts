// GPT review (to-do §4 Security): binning / restoring / purging a voucher and its audit row
// commit together — a failed audit write leaves the voucher exactly where it was.
import { describe, it, expect } from 'vitest'
import { seededDb, postSimpleVoucher } from '../db/testdb'
import { deleteVoucher, getVoucher, purgeOldDeleted, purgeVoucher, restoreVoucher, setLockDate } from './vouchers'

type DB = ReturnType<typeof seededDb>

/** Every INSERT into audit_log fails while this temp trigger exists. */
function breakAudit(db: DB): void {
  db.exec("CREATE TEMP TRIGGER audit_boom BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit write failed'); END")
}
function fixAudit(db: DB): void {
  db.exec('DROP TRIGGER temp.audit_boom')
}
function auditCount(db: DB, id: number, action: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'voucher' AND entity_id = ? AND action = ?").get(id, action) as { n: number }).n
}

describe('bin writes and their audit rows are one transaction', () => {
  it('deleteVoucher: a failing audit write leaves the voucher in the books', () => {
    const db = seededDb()
    const v = postSimpleVoucher(db, { date: '2025-04-05', amount: 50000, kind: 'receipt' })
    breakAudit(db)
    expect(() => deleteVoucher(db, v.id)).toThrow(/audit write failed/)
    expect(getVoucher(db, v.id)!.deletedAt).toBeNull()
    expect(auditCount(db, v.id, 'delete')).toBe(0)
    fixAudit(db)
    deleteVoucher(db, v.id)
    expect(getVoucher(db, v.id)!.deletedAt).toBeTruthy()
    expect(auditCount(db, v.id, 'delete')).toBe(1)
  })

  it('restoreVoucher: a failing audit write leaves the voucher in the bin', () => {
    const db = seededDb()
    const v = postSimpleVoucher(db, { date: '2025-04-05', amount: 50000, kind: 'receipt' })
    deleteVoucher(db, v.id)
    breakAudit(db)
    expect(() => restoreVoucher(db, v.id)).toThrow(/audit write failed/)
    expect(getVoucher(db, v.id)!.deletedAt).toBeTruthy()
    fixAudit(db)
    restoreVoucher(db, v.id)
    expect(getVoucher(db, v.id)!.deletedAt).toBeNull()
    expect(auditCount(db, v.id, 'restore')).toBe(1)
  })

  it('purgeVoucher: a failing audit write keeps the binned voucher', () => {
    const db = seededDb()
    const v = postSimpleVoucher(db, { date: '2025-04-05', amount: 50000, kind: 'receipt' })
    deleteVoucher(db, v.id)
    breakAudit(db)
    expect(() => purgeVoucher(db, v.id)).toThrow(/audit write failed/)
    expect(getVoucher(db, v.id)).not.toBeNull()
    fixAudit(db)
    purgeVoucher(db, v.id)
    expect(getVoucher(db, v.id)).toBeNull()
    expect(auditCount(db, v.id, 'purge')).toBe(1)
  })
  it('purgeOldDeleted: a failing audit write purges nothing; an FK-blocked voucher still lets the rest go', () => {
    const db = seededDb()
    const blocked = postSimpleVoucher(db, { date: '2025-04-05', amount: 5000, kind: 'payment' })
    const a = postSimpleVoucher(db, { date: '2025-04-06', amount: 5000, kind: 'receipt' })
    const b = postSimpleVoucher(db, { date: '2025-04-07', amount: 7000, kind: 'receipt' })
    db.prepare("INSERT INTO payroll_runs (month, voucher_id) VALUES ('2025-04', ?)").run(blocked.id)
    for (const v of [blocked, a, b]) deleteVoucher(db, v.id)
    db.prepare("UPDATE vouchers SET deleted_at = datetime('now', '-40 days')").run()
    setLockDate(db, '2025-04-30')
    breakAudit(db)
    expect(() => purgeOldDeleted(db, 30)).toThrow(/audit write failed/)
    for (const v of [blocked, a, b]) expect(getVoucher(db, v.id)).not.toBeNull()
    fixAudit(db)
    expect(purgeOldDeleted(db, 30)).toBe(2)
    expect(getVoucher(db, blocked.id)).not.toBeNull()
    expect([getVoucher(db, a.id), getVoucher(db, b.id)]).toEqual([null, null])
    expect(auditCount(db, 0, 'purge')).toBe(1)
  })
})
