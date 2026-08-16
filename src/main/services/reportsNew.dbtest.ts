/** DB-layer tests for the v0.3 lane-R report additions (#53–#60). */
import { describe, it, expect } from 'vitest'
import type { DB } from '../db/connection'
import { seededDb, postSimpleVoucher } from '../db/testdb'
import { createLedger } from './masters'
import { saveVoucher } from './vouchers'
import type { VoucherInputParsed } from '@shared/schemas'
import { cashFlow, dashboard } from './reports'

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
  partyLedgerId: number | null = null
): number {
  const vt = db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }
  const input = {
    voucherTypeId: vt.id, date, partyLedgerId, narration: null, reference: null,
    instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null,
    transportDistanceKm: null, currencyCode: null, exchangeRate: null,
    lines: lines.map((l) => ({ ...l, costAllocations: [] })),
    inventory: [], billRefs: [], tds: null
  } as VoucherInputParsed
  return saveVoucher(db, input).id
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
