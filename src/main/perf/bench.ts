// WP 7.1 — the budgeted operations and their runner. Every case calls the service the screen's
// IPC handler calls (same arguments the screen sends), so a measured time is what the main
// process spends answering that screen. Used by `total-cli perf` (a printed table, the manual
// 500k run), by `budgets.dbtest.ts` (the CI check) and — for the read-only cases — by
// `reportEquality.dbtest.ts` (outputs must stay byte-identical across performance work).
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import type { VoucherInput } from '@shared/schemas'
import { fyOf, addDaysISO } from '@shared/dates'
import { join } from 'path'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import * as reports from '../services/reports'
import { outstandings, outstandingsWithAdvances } from '../services/analysis'
import { stockSummary } from '../services/stockAnalysis'
import { gstr1, gstr3b } from '../services/gst'
import { simpleHome, simpleHomeAttention } from '../services/simpleHome'
import { dashboardAll, dashboardSeries } from '../services/dashboard'
import { businessDoing } from '../services/simpleReports'
import { simpleTaxes } from '../services/simpleTaxes'
import { peopleList } from '../services/simplePeople'
import { salesList } from '../services/simpleSell'
import { globalSearch, search } from '../services/search'
import { listVouchers, saveVoucher } from '../services/vouchers'
import { checkIntegrity } from '../db/integrity'
import { quickCheckOk, snapshotTo } from '../db/backup'

export interface PerfContext {
  db: DB
  info: CompanyInfo
  today: string
  fy: { from: string; to: string }
  month: { from: string; to: string; period: string }
  booksFrom: string
  ids: {
    bank: number
    party: number
    partyName: string
    itemName: string
    voucherNumber: string
    salesTypeId: number
    receiptTypeId: number
    salesAccount: number
    outCgst: number
    outSgst: number
    receiptAccount: number
    items: number[]
    /** Customers with ≥ 3 open bills (the receipt case takes one per run). */
    billParties: { id: number; bills: { name: string; pending: number }[] }[]
  }
}

export type PerfGroup = 'report' | 'list' | 'save' | 'search' | 'open' | 'backup'

export interface PerfCase {
  id: string
  label: string
  group: PerfGroup
  /** Budget in ms on this laptop's class of machine for a 100k / 500k-voucher company. */
  budget: { k100: number; k500: number }
  /** Writes (saves, backups) — never part of the output-equality check. */
  writes?: boolean
  /** A bundle of other cases' outputs (dashboard:all): not hashed itself — the output-equality
   *  check asserts each named part equals the case it names, which IS hashed. */
  partsOf?: Record<string, string>
  run: (ctx: PerfContext) => unknown
}

// docs/perf-budgets.md says why each figure is what it is (measured on the laptop, WP 7.1).
const REPORT = { k100: 1000, k500: 3000 }
const SAVE = { k100: 300, k500: 300 }
// A voucher search by a selective word / number goes through the trigram text index (voucher_fts);
// one that matches most of the books (every customer, every item) still reads every voucher and
// sorts the matches — 200 ms at 100k, 600 ms at 500k (docs/perf-budgets.md, "Voucher text index").
const SEARCH = { k100: 200, k500: 600 }

const HEADER = {
  narration: null, reference: null, instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null,
  transportDistanceKm: null, currencyCode: null, exchangeRate: null
}

let receiptRun = 0
let saleRun = 0

export const PERF_CASES: PerfCase[] = [
  { id: 'tb', label: 'Trial balance (as on today)', group: 'report', budget: REPORT, run: (c) => reports.trialBalance(c.db, c.today) },
  { id: 'pnl', label: 'Profit & loss (FY to date)', group: 'report', budget: REPORT, run: (c) => reports.profitAndLoss(c.db, c.fy.from, c.today) },
  { id: 'bs', label: 'Balance sheet (as on today)', group: 'report', budget: REPORT, run: (c) => reports.balanceSheet(c.db, c.booksFrom, c.today) },
  { id: 'daybook', label: 'Day book (this month)', group: 'report', budget: REPORT, run: (c) => reports.dayBook(c.db, c.month.from, c.month.to, { includeOutOfBooks: true }) },
  { id: 'ledger', label: 'Ledger statement (busiest bank, FY)', group: 'report', budget: REPORT, run: (c) => reports.ledgerStatement(c.db, c.ids.bank, c.fy.from, c.today) },
  { id: 'ledgerParty', label: 'Ledger statement (busiest party, FY)', group: 'report', budget: REPORT, run: (c) => reports.ledgerStatement(c.db, c.ids.party, c.fy.from, c.today) },
  { id: 'outstandings', label: 'Outstandings (receivable)', group: 'report', budget: REPORT, run: (c) => outstandings(c.db, 'receivable', c.today) },
  { id: 'outstandingsPay', label: 'Outstandings (payable)', group: 'report', budget: REPORT, run: (c) => outstandings(c.db, 'payable', c.today) },
  { id: 'stock', label: 'Stock summary (valuation pass)', group: 'report', budget: REPORT, run: (c) => stockSummary(c.db, c.today) },
  { id: 'gstr1', label: 'GSTR-1 (this month)', group: 'report', budget: REPORT, run: (c) => gstr1(c.db, c.info, c.month.from, c.month.to, c.month.period) },
  { id: 'gstr3b', label: 'GSTR-3B (this month)', group: 'report', budget: REPORT, run: (c) => gstr3b(c.db, c.info, c.month.from, c.month.to, c.month.period) },
  { id: 'gateway', label: 'Gateway (report:dashboardSeries)', group: 'report', budget: REPORT, run: (c) => dashboardSeries(c.db, c.info, { today: c.today, from: c.fy.from, to: c.fy.to, backups: [] }) },
  { id: 'gatewayRecent', label: 'Gateway (report:dashboard)', group: 'report', budget: REPORT, run: (c) => reports.dashboard(c.db, c.today, c.fy.from) },
  // Launch to Home: the Gateway's four reads in one round trip — its budget is the series' and
  // report:dashboard's together (the MSME / promised chips are ~0.2 s each at 100k, inside it).
  { id: 'gatewayAll', label: 'Gateway (dashboard:all, one round trip)', group: 'report', budget: { k100: 2000, k500: 6000 }, partsOf: { series: 'gateway', dashboard: 'gatewayRecent' }, run: (c) => dashboardAll(c.db, c.info, { today: c.today, from: c.fy.from, to: c.fy.to, backups: [] }) },
  // The floor is the valuation pass + Outstandings on both sides + three P&L periods in one round
  // trip (simpleHome.perf.dbtest keeps its 500 ms bound on its lighter raw-insert fixture).
  { id: 'home', label: 'simple:home', group: 'report', budget: { k100: 600, k500: 3000 }, run: (c) => simpleHome(c.db, c.info, { today: c.today, backups: [] }) },
  { id: 'homeAttention', label: 'simple:homeAttention', group: 'report', budget: REPORT, run: (c) => simpleHomeAttention(c.db, c.info, c.today) },
  { id: 'doing', label: 'Reports: how the business is doing (this year)', group: 'report', budget: REPORT, run: (c) => businessDoing(c.db, { period: 'this-year' }, c.today) },
  { id: 'taxes', label: 'Taxes (simple)', group: 'report', budget: REPORT, run: (c) => simpleTaxes(c.db, c.info, {}, c.today) },
  { id: 'people', label: 'People list', group: 'list', budget: REPORT, run: (c) => peopleList(c.db, c.today) },
  { id: 'sales', label: 'Sales list (simple, FY to date)', group: 'list', budget: REPORT, run: (c) => salesList(c.db, c.fy.from, c.today, c.today) },
  { id: 'voucherList', label: 'Sales vouchers (voucher:list, FY)', group: 'list', budget: REPORT, run: (c) => listVouchers(c.db, c.fy.from, c.fy.to, c.ids.salesTypeId) },
  { id: 'searchParty', label: 'Search: party by name', group: 'search', budget: SEARCH, run: (c) => search(c.db, c.ids.partyName, { today: c.today }) },
  { id: 'searchItem', label: 'Search: item by name', group: 'search', budget: SEARCH, run: (c) => search(c.db, c.ids.itemName, { today: c.today }) },
  { id: 'searchVoucher', label: 'Search: voucher by number', group: 'search', budget: SEARCH, run: (c) => search(c.db, c.ids.voucherNumber, { today: c.today }) },
  { id: 'palette', label: 'Search: palette (party name)', group: 'search', budget: SEARCH, run: (c) => globalSearch(c.db, c.ids.partyName) },
  {
    id: 'saveSale', label: 'Save: sales invoice, 5 lines', group: 'save', budget: SAVE, writes: true,
    run: (c) => {
      const lines = c.ids.items.slice(0, 5).map((id, k) => ({ stockItemId: id, godownId: null, qtyMilli: 1000, ratePaise: 10_000 * (k + 1), discountPaise: 0, amount: 10_000 * (k + 1), direction: 'out' as const }))
      const taxable = lines.reduce((s, l) => s + l.amount, 0)
      const half = Math.round((taxable * 9) / 100)
      return saveVoucher(c.db, {
        ...HEADER, voucherTypeId: c.ids.salesTypeId, date: c.today, number: '', partyLedgerId: c.ids.party,
        lines: [
          { ledgerId: c.ids.party, drCr: 'dr', amount: taxable + 2 * half },
          { ledgerId: c.ids.salesAccount, drCr: 'cr', amount: taxable },
          { ledgerId: c.ids.outCgst, drCr: 'cr', amount: half },
          { ledgerId: c.ids.outSgst, drCr: 'cr', amount: half }
        ],
        inventory: lines,
        billRefs: [{ kind: 'new', name: `PERF/${++saleRun}`, amount: taxable + 2 * half, dueDate: null }]
      } as unknown as VoucherInput)
    }
  },
  {
    id: 'saveReceipt', label: 'Save: receipt against 3 bills', group: 'save', budget: SAVE, writes: true,
    run: (c) => {
      const p = c.ids.billParties[receiptRun++ % Math.max(1, c.ids.billParties.length)]
      if (!p) return null
      const refs = p.bills.slice(0, 3).map((b) => ({ kind: 'against' as const, name: b.name, amount: Math.min(b.pending, 100), dueDate: null }))
      const amount = refs.reduce((s, r) => s + r.amount, 0)
      return saveVoucher(c.db, {
        ...HEADER, voucherTypeId: c.ids.receiptTypeId, date: c.today, number: '', partyLedgerId: p.id,
        lines: [{ ledgerId: c.ids.receiptAccount, drCr: 'dr', amount }, { ledgerId: p.id, drCr: 'cr', amount }],
        inventory: [], billRefs: refs
      } as unknown as VoucherInput)
    }
  },
  { id: 'integrity', label: 'Company open: integrity check', group: 'open', budget: { k100: 1000, k500: 3000 }, run: (c) => checkIntegrity(c.db) },
  {
    id: 'backup', label: 'Backup (online snapshot + verify)', group: 'backup', budget: { k100: 3000, k500: 10_000 }, writes: true,
    run: async (c) => {
      const dir = mkdtempSync(join(tmpdir(), 'total-perf-backup-'))
      try {
        const dest = join(dir, 'b.db')
        await snapshotTo(c.db, dest)
        if (!quickCheckOk(dest)) throw new Error('backup failed verification')
        return null
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  }
]

/** Budget for a company of `vouchers` vouchers: the 100k figure up to 100k, the 500k figure from
 *  500k, linear between. */
export function budgetFor(c: PerfCase, vouchers: number): number {
  if (vouchers <= 100_000) return c.budget.k100
  if (vouchers >= 500_000) return c.budget.k500
  return c.budget.k100 + ((c.budget.k500 - c.budget.k100) * (vouchers - 100_000)) / 400_000
}

/** Ids and dates the cases need — looked up from the books (not timed), so any company works. */
export function perfContext(db: DB, info: CompanyInfo, today: string): PerfContext {
  const fy = fyOf(today)
  const y = Number(today.slice(0, 4))
  const m = Number(today.slice(5, 7))
  const mFrom = `${today.slice(0, 7)}-01`
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`
  const month = { from: mFrom, to: addDaysISO(next, -1), period: `${today.slice(5, 7)}${today.slice(0, 4)}` }
  const one = <T>(sql: string, ...args: unknown[]): T => db.prepare(sql).get(...args) as T
  const typeId = (kind: string): number => one<{ id: number }>('SELECT id FROM voucher_types WHERE kind = ? ORDER BY id', kind).id
  const busiest = (groups: string[]): { id: number; name: string } =>
    one(
      `SELECT l.id, l.name FROM ledgers l JOIN groups g ON g.id = l.group_id
       LEFT JOIN voucher_lines vl ON vl.ledger_id = l.id
       WHERE g.name IN (${groups.map(() => '?').join(',')}) GROUP BY l.id ORDER BY COUNT(vl.id) DESC, l.id LIMIT 1`,
      ...groups
    )
  const bank = busiest(['Bank Accounts', 'Cash-in-Hand'])
  const party = busiest(['Sundry Debtors'])
  const item = one<{ name: string } | undefined>(
    'SELECT si.name FROM stock_items si LEFT JOIN inventory_lines il ON il.stock_item_id = si.id GROUP BY si.id ORDER BY COUNT(il.id) DESC, si.id LIMIT 1'
  )
  const salesTypeId = typeId('sales')
  const lastSale = one<{ number: string } | undefined>('SELECT number FROM vouchers WHERE voucher_type_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1', salesTypeId)
  const ledgerOf = (sql: string): number => (one<{ id: number } | undefined>(sql)?.id ?? 0)
  const salesAccount = ledgerOf("SELECT l.id FROM ledgers l JOIN groups g ON g.id = l.group_id WHERE g.name = 'Sales Accounts' ORDER BY l.id LIMIT 1")
  const outCgst = ledgerOf("SELECT id FROM ledgers WHERE tax_type = 'cgst' ORDER BY (name LIKE '%Output%') DESC, id LIMIT 1")
  const outSgst = ledgerOf("SELECT id FROM ledgers WHERE tax_type = 'sgst' ORDER BY (name LIKE '%Output%') DESC, id LIMIT 1")
  const items = (db.prepare('SELECT id FROM stock_items ORDER BY id LIMIT 5').all() as { id: number }[]).map((r) => r.id)
  const billParties = outstandingsWithAdvances(db, 'receivable', today).parties
    .filter((p) => p.bills.filter((b) => b.pending > 0).length >= 3)
    .slice(0, 50)
    .map((p) => ({ id: p.ledgerId, bills: p.bills.filter((b) => b.pending > 0).map((b) => ({ name: b.number, pending: b.pending })) }))
  return {
    db, info, today, fy, month, booksFrom: `${info.booksFrom}-04-01`,
    ids: {
      bank: bank.id, party: party.id, partyName: party.name, itemName: item?.name ?? 'Item', voucherNumber: lastSale?.number ?? '1',
      salesTypeId, receiptTypeId: typeId('receipt'), salesAccount, outCgst, outSgst, receiptAccount: bank.id, items, billParties
    }
  }
}

export interface PerfResult {
  id: string
  label: string
  group: PerfGroup
  /** First call (cold statements / pages). */
  firstMs: number
  /** Median of the repeats after the first. */
  medianMs: number
  budgetMs: number
}

const now = (): number => performance.now()
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** Run the cases: one cold call, then `repeat` more; the median of those is checked. */
export async function runPerf(ctx: PerfContext, vouchers: number, opts: { cases?: readonly PerfCase[]; repeat?: number; onResult?: (r: PerfResult) => void } = {}): Promise<PerfResult[]> {
  const out: PerfResult[] = []
  const repeat = opts.repeat ?? 3
  for (const c of opts.cases ?? PERF_CASES) {
    const times: number[] = []
    for (let k = 0; k <= repeat; k++) {
      // Most cases are synchronous, so without this the whole table is ONE event-loop task: under
      // vitest (budgets.dbtest) its worker could not answer the runner's RPC for the length of the
      // run, and past 60 s that is an unhandled "Timeout calling onTaskUpdate" (CI, PR #153).
      // Outside the timed region — the figures don't change.
      await yieldToEventLoop()
      const t0 = now()
      await c.run(ctx)
      times.push(now() - t0)
    }
    const rest = times.slice(1).sort((a, b) => a - b)
    const r: PerfResult = { id: c.id, label: c.label, group: c.group, firstMs: times[0]!, medianMs: rest[Math.floor(rest.length / 2)] ?? times[0]!, budgetMs: budgetFor(c, vouchers) }
    opts.onResult?.(r)
    out.push(r)
  }
  return out
}

/** Cases over `tolerance` × (budget × scale). CI scales the budgets to its runner and fails
 *  only past +50 % (tolerance 1.5). */
export function overBudget(results: readonly PerfResult[], scale = 1, tolerance = 1.5): PerfResult[] {
  return results.filter((r) => r.medianMs > r.budgetMs * scale * tolerance)
}

export function formatTable(results: readonly PerfResult[], scale = 1): string {
  const rows = results.map((r) => {
    const budget = r.budgetMs * scale
    const mark = r.medianMs > budget * 1.5 ? 'FAIL' : r.medianMs > budget ? 'over' : 'ok'
    return [r.label, r.firstMs.toFixed(0), r.medianMs.toFixed(0), budget.toFixed(0), mark]
  })
  const head = ['Operation', 'First ms', 'Median ms', 'Budget ms', '']
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)))
  const line = (cells: string[]): string => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join('  ')
  return [line(head), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n')
}
