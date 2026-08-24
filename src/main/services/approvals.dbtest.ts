import { describe, it, expect } from 'vitest'
import { seededDb } from '../db/testdb'
import { saveVoucher, listVouchers, type SaveVoucherActor } from './vouchers'
import { setApprovalThreshold } from './config'
import { decide, listPending, pendingCount } from './approvals'
import { trialBalance } from './reports'
import { saveUser } from './users'
import { findOrCreateLedger } from './masters'
import { runAsAuditUser } from './audit'
import type { DB } from '../db/connection'

const ACCOUNTANT: SaveVoucherActor = { role: 'accountant', hasUsers: true }
const OWNER: SaveVoucherActor = { role: 'owner', hasUsers: true }

/** 'Cash' is seeded; the other side is created on first use (only Cash ships with a company). */
function ledger(db: DB, name: string): number {
  if (name === 'Cash') return (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
  return findOrCreateLedger(db, name, 'Capital Account')
}

/** A receipt of `amount` paise, entered by `who`. */
function post(db: DB, amount: number, actor?: SaveVoucherActor, enteredBy = 'Arun'): number {
  const vt = (db.prepare("SELECT id FROM voucher_types WHERE kind = 'receipt'").get() as { id: number }).id
  const cash = ledger(db, 'Cash')
  const capital = ledger(db, 'Owner Capital')
  return runAsAuditUser(enteredBy, () =>
    saveVoucher(
      db,
      {
        voucherTypeId: vt,
        date: '2026-08-01',
        partyLedgerId: null,
        narration: null,
        reference: null,
        instrumentNo: null,
        instrumentDate: null,
        transporterId: null,
        vehicleNo: null,
        transportDistanceKm: null,
        currencyCode: null,
        exchangeRate: null,
        lines: [
          { ledgerId: cash, drCr: 'dr', amount, costAllocations: [] },
          { ledgerId: capital, drCr: 'cr', amount, costAllocations: [] }
        ],
        inventory: [],
        billRefs: [],
        tds: null
      },
      undefined,
      actor
    ).id
  )
}

function withUsers(db: DB): DB {
  saveUser(db, { name: 'Priya Owner', role: 'owner', pin: '1234', active: true })
  saveUser(db, { name: 'Arun', role: 'accountant', pin: '2222', active: true })
  return db
}

describe('the approval threshold', () => {
  it('holds an accountant entry above it, out of the books but not lost', () => {
    const db = withUsers(seededDb())
    setApprovalThreshold(db, 5000000) // ₹50,000
    const id = post(db, 6000000, ACCOUNTANT)

    expect(pendingCount(db)).toBe(1)
    // Out of the books: the trial balance has not moved.
    expect(trialBalance(db, '2026-08-31').totalDebit).toBe(0)
    // Not lost: it is right there in the day book for the person who typed it.
    expect(listVouchers(db, '2026-08-01', '2026-08-31').some((v) => v.id === id)).toBe(true)
  })

  it('lets an entry at exactly the threshold straight into the books', () => {
    const db = withUsers(seededDb())
    setApprovalThreshold(db, 5000000)
    post(db, 5000000, ACCOUNTANT)
    expect(pendingCount(db)).toBe(0)
    expect(trialBalance(db, '2026-08-31').totalDebit).toBe(5000000)
  })

  it("never holds the owner's own entry", () => {
    const db = withUsers(seededDb())
    setApprovalThreshold(db, 100)
    post(db, 99999999, OWNER, 'Priya Owner')
    expect(pendingCount(db)).toBe(0)
  })

  it('holds everything with an amount at a threshold of zero, which is not the same as off', () => {
    const db = withUsers(seededDb())
    setApprovalThreshold(db, 0)
    post(db, 100, ACCOUNTANT)
    expect(pendingCount(db)).toBe(1)
  })

  it('holds nothing when no threshold has been set', () => {
    const db = withUsers(seededDb())
    post(db, 99999999, ACCOUNTANT)
    expect(pendingCount(db)).toBe(0)
    expect(trialBalance(db, '2026-08-31').totalDebit).toBe(99999999)
  })

  it('holds nothing on a company with no users — one person is not a queue', () => {
    const db = seededDb()
    setApprovalThreshold(db, 0)
    post(db, 500000, { role: null, hasUsers: false })
    expect(pendingCount(db)).toBe(0)
  })

  it('never holds an import, a recurring run or anything else without a person behind it', () => {
    // Every internal caller passes no actor, and that is what makes them ungated.
    const db = withUsers(seededDb())
    setApprovalThreshold(db, 0)
    post(db, 500000, undefined)
    expect(pendingCount(db)).toBe(0)
  })
})

describe('deciding', () => {
  it('puts an approved voucher into the books', () => {
    const db = withUsers(seededDb())
    setApprovalThreshold(db, 5000000)
    const id = post(db, 6000000, ACCOUNTANT)

    decide(db, { voucherId: id, approve: true }, { role: 'owner', name: 'Priya Owner' })

    expect(pendingCount(db)).toBe(0)
    expect(trialBalance(db, '2026-08-31').totalDebit).toBe(6000000)
  })

  it('keeps a rejected voucher out of the books, with the reason', () => {
    const db = withUsers(seededDb())
    setApprovalThreshold(db, 5000000)
    const id = post(db, 6000000, ACCOUNTANT)

    const after = decide(db, { voucherId: id, approve: false, note: 'No such supplier' }, { role: 'owner', name: 'Priya Owner' })

    expect(after.state).toBe('rejected')
    expect(after.note).toBe('No such supplier')
    expect(trialBalance(db, '2026-08-31').totalDebit).toBe(0)
  })

  it('lets a rejected entry back into the books once it has been corrected', () => {
    // The refusal was about the entry as it stood. Corrected, it is a different entry, and a
    // flag nobody can clear would be a voucher stuck outside the books forever.
    const db = withUsers(seededDb())
    setApprovalThreshold(db, 5000000)
    const id = post(db, 6000000, ACCOUNTANT)
    decide(db, { voucherId: id, approve: false, note: 'Wrong party' }, { role: 'owner', name: 'Priya Owner' })

    const vt = (db.prepare("SELECT id FROM voucher_types WHERE kind = 'receipt'").get() as { id: number }).id
    saveVoucher(
      db,
      {
        voucherTypeId: vt,
        date: '2026-08-01',
        partyLedgerId: null,
        narration: 'corrected',
        reference: null,
        instrumentNo: null,
        instrumentDate: null,
        transporterId: null,
        vehicleNo: null,
        transportDistanceKm: null,
        currencyCode: null,
        exchangeRate: null,
        lines: [
          { ledgerId: ledger(db, 'Cash'), drCr: 'dr', amount: 100000, costAllocations: [] },
          { ledgerId: ledger(db, 'Owner Capital'), drCr: 'cr', amount: 100000, costAllocations: [] }
        ],
        inventory: [],
        billRefs: [],
        tds: null
      },
      id,
      ACCOUNTANT
    )

    expect(trialBalance(db, '2026-08-31').totalDebit).toBe(100000)
  })

  it('records who entered it, so the queue means something', () => {
    const db = withUsers(seededDb())
    setApprovalThreshold(db, 5000000)
    post(db, 6000000, ACCOUNTANT, 'Arun')
    expect(listPending(db)[0]!.enteredBy).toBe('Arun')
  })

  it('refuses an accountant, and refuses the person who entered it', () => {
    const db = withUsers(seededDb())
    setApprovalThreshold(db, 5000000)
    const id = post(db, 6000000, ACCOUNTANT, 'Arun')

    expect(() => decide(db, { voucherId: id, approve: true }, { role: 'accountant', name: 'Arun' })).toThrow(/Only the owner/)
    expect(() => decide(db, { voucherId: id, approve: true }, { role: 'owner', name: 'Arun' })).toThrow(/person who made it/)
  })

  it('will not decide the same voucher twice', () => {
    const db = withUsers(seededDb())
    setApprovalThreshold(db, 5000000)
    const id = post(db, 6000000, ACCOUNTANT)
    decide(db, { voucherId: id, approve: true }, { role: 'owner', name: 'Priya Owner' })
    expect(() => decide(db, { voucherId: id, approve: false }, { role: 'owner', name: 'Priya Owner' })).toThrow(/already been decided/)
  })

  it('re-gates an alteration that raises an approved entry past the threshold', () => {
    // Raising a ₹40,000 entry to ₹4,00,000 after approval is exactly the move the threshold
    // exists to catch. Letting the old decision stand would make the whole thing decorative.
    const db = withUsers(seededDb())
    setApprovalThreshold(db, 5000000)
    const id = post(db, 1000000, ACCOUNTANT)
    expect(pendingCount(db)).toBe(0)

    const vt = (db.prepare("SELECT id FROM voucher_types WHERE kind = 'receipt'").get() as { id: number }).id
    saveVoucher(
      db,
      {
        voucherTypeId: vt,
        date: '2026-08-01',
        partyLedgerId: null,
        narration: null,
        reference: null,
        instrumentNo: null,
        instrumentDate: null,
        transporterId: null,
        vehicleNo: null,
        transportDistanceKm: null,
        currencyCode: null,
        exchangeRate: null,
        lines: [
          { ledgerId: ledger(db, 'Cash'), drCr: 'dr', amount: 40000000, costAllocations: [] },
          { ledgerId: ledger(db, 'Owner Capital'), drCr: 'cr', amount: 40000000, costAllocations: [] }
        ],
        inventory: [],
        billRefs: [],
        tds: null
      },
      id,
      ACCOUNTANT
    )

    expect(pendingCount(db)).toBe(1)
  })

  it('leaves an old approval on the record after the threshold is switched off', () => {
    const db = withUsers(seededDb())
    setApprovalThreshold(db, 5000000)
    const id = post(db, 6000000, ACCOUNTANT)
    decide(db, { voucherId: id, approve: true }, { role: 'owner', name: 'Priya Owner' })
    setApprovalThreshold(db, null)

    const row = db.prepare('SELECT approval_state AS s, approval_by AS by FROM vouchers WHERE id = ?').get(id) as
      { s: string; by: string }
    expect(row.s).toBe('approved')
    expect(row.by).toBe('Priya Owner')
  })
})
