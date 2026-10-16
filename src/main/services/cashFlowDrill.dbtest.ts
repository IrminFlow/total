// Cash flow drill-down (e2e 68–71 notes): every line of the cash flow statement carries the
// ledgers it was computed from (their amounts add up to the line) and the in-books vouchers of
// the period that moved them (their lines on those ledgers add up to the line, sign flipped) —
// without changing a figure: the statement's figures on a 1,500-voucher Perf Traders seed are
// pinned to what the code before the drill-down returned.
import { describe, it, expect } from 'vitest'
import type { DB } from '../db/connection'
import type { CashFlowRow, CashFlowStatement } from '@shared/reportMath'
import { freshDb, seededDb } from '../db/testdb'
import { seedLarge } from '../perf/seedLarge'
import { createLedger } from './masters'
import { saveVoucher } from './vouchers'
import type { VoucherInput } from '@shared/schemas'
import { cashFlow } from './reports'

const LEDGER_DEFAULTS = {
  gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null,
  tdsSectionId: null, pan: null, creditDays: null, exportType: null
}
const groupId = (db: DB, name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id

function post(db: DB, kind: string, date: string, lines: { ledgerId: number; drCr: 'dr' | 'cr'; amount: number }[], partyLedgerId: number | null = null): number {
  const vt = db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }
  return saveVoucher(db, {
    voucherTypeId: vt.id, date, partyLedgerId, narration: null, reference: null,
    instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null,
    transportDistanceKm: null, currencyCode: null, exchangeRate: null,
    lines: lines.map((l) => ({ ...l, costAllocations: [] })), inventory: [], billRefs: [], tds: null
  } as VoucherInput).id
}

const linesOf = (cf: CashFlowStatement): CashFlowRow[] => [...cf.operating, ...cf.investing, ...cf.financing]
const figures = (cf: CashFlowStatement): unknown => ({
  ...cf,
  operating: cf.operating.map(({ name, amount }) => ({ name, amount })),
  investing: cf.investing.map(({ name, amount }) => ({ name, amount })),
  financing: cf.financing.map(({ name, amount }) => ({ name, amount }))
})

/** Every line's drill ids add back up to the line. */
function expectDrillsAddUp(db: DB, cf: CashFlowStatement): void {
  const moveOn = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN dr_cr = 'dr' THEN amount ELSE -amount END), 0) AS m FROM voucher_lines WHERE voucher_id = ? AND ledger_id = ?`
  )
  for (const line of linesOf(cf)) {
    if (/stock$/.test(line.name)) {
      expect(line.parts, line.name).toBeUndefined() // the valuation engine's, no ledger behind it
      continue
    }
    expect(line.parts, line.name).toBeDefined()
    expect(line.parts!.reduce((s, p) => s + p.amount, 0), line.name).toBe(line.amount)
    for (const p of line.parts!) expect(p.amount, `${line.name} / ${p.name}`).not.toBe(0)
    if (line.name === 'Income/expense opening balances') {
      expect(line.voucherIds).toBeUndefined()
      continue
    }
    const ids = line.voucherIds!
    expect(new Set(ids).size).toBe(ids.length)
    expect([...ids].sort((a, b) => a - b)).toEqual(ids)
    let moved = 0
    for (const v of ids) for (const p of line.parts!) moved += (moveOn.get(v, p.ledgerId) as { m: number }).m
    expect(-moved, line.name).toBe(line.amount)
    // Every voucher listed is in the books, in the period, and not a closing journal.
    for (const v of ids) {
      const row = db.prepare('SELECT date, deleted_at, is_year_end_close, is_optional FROM vouchers WHERE id = ?').get(v) as { date: string; deleted_at: string | null; is_year_end_close: number; is_optional: number }
      expect(row.deleted_at).toBeNull()
      expect(row.is_year_end_close).toBe(0)
      expect(row.date >= cf.period.from && row.date <= cf.period.to).toBe(true)
    }
  }
}

describe('cash flow drill-down', () => {
  it('a hand-worked month: each line names its ledgers and vouchers', () => {
    const db = seededDb()
    const cash = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
    const L = (name: string, group: string): number => createLedger(db, { ...LEDGER_DEFAULTS, name, groupId: groupId(db, group), openingBalance: 0 }).id
    const fixtures = L('Fixtures', 'Fixed Assets')
    const debtor = L('Debtor A', 'Sundry Debtors')
    const debtorB = L('Debtor B', 'Sundry Debtors')
    const sales = L('Sales Local', 'Sales Accounts')
    const loan = L('Bank Loan', 'Loans (Liability)')
    const s1 = post(db, 'sales', '2025-04-15', [{ ledgerId: debtor, drCr: 'dr', amount: 5000 }, { ledgerId: sales, drCr: 'cr', amount: 5000 }], debtor)
    const s2 = post(db, 'sales', '2025-04-16', [{ ledgerId: debtorB, drCr: 'dr', amount: 3000 }, { ledgerId: sales, drCr: 'cr', amount: 3000 }], debtorB)
    const r1 = post(db, 'receipt', '2025-04-18', [{ ledgerId: cash, drCr: 'dr', amount: 1000 }, { ledgerId: debtorB, drCr: 'cr', amount: 1000 }], debtorB)
    const f1 = post(db, 'payment', '2025-04-20', [{ ledgerId: fixtures, drCr: 'dr', amount: 10000 }, { ledgerId: cash, drCr: 'cr', amount: 10000 }])
    const l1 = post(db, 'receipt', '2025-04-21', [{ ledgerId: cash, drCr: 'dr', amount: 20000 }, { ledgerId: loan, drCr: 'cr', amount: 20000 }])
    post(db, 'sales', '2025-05-02', [{ ledgerId: debtor, drCr: 'dr', amount: 700 }, { ledgerId: sales, drCr: 'cr', amount: 700 }], debtor) // outside the period

    const cf = cashFlow(db, '2025-04-01', '2025-04-30')
    expect(figures(cf)).toMatchObject({
      netProfit: 8000,
      operating: [{ name: 'Current Assets', amount: -7000 }],
      investing: [{ name: 'Fixed Assets', amount: -10000 }],
      financing: [{ name: 'Loans (Liability)', amount: 20000 }],
      netChange: 11000
    })
    const [ca] = cf.operating
    expect(ca!.parts).toEqual([
      { ledgerId: debtor, name: 'Debtor A', amount: -5000 },
      { ledgerId: debtorB, name: 'Debtor B', amount: -2000 }
    ])
    expect(ca!.voucherIds).toEqual([s1, s2, r1])
    expect(cf.investing[0]).toEqual({ name: 'Fixed Assets', amount: -10000, parts: [{ ledgerId: fixtures, name: 'Fixtures', amount: -10000 }], voucherIds: [f1] })
    expect(cf.financing[0]).toEqual({ name: 'Loans (Liability)', amount: 20000, parts: [{ ledgerId: loan, name: 'Bank Loan', amount: 20000 }], voucherIds: [l1] })
    expectDrillsAddUp(db, cf)
  })

  it('income / expense opening balances: the ledgers, no vouchers', () => {
    const db = seededDb()
    const rent = createLedger(db, { ...LEDGER_DEFAULTS, name: 'Rent', groupId: groupId(db, 'Indirect Expenses'), openingBalance: 4000 }).id
    const cf = cashFlow(db, '2025-04-01', '2026-03-31')
    const line = cf.operating.find((r) => r.name === 'Income/expense opening balances')
    expect(line).toEqual({ name: 'Income/expense opening balances', amount: 4000, parts: [{ ledgerId: rent, name: 'Rent', amount: 4000 }] })
    expectDrillsAddUp(db, cf)
  })

  // Perf Traders, 1,500 vouchers: the figures are the ones the code before the drill-down gave
  // (FIGURES below was printed from origin/main's cashFlow on this seed), and every line adds up.
  const db = freshDb()
  seedLarge(db, { vouchers: 1_500 })
  for (const [from, to] of [['2025-04-01', '2026-03-31'], ['2026-04-01', '2026-09-30'], ['2025-07-01', '2025-09-30']] as const) {
    it(`Perf Traders ${from} → ${to}: figures unchanged, drills add up`, () => {
      const cf = cashFlow(db, from, to)
      expect(figures(cf)).toEqual(FIGURES[`${from}:${to}`])
      expectDrillsAddUp(db, cf)
      expect(cf.netChange).toBe(cf.closingCash - cf.openingCash)
    })
  }
  // PR #140 review: a period across the financial-year boundary (income / expense ledgers reset,
  // balance-sheet ledgers carry on) — the drills still add up line by line.
  it('Perf Traders across the year end (2025-10-01 → 2026-06-30): drills add up', () => {
    const cf = cashFlow(db, '2025-10-01', '2026-06-30')
    expectDrillsAddUp(db, cf)
    expect(cf.netChange).toBe(cf.closingCash - cf.openingCash)
  })
})

// Printed from origin/main's cashFlow (before the drill-down) on seedLarge({ vouchers: 1500 }).
const FIGURES: Record<string, unknown> = {
  '2025-04-01:2026-03-31': {"period": {"from": "2025-04-01", "to": "2026-03-31"}, "netProfit": 28348431, "operating": [{"name": "Current Assets", "amount": -103767915}, {"name": "Current Liabilities", "amount": -8130548}, {"name": "Increase in stock", "amount": -348364231}], "operatingTotal": -431914263, "investing": [], "investingTotal": 0, "financing": [{"name": "Capital Account", "amount": 4499600}], "financingTotal": 4499600, "netChange": -427414663, "openingCash": 443471497, "closingCash": 16056834},
  '2026-04-01:2026-09-30': {"period": {"from": "2026-04-01", "to": "2026-09-30"}, "netProfit": 21856129, "operating": [{"name": "Current Assets", "amount": -11537533}, {"name": "Current Liabilities", "amount": 95107117}, {"name": "Increase in stock", "amount": -63315529}], "operatingTotal": 42110184, "investing": [], "investingTotal": 0, "financing": [{"name": "Capital Account", "amount": 4403100}], "financingTotal": 4403100, "netChange": 46513284, "openingCash": 16056834, "closingCash": 62570118},
  '2025-07-01:2025-09-30': {"period": {"from": "2025-07-01", "to": "2025-09-30"}, "netProfit": 6855277, "operating": [{"name": "Current Assets", "amount": -30611928}, {"name": "Current Liabilities", "amount": -714564}, {"name": "Increase in stock", "amount": -141880877}], "operatingTotal": -166352092, "investing": [], "investingTotal": 0, "financing": [{"name": "Capital Account", "amount": 1467700}], "financingTotal": 1467700, "netChange": -164884392, "openingCash": 420311422, "closingCash": 255427030},
}
