// WP 8.6: `simple:home` — the simple Home in one call. Its figures are the accountant screens'
// own: the Gateway dashboard series, Outstandings and the P&L, as on today, on the Demo Traders
// seed; GST due shows only for a regular registration (composition → the CMP-08 note,
// unregistered → nothing); any role may read it, and it writes nothing.
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3-multiple-ciphers'
import { addDays, addMonths } from '@shared/dashboard'
import { fyOf, todayISO } from '@shared/dates'
import type { DashboardSeries } from '@shared/dashboard'
import type { OutstandingParty, ProfitAndLoss } from '@shared/reports'
import type { HomeAttention, SimpleHomeData } from '@shared/simple/home'
import { withoutRoundOff } from '@shared/simple/reports'
import { partyAllocation } from './services/analysis'

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<{ ok: boolean; data?: unknown; error?: string }>>()

vi.mock('electron', () => ({
  app: { getVersion: () => '0.11.0-test', getPath: () => tmpdir(), isPackaged: false, on: () => {} },
  ipcMain: { handle: (ch: string, fn: (e: unknown, p: unknown) => Promise<{ ok: boolean }>) => handlers.set(ch.replace(/^total:/, ''), fn) },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openPath: async () => '', showItemInFolder: () => {} },
  Notification: class {},
  BrowserWindow: class {},
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('./updater', () => ({ checkForUpdatesInteractive: async () => null }))

const DATA_DIR = mkdtempSync(join(tmpdir(), 'total-simple-home-'))
process.env.TOTAL_DATA_DIR = DATA_DIR
process.env.TOTAL_SUPPRESS_SYNC_WARNING = '1'

async function call(channel: string, payload?: unknown): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const h = handlers.get(channel)
  if (!h) throw new Error(`no handler ${channel}`)
  return h({}, payload)
}
async function ok<T>(channel: string, payload?: unknown): Promise<T> {
  const r = await call(channel, payload)
  if (!r.ok) throw new Error(`${channel}: ${r.error}`)
  return r.data as T
}

const company = (name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  name, stateCode: '27', gstin: null, gstRegistrationType: 'regular', address: '', booksFrom: fyOf(todayISO()).startYear, email: null, phone: null, pan: null, tan: null, ...extra
})

let ipc: typeof import('./ipc')
const TODAY = todayISO()
const FY = fyOf(TODAY)

// WP 7.3: the ipc module graph is imported at collection, not inside the hook — on Windows CI the
// import alone (most of the hook's time, measured) ran past the 10 s hookTimeout.
const ipcModule = await import('./ipc')

beforeAll(async () => {
  ipc = ipcModule
  ipc.registerIpc()
})

describe('simple:home (WP 8.6)', () => {
  let demoSlug = ''

  it('Demo Traders: every figure equals the dashboard / Outstandings / P&L services as on today', async () => {
    const { slug } = await ok<{ slug: string }>('company:createDemo', { mode: 'simple' })
    demoSlug = slug
    await ok('company:open', { slug })
    const auditBefore = new Database(join(DATA_DIR, 'companies', slug, 'company.db'), { readonly: true })
    const auditCount = (auditBefore.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n
    auditBefore.close()

    const home = await ok<SimpleHomeData>('simple:home', { today: TODAY })
    const series = await ok<DashboardSeries>('report:dashboardSeries', { today: TODAY, from: FY.from, to: FY.to })
    const data = <T,>(s: { ok: true; data: T } | { ok: false; error: string }): T => {
      if (!s.ok) throw new Error(s.error)
      return s.data
    }

    // Who owes whom: the Gateway tiles and the Outstandings screen.
    const rec = data(series.receivables)
    const pay = data(series.payables)
    expect(home.receivables.total).toBe(rec.total)
    expect(home.receivables.parties).toBe(rec.parties)
    expect(home.payables.total).toBe(pay.total)
    expect(home.payables.parties).toBe(pay.parties)
    const outRec = await ok<OutstandingParty[]>('analysis:outstandings', { side: 'receivable', asOn: TODAY })
    const outPay = await ok<OutstandingParty[]>('analysis:outstandings', { side: 'payable', asOn: TODAY })
    expect(home.receivables.total).toBe(outRec.reduce((s, p) => s + p.pending, 0))
    expect(home.payables.total).toBe(outPay.reduce((s, p) => s + p.pending, 0))
    expect(home.receivables.total).toBeGreaterThan(0)
    const oldest = Math.max(...outRec.flatMap((p) => p.bills.map((b) => b.ageDays)))
    expect(home.receivables.oldest?.days).toBe(oldest)
    expect(home.receivables.overdue).toBe(outRec.flatMap((p) => p.bills).filter((b) => b.overdueDays > 0).reduce((s, b) => s + b.pending, 0))

    // Cash and bank: the Gateway's Cash & bank card, account by account.
    const cash = data(series.cash)
    expect(home.cash.total).toBe(cash.total)
    expect(home.cash.cash).toBe(cash.cash)
    expect(home.cash.bank).toBe(cash.bank)
    expect(home.cash.accounts.map((a) => [a.ledgerId, a.balance])).toEqual(cash.ledgers.map((l) => [l.ledgerId, l.balance]))

    // Profit: the Gateway's FY and month figures, and the P&L screen (→ pnlLedgerAmounts).
    const trade = data(series.trade)
    expect(home.profit.year.netProfit).toBe(trade.periodNetProfit)
    expect(home.profit.month.netProfit).toBe(trade.months.find((m) => m.month === TODAY.slice(0, 7))!.netProfit)
    const pl = await ok<ProfitAndLoss>('report:profitLoss', { from: FY.from, to: TODAY })
    expect(home.profit.year.netProfit).toBe(pl.netProfit)
    expect(home.profit.year.closingStock).toBe(pl.closingStock)
    // WP 10.2: the "Why?" parts are the same P&L's — stock on the shelf = its closing − opening
    // stock, sales / running costs its trading incomes / indirect expenses, the lines add up to
    // its net profit, the biggest running cost its largest indirect expense.
    const sumOf = (n: { amount: number }[]): number => n.reduce((s, x) => s + x.amount, 0)
    const yl = home.profit.year.lines
    expect(home.profit.year.openingStock).toBe(pl.openingStock)
    expect(yl.sales).toBe(sumOf(pl.tradingIncomes))
    expect(yl.costOfGoods).toBe(pl.openingStock + sumOf(pl.tradingExpenses) - pl.closingStock)
    expect(yl.expenses).toBe(sumOf(withoutRoundOff(pl.indirectExpenses)))
    expect(yl.sales - yl.costOfGoods + yl.otherIncome + yl.rounding - yl.expenses).toBe(pl.netProfit)
    expect(yl.profit).toBe(pl.netProfit)
    if (yl.expenses > 0) expect(home.profit.year.topExpense!.amount).toBeGreaterThan(0)
    // The month's comparison = the P&L for the same days of the month before.
    const pm = home.profit.previousMonth
    const plPrev = await ok<ProfitAndLoss>('report:profitLoss', { from: pm.from, to: pm.to })
    expect(pm.lines.profit).toBe(plPrev.netProfit)
    expect(pm.lines.sales).toBe(sumOf(plPrev.tradingIncomes))
    expect(pm.from.slice(0, 7)).toBe(addMonths(TODAY.slice(0, 7), -1))
    const plMonth = await ok<ProfitAndLoss>('report:profitLoss', { from: home.profit.month.from, to: TODAY })
    expect(home.profit.month.lines.profit).toBe(plMonth.netProfit)

    // Money in − money out today = today's change in cash + bank (moves between them net to zero).
    const yesterday = await ok<SimpleHomeData>('simple:home', { today: addDays(TODAY, -1) })
    expect(home.moneyIn.amount - home.moneyOut.amount).toBe(home.cash.total - yesterday.cash.total)

    // GST (regular demo): the Gateway's Compliance row, unchanged; sales tax excludes reverse charge.
    expect(home.gst?.kind).toBe('regular')
    const row = home.gst?.kind === 'regular' ? home.gst.row : null
    expect(row).toEqual(data(series.gst))
    expect(row!.outwardTax! + row!.rcmTax!).toBe(row!.liability)

    // Setup facts: the Gateway's setup section; the wizard's GST answer comes with it.
    expect(home.setup).toEqual(data(series.setup))
    expect(home.gstAnswer).toBe('regular')
    expect(home.fy).toEqual({ from: FY.from, to: FY.to })

    // Customer advances: the same allocation's unapplied credit, party by party.
    const ro = new Database(join(DATA_DIR, 'companies', slug, 'company.db'), { readonly: true })
    const debtors = (await ok<OutstandingParty[]>('analysis:outstandings', { side: 'receivable', asOn: TODAY })).map((p) => p.ledgerId)
    const allDebtors = ro.prepare("SELECT l.id FROM ledgers l JOIN groups g ON g.id = l.group_id WHERE g.name = 'Sundry Debtors'").all() as { id: number }[]
    const advances = [...new Set([...debtors, ...allDebtors.map((d) => d.id)])].reduce((s, id) => s + partyAllocation(ro as never, id, TODAY).unappliedCredit, 0)
    ro.close()
    expect(home.receivables.advances).toBe(advances)

    // One round trip, fast once warm (the plan's < 300 ms on the demo seed; generous here for CI).
    const runs: number[] = []
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now()
      await ok('simple:home', { today: TODAY })
      runs.push(performance.now() - t0)
    }
    console.log(`simple:home warm on Demo Traders: ${runs.map((r) => r.toFixed(1)).join(' / ')} ms`)
    expect(Math.min(...runs)).toBeLessThan(1500)

    // Read-only: nothing was written.
    await ok('simple:homeAttention', { today: TODAY })
    const after = new Database(join(DATA_DIR, 'companies', slug, 'company.db'), { readonly: true })
    expect((after.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n).toBe(auditCount)
    after.close()
  })

  it('the as-on date never runs past today (a later date is clamped server-side)', async () => {
    await ok('company:open', { slug: demoSlug })
    const later = await ok<SimpleHomeData>('simple:home', { today: '2999-01-01' })
    expect(later.today).toBe(TODAY)
    const now = await ok<SimpleHomeData>('simple:home', { today: TODAY })
    expect(later.receivables.total).toBe(now.receivables.total)
    expect(later.cash.total).toBe(now.cash.total)
    expect((await ok<HomeAttention>('simple:homeAttention', { today: '2999-01-01' })).period).toBe(addMonths(TODAY.slice(0, 7), -1))
  })

  it('needs attention: close checklist + anomalies in their own call; overdue bills never from the checklist', async () => {
    await ok('company:open', { slug: demoSlug })
    const att = await ok<HomeAttention>('simple:homeAttention', { today: TODAY })
    expect(att.period).toBe(addMonths(TODAY.slice(0, 7), -1))
    expect(att.anomaliesSkipped).toBe(false)
    const close = await ok<{ checks: { key: string; effective: string; count: number }[] }>('assist:close', { period: att.period })
    for (const c of close.checks.filter((c) => c.effective === 'fail' && c.key !== 'overdue_bills' && c.key !== 'lock')) {
      if (['negative_stock', 'suspense', 'depreciation', 'bank_reconciliation', 'rounding', 'gst_returns', 'withholding'].includes(c.key)) {
        expect(att.items.find((i) => i.source === 'close' && i.key === c.key)?.count, c.key).toBe(Math.max(1, c.count))
      }
    }
    expect(att.items.some((i) => i.key === 'overdue_bills' || i.key === 'lock' || i.key === 'narration')).toBe(false)
    // The tiles carry the overdue figures by side, as on today (the rows the card shows first).
    const home = await ok<SimpleHomeData>('simple:home', { today: TODAY })
    const rec = await ok<OutstandingParty[]>('analysis:outstandings', { side: 'receivable', asOn: TODAY })
    expect(home.receivables.overdueBills).toBe(rec.flatMap((p) => p.bills).filter((b) => b.overdueDays > 0 && b.pending > 0).length)
  })

  it('quarterly filer: the GST figures cover the quarter, or the running quarter so far', async () => {
    await ok('company:open', { slug: demoSlug })
    await ok('gstProfile:set', { filing: 'quarterly' })
    const view = async (from: string, to: string): Promise<{ outward: { igst: number; cgst: number; sgst: number; cess: number }; zeroRated: { igst: number; cess: number }; rcm: { igst: number; cgst: number; sgst: number; cess: number }; itc: { igst: number; cgst: number; sgst: number; cess: number } }> =>
      ok('gst:gstr3b', { from, to, period: `${to.slice(5, 7)}${to.slice(0, 4)}` })
    const sum4 = (a: { igst: number; cgst: number; sgst: number; cess: number }): number => a.igst + a.cgst + a.sgst + a.cess

    const home = await ok<SimpleHomeData>('simple:home', { today: TODAY })
    const row = home.gst?.kind === 'regular' ? home.gst.row : null
    expect(row?.quarterly).toBe(true)
    const qStart = (ym: string): string => addMonths(ym, -((Number(ym.slice(5, 7)) - 1) % 3))
    expect(row!.from!.slice(0, 7)).toBe(qStart(row!.from!.slice(0, 7)))
    if (!row!.soFar) expect(addMonths(row!.from!.slice(0, 7), 2)).toBe(row!.to!.slice(0, 7))
    const q = await view(row!.from!, row!.to!)
    expect(row!.outwardTax).toBe(sum4(q.outward) + q.zeroRated.igst + q.zeroRated.cess)
    expect(row!.rcmTax).toBe(sum4(q.rcm))
    expect(row!.itc).toBe(sum4(q.itc))

    // Mid-quarter, its return more than 45 days off: the quarter so far, never last month alone.
    const start = `${qStart(addMonths(TODAY.slice(0, 7), -3))}-01`
    const mid = addDays(start, 45)
    const running = await ok<SimpleHomeData>('simple:home', { today: mid })
    const r2 = running.gst?.kind === 'regular' ? running.gst.row : null
    expect(r2?.soFar).toBe(true)
    expect(r2?.from).toBe(start)
    expect(r2?.to).toBe(mid)
    const q2 = await view(start, mid)
    expect(r2!.outwardTax).toBe(sum4(q2.outward) + q2.zeroRated.igst + q2.zeroRated.cess)
    // Credit vs GSTR-2B: nothing imported → all of it booked, not yet checked.
    expect(running.gst?.kind === 'regular' && running.gst.credit).toEqual({ checked: 'none', awaiting: 0 })
    await ok('gstProfile:set', { filing: 'monthly' })
  })

  it('GST due only for a regular registration: composition → its note, unregistered → nothing', async () => {
    const reg = await ok<{ slug: string }>('company:create', company('Home Regular', { gstin: '27AAPFU0939F1ZV' }))
    await ok('company:open', { slug: reg.slug })
    const r = await ok<SimpleHomeData>('simple:home', { today: TODAY })
    expect(r.gst?.kind).toBe('regular')

    const comp = await ok<{ slug: string }>('company:create', company('Home Composition', { gstin: '27AAPFU0939F1ZV', gstRegistrationType: 'composition' }))
    await ok('company:open', { slug: comp.slug })
    expect((await ok<SimpleHomeData>('simple:home', { today: TODAY })).gst).toEqual({ kind: 'composition' })

    const un = await ok<{ slug: string }>('company:create', company('Home Unregistered', { gstRegistrationType: 'unregistered' }))
    await ok('company:open', { slug: un.slug })
    const u = await ok<SimpleHomeData>('simple:home', { today: TODAY })
    expect(u.gst).toBeNull()
    expect(u.deadlines.some((d) => d.kind === 'gst')).toBe(false)

    // An empty company: zeros everywhere, nothing needing attention, no backup nudge.
    expect(u.moneyIn).toEqual({ amount: 0, entries: 0, loans: 0 })
    expect(u.moneyOut).toEqual({ amount: 0, entries: 0, loans: 0 })
    expect(u.receivables.total).toBe(0)
    expect(u.payables.total).toBe(0)
    expect(u.profit.year.netProfit).toBe(0)
    expect((await ok<HomeAttention>('simple:homeAttention', { today: TODAY })).items).toEqual([])
    expect(u.backup).toEqual({ lastAt: null, days: null, nudge: false })
    expect(u.setup.voucherCount).toBe(0)
    expect(u.gstAnswer).toBeNull()

    // A loan drawn into cash is money in, noted as borrowed; a customer's advance shows as held.
    const groups = await ok<{ id: number; name: string }[]>('master:groups:list')
    const gid = (n: string): number => groups.find((g) => g.name === n)!.id
    const loan = (await ok<{ id: number }>('master:ledgers:create', { name: 'Bank Loan', groupId: gid('Loans (Liability)') })).id
    const customer = (await ok<{ id: number }>('master:ledgers:create', { name: 'Advance Customer', groupId: gid('Sundry Debtors') })).id
    const ledgers = await ok<{ id: number; name: string }[]>('master:ledgers:list')
    const cash = ledgers.find((l) => l.name === 'Cash')!.id
    const types = await ok<{ id: number; kind: string }[]>('master:voucherTypes:list')
    const receipt = types.find((t) => t.kind === 'receipt')!.id
    const save = (party: number | null, credit: number, amount: number): Promise<unknown> =>
      ok('voucher:save', {
        data: {
          voucherTypeId: receipt, date: TODAY, partyLedgerId: party, narration: 'in', reference: null, instrumentNo: null,
          instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
          lines: [
            { ledgerId: cash, drCr: 'dr', amount, costAllocations: [] },
            { ledgerId: credit, drCr: 'cr', amount, costAllocations: [] }
          ],
          inventory: [], billRefs: [], tds: null
        }
      })
    await save(null, loan, 20000000)
    await save(customer, customer, 500000)
    const after = await ok<SimpleHomeData>('simple:home', { today: TODAY })
    expect(after.moneyIn).toEqual({ amount: 20500000, entries: 2, loans: 20000000 })
    expect(after.receivables.total).toBe(0)
    expect(after.receivables.advances).toBe(500000)
    expect(after.receivables.advanceParties).toBe(1)
  })

  it('a viewer may read it; a bad payload is refused', async () => {
    expect(ipc.CHANNEL_ROLES.get('simple:home')).toBe('viewer')
    expect(ipc.CHANNEL_ROLES.get('simple:homeAttention')).toBe('viewer')
    await ok('company:open', { slug: demoSlug })
    await ok('users:save', { data: { name: 'Owner', pin: '1111', role: 'owner', active: true } })
    const viewer = await ok<{ id: number }>('users:save', { data: { name: 'Looker', pin: '3333', role: 'viewer', active: true } })
    await ok('auth:login', { userId: viewer.id, pin: '3333' })
    expect((await ok<SimpleHomeData>('simple:home', { today: TODAY })).receivables.total).toBeGreaterThan(0)
    expect((await ok<HomeAttention>('simple:homeAttention', { today: TODAY })).period).toBeTruthy()
    expect((await call('simple:home', { today: 'tomorrow' })).ok).toBe(false)
    expect((await call('simple:home', { today: TODAY, extra: 1 })).ok).toBe(false)
  })
})
