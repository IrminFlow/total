// WP 1.10b — every Gateway dashboard figure equals the report it summarises, on the Demo Traders
// fixture plus credit/debit notes, a negative-stock sale, a reorder breach and out-of-books
// vouchers (soft-deleted, optional, post-dated) — which must be treated exactly as those reports
// treat them.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { DB } from '../db/connection'
import { openCompanyDb, closeCompanyDb } from '../db/connection'
import { DEMO_COMPANY } from '@shared/demo'
import { fyOf, gstPeriodOf, todayISO } from '@shared/dates'
import { addDays, monthEnd, weekStart, type DashboardSeries } from '@shared/dashboard'
import { tdsQuarterOf } from '@shared/tds'
import { createDemoCompany } from './demo'
import { dashboardSeries } from './dashboard'
import { dayBook, profitAndLoss, stockAgeing, trialBalance } from './reports'
import { noteVoucherRows, outstandings, registerByMonth, registerVoucherRows } from './analysis'
import { negativeStock } from './stockAnalysis'
import { gstr3b } from './gst'
import { tdsSummary } from './tds'
import { deleteVoucher, saveVoucher } from './vouchers'
import { getFeatures, setFeatures } from './config'

let dataDir: string
let db: DB
let slug: string
const today = todayISO()
const fy = fyOf(today)
const info = { ...DEMO_COMPANY, booksFrom: fy.startYear }

const id = (sql: string, ...args: unknown[]): number => (db.prepare(sql).get(...args) as { id: number }).id
const ledger = (name: string): number => id('SELECT id FROM ledgers WHERE name = ?', name)
const vtype = (kind: string): number => id('SELECT id FROM voucher_types WHERE kind = ?', kind)
const item = (name: string): number => id('SELECT id FROM stock_items WHERE name = ?', name)

const header = {
  partyLedgerId: null, narration: null, reference: null, instrumentNo: null, instrumentDate: null,
  transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null
}

function post(kind: string, date: string, lines: [string, 'dr' | 'cr', number][], extra: Record<string, unknown> = {}): number {
  return saveVoucher(db, {
    ...header,
    voucherTypeId: vtype(kind),
    date,
    lines: lines.map(([name, drCr, amount]) => ({ ledgerId: ledger(name), drCr, amount })),
    ...extra
  }).id
}

const series = (): DashboardSeries => dashboardSeries(db, info, { today, from: fy.from, to: fy.to, backups: [] })
function ok<T>(s: { ok: true; data: T } | { ok: false; error: string }): T {
  if (!s.ok) throw new Error(`section failed: ${s.error}`)
  return s.data
}

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'total-dash-'))
  process.env.TOTAL_DATA_DIR = dataDir
  slug = createDemoCompany().slug
  db = openCompanyDb(slug)
  // Sales return (credit note) and purchase return (debit note), dated today.
  post('credit_note', today, [['Sales A/c', 'dr', 10000], ['CGST Output', 'dr', 900], ['SGST Output', 'dr', 900], ['Umbrella Retail', 'cr', 11800]],
    { partyLedgerId: ledger('Umbrella Retail') })
  post('debit_note', today, [['Bharat Steel Suppliers', 'dr', 5900], ['Purchase A/c', 'cr', 5000], ['CGST Input', 'cr', 450], ['SGST Input', 'cr', 450]],
    { partyLedgerId: ledger('Bharat Steel Suppliers') })
  // Sell far more Notebook Packs than were ever bought → negative stock.
  post('sales', today, [['Silverline Traders', 'dr', 45_000_000], ['Sales A/c', 'cr', 45_000_000]], {
    partyLedgerId: ledger('Silverline Traders'),
    inventory: [{ stockItemId: item('Notebook Pack'), godownId: null, qtyMilli: 1_000_000, ratePaise: 45000, amount: 45_000_000, direction: 'out' }]
  })
  // A reorder level far above what's held.
  db.prepare('UPDATE stock_items SET reorder_level_milli = 1000000 WHERE id = ?').run(item('Laptop 14"'))
})

afterAll(() => {
  closeCompanyDb(db)
  delete process.env.TOTAL_DATA_DIR
  rmSync(dataDir, { recursive: true, force: true })
})

describe('dashboardSeries reconciles with the reports', () => {
  it('monthly sales/purchases are the registers net of notes; profit is the P&L for the same dates', () => {
    const trade = ok(series().trade)
    expect(trade.months.length).toBeGreaterThan(0)
    for (const m of trade.months) {
      const sales = registerByMonth(db, 'sales', m.from, m.to).reduce((s, r) => s + r.taxable, 0)
      const purchases = registerByMonth(db, 'purchase', m.from, m.to).reduce((s, r) => s + r.taxable, 0)
      const notes = noteVoucherRows(db, m.from, m.to)
      expect(m.sales).toBe(sales + notes.reduce((s, n) => s + n.sales, 0))
      expect(m.purchases).toBe(purchases + notes.reduce((s, n) => s + n.purchases, 0))
      expect(m.netProfit).toBe(profitAndLoss(db, m.from, m.to).netProfit)
    }
    const current = trade.months.find((m) => m.month === today.slice(0, 7))!
    const regSales = registerByMonth(db, 'sales', current.from, current.to)[0]!.taxable
    expect(current.sales).toBe(regSales - 10000) // the credit note's taxable value, never its tax
    const regPurch = registerByMonth(db, 'purchase', current.from, current.to)[0]?.taxable ?? 0
    expect(current.purchases).toBe(regPurch - 5000)
    expect(trade.periodNetProfit).toBe(profitAndLoss(db, fy.from, today).netProfit)
    const inPeriod = trade.months.filter((m) => m.from >= fy.from)
    expect(inPeriod.reduce((s, m) => s + m.netProfit, 0)).toBe(trade.periodNetProfit)
  })

  it('cash & bank per ledger equal the trial balance rows', () => {
    const cash = ok(series().cash)
    const tb = trialBalance(db, today)
    for (const l of cash.ledgers) {
      const row = tb.rows.find((r) => r.ledgerId === l.ledgerId)
      expect(l.balance).toBe(row ? row.debit - row.credit : 0)
    }
    expect(cash.ledgers.map((l) => l.name)).toEqual(expect.arrayContaining(['Cash', 'HDFC Bank']))
    expect(cash.total).toBe(cash.cash + cash.bank)
    expect(cash.trend).toHaveLength(6)
    expect(cash.trend.at(-1)!.amount).toBe(cash.total)
  })

  it('receivables / payables equal the Outstandings screen, buckets included', () => {
    const s = series()
    for (const [side, sec] of [['receivable', s.receivables], ['payable', s.payables]] as const) {
      const a = ok(sec)
      const parties = outstandings(db, side, today)
      expect(a.total).toBe(parties.reduce((t, p) => t + p.pending, 0))
      for (let i = 0; i < 4; i++) expect(a.buckets[i]).toBe(parties.reduce((t, p) => t + p.buckets[i]!, 0))
      expect(a.buckets.reduce((t, b) => t + b, 0)).toBe(a.total)
    }
    // The trend's last point is the month-end amount owed: positive debtor balances on the TB.
    const tb = trialBalance(db, today)
    const debtorNames = ['Umbrella Retail', 'Silverline Traders', 'Krishna Enterprises']
    const owed = tb.rows.filter((r) => debtorNames.includes(r.ledgerName)).reduce((t, r) => t + r.debit, 0)
    expect(ok(s.receivables).trend.at(-1)!.amount).toBe(owed)
  })

  it('top customers/suppliers rank FY register turnover net of notes, with ledger ids', () => {
    const s = series()
    const customers = ok(s.topCustomers)
    expect(customers.length).toBeGreaterThan(0)
    expect(customers.length).toBeLessThanOrEqual(5)
    const notes = noteVoucherRows(db, fy.from, today)
    for (const c of customers) {
      const reg = registerVoucherRows(db, 'sales', fy.from, today).filter((r) => r.partyLedgerId === c.ledgerId).reduce((t, r) => t + r.taxable, 0)
      const adj = notes.filter((n) => n.partyLedgerId === c.ledgerId).reduce((t, n) => t + n.sales, 0)
      expect(c.amount).toBe(reg + adj)
      expect(c.name).toBe((db.prepare('SELECT name FROM ledgers WHERE id = ?').get(c.ledgerId) as { name: string }).name)
    }
    expect(customers[0]!.name).toBe('Silverline Traders') // the ₹4.5 lakh notebook sale
    expect([...customers].sort((a, b) => b.amount - a.amount)).toEqual(customers)
    const suppliers = ok(s.topSuppliers)
    expect(suppliers.map((p) => p.name)).toEqual(expect.arrayContaining(['Bharat Steel Suppliers']))
  })

  it('GST card is the GSTR-3B computation for the period the next 3B files', () => {
    const g = ok(series().gst)!
    expect(g).not.toBeNull()
    expect(g.gstr3bDue! >= today).toBe(true)
    const from = `${g.period}-01`
    const r = gstr3b(db, info, from, monthEnd(g.period), gstPeriodOf(from))
    const s4 = (a: { igst: number; cgst: number; sgst: number; cess: number }): number => a.igst + a.cgst + a.sgst + a.cess
    expect(g.itc).toBe(s4(r.itc))
    expect(g.payable).toBe(s4(r.netPayable) + s4(r.rcmPayable))
    expect(g.liability).toBe(s4(r.outward) + r.zeroRated.igst + r.zeroRated.cess + s4(r.rcm))
    // Unregistered / composition: no GSTR-1/3B card.
    const none = dashboardSeries(db, { ...info, gstRegistrationType: 'unregistered' }, { today, from: fy.from, to: fy.to, backups: [] })
    expect(ok(none.gst)).toBeNull()
  })

  it('TDS card: quarter deductions from the TDS summary; off with the feature', () => {
    const t = ok(series().tds)!
    const q = tdsQuarterOf(today)
    expect(t.quarter).toBe(q.label)
    expect(t.deducted).toBe(tdsSummary(db, q.fyStartYear).filter((r) => r.quarter === q.label).reduce((s, r) => s + r.tds, 0))
    expect(t.nextDue).not.toBeNull()
  })

  it('stock alerts are the Exceptions negative-stock rows and the stock-ageing reorder breaches', () => {
    const st = ok(series().stock)!
    expect(st.negative.map((n) => n.stockItemId)).toEqual(negativeStock(db, today).map((n) => n.stockItemId))
    expect(st.negative.map((n) => n.name)).toContain('Notebook Pack')
    expect(st.belowReorder.map((r) => r.stockItemId)).toEqual(stockAgeing(db, today).filter((r) => r.belowReorder).map((r) => r.stockItemId))
    expect(st.belowReorder.map((r) => r.name)).toContain('Laptop 14"')
  })

  it('activity counts are the Day Book row counts for today and this week', () => {
    const a = ok(series().activity)
    expect(a.today).toBe(dayBook(db, today, today, { includeOutOfBooks: true }).length)
    expect(a.weekFrom).toBe(weekStart(today))
    expect(a.week).toBe(dayBook(db, weekStart(today), today, { includeOutOfBooks: true }).length)
  })

  it('soft-deleted, optional and post-dated vouchers move nothing but the Day Book counts', () => {
    const before = series()
    const sale = (extra: Record<string, unknown>): number =>
      post('sales', today, [['Krishna Enterprises', 'dr', 777_00], ['Sales A/c', 'cr', 777_00]], { partyLedgerId: ledger('Krishna Enterprises'), ...extra })
    deleteVoucher(db, sale({}))
    sale({ isOptional: true })
    sale({ postDated: true })
    const after = series()
    for (const key of ['trade', 'cash', 'receivables', 'payables', 'topCustomers', 'topSuppliers', 'gst', 'tds', 'stock'] as const) {
      expect(after[key]).toEqual(before[key])
    }
    // The Day Book lists optional + post-dated vouchers (badged), never the bin.
    expect(ok(after.activity).today).toBe(ok(before.activity).today + 2)
    expect(ok(after.activity).today).toBe(dayBook(db, today, today, { includeOutOfBooks: true }).length)
  })

  it('feature flags switch the stock and TDS sections off', () => {
    const f = getFeatures(db)
    setFeatures(db, { ...f, inventory: false, tds: false })
    try {
      const s = series()
      expect(ok(s.stock)).toBeNull()
      expect(ok(s.tds)).toBeNull()
    } finally {
      setFeatures(db, f)
    }
  })

  it('backup status and setup facts', () => {
    const s = dashboardSeries(db, info, {
      today, from: fy.from, to: fy.to,
      backups: [{ mtime: 1000, tag: 'open' }, { mtime: 3000, tag: 'manual' }, { mtime: 2000, tag: 'open' }]
    })
    expect(ok(s.status)).toEqual({ lockDate: null, lastBackup: { at: 3000, tag: 'manual' }, userBackups: 1 })
    const setup = ok(s.setup)
    expect(setup).toMatchObject({ companyInfoComplete: true, gstRegistered: true, gstinSet: true, bankLedgers: 1, userBackups: 1 })
    expect(setup.userLedgers).toBeGreaterThan(5)
    expect(setup.voucherCount).toBeGreaterThan(30)
  })

  it('a past working period shows its closing position and its last month', () => {
    const prev = { from: addDays(fy.from, -365), to: addDays(fy.from, -1) }
    const s = dashboardSeries(db, info, { today, ...prev, backups: [] })
    expect(s.window.asOn).toBe(prev.to)
    expect(s.window.focusMonth).toBe(prev.to.slice(0, 7))
    expect(ok(s.trade).periodNetProfit).toBe(profitAndLoss(db, prev.from, prev.to).netProfit)
  })

  it('one failing section does not take the others down', () => {
    db.exec('ALTER TABLE tds_entries RENAME TO tds_entries_gone')
    try {
      const s = series()
      expect(s.tds.ok).toBe(false)
      expect(s.trade.ok && s.cash.ok && s.receivables.ok && s.stock.ok).toBe(true)
    } finally {
      db.exec('ALTER TABLE tds_entries_gone RENAME TO tds_entries')
    }
  })
})
