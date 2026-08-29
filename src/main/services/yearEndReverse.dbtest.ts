import { describe, it, expect, beforeEach } from 'vitest'
import { seededDb, TEST_INFO } from '../db/testdb'
import { createLedger } from './masters'
import { saveVoucher, getLockDate, setLockDate } from './vouchers'
import { setAuditContext } from './audit'
import { closePreview, postClose, reverseClose } from './yearEnd'
import { trialBalance } from './reports'
import type { VoucherInputParsed } from '@shared/schemas'

function ledgerUnder(db: ReturnType<typeof seededDb>, name: string, groupName: string): number {
  const group = db.prepare('SELECT id FROM groups WHERE name = ?').get(groupName) as { id: number }
  return createLedger(db, {
    name, groupId: group.id, openingBalance: 0, gstin: null, stateCode: null, address: null,
    taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
  }).id
}

function journal(db: ReturnType<typeof seededDb>, date: string, lines: VoucherInputParsed['lines']): void {
  const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'journal'").get() as { id: number }
  saveVoucher(db, {
    voucherTypeId: vt.id, date, number: undefined, partyLedgerId: null, narration: null, reference: null,
    instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null,
    currencyCode: null, exchangeRate: null, lines, inventory: [], billRefs: [], tds: null
  })
}

/** A company whose FY 2025-26 has income and expense in it, ready to close. */
function closable(): ReturnType<typeof seededDb> {
  const db = seededDb() // TEST_INFO.booksFrom = 2025
  const cashId = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
  const salesId = ledgerUnder(db, 'Sales Income', 'Direct Incomes')
  const rentId = ledgerUnder(db, 'Rent', 'Direct Expenses')
  journal(db, '2025-06-01', [
    { ledgerId: cashId, drCr: 'dr', amount: 100000, costAllocations: [] },
    { ledgerId: salesId, drCr: 'cr', amount: 100000, costAllocations: [] }
  ])
  journal(db, '2025-07-01', [
    { ledgerId: rentId, drCr: 'dr', amount: 60000, costAllocations: [] },
    { ledgerId: cashId, drCr: 'cr', amount: 60000, costAllocations: [] }
  ])
  return db
}

describe('undoing a year-end close', () => {
  beforeEach(() => {
    setAuditContext({ appVersion: '0.4.0-test', getUserName: () => 'Asha' })
  })

  it('puts the books back exactly as they were before the close', () => {
    const db = closable()
    const before = trialBalance(db, '2026-03-31')

    const closed = postClose(db, TEST_INFO, 2025)
    expect(getLockDate(db)).toBe('2026-03-31')
    expect(closePreview(db, 2025).alreadyClosed).toBe(true)

    const reversed = reverseClose(db, 2025)
    expect(reversed.voucherId).toBe(closed.voucherId)

    // The lock is off, the close is no longer recorded, and every balance is what it was.
    expect(getLockDate(db)).toBeNull()
    expect(closePreview(db, 2025).alreadyClosed).toBe(false)
    const after = trialBalance(db, '2026-03-31')
    expect(after.totalDebit).toBe(before.totalDebit)
    expect(after.rows.map((r) => [r.ledgerName, r.debit, r.credit])).toEqual(before.rows.map((r) => [r.ledgerName, r.debit, r.credit]))
  })

  it('leaves the reversed close in the bin, not erased', () => {
    const db = closable()
    const closed = postClose(db, TEST_INFO, 2025)
    reverseClose(db, 2025)
    const row = db.prepare('SELECT deleted_at FROM vouchers WHERE id = ?').get(closed.voucherId) as {
      deleted_at: string | null
    }
    expect(row.deleted_at).not.toBeNull()
  })

  it('can be closed again afterwards, to the same figures', () => {
    const db = closable()
    const first = postClose(db, TEST_INFO, 2025)
    reverseClose(db, 2025)
    const second = postClose(db, TEST_INFO, 2025)
    expect(second.netProfit).toBe(first.netProfit)
    expect(second.lockedUpTo).toBe(first.lockedUpTo)
  })

  it('refuses when the next year has already been entered', () => {
    const db = closable()
    postClose(db, TEST_INFO, 2025)
    // Unlock briefly, the way a user would, and enter something in the new year.
    setLockDate(db, null)
    const cashId = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
    const salesId = (db.prepare("SELECT id FROM ledgers WHERE name = 'Sales Income'").get() as { id: number }).id
    journal(db, '2026-04-05', [
      { ledgerId: cashId, drCr: 'dr', amount: 500000, costAllocations: [] },
      { ledgerId: salesId, drCr: 'cr', amount: 500000, costAllocations: [] }
    ])

    expect(() => reverseClose(db, 2025)).toThrow(/dated after the closing entry/)
    // And nothing was half-done: the closing entry is still in the books.
    expect(closePreview(db, 2025).alreadyClosed).toBe(true)
  })

  it('restores a lock that was already there before the close', () => {
    const db = closable()
    setLockDate(db, '2025-05-31')
    postClose(db, TEST_INFO, 2025)
    const reversed = reverseClose(db, 2025)
    // The close moved the lock to 31 March; reversing puts it back where the user had it.
    expect(reversed.lockedUpTo).toBe('2025-05-31')
    expect(getLockDate(db)).toBe('2025-05-31')
  })

  it('says so plainly when there is no close to reverse', () => {
    expect(() => reverseClose(closable(), 2025)).toThrow(/No year-end close/)
  })

  it('records who reversed it', () => {
    const db = closable()
    postClose(db, TEST_INFO, 2025)
    reverseClose(db, 2025)
    const row = db
      .prepare("SELECT user_name AS userName, after_json AS afterJson FROM audit_log WHERE entity = 'year_end' AND action = 'delete'")
      .get() as { userName: string; afterJson: string }
    expect(row.userName).toBe('Asha')
    expect(JSON.parse(row.afterJson)).toMatchObject({ reversed: true })
  })
})
