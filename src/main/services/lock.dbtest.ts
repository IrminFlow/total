import { describe, it, expect } from 'vitest'
import { seededDb, postSimpleVoucher } from '../db/testdb'
import { getLockDate, setLockDate, saveVoucher, deleteVoucher, restoreVoucher, getVoucher } from './vouchers'

describe('period lock', () => {
  it('defaults to unlocked (null)', () => {
    const db = seededDb()
    expect(getLockDate(db)).toBeNull()
  })

  it('setLockDate writes and reads back the lock date, and writes an audit row', () => {
    const db = seededDb()
    setLockDate(db, '2025-06-30')
    expect(getLockDate(db)).toBe('2025-06-30')

    const rows = db
      .prepare("SELECT action, before_json, after_json FROM audit_log WHERE entity = 'company' AND entity_id = 0 ORDER BY id")
      .all() as { action: string; before_json: string | null; after_json: string | null }[]
    const last = rows[rows.length - 1]!
    expect(last.action).toBe('update')
    expect(JSON.parse(last.before_json!)).toEqual({ lockBefore: null })
    expect(JSON.parse(last.after_json!)).toEqual({ lockBefore: '2025-06-30' })
  })

  it('throws when saving a voucher dated on or before the lock date', () => {
    const db = seededDb()
    setLockDate(db, '2025-06-30')
    expect(() => postSimpleVoucher(db, { date: '2025-06-30', amount: 1000, kind: 'receipt' })).toThrow(
      'Books are locked up to 2025-06-30'
    )
    expect(() => postSimpleVoucher(db, { date: '2025-06-15', amount: 1000, kind: 'receipt' })).toThrow(
      'Books are locked up to 2025-06-30'
    )
  })

  it('allows saving a voucher dated after the lock date', () => {
    const db = seededDb()
    setLockDate(db, '2025-06-30')
    const saved = postSimpleVoucher(db, { date: '2025-07-01', amount: 1000, kind: 'receipt' })
    expect(getVoucher(db, saved.id)?.date).toBe('2025-07-01')
  })

  it('blocks updating a voucher whose existing date is locked, even if the new date is not', () => {
    const db = seededDb()
    const saved = postSimpleVoucher(db, { date: '2025-05-01', amount: 1000, kind: 'receipt' })
    setLockDate(db, '2025-06-30')

    expect(() =>
      saveVoucher(
        db,
        {
          voucherTypeId: saved.voucherTypeId,
          date: '2025-07-15',
          partyLedgerId: null,
          narration: 'moved forward',
          reference: null,
          instrumentNo: null,
          instrumentDate: null,
          transporterId: null,
          vehicleNo: null,
          transportDistanceKm: null,
          currencyCode: null,
          exchangeRate: null,
          lines: saved.lines.map((l) => ({ ledgerId: l.ledgerId, drCr: l.drCr, amount: l.amount, costAllocations: [] })),
          inventory: [],
          billRefs: [],
          tds: null
        },
        saved.id
      )
    ).toThrow('Books are locked up to 2025-06-30')
  })

  it('blocks deleting a voucher dated on or before the lock date', () => {
    const db = seededDb()
    const saved = postSimpleVoucher(db, { date: '2025-05-01', amount: 1000, kind: 'receipt' })
    setLockDate(db, '2025-06-30')
    expect(() => deleteVoucher(db, saved.id)).toThrow('Books are locked up to 2025-06-30')
  })

  it('blocks restoring a binned voucher into a locked period', () => {
    const db = seededDb()
    const saved = postSimpleVoucher(db, { date: '2025-05-01', amount: 1000, kind: 'receipt' })
    deleteVoucher(db, saved.id) // still unlocked at this point
    setLockDate(db, '2025-06-30')
    expect(() => restoreVoucher(db, saved.id)).toThrow('Books are locked up to 2025-06-30')
  })

  it('unlocking (setLockDate(db, null)) restores normal save/delete behavior', () => {
    const db = seededDb()
    setLockDate(db, '2025-06-30')
    expect(() => postSimpleVoucher(db, { date: '2025-06-15', amount: 1000, kind: 'receipt' })).toThrow()

    setLockDate(db, null)
    expect(getLockDate(db)).toBeNull()

    const saved = postSimpleVoucher(db, { date: '2025-06-15', amount: 1000, kind: 'receipt' })
    expect(getVoucher(db, saved.id)?.date).toBe('2025-06-15')
    expect(() => deleteVoucher(db, saved.id)).not.toThrow()
  })
})
