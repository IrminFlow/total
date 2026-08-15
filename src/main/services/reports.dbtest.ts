import { describe, it, expect } from 'vitest'
import { seededDb, postSimpleVoucher } from '../db/testdb'
import { createLedger } from './masters'
import { trialBalance, ledgerStatement } from './reports'

describe('trialBalance / ledgerStatement', () => {
  it('balances after mixed vouchers plus self-cancelling opening balances', () => {
    const db = seededDb()

    const fixedAssetsGroup = db.prepare("SELECT id FROM groups WHERE name = 'Fixed Assets'").get() as { id: number }
    const capitalGroup = db.prepare("SELECT id FROM groups WHERE name = 'Capital Account'").get() as { id: number }

    const fixtures = createLedger(db, {
      name: 'Fixtures',
      groupId: fixedAssetsGroup.id,
      openingBalance: 200000,
      gstin: null,
      stateCode: null,
      address: null,
      taxType: null,
      gstRate: null,
      hsn: null
    })
    createLedger(db, {
      name: "Owner's Capital",
      groupId: capitalGroup.id,
      openingBalance: -200000,
      gstin: null,
      stateCode: null,
      address: null,
      taxType: null,
      gstRate: null,
      hsn: null
    })

    postSimpleVoucher(db, { date: '2025-04-05', amount: 50000, kind: 'receipt' })
    postSimpleVoucher(db, { date: '2025-04-10', amount: 20000, kind: 'payment' })
    postSimpleVoucher(db, { date: '2025-04-15', amount: 30000, kind: 'journal' })

    const asOn = '2025-04-30'
    const tb = trialBalance(db, asOn)
    expect(tb.totalDebit).toBe(tb.totalCredit)

    // Sanity: both opening-balance ledgers show up, cancelling each other out.
    const fixturesRow = tb.rows.find((r) => r.ledgerId === fixtures.id)
    expect(fixturesRow).toMatchObject({ debit: 200000, credit: 0 })

    const cashLedger = db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }
    const cashRow = tb.rows.find((r) => r.ledgerId === cashLedger.id)!
    expect(cashRow).toMatchObject({ debit: 60000, credit: 0 })

    const stmt = ledgerStatement(db, cashLedger.id, '2025-01-01', asOn)
    expect(stmt.closing).toBe(cashRow.debit - cashRow.credit)
  })
})
