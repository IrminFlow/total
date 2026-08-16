import { describe, it, expect } from 'vitest'
import { seededDb, postSimpleVoucher } from '../db/testdb'
import { createLedger } from './masters'
import { trialBalance, ledgerStatement, dashboard } from './reports'

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
      hsn: null,
      tdsSectionId: null,
      pan: null,
      creditDays: null,
      exportType: null
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
      hsn: null,
      tdsSectionId: null,
      pan: null,
      creditDays: null,
      exportType: null
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

describe('dashboard v2', () => {
  it('ranks top receivables/payables, walks a 30-day cash spark, and counts masters', () => {
    const db = seededDb()

    const debtorsGroup = db.prepare("SELECT id FROM groups WHERE name = 'Sundry Debtors'").get() as { id: number }
    const creditorsGroup = db.prepare("SELECT id FROM groups WHERE name = 'Sundry Creditors'").get() as { id: number }
    const unitId = (db.prepare('SELECT id FROM units LIMIT 1').get() as { id: number }).id
    const stockGroupId = (db.prepare('SELECT id FROM stock_groups LIMIT 1').get() as { id: number } | undefined)?.id
      ?? (db.prepare("INSERT INTO stock_groups (name) VALUES ('Test Group')").run().lastInsertRowid as number)

    const partyLedger = { gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null }

    const bigDebtor = createLedger(db, { name: 'Big Debtor', groupId: debtorsGroup.id, openingBalance: 500000, ...partyLedger })
    createLedger(db, { name: 'Small Debtor', groupId: debtorsGroup.id, openingBalance: 100000, ...partyLedger })
    const bigCreditor = createLedger(db, { name: 'Big Creditor', groupId: creditorsGroup.id, openingBalance: -300000, ...partyLedger })
    createLedger(db, { name: 'Small Creditor', groupId: creditorsGroup.id, openingBalance: -50000, ...partyLedger })

    db.prepare('INSERT INTO stock_items (name, group_id, unit_id, opening_qty_milli, opening_value) VALUES (?, ?, ?, 0, 0)')
      .run('Widget', stockGroupId, unitId)
    db.prepare(
      `INSERT INTO employees (name, basic, hra, special, pf_enabled, esi_enabled, pt_enabled, active)
       VALUES ('Employee One', 0, 0, 0, 1, 1, 1, 1)`
    ).run()

    // Cash movement across a few days within the trailing-30 window ending on `today`.
    const today = '2025-05-15'
    postSimpleVoucher(db, { date: '2025-05-01', amount: 40000, kind: 'receipt' })
    postSimpleVoucher(db, { date: '2025-05-10', amount: 15000, kind: 'payment' })

    const cashLedger = db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }
    const cashOpening = (db.prepare('SELECT opening_balance AS ob FROM ledgers WHERE id = ?').get(cashLedger.id) as { ob: number }).ob

    const d = dashboard(db, today, '2025-04-01')

    expect(d.topReceivables).toHaveLength(2)
    expect(d.topReceivables[0]).toMatchObject({ ledgerId: bigDebtor.id, name: 'Big Debtor', amount: 500000 })
    expect(d.topPayables[0]).toMatchObject({ ledgerId: bigCreditor.id, name: 'Big Creditor', amount: 300000 })
    // Every payable amount must be positive (sign-flipped from the natural credit balance).
    expect(d.topPayables.every((r) => r.amount > 0)).toBe(true)

    expect(d.cashSpark).toHaveLength(30)
    expect(d.cashSpark[0]!.date).toBe('2025-04-16')
    expect(d.cashSpark[d.cashSpark.length - 1]!.date).toBe(today)
    // Before any movement in the window, the balance carries the ledger's opening balance forward.
    expect(d.cashSpark[0]!.balance).toBe(cashOpening)
    // After the 1 May receipt (+40000) and 10 May payment (-15000): opening + 40000 - 15000.
    const may10 = d.cashSpark.find((p) => p.date === '2025-05-10')!
    expect(may10.balance).toBe(cashOpening + 40000 - 15000)
    const may15 = d.cashSpark.find((p) => p.date === today)!
    expect(may15.balance).toBe(may10.balance)

    expect(d.voucherCount).toBe(2)
    expect(d.partyCount).toBe(4)
    expect(d.itemCount).toBe(1)
    expect(d.hasEmployees).toBe(true)
  })

  it('reports hasEmployees false and empty top-lists for a bare seeded company', () => {
    const db = seededDb()
    const d = dashboard(db, '2025-05-15', '2025-04-01')
    expect(d.hasEmployees).toBe(false)
    expect(d.topReceivables).toEqual([])
    expect(d.topPayables).toEqual([])
    expect(d.itemCount).toBe(0)
    expect(d.voucherCount).toBe(0)
    expect(d.cashSpark).toHaveLength(30)
  })
})
