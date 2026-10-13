// WP 8.6: `simple:home` — the simple Home in one call. Its figures are the accountant screens'
// own: the Gateway dashboard series, Outstandings and the P&L, as on today, on the Demo Traders
// seed; GST due shows only for a regular registration (composition → the CMP-08 note,
// unregistered → nothing); any role may read it, and it writes nothing.
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { addDays } from '@shared/dashboard'
import { fyOf, todayISO } from '@shared/dates'
import type { DashboardSeries } from '@shared/dashboard'
import type { OutstandingParty, ProfitAndLoss } from '@shared/reports'
import type { SimpleHomeData } from '@shared/simple/home'

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

beforeAll(async () => {
  ipc = await import('./ipc')
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

    // Money in − money out today = today's change in cash + bank (moves between them net to zero).
    const yesterday = await ok<SimpleHomeData>('simple:home', { today: addDays(TODAY, -1) })
    expect(home.moneyIn.amount - home.moneyOut.amount).toBe(home.cash.total - yesterday.cash.total)

    // GST (regular demo): the Gateway's Compliance row, unchanged.
    expect(home.gst?.kind).toBe('regular')
    expect(home.gst?.kind === 'regular' && home.gst.row).toEqual(data(series.gst))

    // Setup facts: the Gateway's setup section; the wizard's GST answer comes with it.
    expect(home.setup).toEqual(data(series.setup))
    expect(home.gstAnswer).toBe('regular')
    expect(home.fy).toEqual({ from: FY.from, to: FY.to })
    expect(home.attention).not.toBeNull()

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
    const after = new Database(join(DATA_DIR, 'companies', slug, 'company.db'), { readonly: true })
    expect((after.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n).toBe(auditCount)
    after.close()
  })

  it('needs attention lifts the overdue-bills check when the close checklist reports one', async () => {
    await ok('company:open', { slug: demoSlug })
    const home = await ok<SimpleHomeData>('simple:home', { today: TODAY })
    const period = home.attention!.period
    const close = await ok<{ checks: { key: string; effective: string; count: number }[] }>('assist:close', { period })
    const overdue = close.checks.find((c) => c.key === 'overdue_bills')!
    const item = home.attention!.items.find((i) => i.source === 'close' && i.key === 'overdue_bills')
    if (overdue.effective === 'warn' || overdue.effective === 'fail') expect(item?.count).toBe(Math.max(1, overdue.count))
    else expect(item).toBeUndefined()
    // Never a housekeeping row.
    expect(home.attention!.items.some((i) => i.key === 'lock' || i.key === 'narration')).toBe(false)
  })

  it('GST due only for a regular registration: composition → the CMP-08 note, unregistered → nothing', async () => {
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
    expect(u.moneyIn).toEqual({ amount: 0, entries: 0 })
    expect(u.moneyOut).toEqual({ amount: 0, entries: 0 })
    expect(u.receivables.total).toBe(0)
    expect(u.payables.total).toBe(0)
    expect(u.profit.year.netProfit).toBe(0)
    expect(u.attention?.items).toEqual([])
    expect(u.backup).toEqual({ lastAt: null, days: null, nudge: false })
    expect(u.setup.voucherCount).toBe(0)
    expect(u.gstAnswer).toBeNull()
  })

  it('a viewer may read it; a bad payload is refused', async () => {
    expect(ipc.CHANNEL_ROLES.get('simple:home')).toBe('viewer')
    await ok('company:open', { slug: demoSlug })
    await ok('users:save', { data: { name: 'Owner', pin: '1111', role: 'owner', active: true } })
    const viewer = await ok<{ id: number }>('users:save', { data: { name: 'Looker', pin: '3333', role: 'viewer', active: true } })
    await ok('auth:login', { userId: viewer.id, pin: '3333' })
    expect((await ok<SimpleHomeData>('simple:home', { today: TODAY })).receivables.total).toBeGreaterThan(0)
    expect((await call('simple:home', { today: 'tomorrow' })).ok).toBe(false)
    expect((await call('simple:home', { today: TODAY, extra: 1 })).ok).toBe(false)
  })
})
