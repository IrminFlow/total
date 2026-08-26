/** DB-layer tests for the roadmap section C report additions (C57–C72). */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { DB } from '../db/connection'
import { seededDb } from '../db/testdb'
import { createLedger } from './masters'
import { saveVoucher } from './vouchers'
import type { VoucherInput } from '@shared/schemas'
import { dashboard, exceptions, itemProfitabilityByPeriod, ratios, trialBalance, whatChanged } from './reports'
import { cashForecast } from './cashForecast'
import { ccReport, saveCostCentre } from './costCentres'
import { deleteReportView, listReportViews, saveReportView } from './reportViews'
import { deleteSchedule, listSchedules, runSchedule, saveSchedule } from './reportSchedules'
import { renderDayBook, renderTrialBalance, toCsv, toXlsSheet } from './reportRender'
import { saveTemplate } from './recurring'

const LEDGER_DEFAULTS = {
  gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null,
  tdsSectionId: null, pan: null, creditDays: null, exportType: null
}

function groupId(db: DB, name: string): number {
  return (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
}

function ledger(db: DB, name: string, group: string, opening = 0): number {
  return createLedger(db, { ...LEDGER_DEFAULTS, name, groupId: groupId(db, group), openingBalance: opening }).id
}

function postLines(
  db: DB,
  kind: string,
  date: string,
  lines: { ledgerId: number; drCr: 'dr' | 'cr'; amount: number }[],
  extra: Partial<VoucherInput> = {}
): number {
  const vt = db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }
  return saveVoucher(db, {
    voucherTypeId: vt.id, date, partyLedgerId: null, narration: 'test', reference: null,
    instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null,
    transportDistanceKm: null, currencyCode: null, exchangeRate: null,
    lines: lines.map((l) => ({ ...l, costAllocations: [] })),
    inventory: [], billRefs: [], tds: null,
    ...extra
  } as VoucherInput).id
}

function makeItem(db: DB, name: string, openingQtyMilli = 0, openingValue = 0): number {
  const unitId = (db.prepare("SELECT id FROM units WHERE symbol = 'Nos'").get() as { id: number }).id
  return Number(
    db.prepare('INSERT INTO stock_items (name, unit_id, opening_qty_milli, opening_value) VALUES (?, ?, ?, ?)')
      .run(name, unitId, openingQtyMilli, openingValue).lastInsertRowid
  )
}

// ---------- C63: group subtotals need the primary group on every row ----------

describe('trialBalance topGroupName (C63)', () => {
  it('resolves each ledger to the primary group its own group descends from', () => {
    const db = seededDb()
    const debtor = ledger(db, 'Ram', 'Sundry Debtors', 100_00)
    const rows = trialBalance(db, '2025-04-30').rows
    const row = rows.find((r) => r.ledgerId === debtor)!
    expect(row.groupName).toBe('Sundry Debtors')
    expect(row.topGroupName).toBe('Current Assets')
  })

  it('gives a ledger sitting directly under a primary group that group as its own top', () => {
    const db = seededDb()
    const cap = ledger(db, 'Owner capital', 'Capital Account', -500_00)
    const row = trialBalance(db, '2025-04-30').rows.find((r) => r.ledgerId === cap)!
    expect(row.topGroupName).toBe('Capital Account')
  })

  it('every row carries one, so no ledger can vanish from a subtotalled report', () => {
    const db = seededDb()
    ledger(db, 'Ram', 'Sundry Debtors', 100_00)
    for (const r of trialBalance(db, '2025-04-30', true).rows) {
      expect(typeof r.topGroupName).toBe('string')
      expect(r.topGroupName!.length).toBeGreaterThan(0)
    }
  })
})

// ---------- C66: what changed ----------

describe('whatChanged (C66)', () => {
  it('reports the movement between two dates, biggest first', () => {
    const db = seededDb()
    const cash = ledger(db, 'Cash box', 'Cash-in-Hand')
    const sales = ledger(db, 'Sales A', 'Sales Accounts')
    const rent = ledger(db, 'Rent', 'Indirect Expenses')
    postLines(db, 'receipt', '2025-04-10', [
      { ledgerId: cash, drCr: 'dr', amount: 900_00 },
      { ledgerId: sales, drCr: 'cr', amount: 900_00 }
    ])
    postLines(db, 'payment', '2025-04-20', [
      { ledgerId: rent, drCr: 'dr', amount: 100_00 },
      { ledgerId: cash, drCr: 'cr', amount: 100_00 }
    ])

    const r = whatChanged(db, '2025-04-01', '2025-04-30')
    expect(r.rows[0]!.ledgerName).toBe('Sales A')
    expect(r.rows[0]!.change).toBe(-900_00)
    const cashRow = r.rows.find((x) => x.ledgerId === cash)!
    expect(cashRow.change).toBe(800_00)
    expect(cashRow.vouchers).toBe(2)
    // Double entry: every movement nets out.
    expect(r.netChange).toBe(0)
  })

  it('counts nothing on a single-day window, because the opening already includes that day', () => {
    const db = seededDb()
    const cash = ledger(db, 'Cash box', 'Cash-in-Hand')
    const sales = ledger(db, 'Sales A', 'Sales Accounts')
    postLines(db, 'receipt', '2025-04-10', [
      { ledgerId: cash, drCr: 'dr', amount: 900_00 },
      { ledgerId: sales, drCr: 'cr', amount: 900_00 }
    ])
    expect(whatChanged(db, '2025-04-10', '2025-04-10').rows).toEqual([])
  })

  it('an empty period reports nothing changed', () => {
    const db = seededDb()
    ledger(db, 'Cash box', 'Cash-in-Hand', 500_00)
    const r = whatChanged(db, '2025-04-01', '2025-04-30')
    expect(r.rows).toEqual([])
    expect(r.movedCount).toBe(0)
  })

  it('ignores a binned voucher, like every other report', () => {
    const db = seededDb()
    const cash = ledger(db, 'Cash box', 'Cash-in-Hand')
    const sales = ledger(db, 'Sales A', 'Sales Accounts')
    const id = postLines(db, 'receipt', '2025-04-10', [
      { ledgerId: cash, drCr: 'dr', amount: 900_00 },
      { ledgerId: sales, drCr: 'cr', amount: 900_00 }
    ])
    db.prepare("UPDATE vouchers SET deleted_at = datetime('now') WHERE id = ?").run(id)
    expect(whatChanged(db, '2025-04-01', '2025-04-30').rows).toEqual([])
  })
})

// ---------- C60: ratios ----------

describe('ratios (C60)', () => {
  it('gears borrowings against capital and the year profit', () => {
    const db = seededDb()
    ledger(db, 'Owner capital', 'Capital Account', -200_000_00)
    ledger(db, 'Term loan', 'Loans (Liability)', -100_000_00)
    const r = ratios(db, '2025-04-01', '2026-03-31')
    // 1,00,000 of debt against 2,00,000 of capital, with no profit yet.
    expect(r.ratios.debtEquity).toBe(0.5)
    expect(r.inputs.borrowings).toBe(100_000_00)
  })

  it('returns nulls rather than Infinity on books with nothing in them', () => {
    const db = seededDb()
    const r = ratios(db, '2025-04-01', '2025-04-01')
    expect(r.ratios.currentRatio).toBeNull()
    expect(r.ratios.debtEquity).toBeNull()
    expect(r.ratios.grossMarginPct).toBeNull()
  })

  it('shows its workings, so a ratio can be argued with', () => {
    const db = seededDb()
    const debtor = ledger(db, 'Ram', 'Sundry Debtors')
    const sales = ledger(db, 'Sales A', 'Sales Accounts')
    postLines(db, 'sales', '2025-04-10', [
      { ledgerId: debtor, drCr: 'dr', amount: 1000_00 },
      { ledgerId: sales, drCr: 'cr', amount: 1000_00 }
    ], { partyLedgerId: debtor })
    const r = ratios(db, '2025-04-01', '2025-04-30')
    expect(r.inputs.receivables).toBe(1000_00)
    expect(r.inputs.sales).toBe(1000_00)
    expect(r.inputs.periodDays).toBe(30)
  })
})

// ---------- C72: item margin by period ----------

describe('itemProfitabilityByPeriod (C72)', () => {
  it('cuts the margin month by month rather than smearing it over the range', () => {
    const db = seededDb()
    const item = makeItem(db, 'Widget', 100_000, 500_00)
    const debtor = ledger(db, 'Ram', 'Sundry Debtors')
    const sales = ledger(db, 'Sales A', 'Sales Accounts')
    const sell = (date: string, amount: number, qtyMilli: number): void => {
      const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'sales'").get() as { id: number }
      saveVoucher(db, {
        voucherTypeId: vt.id, date, partyLedgerId: debtor, narration: null, reference: null,
        instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null,
        transportDistanceKm: null, currencyCode: null, exchangeRate: null,
        lines: [
          { ledgerId: debtor, drCr: 'dr', amount, costAllocations: [] },
          { ledgerId: sales, drCr: 'cr', amount, costAllocations: [] }
        ],
        inventory: [{ stockItemId: item, godownId: null, qtyMilli, ratePaise: amount / (qtyMilli / 1000), amount, direction: 'out' }],
        billRefs: [], tds: null
      } as VoucherInput)
    }
    sell('2025-04-10', 100_00, 10_000)
    sell('2025-05-10', 300_00, 10_000)

    const months = itemProfitabilityByPeriod(db, '2025-04-01', '2025-05-31', 'month')
    expect(months.map((m) => m.key)).toEqual(['2025-04', '2025-05'])
    expect(months[0]!.salesValue).toBe(100_00)
    expect(months[1]!.salesValue).toBe(300_00)
    // The margin genuinely differs between the two months, which is the point of the report.
    expect(months[0]!.profit).not.toBe(months[1]!.profit)
  })

  it('clamps the first and last buckets to the window, so no bucket overstates its range', () => {
    const db = seededDb()
    const buckets = itemProfitabilityByPeriod(db, '2025-04-15', '2025-05-15', 'month')
    expect(buckets[0]!.from).toBe('2025-04-15')
    expect(buckets[buckets.length - 1]!.to).toBe('2025-05-15')
  })

  it('an empty period yields buckets with zero totals, not an error', () => {
    const db = seededDb()
    const buckets = itemProfitabilityByPeriod(db, '2025-04-01', '2025-04-30', 'month')
    expect(buckets).toHaveLength(1)
    expect(buckets[0]!.rows).toEqual([])
    expect(buckets[0]!.profit).toBe(0)
  })
})

// ---------- C62: tile sparklines ----------

describe('dashboard tile sparks (C62)', () => {
  it('gives twelve months per tile, ending in the current month', () => {
    const db = seededDb()
    const d = dashboard(db, '2025-06-15', '2025-04-01')
    for (const spark of d.tileSparks) {
      expect(spark.points).toHaveLength(12)
      expect(spark.points[11]!.month).toBe('2025-06')
      expect(spark.points[0]!.month).toBe('2024-07')
    }
  })

  it('the last point of a balance tile equals the tile figure itself', () => {
    const db = seededDb()
    const cash = ledger(db, 'Cash box', 'Cash-in-Hand')
    const sales = ledger(db, 'Sales A', 'Sales Accounts')
    postLines(db, 'receipt', '2025-05-10', [
      { ledgerId: cash, drCr: 'dr', amount: 900_00 },
      { ledgerId: sales, drCr: 'cr', amount: 900_00 }
    ])
    const d = dashboard(db, '2025-06-15', '2025-04-01')
    const spark = d.tileSparks.find((s) => s.key === 'cash')!
    expect(spark.points[11]!.value).toBe(d.cashBalance)
    // And the month before the receipt is still nil — the walk backwards is real.
    expect(spark.points.find((p) => p.month === '2025-04')!.value).toBe(0)
  })

  it('clamps receivables ledger by ledger, so the last point matches the tile above it', () => {
    const db = seededDb()
    const owing = ledger(db, 'Ram', 'Sundry Debtors')
    // A customer in credit: an advance received, sitting as a credit balance under Sundry Debtors.
    const advance = ledger(db, 'Shyam', 'Sundry Debtors')
    const sales = ledger(db, 'Sales A', 'Sales Accounts')
    const cash = ledger(db, 'Cash box', 'Cash-in-Hand')
    postLines(db, 'sales', '2025-05-10', [
      { ledgerId: owing, drCr: 'dr', amount: 500_00 },
      { ledgerId: sales, drCr: 'cr', amount: 500_00 }
    ])
    postLines(db, 'receipt', '2025-05-12', [
      { ledgerId: cash, drCr: 'dr', amount: 200_00 },
      { ledgerId: advance, drCr: 'cr', amount: 200_00 }
    ])

    const d = dashboard(db, '2025-06-15', '2025-04-01')
    const spark = d.tileSparks.find((s) => s.key === 'receivables')!
    // 500 owed, and the 200 advance does NOT net it down to 300 — on either the tile or the line.
    expect(d.receivables).toBe(500_00)
    expect(spark.points[11]!.value).toBe(d.receivables)
  })

  it('the sales tile is a monthly flow, not a running balance', () => {
    const db = seededDb()
    const cash = ledger(db, 'Cash box', 'Cash-in-Hand')
    const sales = ledger(db, 'Sales A', 'Sales Accounts')
    for (const date of ['2025-05-10', '2025-06-10']) {
      postLines(db, 'sales', date, [
        { ledgerId: cash, drCr: 'dr', amount: 100_00 },
        { ledgerId: sales, drCr: 'cr', amount: 100_00 }
      ])
    }
    const spark = dashboard(db, '2025-06-15', '2025-04-01').tileSparks.find((s) => s.key === 'sales')!
    expect(spark.points.find((p) => p.month === '2025-05')!.value).toBe(100_00)
    expect(spark.points.find((p) => p.month === '2025-06')!.value).toBe(100_00)
  })
})

// ---------- C77: large vouchers ----------

describe('exceptions large vouchers (C77)', () => {
  it('flags only vouchers at or above the threshold', () => {
    const db = seededDb()
    const cash = ledger(db, 'Cash box', 'Cash-in-Hand')
    const sales = ledger(db, 'Sales A', 'Sales Accounts')
    postLines(db, 'receipt', '2025-04-10', [
      { ledgerId: cash, drCr: 'dr', amount: 50_00 },
      { ledgerId: sales, drCr: 'cr', amount: 50_00 }
    ])
    postLines(db, 'receipt', '2025-04-11', [
      { ledgerId: cash, drCr: 'dr', amount: 5000_00 },
      { ledgerId: sales, drCr: 'cr', amount: 5000_00 }
    ])
    const section = exceptions(db, '2025-04-01', '2025-04-30', undefined, 1000_00).sections.find(
      (s) => s.key === 'largeVouchers'
    )!
    expect(section.count).toBe(1)
    expect(section.rows[0]!.amount).toBe(5000_00)
  })

  it('is empty when nothing crosses the line', () => {
    const db = seededDb()
    const section = exceptions(db, '2025-04-01', '2025-04-30', undefined, 1000_00).sections.find(
      (s) => s.key === 'largeVouchers'
    )!
    expect(section.count).toBe(0)
  })
})

// ---------- C61: cash forecast ----------

describe('cashForecast (C61)', () => {
  it('carries an open payable bill out as an outflow on its due date', () => {
    const db = seededDb()
    const cash = ledger(db, 'Cash box', 'Cash-in-Hand', 10_000_00)
    const supplier = ledger(db, 'Supplier A', 'Sundry Creditors')
    const purchases = ledger(db, 'Purchases A', 'Purchase Accounts')
    const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'purchase'").get() as { id: number }
    saveVoucher(db, {
      voucherTypeId: vt.id, date: '2025-04-01', partyLedgerId: supplier, narration: null, reference: null,
      instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null,
      transportDistanceKm: null, currencyCode: null, exchangeRate: null,
      lines: [
        { ledgerId: purchases, drCr: 'dr', amount: 2000_00, costAllocations: [] },
        { ledgerId: supplier, drCr: 'cr', amount: 2000_00, costAllocations: [] }
      ],
      inventory: [],
      billRefs: [{ kind: 'new', name: 'P-1', amount: 2000_00, dueDate: '2025-04-20' }],
      tds: null
    } as VoucherInput)

    const f = cashForecast(db, '2025-04-05', '2025-05-05')
    expect(f.openingCash).toBe(10_000_00)
    const all = f.buckets.flatMap((b) => b.items)
    const bill = all.find((i) => i.label.includes('P-1'))!
    expect(bill.amount).toBe(-2000_00)
    expect(bill.certainty).toBe('contracted')
    expect(f.closingCash).toBe(8000_00)
    // cash usage is unrelated to the bank ledger id below
    expect(cash).toBeGreaterThan(0)
  })

  it('includes a post-dated cheque, which the books themselves are ignoring', () => {
    const db = seededDb()
    ledger(db, 'Cash box', 'Cash-in-Hand', 1000_00)
    const bank = ledger(db, 'HDFC', 'Bank Accounts')
    const sales = ledger(db, 'Sales A', 'Sales Accounts')
    postLines(db, 'receipt', '2025-04-20', [
      { ledgerId: bank, drCr: 'dr', amount: 500_00 },
      { ledgerId: sales, drCr: 'cr', amount: 500_00 }
    ], { postDated: true })

    const f = cashForecast(db, '2025-04-01', '2025-04-30')
    // Not in the opening balance (a PDC is out of books)...
    expect(f.openingCash).toBe(1000_00)
    // ...but in the forecast, which is the whole point.
    const pdc = f.buckets.flatMap((b) => b.items).find((i) => i.source === 'pdc')!
    expect(pdc.amount).toBe(500_00)
    expect(f.closingCash).toBe(1500_00)
  })

  it('projects a recurring template as expected rather than contracted', () => {
    const db = seededDb()
    const cash = ledger(db, 'Cash box', 'Cash-in-Hand', 10_000_00)
    const rent = ledger(db, 'Rent', 'Indirect Expenses')
    const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'payment'").get() as { id: number }
    saveTemplate(db, {
      name: 'Shop rent',
      cadence: 'monthly',
      dayOfMonth: 5,
      nextDue: '2025-04-05',
      active: true,
      voucherJson: JSON.stringify({
        voucherTypeId: vt.id, date: '2025-04-05', partyLedgerId: null, narration: 'Rent',
        lines: [
          { ledgerId: rent, drCr: 'dr', amount: 300_00 },
          { ledgerId: cash, drCr: 'cr', amount: 300_00 }
        ]
      })
    })

    const f = cashForecast(db, '2025-04-01', '2025-06-30')
    const recurring = f.buckets.flatMap((b) => b.items).filter((i) => i.source === 'recurring')
    expect(recurring).toHaveLength(3)
    expect(recurring.every((i) => i.certainty === 'expected' && i.amount === -300_00)).toBe(true)
    // The pessimistic line ignores them entirely.
    const last = f.buckets[f.buckets.length - 1]!
    expect(last.closingContracted).toBe(10_000_00)
    expect(last.closing).toBe(10_000_00 - 900_00)
  })

  it('an empty book forecasts nothing and says so', () => {
    const db = seededDb()
    const f = cashForecast(db, '2025-04-01', '2025-04-28')
    expect(f.openingCash).toBe(0)
    expect(f.closingCash).toBe(0)
    expect(f.shortfallDate).toBeNull()
  })
})

// ---------- C71: cost-centre profitability ----------

describe('ccReport unallocated share (C71)', () => {
  it('reconciles the allocated cost centres against the whole P&L', () => {
    const db = seededDb()
    const cc = saveCostCentre(db, { name: 'Shop', parentId: null, active: true })
    const cash = ledger(db, 'Cash box', 'Cash-in-Hand')
    const sales = ledger(db, 'Sales A', 'Sales Accounts')

    const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'receipt'").get() as { id: number }
    saveVoucher(db, {
      voucherTypeId: vt.id, date: '2025-04-10', partyLedgerId: null, narration: null, reference: null,
      instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null,
      transportDistanceKm: null, currencyCode: null, exchangeRate: null,
      lines: [
        { ledgerId: cash, drCr: 'dr', amount: 600_00, costAllocations: [] },
        { ledgerId: sales, drCr: 'cr', amount: 600_00, costAllocations: [{ costCentreId: cc.id, amount: 400_00 }] }
      ],
      inventory: [], billRefs: [], tds: null
    } as VoucherInput)

    const rows = ccReport(db, '2025-04-01', '2025-04-30')
    const shop = rows.find((r) => r.costCentreId === cc.id)!
    expect(shop.income).toBe(400_00)
    expect(shop.marginPct).toBe(100)
    const unallocated = rows.find((r) => r.costCentreId === -1)!
    expect(unallocated.income).toBe(200_00)
    // The reconciling line sorts last, whatever it is called.
    expect(rows[rows.length - 1]!.costCentreId).toBe(-1)
  })

  it('shows no unallocated row when every rupee is allocated', () => {
    const db = seededDb()
    const cc = saveCostCentre(db, { name: 'Shop', parentId: null, active: true })
    const cash = ledger(db, 'Cash box', 'Cash-in-Hand')
    const sales = ledger(db, 'Sales A', 'Sales Accounts')
    const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'receipt'").get() as { id: number }
    saveVoucher(db, {
      voucherTypeId: vt.id, date: '2025-04-10', partyLedgerId: null, narration: null, reference: null,
      instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null,
      transportDistanceKm: null, currencyCode: null, exchangeRate: null,
      lines: [
        { ledgerId: cash, drCr: 'dr', amount: 600_00, costAllocations: [] },
        { ledgerId: sales, drCr: 'cr', amount: 600_00, costAllocations: [{ costCentreId: cc.id, amount: 600_00 }] }
      ],
      inventory: [], billRefs: [], tds: null
    } as VoucherInput)
    const rows = ccReport(db, '2025-04-01', '2025-04-30')
    expect(rows.find((r) => r.costCentreId === -1)).toBeUndefined()
  })

  it('says nothing at all on books that use no cost centres', () => {
    const db = seededDb()
    const cash = ledger(db, 'Cash box', 'Cash-in-Hand')
    const sales = ledger(db, 'Sales A', 'Sales Accounts')
    postLines(db, 'receipt', '2025-04-10', [
      { ledgerId: cash, drCr: 'dr', amount: 600_00 },
      { ledgerId: sales, drCr: 'cr', amount: 600_00 }
    ])
    // Not a row reading "Not allocated 600.00" — that is the P&L wearing a misleading label.
    expect(ccReport(db, '2025-04-01', '2025-04-30')).toEqual([])
  })
})

// ---------- C58: saved views ----------

describe('report views (C58)', () => {
  it('saves, lists per screen, and replaces on the same name', () => {
    const db = seededDb()
    saveReportView(db, 'trial-balance', 'March', { hideZeros: true })
    saveReportView(db, 'day-book', 'Cash only', { kind: 'receipt' })
    expect(listReportViews(db, 'trial-balance')).toHaveLength(1)

    const again = saveReportView(db, 'trial-balance', 'March', { hideZeros: false })
    expect(listReportViews(db, 'trial-balance')).toHaveLength(1)
    expect((again.state as { hideZeros: boolean }).hideZeros).toBe(false)
  })

  it('refuses a state blob big enough to be a report rather than a preference', () => {
    const db = seededDb()
    expect(() => saveReportView(db, 'trial-balance', 'Huge', { blob: 'x'.repeat(20_000) })).toThrow(/too much state/)
  })

  it('deletes, and complains about deleting one that is not there', () => {
    const db = seededDb()
    const v = saveReportView(db, 'trial-balance', 'March', {})
    deleteReportView(db, v.id)
    expect(listReportViews(db)).toEqual([])
    expect(() => deleteReportView(db, v.id)).toThrow(/not found/)
  })
})

// ---------- C59: scheduled reports ----------

describe('report schedules (C59)', () => {
  const input = {
    report: 'trialBalance' as const,
    periodKind: 'lastMonth' as const,
    format: 'csv' as const,
    frequency: 'monthly' as const,
    folder: null,
    nextRun: '2025-05-01',
    active: true
  }

  it('stores a schedule with the label the UI shows', () => {
    const db = seededDb()
    const s = saveSchedule(db, input)
    expect(s.label).toBe('Trial balance')
    expect(listSchedules(db)).toHaveLength(1)
    deleteSchedule(db, s.id)
    expect(listSchedules(db)).toEqual([])
  })

  it('writes the file and rolls next_run forward from the day it actually ran', async () => {
    const db = seededDb()
    ledger(db, 'Cash box', 'Cash-in-Hand', 500_00)
    // An explicit folder, so the run never needs Electron's app.getPath for the exports dir.
    const folder = mkdtempSync(join(tmpdir(), 'total-schedule-'))
    const s = saveSchedule(db, { ...input, folder })
    const result = await runSchedule(db, { ...TEST_COMPANY }, 'test-co', s, '2025-05-17')
    expect(result.error).toBeNull()
    expect(result.period).toEqual({ from: '2025-04-01', to: '2025-04-30' })

    const after = listSchedules(db)[0]!
    // Monthly means the first of next month, counted from the run date, not the due date.
    expect(after.nextRun).toBe('2025-06-01')
    expect(after.lastRun).toBe('2025-05-17')
    expect(after.lastPath).toContain('trial-balance-2025-04-01_2025-04-30.csv')
  })

  it('records a failure and still moves on, so one bad schedule cannot block every open', async () => {
    const db = seededDb()
    const s = saveSchedule(db, { ...input, report: 'trialBalance' })
    // A folder that cannot be created is the realistic failure: an unplugged network share.
    //
    // Expressed as "a directory inside a regular file", because that is impossible on every OS.
    // This used to be '/dev/null/not-a-folder', which is unwritable on POSIX and a perfectly
    // ordinary relative path on Windows — mkdir -p created it happily, no error was recorded, and
    // the test failed on Windows CI while passing everywhere it was ever run by hand.
    const blocker = join(mkdtempSync(join(tmpdir(), 'total-sched-')), 'i-am-a-file')
    writeFileSync(blocker, 'not a directory')
    const broken = { ...s, folder: join(blocker, 'nested') }
    const result = await runSchedule(db, { ...TEST_COMPANY }, 'test-co', broken, '2025-05-17')
    expect(result.error).not.toBeNull()
    expect(listSchedules(db)[0]!.nextRun).toBe('2025-06-01')
  })
})

// ---------- report rendering, shared by every export ----------

describe('reportRender (C67)', () => {
  it('exports the whole period, never a page', () => {
    const db = seededDb()
    const cash = ledger(db, 'Cash box', 'Cash-in-Hand')
    const sales = ledger(db, 'Sales A', 'Sales Accounts')
    for (let d = 1; d <= 25; d++) {
      postLines(db, 'receipt', `2025-04-${String(d).padStart(2, '0')}`, [
        { ledgerId: cash, drCr: 'dr', amount: 10_00 },
        { ledgerId: sales, drCr: 'cr', amount: 10_00 }
      ])
    }
    const rendered = renderDayBook(db, '2025-04-01', '2025-04-30')
    // 25 vouchers plus the total row — nothing truncated at a page boundary.
    expect(rendered.rows).toHaveLength(26)
  })

  it('writes money into CSV as a plain decimal a spreadsheet can total', () => {
    const db = seededDb()
    ledger(db, 'Cash box', 'Cash-in-Hand', 123456)
    const csv = toCsv(renderTrialBalance(db, '2025-04-30'))
    expect(csv).toContain('1234.56')
    expect(csv).not.toContain('₹')
  })

  it('keeps money as integer paise all the way into the spreadsheet cell', () => {
    const db = seededDb()
    ledger(db, 'Cash box', 'Cash-in-Hand', 123456)
    const sheet = toXlsSheet(renderTrialBalance(db, '2025-04-30'))
    const moneyCell = sheet.rows[0]!.cells.find((c) => c.kind === 'money')
    expect(moneyCell).toEqual({ kind: 'money', paise: 123456 })
  })
})

const TEST_COMPANY = {
  name: 'Test Co',
  stateCode: '27',
  gstin: null,
  gstRegistrationType: 'regular' as const,
  gstFilingFrequency: 'monthly' as const,
  turnoverBand: null,
  address: '',
  booksFrom: 2025,
  email: null,
  phone: null,
  pan: null,
  tan: null
}
