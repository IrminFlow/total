// WP 9.9: the simple Reports screens are the accountant reports' own figures.
//   - "How is my business doing": profit EQUALS profitAndLoss's net profit for every period (this
//     month, last month, this FY, custom, and each one's previous period) on the Demo Traders seed,
//     and after a year-end closing journal (which the P&L leaves out); the lines are the P&L's own
//     totals; cash + bank = the trial balance's cash / bank rows; dues = Outstandings;
//   - cash in the next 30 days opens at the forecast's (= trial balance) cash; who owes whom =
//     Outstandings; by month = the registers' monthly rows;
//   - read-only (no audit row), any role; a custom period that ends before it starts → `to`.
import { TRUSTED_EVENT } from './ipcSender.testutil'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3-multiple-ciphers'
import { fyOf, todayISO } from '@shared/dates'
import type { OutstandingParty, ProfitAndLoss, TrialBalanceRow } from '@shared/reports'
import { previousSpan, reportSpan, withoutRoundOff, type BusinessDoing, type ReportPeriodKind, type SimpleByMonth, type SimpleCash, type SimpleOwed } from '@shared/simple/reports'
import type { CompanyInfo } from '@shared/domain'
import { seededDb, TEST_INFO } from './db/testdb'
import { createLedger } from './services/masters'
import { saveVoucher } from './services/vouchers'
import { postClose } from './services/yearEnd'
import { profitAndLoss } from './services/reports'
import { registerByMonth } from './services/analysis'
import { businessDoing } from './services/simpleReports'

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<{ ok: boolean; data?: unknown; error?: string; code?: string; field?: string }>>()

vi.mock('electron', () => ({
  app: { getVersion: () => '0.12.0-test', getPath: () => tmpdir(), isPackaged: false, on: () => {} },
  ipcMain: { handle: (ch: string, fn: (e: unknown, p: unknown) => Promise<{ ok: boolean }>) => handlers.set(ch.replace(/^total:/, ''), fn) },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openPath: async () => '', showItemInFolder: () => {} },
  Notification: class {},
  BrowserWindow: class {},
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('./updater', () => ({ checkForUpdatesInteractive: async () => null }))

const DATA_DIR = mkdtempSync(join(tmpdir(), 'total-simple-reports-'))
process.env.TOTAL_DATA_DIR = DATA_DIR
process.env.TOTAL_SUPPRESS_SYNC_WARNING = '1'

async function call(channel: string, payload?: unknown): Promise<{ ok: boolean; data?: unknown; error?: string; code?: string; field?: string }> {
  const h = handlers.get(channel)
  if (!h) throw new Error(`no handler ${channel}`)
  return h(TRUSTED_EVENT, payload)
}
async function ok<T>(channel: string, payload?: unknown): Promise<T> {
  const r = await call(channel, payload)
  if (!r.ok) throw new Error(`${channel}: ${r.error}`)
  return r.data as T
}

const TODAY = todayISO()
const sumTb = (rows: TrialBalanceRow[], ids: number[]): number => rows.filter((r) => ids.includes(r.ledgerId)).reduce((s, r) => s + r.debit - r.credit, 0)
const nodes = (n: { amount: number }[]): number => n.reduce((s, x) => s + x.amount, 0)

// WP 7.3: the ipc module graph is imported at collection, not inside the hook — on Windows CI the
// import alone (most of the hook's time, measured) ran past the 10 s hookTimeout.
const ipcModule = await import('./ipc')

beforeAll(async () => {
  const ipc = ipcModule
  ipc.registerIpc()
})

describe('simple:reports on Demo Traders (WP 9.9)', () => {
  let slug = ''

  it('profit equals the P&L net profit for every period and its previous one; lines are the P&L totals; cash = TB; dues = Outstandings', async () => {
    slug = (await ok<{ slug: string }>('company:createDemo', { mode: 'simple' })).slug
    await ok('company:open', { slug })
    const ro = new Database(join(DATA_DIR, 'companies', slug, 'company.db'), { readonly: true })
    const audit = (): number => (ro.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n
    const before = audit()
    const fy = fyOf(TODAY)
    const custom = { from: fy.from, to: `${fy.from.slice(0, 7)}-28` }
    const kinds: [ReportPeriodKind, { from?: string; to?: string }][] = [['this-month', {}], ['last-month', {}], ['this-year', {}], ['custom', custom]]
    let nonZero = 0
    for (const [period, dates] of kinds) {
      const d = await ok<BusinessDoing>('simple:reports:doing', { period, ...dates, today: TODAY })
      const span = reportSpan(period, TODAY, dates)!
      expect(d.span, period).toEqual(span)
      expect(d.previous, period).toEqual(previousSpan(period, span))
      const pl = await ok<ProfitAndLoss>('report:profitLoss', { from: span.from, to: span.to })
      const prev = await ok<ProfitAndLoss>('report:profitLoss', { from: d.previous.from, to: d.previous.to })
      expect(d.lines.profit, period).toBe(pl.netProfit)
      expect(d.previousLines.profit, period).toBe(prev.netProfit)
      expect(d.lines.sales).toBe(nodes(pl.tradingIncomes))
      expect(d.lines.purchases).toBe(nodes(pl.tradingExpenses))
      expect(d.lines.openingStock).toBe(pl.openingStock)
      expect(d.lines.closingStock).toBe(pl.closingStock)
      // Gate polish: the Round Off account is its own line (rounding), out of both sides.
      expect(d.lines.expenses).toBe(nodes(withoutRoundOff(pl.indirectExpenses)))
      expect(d.lines.otherIncome).toBe(nodes(withoutRoundOff(pl.indirectIncomes)))
      expect(d.lines.otherIncome + d.lines.rounding - d.lines.expenses).toBe(nodes(pl.indirectIncomes) - nodes(pl.indirectExpenses))
      expect(d.lines.profitOnGoods).toBe(pl.grossProfit)
      expect(d.lines.sales - d.lines.costOfGoods + d.lines.otherIncome + d.lines.rounding - d.lines.expenses).toBe(d.lines.profit)
      if (d.lines.profit !== 0) nonZero++

      const asOn = span.to < TODAY ? span.to : TODAY
      expect(d.asOn).toBe(asOn)
      const tb = (await ok<{ rows: TrialBalanceRow[] }>('report:trialBalance', { asOn })).rows
      expect(d.cash.total, period).toBe(sumTb(tb, d.cash.ledgerIds))
      const rec = await ok<OutstandingParty[]>('analysis:outstandings', { side: 'receivable', asOn })
      const pay = await ok<OutstandingParty[]>('analysis:outstandings', { side: 'payable', asOn })
      expect(d.owed.receivable).toBe(rec.reduce((s, p) => s + p.pending, 0))
      expect(d.owed.payable).toBe(pay.reduce((s, p) => s + p.pending, 0))
    }
    expect(nonZero).toBeGreaterThan(0)
    // The Home tile's FY figure is the same number.
    const year = await ok<BusinessDoing>('simple:reports:doing', { period: 'this-year', today: TODAY })
    const home = await ok<{ profit: { year: { netProfit: number } } }>('simple:home', { today: TODAY })
    expect(year.lines.profit).toBe(home.profit.year.netProfit)

    // Cash in the next 30 days: opens at today's cash + bank (TB); the end is open + in − out.
    const cash = await ok<SimpleCash>('simple:reports:cash', { today: TODAY })
    const tbNow = (await ok<{ rows: TrialBalanceRow[] }>('report:trialBalance', { asOn: TODAY })).rows
    expect(cash.now).toBe(sumTb(tbNow, year.cash.ledgerIds))
    expect(cash.end).toBe(cash.now + cash.moneyIn - cash.moneyOut)
    expect(Object.values(cash.inBy).reduce((s, v) => s + (v ?? 0), 0)).toBe(cash.moneyIn)
    // WP 10.2: today's figure in parts = the trial balance's cash / bank rows; the below-zero day
    // is a day the running balance (open + every flow up to it) is under zero, and the first one.
    expect(cash.split.total).toBe(cash.now)
    expect(cash.split.cash + cash.split.bank).toBe(cash.now)
    expect(cash.split.ledgerIds.sort()).toEqual([...year.cash.ledgerIds].sort())
    expect(Object.values(cash.outBy).reduce((s, v) => s + (v ?? 0), 0)).toBe(cash.moneyOut)
    if (cash.belowZero) {
      expect(cash.belowZero.amount).toBeLessThan(0)
      expect(cash.belowZero.date <= cash.until).toBe(true)
    } else if (cash.lowest) expect(cash.lowest.amount).toBeGreaterThanOrEqual(0)
    if (cash.end < 0) expect(cash.belowZero).not.toBeNull()

    // The profit line's comparison: its parts are the two P&Ls' own lines (previousLines = the
    // previous period's P&L), so the change "mostly from" a line is a difference of P&L totals.
    const month = await ok<BusinessDoing>('simple:reports:doing', { period: 'this-month', today: TODAY })
    const plPrev = await ok<ProfitAndLoss>('report:profitLoss', { from: month.previous.from, to: month.previous.to })
    expect(month.previousLines.profit).toBe(plPrev.netProfit)
    expect(month.previousLines.sales).toBe(nodes(plPrev.tradingIncomes))
    expect(month.previousLines.expenses).toBe(nodes(withoutRoundOff(plPrev.indirectExpenses)))

    // Who owes whom = Outstandings as on today.
    for (const side of ['receivable', 'payable'] as const) {
      const o = await ok<SimpleOwed>('simple:reports:owed', { side, today: TODAY })
      const out = await ok<OutstandingParty[]>('analysis:outstandings', { side, asOn: TODAY })
      expect(o.total).toBe(out.reduce((s, p) => s + p.pending, 0))
      expect(o.parties.map((p) => p.ledgerId).sort()).toEqual(out.filter((p) => p.pending !== 0).map((p) => p.ledgerId).sort())
    }

    // By month = the registers' monthly rows.
    const bm = await ok<SimpleByMonth>('simple:reports:byMonth', { today: TODAY })
    expect(bm.months).toHaveLength(12)
    const sales = registerByMonth(ro as never, 'sales', bm.from, TODAY)
    const purchases = registerByMonth(ro as never, 'purchase', bm.from, TODAY)
    for (const m of bm.months) {
      expect(m.sales, m.month).toBe(sales.find((r) => r.month === m.month)?.taxable ?? 0)
      expect(m.purchases, m.month).toBe(purchases.find((r) => r.month === m.month)?.taxable ?? 0)
    }
    expect(bm.months.some((m) => m.sales > 0)).toBe(true)
    // WP 10.2: the 12 months' totals = the registers' rows summed.
    expect(bm.totals).toEqual({ sales: sales.reduce((s, r) => s + r.taxable, 0), purchases: purchases.reduce((s, r) => s + r.taxable, 0) })

    // Read-only.
    expect(audit()).toBe(before)
    ro.close()
  })

  it('a later date is clamped to today; a custom period ending before it starts is refused on "to"', async () => {
    await ok('company:open', { slug })
    const later = await ok<BusinessDoing>('simple:reports:doing', { period: 'this-month', today: '2999-01-01' })
    expect(later.span.to).toBe(TODAY)
    const bad = await call('simple:reports:doing', { period: 'custom', from: '2026-06-10', to: '2026-06-01' })
    expect(bad).toMatchObject({ ok: false, code: 'simple_report_period', field: 'to' })
  })
})

describe('profit after a year-end closing journal (WP 9.9)', () => {
  it('the closing journal is left out — profit still equals the P&L for the closed year and the next', () => {
    const info: CompanyInfo = { ...TEST_INFO, booksFrom: 2025 }
    const db = seededDb()
    const group = (name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
    const ledger = (name: string, g: string): number =>
      createLedger(db, { name, groupId: group(g), openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null }).id
    const cash = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
    const sales = ledger('Counter sales', 'Sales Accounts')
    const rent = ledger('Shop rent', 'Indirect Expenses')
    const vt = (kind: string): number => (db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }).id
    const entry = (kind: 'receipt' | 'payment', date: string, dr: number, cr: number, amount: number): void => {
      saveVoucher(db, {
        voucherTypeId: vt(kind), date, partyLedgerId: null, narration: null, reference: null, instrumentNo: null, instrumentDate: null,
        transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
        lines: [{ ledgerId: dr, drCr: 'dr', amount, costAllocations: [] }, { ledgerId: cr, drCr: 'cr', amount, costAllocations: [] }],
        inventory: [], billRefs: [], tds: null
      })
    }
    // FY 2025-26: sales 50,000 − rent 12,000 = 38,000. FY 2026-27 to date: sales 9,000 − rent 2,000 = 7,000.
    entry('receipt', '2025-08-10', cash, sales, 50_000_00)
    entry('payment', '2025-09-01', rent, cash, 12_000_00)
    entry('receipt', '2026-05-10', cash, sales, 9_000_00)
    entry('payment', '2026-05-12', rent, cash, 2_000_00)
    postClose(db, info, 2025)
    expect((db.prepare('SELECT COUNT(*) AS n FROM vouchers WHERE is_year_end_close = 1').get() as { n: number }).n).toBe(1)

    const closed = businessDoing(db, { period: 'custom', from: '2025-04-01', to: '2026-03-31' }, '2026-10-14')
    expect(closed.lines.profit).toBe(38_000_00)
    expect(closed.lines.profit).toBe(profitAndLoss(db, '2025-04-01', '2026-03-31').netProfit)
    expect(closed.lines.sales).toBe(50_000_00)
    expect(closed.lines.expenses).toBe(12_000_00)
    const yearEnd = businessDoing(db, { period: 'this-year' }, '2026-03-31')
    expect(yearEnd.lines.profit).toBe(38_000_00)
    const now = businessDoing(db, { period: 'this-year' }, '2026-10-14')
    expect(now.lines.profit).toBe(7_000_00)
    expect(now.lines.profit).toBe(profitAndLoss(db, '2026-04-01', '2026-10-14').netProfit)
    expect(now.previousLines.profit).toBe(profitAndLoss(db, '2025-04-01', '2025-10-14').netProfit)
    expect(now.previousLines.profit).toBe(38_000_00)
    const may = businessDoing(db, { period: 'last-month' }, '2026-06-03')
    expect(may.lines.profit).toBe(7_000_00)
    expect(may.cash.total).toBe(50_000_00 - 12_000_00 + 9_000_00 - 2_000_00)
  })
})

describe('gate polish: a bill\'s round-off in "How is my business doing"', () => {
  it('is its own Rounding line — never a negative running cost — and profit is still the P&L\'s', () => {
    const db = seededDb()
    const group = (name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
    const ledger = (name: string, g: string): number =>
      createLedger(db, { name, groupId: group(g), openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null }).id
    const cash = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
    const sales = ledger('Counter sales', 'Sales Accounts')
    const roundOff = (db.prepare("SELECT id FROM ledgers WHERE lower(name) = 'round off'").get() as { id: number } | undefined)?.id ?? ledger('Round Off', 'Indirect Expenses')
    const vt = (db.prepare("SELECT id FROM voucher_types WHERE kind = 'receipt'").get() as { id: number }).id
    // Hand-worked: a ₹999.50 sale rounded up to ₹1,000 — cash Dr 1,000, sales Cr 999.50, Round Off
    // Cr 0.50. Sales ₹999.50, running costs ₹0 (not −₹0.50), rounding +₹0.50, profit ₹1,000.
    saveVoucher(db, {
      voucherTypeId: vt, date: '2026-05-10', partyLedgerId: null, narration: null, reference: null, instrumentNo: null, instrumentDate: null,
      transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
      lines: [
        { ledgerId: cash, drCr: 'dr', amount: 1_000_00, costAllocations: [] },
        { ledgerId: sales, drCr: 'cr', amount: 999_50, costAllocations: [] },
        { ledgerId: roundOff, drCr: 'cr', amount: 50, costAllocations: [] }
      ],
      inventory: [], billRefs: [], tds: null
    })
    const d = businessDoing(db, { period: 'custom', from: '2026-05-01', to: '2026-05-31' }, '2026-10-14')
    expect(d.lines.sales).toBe(999_50)
    expect(d.lines.expenses).toBe(0)
    expect(d.lines.otherIncome).toBe(0)
    expect(d.lines.rounding).toBe(50)
    expect(d.lines.profit).toBe(1_000_00)
    expect(d.lines.profit).toBe(profitAndLoss(db, '2026-05-01', '2026-05-31').netProfit)
    expect(d.topExpenses).toEqual([])

    // Review: a period with nothing but a round-off, rounded DOWN (Round Off Dr ₹0.40, cash Cr) →
    // rounding −₹0.40, no running cost, loss ₹0.40 = the P&L's; and a round-off account under
    // Indirect Incomes ("Rounding Off", Cr ₹0.30 in August) → +₹0.30, not other income.
    const jv = (db.prepare("SELECT id FROM voucher_types WHERE kind = 'journal'").get() as { id: number }).id
    const post = (date: string, lines: { ledgerId: number; drCr: 'dr' | 'cr'; amount: number }[]): void => {
      saveVoucher(db, {
        voucherTypeId: jv, date, partyLedgerId: null, narration: null, reference: null, instrumentNo: null, instrumentDate: null,
        transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
        lines: lines.map((l) => ({ ...l, costAllocations: [] })), inventory: [], billRefs: [], tds: null
      })
    }
    post('2026-07-10', [{ ledgerId: roundOff, drCr: 'dr', amount: 40 }, { ledgerId: cash, drCr: 'cr', amount: 40 }])
    const july = businessDoing(db, { period: 'custom', from: '2026-07-01', to: '2026-07-31' }, '2026-10-14')
    expect(july.lines).toMatchObject({ sales: 0, expenses: 0, otherIncome: 0, rounding: -40, profit: -40 })
    expect(july.lines.profit).toBe(profitAndLoss(db, '2026-07-01', '2026-07-31').netProfit)
    expect(july.topExpenses).toEqual([])
    const incomeSide = ledger('Rounding Off', 'Indirect Incomes')
    post('2026-08-10', [{ ledgerId: cash, drCr: 'dr', amount: 30 }, { ledgerId: incomeSide, drCr: 'cr', amount: 30 }])
    const aug = businessDoing(db, { period: 'custom', from: '2026-08-01', to: '2026-08-31' }, '2026-10-14')
    expect(aug.lines).toMatchObject({ otherIncome: 0, rounding: 30, profit: 30 })
    expect(aug.lines.profit).toBe(profitAndLoss(db, '2026-08-01', '2026-08-31').netProfit)
    // The year: +0.50 − 0.40 + 0.30 = +₹0.40, and the column still adds up to the P&L's profit.
    const year = businessDoing(db, { period: 'custom', from: '2026-04-01', to: '2026-10-14' }, '2026-10-14')
    const y = year.lines
    expect(y.rounding).toBe(40)
    expect(y.sales - y.costOfGoods + y.otherIncome + y.rounding - y.expenses).toBe(y.profit)
    expect(y.profit).toBe(profitAndLoss(db, '2026-04-01', '2026-10-14').netProfit)
  })
})
