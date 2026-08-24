/** DB-layer tests for the v0.3 lane-R report additions (#53–#60). */
import { describe, it, expect } from 'vitest'
import type { DB } from '../db/connection'
import { seededDb, postSimpleVoucher } from '../db/testdb'
import { createLedger } from './masters'
import { saveVoucher } from './vouchers'
import type { VoucherInput } from '@shared/schemas'
import {
  cashFlow, dashboard, ledgerStatement, trialBalance, profitAndLoss, balanceSheet,
  stockAgeing, itemProfitability, exceptions
} from './reports'

const LEDGER_DEFAULTS = {
  gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null,
  tdsSectionId: null, pan: null, creditDays: null, exportType: null
}

function groupId(db: DB, name: string): number {
  return (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
}

function postLines(
  db: DB,
  kind: string,
  date: string,
  lines: { ledgerId: number; drCr: 'dr' | 'cr'; amount: number }[],
  partyLedgerId: number | null = null,
  inventory: { stockItemId: number; qtyMilli: number; ratePaise: number; amount: number; direction: 'in' | 'out' }[] = [],
  narration: string | null = 'test narration'
): number {
  const vt = db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }
  const input = {
    voucherTypeId: vt.id, date, partyLedgerId, narration, reference: null,
    instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null,
    transportDistanceKm: null, currencyCode: null, exchangeRate: null,
    lines: lines.map((l) => ({ ...l, costAllocations: [] })),
    inventory: inventory.map((inv) => ({ ...inv, godownId: null })),
    billRefs: [], tds: null
  } as VoucherInput
  return saveVoucher(db, input).id
}

function makeItem(db: DB, name: string, openingQtyMilli = 0, openingValue = 0, reorderLevelMilli: number | null = null): number {
  const unitId = (db.prepare("SELECT id FROM units WHERE symbol = 'Nos'").get() as { id: number }).id
  return Number(
    db.prepare(
      'INSERT INTO stock_items (name, unit_id, opening_qty_milli, opening_value, reorder_level_milli) VALUES (?, ?, ?, ?, ?)'
    ).run(name, unitId, openingQtyMilli, openingValue, reorderLevelMilli).lastInsertRowid
  )
}

describe('cashFlow (#53)', () => {
  it('splits activities and reconciles net change to the cash+bank movement', () => {
    const db = seededDb()
    const cash = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
    const fixtures = createLedger(db, { ...LEDGER_DEFAULTS, name: 'Fixtures', groupId: groupId(db, 'Fixed Assets'), openingBalance: 0 }).id
    const debtor = createLedger(db, { ...LEDGER_DEFAULTS, name: 'Debtor A', groupId: groupId(db, 'Sundry Debtors'), openingBalance: 0 }).id
    const sales = createLedger(db, { ...LEDGER_DEFAULTS, name: 'Sales Local', groupId: groupId(db, 'Sales Accounts'), openingBalance: 0 }).id
    const rent = createLedger(db, { ...LEDGER_DEFAULTS, name: 'Rent', groupId: groupId(db, 'Indirect Expenses'), openingBalance: 0 }).id

    postLines(db, 'receipt', '2025-04-05', [
      { ledgerId: cash, drCr: 'dr', amount: 50000 },
      { ledgerId: sales, drCr: 'cr', amount: 50000 }
    ])
    postLines(db, 'payment', '2025-04-10', [
      { ledgerId: rent, drCr: 'dr', amount: 20000 },
      { ledgerId: cash, drCr: 'cr', amount: 20000 }
    ])
    // Credit sale: debtors up 5000 (working capital absorbs the profit).
    postLines(db, 'sales', '2025-04-15', [
      { ledgerId: debtor, drCr: 'dr', amount: 5000 },
      { ledgerId: sales, drCr: 'cr', amount: 5000 }
    ], debtor)
    // Fixed asset bought for cash: investing outflow.
    postLines(db, 'payment', '2025-04-20', [
      { ledgerId: fixtures, drCr: 'dr', amount: 10000 },
      { ledgerId: cash, drCr: 'cr', amount: 10000 }
    ])

    const cf = cashFlow(db, '2025-04-01', '2025-04-30')
    expect(cf.netProfit).toBe(35000)
    expect(cf.operating).toEqual([{ name: 'Current Assets', amount: -5000 }])
    expect(cf.operatingTotal).toBe(30000)
    expect(cf.investing).toEqual([{ name: 'Fixed Assets', amount: -10000 }])
    expect(cf.investingTotal).toBe(-10000)
    expect(cf.financing).toEqual([])
    expect(cf.netChange).toBe(20000)
    expect(cf.openingCash).toBe(0)
    expect(cf.closingCash).toBe(20000)
    expect(cf.netChange).toBe(cf.closingCash - cf.openingCash)
  })
})

describe('columnar monthly ledger (#55)', () => {
  it('returns a month matrix with carried closings when groupBy month is requested', () => {
    const db = seededDb()
    postSimpleVoucher(db, { date: '2025-04-10', amount: 50000, kind: 'receipt' })
    postSimpleVoucher(db, { date: '2025-06-05', amount: 20000, kind: 'payment' })
    const cash = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id

    const plain = ledgerStatement(db, cash, '2025-04-01', '2025-07-31')
    expect(plain.periods).toBeUndefined()

    const stmt = ledgerStatement(db, cash, '2025-04-01', '2025-07-31', 'month')
    expect(stmt.periods).toEqual([
      { period: '2025-04', label: 'Apr 2025', debit: 50000, credit: 0, closing: 50000 },
      { period: '2025-05', label: 'May 2025', debit: 0, credit: 0, closing: 50000 },
      { period: '2025-06', label: 'Jun 2025', debit: 0, credit: 20000, closing: 30000 },
      { period: '2025-07', label: 'Jul 2025', debit: 0, credit: 0, closing: 30000 }
    ])
  })
})

describe('trial balance opening/movement columns (#56)', () => {
  it('carries opening, gross movement, and closing per ledger, with totals', () => {
    const db = seededDb()
    const fixtures = createLedger(db, { ...LEDGER_DEFAULTS, name: 'Fixtures', groupId: groupId(db, 'Fixed Assets'), openingBalance: 70000 }).id
    createLedger(db, { ...LEDGER_DEFAULTS, name: 'Capital', groupId: groupId(db, 'Capital Account'), openingBalance: -70000 })
    postSimpleVoucher(db, { date: '2025-04-10', amount: 50000, kind: 'receipt' })
    postSimpleVoucher(db, { date: '2025-04-20', amount: 20000, kind: 'payment' })

    const tb = trialBalance(db, '2025-04-30')
    const cashRow = tb.rows.find((r) => r.ledgerName === 'Cash')!
    expect(cashRow).toMatchObject({ opening: 0, movementDebit: 50000, movementCredit: 20000, debit: 30000, credit: 0 })
    const fixturesRow = tb.rows.find((r) => r.ledgerId === fixtures)!
    expect(fixturesRow).toMatchObject({ opening: 70000, movementDebit: 0, movementCredit: 0, debit: 70000 })
    expect(tb.openingDebitTotal).toBe(70000)
    expect(tb.openingCreditTotal).toBe(70000)
    expect(tb.movementDebitTotal).toBe(tb.movementCreditTotal)
    expect(tb.totalDebit).toBe(tb.totalCredit)
  })

  it('keeps a ledger whose closing nets to zero but which had movement', () => {
    const db = seededDb()
    postSimpleVoucher(db, { date: '2025-04-10', amount: 50000, kind: 'receipt' })
    postSimpleVoucher(db, { date: '2025-04-20', amount: 50000, kind: 'payment' })
    const tb = trialBalance(db, '2025-04-30')
    const cashRow = tb.rows.find((r) => r.ledgerName === 'Cash')
    expect(cashRow).toMatchObject({ debit: 0, credit: 0, movementDebit: 50000, movementCredit: 50000 })
  })
})

describe('prior-year comparison (#57)', () => {
  it('attaches the year-earlier P&L and balance sheet when asked', () => {
    const db = seededDb()
    postSimpleVoucher(db, { date: '2024-05-10', amount: 30000, kind: 'receipt' })
    postSimpleVoucher(db, { date: '2025-05-10', amount: 80000, kind: 'receipt' })

    const pnl = profitAndLoss(db, '2025-04-01', '2026-03-31', { comparePrior: true })
    expect(pnl.netProfit).toBe(80000)
    expect(pnl.prior?.period).toEqual({ from: '2024-04-01', to: '2025-03-31' })
    expect(pnl.prior?.netProfit).toBe(30000)
    expect(pnl.prior?.prior).toBeUndefined()

    const bs = balanceSheet(db, '2024-04-01', '2026-03-31', true)
    expect(bs.prior?.asOn).toBe('2025-03-31')
    expect(bs.prior?.prior).toBeUndefined()

    expect(profitAndLoss(db, '2025-04-01', '2026-03-31').prior).toBeUndefined()
  })
})

describe('stock ageing + reorder (#58)', () => {
  it('buckets held qty by inward age, flags slow movers and reorder breaches', () => {
    const db = seededDb()
    const cash = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
    const purchases = createLedger(db, { ...LEDGER_DEFAULTS, name: 'Purchases', groupId: groupId(db, 'Purchase Accounts'), openingBalance: 0 }).id
    // Opening 2, bought 5 on 15 May (46d old at asOn), bought 2 on 25 Jun (5d), sold 3 on 1 Jun.
    const widget = makeItem(db, 'Widget', 2000, 100000, 8000)
    postLines(db, 'purchase', '2025-05-15', [
      { ledgerId: purchases, drCr: 'dr', amount: 250000 }, { ledgerId: cash, drCr: 'cr', amount: 250000 }
    ], null, [{ stockItemId: widget, qtyMilli: 5000, ratePaise: 50000, amount: 250000, direction: 'in' }])
    postLines(db, 'purchase', '2025-06-25', [
      { ledgerId: purchases, drCr: 'dr', amount: 100000 }, { ledgerId: cash, drCr: 'cr', amount: 100000 }
    ], null, [{ stockItemId: widget, qtyMilli: 2000, ratePaise: 50000, amount: 100000, direction: 'in' }])
    postLines(db, 'sales', '2025-06-01', [
      { ledgerId: cash, drCr: 'dr', amount: 240000 },
      { ledgerId: createLedger(db, { ...LEDGER_DEFAULTS, name: 'Sales Local', groupId: groupId(db, 'Sales Accounts'), openingBalance: 0 }).id, drCr: 'cr', amount: 240000 }
    ], null, [{ stockItemId: widget, qtyMilli: 3000, ratePaise: 80000, amount: 240000, direction: 'out' }])
    // A stale item: opening stock only, never sold.
    makeItem(db, 'Dust Collector', 1000, 5000)

    const rows = stockAgeing(db, '2025-06-30')
    const w = rows.find((r) => r.name === 'Widget')!
    // Closing 6: newest-first — 2 from 25 Jun (0-30), 4 from 15 May (31-60).
    expect(w.closingQtyMilli).toBe(6000)
    expect(w.buckets).toEqual([2000, 4000, 0, 0])
    expect(w.lastOutwardDate).toBe('2025-06-01')
    expect(w.slowMoving).toBe(false)
    expect(w.belowReorder).toBe(true) // closing 6 <= reorder 8

    const d = rows.find((r) => r.name === 'Dust Collector')!
    expect(d.buckets).toEqual([0, 0, 0, 1000]) // opening stock = unknown date = 90+
    expect(d.slowMoving).toBe(true)
    expect(d.belowReorder).toBe(false) // no reorder level set
  })

  it('physical-stock absolute lines PIN the quantity — they are not ordinary inward movements', () => {
    const db = seededDb()
    const cash = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
    const purchases = createLedger(db, { ...LEDGER_DEFAULTS, name: 'Purchases', groupId: groupId(db, 'Purchase Accounts'), openingBalance: 0 }).id
    const sales = createLedger(db, { ...LEDGER_DEFAULTS, name: 'Sales Local', groupId: groupId(db, 'Sales Accounts'), openingBalance: 0 }).id
    const psVt = (db.prepare("SELECT id FROM voucher_types WHERE kind = 'physical_stock'").get() as { id: number }).id
    const count = (itemId: number, date: string, qtyMilli: number): void => {
      saveVoucher(db, {
        voucherTypeId: psVt, date, partyLedgerId: null, narration: null, reference: null,
        instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null,
        transportDistanceKm: null, currencyCode: null, exchangeRate: null, lines: [],
        inventory: [{ stockItemId: itemId, godownId: null, qtyMilli, ratePaise: 0, amount: 0, direction: 'in', isAbsolute: true }],
        billRefs: [], tds: null
      } as VoucherInput)
    }

    // Opening 0, purchase 100 on 1 Apr, sale of 40 on 1 May, count confirms 60 on 30 Jun.
    const widget = makeItem(db, 'Widget', 0, 0, 100000) // reorder level 100
    postLines(db, 'purchase', '2025-04-01', [
      { ledgerId: purchases, drCr: 'dr', amount: 5000000 }, { ledgerId: cash, drCr: 'cr', amount: 5000000 }
    ], null, [{ stockItemId: widget, qtyMilli: 100000, ratePaise: 50000, amount: 5000000, direction: 'in' }])
    postLines(db, 'sales', '2025-05-01', [
      { ledgerId: cash, drCr: 'dr', amount: 3200000 }, { ledgerId: sales, drCr: 'cr', amount: 3200000 }
    ], null, [{ stockItemId: widget, qtyMilli: 40000, ratePaise: 80000, amount: 3200000, direction: 'out' }])
    count(widget, '2025-06-30', 60000)

    // A second item whose count writes stock DOWN (shrinkage): 50 bought, count finds 45.
    const gasket = makeItem(db, 'Gasket', 0, 0)
    postLines(db, 'purchase', '2025-04-01', [
      { ledgerId: purchases, drCr: 'dr', amount: 500000 }, { ledgerId: cash, drCr: 'cr', amount: 500000 }
    ], null, [{ stockItemId: gasket, qtyMilli: 50000, ratePaise: 10000, amount: 500000, direction: 'in' }])
    count(gasket, '2025-06-15', 45000)

    const rows = stockAgeing(db, '2025-06-30')
    const w = rows.find((r) => r.name === 'Widget')!
    // The count PINS the level: closing is 60 (not 100 + 60 − 40 = 120), and no phantom
    // "fresh lot" appears on the count date — all 60 still age from the 1 Apr purchase (90d).
    expect(w.closingQtyMilli).toBe(60000)
    expect(w.buckets).toEqual([0, 0, 60000, 0])
    // The true closing 60 ≤ reorder 100 — the inflated 120 used to mask the breach.
    expect(w.belowReorder).toBe(true)

    const g = rows.find((r) => r.name === 'Gasket')!
    expect(g.closingQtyMilli).toBe(45000) // 50 − 5 written off by the count
    expect(g.buckets).toEqual([0, 0, 45000, 0])
    // A count write-down is a correction, not a consumption — it must not reset staleness.
    expect(g.lastOutwardDate).toBeNull()
  })
})

describe('item-wise profitability (#59)', () => {
  it('computes sales value minus weighted-average COGS per item', () => {
    const db = seededDb()
    const cash = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
    const purchases = createLedger(db, { ...LEDGER_DEFAULTS, name: 'Purchases', groupId: groupId(db, 'Purchase Accounts'), openingBalance: 0 }).id
    const sales = createLedger(db, { ...LEDGER_DEFAULTS, name: 'Sales Local', groupId: groupId(db, 'Sales Accounts'), openingBalance: 0 }).id
    // Opening 10 @ ₹40 (40000 paise value 400000), buy 10 @ ₹60 → pool 20 @ avg ₹50.
    const widget = makeItem(db, 'Widget', 10000, 400000)
    postLines(db, 'purchase', '2025-04-10', [
      { ledgerId: purchases, drCr: 'dr', amount: 600000 }, { ledgerId: cash, drCr: 'cr', amount: 600000 }
    ], null, [{ stockItemId: widget, qtyMilli: 10000, ratePaise: 60000, amount: 600000, direction: 'in' }])
    // Sell 8 @ ₹90 = 720000; COGS = 8 × ₹50 = 400000; profit 320000.
    postLines(db, 'sales', '2025-05-05', [
      { ledgerId: cash, drCr: 'dr', amount: 720000 }, { ledgerId: sales, drCr: 'cr', amount: 720000 }
    ], null, [{ stockItemId: widget, qtyMilli: 8000, ratePaise: 90000, amount: 720000, direction: 'out' }])

    const rows = itemProfitability(db, '2025-04-01', '2025-06-30')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      name: 'Widget', outQtyMilli: 8000, salesValue: 720000, cogs: 400000, profit: 320000
    })
  })
})

describe('exception reports (#60)', () => {
  it('finds negative stock, missing narration, outside-period entries, and missing GST', () => {
    const db = seededDb()
    const cash = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
    const sales = createLedger(db, { ...LEDGER_DEFAULTS, name: 'Sales Local', groupId: groupId(db, 'Sales Accounts'), openingBalance: 0 }).id
    const gstParty = createLedger(db, {
      ...LEDGER_DEFAULTS, name: 'B2B Party', groupId: groupId(db, 'Sundry Debtors'), openingBalance: 0,
      gstin: '27AAPFU0939F1ZV', stateCode: '27'
    }).id
    // Sell 3 of an item that has none in stock -> negative stock.
    const widget = makeItem(db, 'Widget')
    postLines(db, 'sales', '2025-05-05', [
      { ledgerId: gstParty, drCr: 'dr', amount: 90000 }, { ledgerId: sales, drCr: 'cr', amount: 90000 }
    ], gstParty, [{ stockItemId: widget, qtyMilli: 3000, ratePaise: 30000, amount: 90000, direction: 'out' }], null)
    // Outside the working period.
    postLines(db, 'receipt', '2026-05-01', [
      { ledgerId: cash, drCr: 'dr', amount: 1000 }, { ledgerId: sales, drCr: 'cr', amount: 1000 }
    ])

    const report = exceptions(db, '2025-04-01', '2026-03-31')
    const by = new Map(report.sections.map((s) => [s.key, s]))
    expect(by.get('negativeStock')!.count).toBe(1)
    expect(by.get('negativeStock')!.rows[0]!.label).toBe('Widget')
    expect(by.get('missingNarration')!.count).toBe(1) // the sales voucher was posted without one
    expect(by.get('outsidePeriod')!.count).toBe(1)
    expect(by.get('unbalanced')!.count).toBe(0)
    // B2B party with GSTIN but no cgst/sgst/igst line on the invoice.
    expect(by.get('missingGst')!.count).toBe(1)
    expect(by.get('missingGst')!.rows[0]!.voucherId).toBeDefined()
    expect(by.get('negativeCash')!.count).toBe(0)
    expect(by.get('singleLedger')!.count).toBe(0)
  })

  it('flags a purchase whose section 16(4) credit window has shut, and leaves a fresh one alone', () => {
    // Input credit lapses 30 November of the following FY, and is then gone rather than deferred.
    // An old purchase otherwise sits in the books looking exactly like one from last month.
    const db = seededDb()
    const purchases = createLedger(db, {
      ...LEDGER_DEFAULTS, name: 'Purchases', groupId: groupId(db, 'Purchase Accounts'), openingBalance: 0
    }).id
    const cgst = createLedger(db, {
      ...LEDGER_DEFAULTS, name: 'CGST Input', groupId: groupId(db, 'Duties & Taxes'), openingBalance: 0,
      taxType: 'cgst'
    }).id
    const vendor = createLedger(db, {
      ...LEDGER_DEFAULTS, name: 'Old Vendor', groupId: groupId(db, 'Sundry Creditors'), openingBalance: 0,
      gstin: '27AAPFU0939F1ZV', stateCode: '27'
    }).id

    const buy = (date: string): void => {
      postLines(db, 'purchase', date, [
        { ledgerId: purchases, drCr: 'dr', amount: 100000 },
        { ledgerId: cgst, drCr: 'dr', amount: 9000 },
        { ledgerId: vendor, drCr: 'cr', amount: 109000 }
      ], vendor)
    }

    // FY 2020-21: the window shut 30 Nov 2021, long past whenever this test runs.
    buy('2020-06-15')
    // And one dated today, which cannot be at risk.
    buy(new Date().toISOString().slice(0, 10))

    const section = exceptions(db, '2020-04-01', '2021-03-31').sections.find((x) => x.key === 'itcAtRisk')!
    expect(section.count).toBe(1)
    expect(section.rows[0]!.detail).toMatch(/credit window shut/)
    // The row is drillable — the point is to open the voucher and deal with it.
    expect(section.rows[0]!.voucherId).toBeDefined()
  })

  it('ignores a purchase with no input tax on it, which has no credit to lose', () => {
    const db = seededDb()
    const purchases = createLedger(db, {
      ...LEDGER_DEFAULTS, name: 'Purchases', groupId: groupId(db, 'Purchase Accounts'), openingBalance: 0
    }).id
    const vendor = createLedger(db, {
      ...LEDGER_DEFAULTS, name: 'Unregistered Vendor', groupId: groupId(db, 'Sundry Creditors'), openingBalance: 0
    }).id
    postLines(db, 'purchase', '2020-06-15', [
      { ledgerId: purchases, drCr: 'dr', amount: 100000 },
      { ledgerId: vendor, drCr: 'cr', amount: 100000 }
    ], vendor)

    const section = exceptions(db, '2020-04-01', '2021-03-31').sections.find((x) => x.key === 'itcAtRisk')!
    expect(section.count).toBe(0)
  })

  it('reports a gap left by a deleted voucher, and nothing on an unbroken series', () => {
    // A missing invoice number is the first thing an auditor asks about. The bin is a soft
    // delete, so the number is not reissued — which is correct, and is what leaves the hole.
    const db = seededDb()
    const cash = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
    const sales = createLedger(db, {
      ...LEDGER_DEFAULTS, name: 'Sales', groupId: groupId(db, 'Sales Accounts'), openingBalance: 0
    }).id

    const ids: number[] = []
    for (let i = 0; i < 4; i++) {
      ids.push(
        postLines(db, 'receipt', '2026-05-01', [
          { ledgerId: cash, drCr: 'dr', amount: 1000 },
          { ledgerId: sales, drCr: 'cr', amount: 1000 }
        ])
      )
    }

    const clean = exceptions(db, '2026-04-01', '2027-03-31').sections.find((x) => x.key === 'numberGaps')!
    expect(clean.count).toBe(0)

    // Delete the second of four: 1, _, 3, 4.
    db.prepare("UPDATE vouchers SET deleted_at = '2026-06-01T00:00:00Z' WHERE id = ?").run(ids[1])
    const withGap = exceptions(db, '2026-04-01', '2027-03-31').sections.find((x) => x.key === 'numberGaps')!
    expect(withGap.count).toBe(1)
    expect(withGap.rows[0]!.label).toMatch(/2$/)
    expect(withGap.rows[0]!.detail).toMatch(/1 number missing/)
  })

  it('ignores a soft-deleted purchase', () => {
    const db = seededDb()
    const purchases = createLedger(db, {
      ...LEDGER_DEFAULTS, name: 'Purchases', groupId: groupId(db, 'Purchase Accounts'), openingBalance: 0
    }).id
    const cgst = createLedger(db, {
      ...LEDGER_DEFAULTS, name: 'CGST Input', groupId: groupId(db, 'Duties & Taxes'), openingBalance: 0,
      taxType: 'cgst'
    }).id
    const vendor = createLedger(db, {
      ...LEDGER_DEFAULTS, name: 'Vendor', groupId: groupId(db, 'Sundry Creditors'), openingBalance: 0
    }).id
    postLines(db, 'purchase', '2020-06-15', [
      { ledgerId: purchases, drCr: 'dr', amount: 100000 },
      { ledgerId: cgst, drCr: 'dr', amount: 9000 },
      { ledgerId: vendor, drCr: 'cr', amount: 109000 }
    ], vendor)
    db.prepare("UPDATE vouchers SET deleted_at = '2021-01-01T00:00:00Z'").run()

    const section = exceptions(db, '2020-04-01', '2021-03-31').sections.find((x) => x.key === 'itcAtRisk')!
    expect(section.count).toBe(0)
  })
})

describe('dashboard ratios (#54)', () => {
  it('exposes an FY-to-date ratio panel', () => {
    const db = seededDb()
    postSimpleVoucher(db, { date: '2025-04-05', amount: 50000, kind: 'sales' })
    const d = dashboard(db, '2025-04-30', '2025-04-01')
    // Cash 50000 is a current asset; no current liabilities -> ratio null; sales flowed 50000.
    expect(d.ratios.currentRatio).toBeNull()
    expect(d.ratios.debtorDays).toBe(0)
    expect(d.ratios.grossMarginPct).toBe(100)
    expect(d.ratios.netMarginPct).toBe(100)
  })
})
