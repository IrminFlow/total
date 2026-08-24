import { describe, it, expect, beforeEach } from 'vitest'
import { seededDb, postSimpleVoucher, TEST_INFO } from '../db/testdb'
import { freshDb } from '../db/testdb'
import { seedCompany } from '../db/seed'
import { setAuditContext } from './audit'
import { exportPortable, importPortable } from './portable'
import { trialBalance } from './reports'
import { createLedger, createStockItem, createUnit } from './masters'
import { stockItemInputSchema } from '@shared/schemas'
import { saveVoucher } from './vouchers'
import { validatePortable, portableTotals } from '@shared/portable'

/** A company with masters, opening balances, inventory and a handful of entries. */
function bookedDb(): ReturnType<typeof seededDb> {
  const db = seededDb()
  const sales = db.prepare("SELECT id FROM groups WHERE name = 'Sales Accounts'").get() as { id: number }
  createLedger(db, {
    name: 'Kirti Traders',
    groupId: sales.id,
    openingBalance: 250000,
    gstin: '27AAPFU0939F1ZV',
    stateCode: '27',
    address: 'Pune',
    taxType: null,
    gstRate: null,
    hsn: null,
    tdsSectionId: null,
    pan: null,
    creditDays: 30,
    exportType: null
  })
  const unit = createUnit(db, { name: 'Cartons', symbol: 'ctn', decimals: 0, uqc: 'CTN' })
  createStockItem(
    db,
    stockItemInputSchema.parse({
      name: 'Widget',
      groupId: null,
      unitId: unit.id,
      hsn: '8482',
      gstRate: 18,
      cessRate: null,
      openingQtyMilli: 10_000,
      openingValue: 500000
    })
  )
  postSimpleVoucher(db, { date: '2026-04-01', amount: 125000, kind: 'receipt' })
  postSimpleVoucher(db, { date: '2026-04-02', amount: 47500, kind: 'payment' })

  // One voucher carrying stock, so the inventory lines are in the round trip too.
  const sale = db.prepare("SELECT id FROM voucher_types WHERE kind = 'sales'").get() as { id: number }
  const cash = db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }
  const salesLedger = db.prepare("SELECT id FROM ledgers WHERE name = 'Sales Account'").get() as { id: number }
  const item = db.prepare("SELECT id FROM stock_items WHERE name = 'Widget'").get() as { id: number }
  saveVoucher(db, {
    voucherTypeId: sale.id,
    date: '2026-04-03',
    partyLedgerId: null,
    narration: 'Counter sale',
    reference: 'REF-9',
    instrumentNo: null,
    instrumentDate: null,
    transporterId: null,
    vehicleNo: null,
    transportDistanceKm: null,
    currencyCode: null,
    exchangeRate: null,
    lines: [
      { ledgerId: cash.id, drCr: 'dr', amount: 100000, costAllocations: [] },
      { ledgerId: salesLedger.id, drCr: 'cr', amount: 100000, costAllocations: [] }
    ],
    inventory: [{ stockItemId: item.id, godownId: null, qtyMilli: 2000, ratePaise: 50000, amount: 100000, direction: 'out' }],
    billRefs: [],
    tds: null
  })
  return db
}

describe('the open export format, end to end', () => {
  beforeEach(() => {
    setAuditContext({ appVersion: '0.4.0-test', getUserName: () => 'Asha' })
  })

  it('exports a document that validates against its own rules', () => {
    const doc = exportPortable(bookedDb())
    expect(validatePortable(doc)).toEqual([])
    expect(portableTotals(doc).vouchers).toBe(3)
    expect(portableTotals(doc).debits).toBe(portableTotals(doc).credits)
  })

  it('round-trips: what comes back out is what went in', () => {
    const source = bookedDb()
    const first = exportPortable(source)

    const target = freshDb()
    seedCompany(target, TEST_INFO)
    importPortable(target, JSON.parse(JSON.stringify(first)))
    const second = exportPortable(target)

    // exportedAt is the wall clock and nothing else; everything else must be identical.
    expect({ ...second, exportedAt: '' }).toEqual({ ...first, exportedAt: '' })
  })

  it('round-trips the money, not just the shape', () => {
    const source = bookedDb()
    const before = trialBalance(source, '2026-04-30')

    const target = freshDb()
    seedCompany(target, TEST_INFO)
    importPortable(target, exportPortable(source))
    const after = trialBalance(target, '2026-04-30')

    expect(after.totalDebit).toBe(before.totalDebit)
    expect(after.totalCredit).toBe(before.totalCredit)
    expect(after.rows.map((r) => [r.ledgerName, r.debit, r.credit])).toEqual(
      before.rows.map((r) => [r.ledgerName, r.debit, r.credit])
    )
  })

  it('carries opening balances and stock openings, which a voucher-only export would lose', () => {
    const source = bookedDb()
    const target = freshDb()
    seedCompany(target, TEST_INFO)
    importPortable(target, exportPortable(source))

    const ledger = target.prepare("SELECT opening_balance AS ob FROM ledgers WHERE name = 'Kirti Traders'").get() as {
      ob: number
    }
    expect(ledger.ob).toBe(250000)
    const item = target
      .prepare("SELECT opening_qty_milli AS qty, opening_value AS value FROM stock_items WHERE name = 'Widget'")
      .get() as { qty: number; value: number }
    expect(item).toEqual({ qty: 10_000, value: 500000 })
  })

  it('carries the inventory lines on a voucher', () => {
    const source = bookedDb()
    const target = freshDb()
    seedCompany(target, TEST_INFO)
    importPortable(target, exportPortable(source))

    const lines = target
      .prepare(
        `SELECT si.name, il.qty_milli AS qtyMilli, il.direction FROM inventory_lines il
         JOIN stock_items si ON si.id = il.stock_item_id`
      )
      .all() as { name: string; qtyMilli: number; direction: string }[]
    expect(lines).toEqual([{ name: 'Widget', qtyMilli: 2000, direction: 'out' }])
  })

  it('refuses to merge into books that already hold entries', () => {
    const source = bookedDb()
    const target = bookedDb()
    expect(() => importPortable(target, exportPortable(source))).toThrow(/already hold/)
  })

  it('refuses a document whose vouchers do not balance, rather than importing books that do not foot', () => {
    const doc = exportPortable(bookedDb()) as ReturnType<typeof exportPortable>
    doc.vouchers[0]!.lines[0]!.amount += 1
    const target = freshDb()
    seedCompany(target, TEST_INFO)
    expect(() => importPortable(target, doc)).toThrow(/balance/)
    const count = target.prepare('SELECT COUNT(*) AS n FROM vouchers').get() as { n: number }
    expect(count.n).toBe(0)
  })

  it('leaves nothing behind when an import fails halfway', () => {
    const doc = exportPortable(bookedDb())
    doc.vouchers[doc.vouchers.length - 1]!.lines[0]!.ledger = 'A ledger that is not here'
    const target = freshDb()
    seedCompany(target, TEST_INFO)
    expect(() => importPortable(target, doc)).toThrow()
    const count = target.prepare('SELECT COUNT(*) AS n FROM vouchers').get() as { n: number }
    expect(count.n).toBe(0)
  })
})
