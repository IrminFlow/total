import { describe, it, expect } from 'vitest'
import { seededDb, postSimpleVoucher } from '../db/testdb'
import { deleteVoucher, getVoucher, listBin, listVouchers, nextVoucherNumber, purgeOldDeleted, purgeVoucher, restoreVoucher, saveVoucher, setLockDate } from './vouchers'
import { trialBalance } from './reports'

describe('soft delete + bin', () => {
  it('excludes a binned voucher from listVouchers and trialBalance, while keeping the books balanced', () => {
    const db = seededDb()
    const v1 = postSimpleVoucher(db, { date: '2025-04-05', amount: 50000, kind: 'receipt' })
    const v2 = postSimpleVoucher(db, { date: '2025-04-10', amount: 20000, kind: 'payment' })

    const cashLedger = db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }
    const tbBefore = trialBalance(db, '2025-04-30')
    expect(tbBefore.totalDebit).toBe(tbBefore.totalCredit)
    const cashBefore = tbBefore.rows.find((r) => r.ledgerId === cashLedger.id)!.debit

    deleteVoucher(db, v2.id)

    const list = listVouchers(db, '2025-01-01', '2025-12-31')
    expect(list.map((r) => r.id)).toEqual([v1.id])

    const tbAfter = trialBalance(db, '2025-04-30')
    expect(tbAfter.totalDebit).toBe(tbAfter.totalCredit)
    const cashAfter = tbAfter.rows.find((r) => r.ledgerId === cashLedger.id)!.debit
    // v2 was a payment (cash credited) — dropping it raises Cash's net debit balance by its amount.
    expect(cashAfter).toBe(cashBefore + 20000)
  })

  it('appears in listBin once deleted, mirroring listVouchers row shape plus deletedAt', () => {
    const db = seededDb()
    const v = postSimpleVoucher(db, { date: '2025-04-05', amount: 12345, kind: 'receipt' })
    expect(listBin(db)).toHaveLength(0)

    deleteVoucher(db, v.id)

    const bin = listBin(db)
    expect(bin).toHaveLength(1)
    expect(bin[0]).toMatchObject({ id: v.id, amount: 12345 })
    expect(bin[0]!.deletedAt).toBeTruthy()
  })

  it('restoreVoucher reinstates the voucher and returns the trial balance to its original state', () => {
    const db = seededDb()
    postSimpleVoucher(db, { date: '2025-04-05', amount: 50000, kind: 'receipt' })
    const v2 = postSimpleVoucher(db, { date: '2025-04-10', amount: 20000, kind: 'payment' })
    const tbOriginal = trialBalance(db, '2025-04-30')

    deleteVoucher(db, v2.id)
    expect(listVouchers(db, '2025-01-01', '2025-12-31').map((r) => r.id)).not.toContain(v2.id)

    restoreVoucher(db, v2.id)

    const tbRestored = trialBalance(db, '2025-04-30')
    expect(tbRestored).toEqual(tbOriginal)
    expect(listBin(db)).toHaveLength(0)
    expect(listVouchers(db, '2025-01-01', '2025-12-31').map((r) => r.id)).toContain(v2.id)
    expect(getVoucher(db, v2.id)!.deletedAt).toBeNull()
  })

  it('nextVoucherNumber still counts a deleted voucher\'s number (no reuse)', () => {
    const db = seededDb()
    let last = postSimpleVoucher(db, { date: '2025-04-01', amount: 1000, kind: 'receipt' })
    for (let i = 1; i < 5; i++) {
      last = postSimpleVoucher(db, { date: '2025-04-01', amount: 1000, kind: 'receipt' })
    }
    expect(last.number).toBe('5')

    deleteVoucher(db, last.id)

    const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'receipt'").get() as { id: number }
    expect(nextVoucherNumber(db, vt.id, '2025-04-02')).toBe('6')
  })

  it('purgeVoucher hard-deletes a binned voucher', () => {
    const db = seededDb()
    const v = postSimpleVoucher(db, { date: '2025-04-05', amount: 5000, kind: 'receipt' })
    deleteVoucher(db, v.id)

    purgeVoucher(db, v.id)

    expect(getVoucher(db, v.id)).toBeNull()
    expect(listBin(db)).toHaveLength(0)
    const row = db.prepare('SELECT COUNT(*) AS n FROM vouchers WHERE id = ?').get(v.id) as { n: number }
    expect(row.n).toBe(0)
  })

  it('purgeVoucher refuses a voucher that is not yet in the bin', () => {
    const db = seededDb()
    const v = postSimpleVoucher(db, { date: '2025-04-05', amount: 5000, kind: 'receipt' })
    expect(() => purgeVoucher(db, v.id)).toThrow(/bin/i)
    expect(getVoucher(db, v.id)).not.toBeNull()
  })

  it('purgeOldDeleted removes only LOCKED-period vouchers binned more than `days` ago', () => {
    const db = seededDb()
    const recent = postSimpleVoucher(db, { date: '2025-04-05', amount: 5000, kind: 'receipt' })
    const old = postSimpleVoucher(db, { date: '2025-04-06', amount: 5000, kind: 'receipt' })
    deleteVoucher(db, recent.id)
    deleteVoucher(db, old.id)
    // Backdate `old`'s bin entry past the 30-day window via a raw UPDATE (simulates elapsed time).
    db.prepare("UPDATE vouchers SET deleted_at = datetime('now', '-40 days') WHERE id = ?").run(old.id)

    // With NO lock date, nothing is auto-purged — GSTR-1 Table 13 (cancelled documents) and
    // number-uniqueness still need binned rows for periods that haven't been closed/filed.
    expect(purgeOldDeleted(db, 30)).toBe(0)
    expect(getVoucher(db, old.id)).not.toBeNull()

    setLockDate(db, '2025-04-30')
    const purged = purgeOldDeleted(db, 30)

    expect(purged).toBe(1)
    expect(getVoucher(db, old.id)).toBeNull()
    expect(getVoucher(db, recent.id)).not.toBeNull()
    expect(getVoucher(db, recent.id)!.deletedAt).toBeTruthy()
  })

  it('purgeOldDeleted never purges vouchers dated after the lock date, however old their bin entry', () => {
    const db = seededDb()
    const unlocked = postSimpleVoucher(db, { date: '2025-06-15', amount: 5000, kind: 'receipt' })
    deleteVoucher(db, unlocked.id)
    db.prepare("UPDATE vouchers SET deleted_at = datetime('now', '-90 days') WHERE id = ?").run(unlocked.id)
    setLockDate(db, '2025-04-30') // books locked only through April — June stays in the bin

    expect(purgeOldDeleted(db, 30)).toBe(0)
    expect(getVoucher(db, unlocked.id)).not.toBeNull()
  })

  it('one purge-blocked voucher (payroll FK) does not stop the rest of the purge', () => {
    const db = seededDb()
    const blocked = postSimpleVoucher(db, { date: '2025-04-05', amount: 5000, kind: 'payment' })
    const purgeable = postSimpleVoucher(db, { date: '2025-04-06', amount: 5000, kind: 'receipt' })
    // payroll_runs.voucher_id references vouchers WITHOUT ON DELETE CASCADE — the classic blocker.
    db.prepare(
      `INSERT INTO payroll_runs (month, cycle, period_start, period_end, voucher_id)
       VALUES ('2025-04', 'monthly', '2025-04-01', '2025-04-30', ?)`
    ).run(blocked.id)
    deleteVoucher(db, blocked.id)
    deleteVoucher(db, purgeable.id)
    db.prepare("UPDATE vouchers SET deleted_at = datetime('now', '-40 days')").run()
    setLockDate(db, '2025-04-30')

    const purged = purgeOldDeleted(db, 30)

    expect(purged).toBe(1) // the FK-blocked voucher is skipped, not fatal
    expect(getVoucher(db, purgeable.id)).toBeNull()
    expect(getVoucher(db, blocked.id)).not.toBeNull() // still in the bin
  })

  it('saveVoucher refuses to edit a binned voucher until it is restored', () => {
    const db = seededDb()
    const v = postSimpleVoucher(db, { date: '2025-04-05', amount: 5000, kind: 'receipt' })
    deleteVoucher(db, v.id)

    expect(() =>
      saveVoucher(
        db,
        {
          voucherTypeId: v.voucherTypeId,
          date: v.date,
          partyLedgerId: null,
          narration: 'edit attempt',
          reference: null,
          instrumentNo: null,
          instrumentDate: null,
          transporterId: null,
          vehicleNo: null,
          transportDistanceKm: null,
          currencyCode: null,
          exchangeRate: null,
          lines: v.lines.map((l) => ({ ledgerId: l.ledgerId, drCr: l.drCr, amount: l.amount, costAllocations: [] })),
          inventory: [],
          billRefs: [],
          tds: null
        },
        v.id
      )
    ).toThrow('Voucher is in the bin; restore it first')
  })

  it('deleteVoucher / restoreVoucher / purgeVoucher write the expected audit_log trail', () => {
    const db = seededDb()
    const v = postSimpleVoucher(db, { date: '2025-04-05', amount: 5000, kind: 'receipt' })
    deleteVoucher(db, v.id)
    restoreVoucher(db, v.id)
    deleteVoucher(db, v.id)
    purgeVoucher(db, v.id)

    const rows = db
      .prepare("SELECT action, after_json FROM audit_log WHERE entity = 'voucher' AND entity_id = ? ORDER BY id")
      .all(v.id) as { action: string; after_json: string | null }[]
    expect(rows.map((r) => r.action)).toEqual(['create', 'delete', 'update', 'delete', 'delete'])
    // The restore records the whole voucher on both sides, not a `{ restored: true }` marker.
    // Against a marker, a reader comparing snapshots sees every field on the voucher reported as
    // removed — the opposite of what happened.
    const restored = JSON.parse(rows[2]!.after_json!) as { id: number; deletedAt: string | null }
    expect(restored.id).toBe(v.id)
    expect(restored.deletedAt).toBeNull()
  })
})
