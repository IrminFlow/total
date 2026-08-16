/** v0.3 lane R — correctness bug batch (#61–#64, #68, #69). One test per bug, written failing first. */
import { describe, it, expect } from 'vitest'
import type { DB } from '../db/connection'
import { seededDb, postSimpleVoucher } from '../db/testdb'
import { createLedger, createStockItem, listUnits } from './masters'
import { saveVoucher } from './vouchers'
import type { VoucherInputParsed } from '@shared/schemas'
import { dayBook, trialBalance, balanceSheet, stockSummary } from './reports'
import { outstandings } from './analysis'
import { importItems } from './importers'

const LEDGER_DEFAULTS = {
  gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null,
  tdsSectionId: null, pan: null, creditDays: null, exportType: null
}

function groupId(db: DB, name: string): number {
  return (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
}

function voucherInput(
  db: DB,
  kind: string,
  date: string,
  lines: { ledgerId: number; drCr: 'dr' | 'cr'; amount: number }[],
  extra: Partial<{ number: string; partyLedgerId: number | null }> = {}
): VoucherInputParsed {
  const vt = db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }
  return {
    voucherTypeId: vt.id, date, partyLedgerId: extra.partyLedgerId ?? null,
    number: extra.number, narration: null, reference: null,
    instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null,
    transportDistanceKm: null, currencyCode: null, exchangeRate: null,
    lines: lines.map((l) => ({ ...l, costAllocations: [] })),
    inventory: [], billRefs: [], tds: null
  } as VoucherInputParsed
}

describe('#61 — Day Book real Dr/Cr split', () => {
  it("puts the account's amount on its actual side instead of both columns", () => {
    const db = seededDb()
    // Receipt: Cash dr 50000 / Sales Account cr — the shown account (Cash) is a debit.
    postSimpleVoucher(db, { date: '2025-04-05', amount: 50000, kind: 'receipt' })
    // Payment: Sales Account dr / Cash cr 20000 — shown account (Sales Account) is a debit too,
    // but a receipt against a party shows on the credit side:
    const debtor = createLedger(db, { ...LEDGER_DEFAULTS, name: 'Debtor A', groupId: groupId(db, 'Sundry Debtors'), openingBalance: 0 }).id
    const cash = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
    saveVoucher(db, voucherInput(db, 'receipt', '2025-04-10', [
      { ledgerId: cash, drCr: 'dr', amount: 30000 },
      { ledgerId: debtor, drCr: 'cr', amount: 30000 }
    ], { partyLedgerId: debtor }))

    const rows = dayBook(db, '2025-04-01', '2025-04-30')
    expect(rows).toHaveLength(2)
    const cashReceipt = rows.find((r) => r.account === 'Cash')!
    expect(cashReceipt.debit).toBe(50000)
    expect(cashReceipt.credit).toBe(0)
    const partyReceipt = rows.find((r) => r.account === 'Debtor A')!
    expect(partyReceipt.debit).toBe(0)
    expect(partyReceipt.credit).toBe(30000)
  })
})

describe('#62 — outstandings FY start for Jan–Mar asOn dates', () => {
  it('dates the opening-balance bill at the FY start of asOn, not asOn.year-04-01', () => {
    const db = seededDb()
    createLedger(db, { ...LEDGER_DEFAULTS, name: 'Old Debtor', groupId: groupId(db, 'Sundry Debtors'), openingBalance: 100000 })
    // asOn Feb 2026 lies in FY 2025-26, whose start is 2025-04-01. The old code stamped
    // 2026-04-01 (a date in the FUTURE of asOn), zeroing the age.
    const parties = outstandings(db, 'receivable', '2026-02-15')
    expect(parties).toHaveLength(1)
    const bill = parties[0]!.bills[0]!
    expect(bill.date).toBe('2025-04-01')
    expect(bill.ageDays).toBe(320)
    expect(parties[0]!.buckets[3]).toBe(100000) // 90+ bucket
  })
})

describe('#63 — stock opening double-count guards', () => {
  it('skips the synthetic TB stock row and the BS opening-difference stock component when a Stock-in-Hand ledger exists', () => {
    const db = seededDb()
    const unitId = listUnits(db)[0]!.id
    createStockItem(db, {
      name: 'Widget', groupId: null, unitId, hsn: null, gstRate: null, cessRate: null,
      openingQtyMilli: 1000, openingValue: 500000, barcode: null, reorderLevelMilli: null
    })
    // The user also keeps a Stock-in-Hand ledger carrying the same opening — the books balance
    // against Capital with the LEDGER, so the synthetic figure must stand down.
    createLedger(db, { ...LEDGER_DEFAULTS, name: 'Stock in Hand A/c', groupId: groupId(db, 'Stock-in-Hand'), openingBalance: 500000 })
    createLedger(db, { ...LEDGER_DEFAULTS, name: 'Capital', groupId: groupId(db, 'Capital Account'), openingBalance: -500000 })

    const tb = trialBalance(db, '2025-04-30')
    expect(tb.rows.filter((r) => r.groupName === 'Stock-in-Hand')).toHaveLength(1) // the ledger only
    expect(tb.rows.find((r) => r.ledgerId === -1)).toBeUndefined()
    expect(tb.totalDebit).toBe(tb.totalCredit)

    const bs = balanceSheet(db, '2025-04-01', '2025-04-30')
    expect(bs.liabilities.find((n) => n.name === 'Difference in Opening Balances')).toBeUndefined()
  })

  it('still adds the synthetic figures when no Stock-in-Hand ledger exists', () => {
    const db = seededDb()
    const unitId = listUnits(db)[0]!.id
    createStockItem(db, {
      name: 'Widget', groupId: null, unitId, hsn: null, gstRate: null, cessRate: null,
      openingQtyMilli: 1000, openingValue: 500000, barcode: null, reorderLevelMilli: null
    })
    const tb = trialBalance(db, '2025-04-30')
    expect(tb.rows.find((r) => r.ledgerId === -1)).toMatchObject({ debit: 500000 })
  })
})

describe('#64 — stock summary explicit opening column', () => {
  it('separates opening from inwards instead of folding opening into inwardQtyMilli', () => {
    const db = seededDb()
    const unitId = listUnits(db)[0]!.id
    const widget = createStockItem(db, {
      name: 'Widget', groupId: null, unitId, hsn: null, gstRate: null, cessRate: null,
      openingQtyMilli: 2000, openingValue: 100000, barcode: null, reorderLevelMilli: null
    })
    const cash = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
    const purchases = createLedger(db, { ...LEDGER_DEFAULTS, name: 'Purchases', groupId: groupId(db, 'Purchase Accounts'), openingBalance: 0 }).id
    const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'purchase'").get() as { id: number }
    saveVoucher(db, {
      ...voucherInput(db, 'purchase', '2025-04-10', [
        { ledgerId: purchases, drCr: 'dr', amount: 150000 },
        { ledgerId: cash, drCr: 'cr', amount: 150000 }
      ]),
      voucherTypeId: vt.id,
      inventory: [{ stockItemId: widget.id, godownId: null, qtyMilli: 3000, ratePaise: 50000, amount: 150000, direction: 'in' }]
    })

    const rows = stockSummary(db, '2025-04-30')
    expect(rows[0]).toMatchObject({
      name: 'Widget',
      openingQtyMilli: 2000,
      openingValue: 100000,
      inwardQtyMilli: 3000, // pure inwards — no longer opening+inwards
      outwardQtyMilli: 0,
      closingQtyMilli: 5000,
      closingValue: 250000
    })
  })
})

describe('#68 — item re-import must not wipe cessRate/barcode', () => {
  it('preserves existing cessRate and barcode when the CSV has no such columns', () => {
    const db = seededDb()
    const unitId = listUnits(db)[0]!.id
    const unitName = listUnits(db)[0]!.name
    createStockItem(db, {
      name: 'Widget', groupId: null, unitId, hsn: '8471', gstRate: 18, cessRate: 5,
      openingQtyMilli: 0, openingValue: 0, barcode: 'BAR-1', reorderLevelMilli: 4000
    })
    const result = importItems(db, `Name,Unit,HSN,GST Rate\nWidget,${unitName},8471,18\n`)
    expect(result.updated).toBe(1)
    expect(result.errors).toEqual([])
    const row = db.prepare("SELECT cess_rate, barcode, reorder_level_milli FROM stock_items WHERE name = 'Widget'").get() as {
      cess_rate: number | null; barcode: string | null; reorder_level_milli: number | null
    }
    expect(row.cess_rate).toBe(5)
    expect(row.barcode).toBe('BAR-1')
    expect(row.reorder_level_milli).toBe(4000)
  })
})

describe('#69 — duplicate voucher number soft guard', () => {
  it('flags a save that reuses an existing (type, number) pair', () => {
    const db = seededDb()
    const first = saveVoucher(db, voucherInput(db, 'journal', '2025-04-05', [
      { ledgerId: 1, drCr: 'dr', amount: 1000 }, { ledgerId: 1, drCr: 'cr', amount: 1000 }
    ], { number: 'J-7' }))
    expect(first.duplicateNumber).toBeFalsy()

    const dup = saveVoucher(db, voucherInput(db, 'journal', '2025-04-06', [
      { ledgerId: 1, drCr: 'dr', amount: 2000 }, { ledgerId: 1, drCr: 'cr', amount: 2000 }
    ], { number: 'J-7' }))
    expect(dup.duplicateNumber).toBe(true)

    // Editing the SAME voucher keeping its own number is not a duplicate.
    const edited = saveVoucher(db, voucherInput(db, 'journal', '2025-04-05', [
      { ledgerId: 1, drCr: 'dr', amount: 1500 }, { ledgerId: 1, drCr: 'cr', amount: 1500 }
    ], { number: 'J-7' }), first.id)
    expect(edited.duplicateNumber).toBe(true) // still duplicated by the second voucher

    // A different voucher type may reuse the number freely.
    const otherKind = saveVoucher(db, voucherInput(db, 'receipt', '2025-04-07', [
      { ledgerId: 1, drCr: 'dr', amount: 3000 }, { ledgerId: 1, drCr: 'cr', amount: 3000 }
    ], { number: 'J-7' }))
    expect(otherKind.duplicateNumber).toBeFalsy()
  })
})
