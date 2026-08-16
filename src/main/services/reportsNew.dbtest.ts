/** DB-layer tests for the v0.3 lane-R report additions (#53–#60). */
import { describe, it, expect } from 'vitest'
import type { DB } from '../db/connection'
import { seededDb, postSimpleVoucher } from '../db/testdb'
import { createLedger } from './masters'
import { saveVoucher } from './vouchers'
import type { VoucherInputParsed } from '@shared/schemas'
import { cashFlow, dashboard, ledgerStatement, trialBalance, profitAndLoss, balanceSheet } from './reports'

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

describe('columnar monthly ledger (#55)', () => {
  it('returns a month matrix with carried closings when groupBy month is requested', () => {
    const db = seededDb()
    postSimpleVoucher(db, { date: '2025-04-10', amount: 50000, kind: 'receipt' })
    postSimpleVoucher(db, { date: '2025-06-05', amount: 20000, kind: 'payment' })
    const cash = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id

    const plain = ledgerStatement(db, cash, '2025-04-01', '2025-07-31')
    expect(plain.months).toBeUndefined()

    const stmt = ledgerStatement(db, cash, '2025-04-01', '2025-07-31', 'month')
    expect(stmt.months).toEqual([
      { month: '2025-04', debit: 50000, credit: 0, closing: 50000 },
      { month: '2025-05', debit: 0, credit: 0, closing: 50000 },
      { month: '2025-06', debit: 0, credit: 20000, closing: 30000 },
      { month: '2025-07', debit: 0, credit: 0, closing: 30000 }
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
