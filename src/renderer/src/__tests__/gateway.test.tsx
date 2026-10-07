// WP 1.10b Gateway dashboard: tiles show the service's figures, click-throughs navigate, feature
// flags hide cards, and one failing section (or the whole series query) never blanks the rest.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Gateway } from '../screens/Gateway'
import { useNav, useSession } from '../state/stores'
import { DEFAULT_FEATURES, type CompanyFeatures } from '@shared/features'
import { fyOf, todayISO } from '@shared/dates'
import { dashboardWindow, type DashboardSeries } from '@shared/dashboard'
import type { CompanyInfo } from '@shared/domain'
import { onboardingSteps } from '../screens/gateway/onboarding'

vi.setConfig({ testTimeout: 30_000 })

const invoke = vi.fn()
const go = vi.fn()
const today = todayISO()
const fy = fyOf(today)
const INFO: CompanyInfo = {
  name: 'Alpha Co', stateCode: '27', gstin: '27AAPFU0939F1ZV', gstRegistrationType: 'regular', address: 'Pune',
  booksFrom: fy.startYear, email: 'a@b.c', phone: null, pan: 'AAPFU0939F', tan: null
}

function series(over: Partial<DashboardSeries> = {}): DashboardSeries {
  const w = dashboardWindow(today, fy.from, fy.to)
  const months = w.sparkMonths.map((m, i) => ({ month: m, from: `${m}-01`, to: `${m}-28`, sales: 100000 * (i + 1), purchases: 50000 * (i + 1), netProfit: i === 2 ? -20000 : 30000 }))
  const ok = <T,>(data: T): { ok: true; data: T } => ({ ok: true, data })
  return {
    window: w,
    trade: ok({ months, periodNetProfit: 8_882_000, periodSales: 2_100_000, periodPurchases: 1_050_000 }),
    cash: ok({
      ledgers: [
        { ledgerId: 1, name: 'Cash', kind: 'cash', balance: 6_450_000 },
        { ledgerId: 9, name: 'HDFC Bank', kind: 'bank', balance: 8_450_000 }
      ],
      cash: 6_450_000, bank: 8_450_000, total: 14_900_000,
      trend: w.sparkMonths.map((m, i) => ({ month: m, amount: 1_000_000 * i }))
    }),
    receivables: ok({ total: 6_728_220, buckets: [6_728_220, 0, 0, 0], parties: 2, trend: w.sparkMonths.map((m) => ({ month: m, amount: 100 })) }),
    payables: ok({ total: 30_482_000, buckets: [30_000_000, 482_000, 0, 0], parties: 1, trend: w.sparkMonths.map((m) => ({ month: m, amount: 100 })) }),
    topCustomers: ok([{ ledgerId: 31, name: 'Umbrella Retail', amount: 13_556_000 }]),
    topSuppliers: ok([{ ledgerId: 41, name: 'Bharat Steel', amount: 392_000 }]),
    gst: ok({ period: '2026-09', gstr1Due: '2099-10-11', gstr3bDue: '2099-10-20', liability: 1_460_000, itc: 280_000, payable: 1_180_000 }),
    tds: ok({ quarter: 'Q3 FY2026-27', deducted: 0, payable: 0, payableLedgers: [], nextDue: '2099-11-07' }),
    stock: ok({ negative: [{ stockItemId: 7, name: 'Wireless Mouse', unitSymbol: 'Nos', decimals: 0, closingQtyMilli: -4000, reorderLevelMilli: null }], belowReorder: [] }),
    activity: ok({ today: 6, week: 9, weekFrom: today }),
    status: ok({ lockDate: null, lastBackup: { at: Date.UTC(2026, 9, 7, 6, 7), tag: 'open' }, userBackups: 0 }),
    setup: ok({ companyInfoComplete: true, gstRegistered: true, gstinSet: true, userLedgers: 10, bankLedgers: 1, voucherCount: 40, userBackups: 0 }),
    ...over
  }
}

const DASH = {
  cashBalance: 0, bankBalance: 0, todaySales: 0, monthSales: 0, monthPurchases: 0, receivables: 0, payables: 0, gstPayable: 0,
  recentVouchers: [
    { voucherId: 501, date: today, voucherType: 'Sales', kind: 'sales', number: '14', account: 'Silverline Traders', accountLedgerId: 32, narration: null, debit: 188800, credit: 188800, isOptional: false, postDated: false }
  ],
  topReceivables: [], topPayables: [], cashSpark: [], voucherCount: 40, partyCount: 5, itemCount: 6, hasEmployees: false, ratios: {}
}

function setup(opts: { series?: DashboardSeries | { fail: string }; features?: Partial<CompanyFeatures> } = {}): void {
  invoke.mockImplementation(async (channel: string) => {
    switch (channel) {
      case 'report:dashboardSeries': {
        const s = opts.series ?? series()
        return 'fail' in s ? { ok: false, error: s.fail } : { ok: true, data: s }
      }
      case 'report:dashboard': return { ok: true, data: DASH }
      case 'config:features:get': return { ok: true, data: { ...DEFAULT_FEATURES, ...opts.features } }
      case 'app:notifyDeadlines': return { ok: true, data: null }
      case 'log:renderer': return { ok: true, data: null }
      case 'master:ledgers:list': return { ok: true, data: [] }
      default: return { ok: false, error: `unmocked channel ${channel}` }
    }
  })
  window.total = { platform: 'test', invoke }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <Gateway />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  go.mockReset()
  invoke.mockReset()
  act(() => {
    useSession.setState({ slug: 'alpha-co', info: INFO, from: fy.from, to: fy.to, user: null })
    useNav.setState({ go, stack: [{ name: 'gateway' }] })
  })
})
afterEach(() => cleanup())

describe('Gateway dashboard', () => {
  it('tiles render the service figures', async () => {
    setup()
    await waitFor(() => expect(screen.getByTestId('tile-cash').textContent).toContain('1,49,000.00'))
    expect(screen.getByTestId('tile-receivables').textContent).toContain('67,282.20')
    expect(screen.getByTestId('tile-payables').textContent).toContain('3,04,820.00')
    expect(screen.getByTestId('tile-profit').textContent).toContain('88,820.00')
    // "This month" = the focus month's row (the last spark month).
    expect(screen.getByTestId('tile-sales').textContent).toContain('6,000.00')
    expect(screen.getByTestId('tile-purchases').textContent).toContain('3,000.00')
    expect(screen.getByTestId('tile-payables').textContent).toContain('1 party')
    expect(within(screen.getByTestId('tile-cash')).getByTestId('spark-cash')).toBeTruthy()
    // Recent entries keep their testids.
    expect(screen.getAllByTestId('recent-voucher')).toHaveLength(1)
  })

  it('tiles and rows click through to the matching report', async () => {
    setup()
    await waitFor(() => expect(screen.getByTestId('tile-receivables').textContent).toContain('67,282.20'))
    fireEvent.click(screen.getByTestId('tile-receivables'))
    expect(go).toHaveBeenLastCalledWith({ name: 'outstandings' })
    fireEvent.click(screen.getByTestId('tile-profit'))
    expect(go).toHaveBeenLastCalledWith({ name: 'profit-loss' })
    fireEvent.click(screen.getByTestId('tile-sales'))
    expect(go).toHaveBeenLastCalledWith({ name: 'registers' })
    // A top-customer row opens the ledger statement (the name itself opens the edit window).
    const row = within(screen.getByTestId('dash-top-customers')).getByTestId('top-ledger')
    fireEvent.click(row)
    expect(go).toHaveBeenLastCalledWith({ name: 'ledger-statement', ledgerId: 31 })
    fireEvent.click(within(screen.getByTestId('dash-compliance')).getByTestId('dash-gst'))
    expect(go).toHaveBeenLastCalledWith({ name: 'gstr3b' })
  })

  it('F-keys start a voucher; single letters still jump to screens', async () => {
    setup()
    await waitFor(() => screen.getByTestId('tile-cash'))
    fireEvent.keyDown(window, { key: 'F8' })
    expect(go).toHaveBeenLastCalledWith({ name: 'voucher-entry', kindHint: 'sales' })
    fireEvent.keyDown(window, { key: 'F8', ctrlKey: true })
    expect(go).toHaveBeenLastCalledWith({ name: 'voucher-entry', kindHint: 'credit_note' })
    fireEvent.keyDown(window, { key: 'd' })
    expect(go).toHaveBeenLastCalledWith({ name: 'daybook' })
  })

  it('feature flags hide the stock card and the TDS row; no GST registration hides GST', async () => {
    setup({ features: { inventory: false, tds: false }, series: series({ gst: { ok: true, data: null } }) })
    await waitFor(() => expect(screen.getByTestId('tile-cash').textContent).toContain('1,49,000.00'))
    await waitFor(() => expect(screen.queryByTestId('dash-stock')).toBeNull())
    expect(screen.queryByTestId('dash-tds')).toBeNull()
    expect(screen.queryByTestId('dash-gst')).toBeNull()
  })

  it('shows the stock, GST and TDS cards when the features are on', async () => {
    setup()
    await waitFor(() => expect(screen.getByTestId('dash-stock').textContent).toContain('Wireless Mouse'))
    expect(screen.getByTestId('dash-tds')).toBeTruthy()
    expect(screen.getByTestId('chip-gstr3b').textContent).toContain('GSTR-3B in')
  })

  it('one failing section degrades only its own tile and card', async () => {
    setup({ series: series({ receivables: { ok: false, error: 'boom' } }) })
    await waitFor(() => expect(screen.getByTestId('tile-cash').textContent).toContain('1,49,000.00'))
    expect(screen.getByTestId('tile-receivables').textContent).toContain('Unavailable')
    expect(screen.getByTestId('tile-payables').textContent).toContain('3,04,820.00')
    expect(screen.getByTestId('dash-ageing').textContent).toContain('Receivables unavailable')
    expect(screen.getByTestId('dash-top-customers').textContent).toContain('Umbrella Retail')
  })

  it('a failed series query leaves recent entries and the rest of the page standing', async () => {
    setup({ series: { fail: 'database is locked' } })
    await waitFor(() => expect(screen.getByTestId('dash-trade').getAttribute('data-state')).toBe('error'))
    expect(screen.getByTestId('dash-trade').textContent).toContain('database is locked')
    expect(screen.getByTestId('tile-cash').textContent).toContain('Unavailable')
    await waitFor(() => expect(screen.getAllByTestId('recent-voucher')).toHaveLength(1))
  })

  it('a card that throws while rendering is contained by its boundary', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    // Malformed stock data (numbers, not arrays) makes the stock card throw during render.
    setup({ series: series({ stock: { ok: true, data: { negative: 5, belowReorder: 5 } as never } }) })
    try {
      await waitFor(() => expect(within(screen.getByTestId('dash-stock')).getByTestId('card-error')).toBeTruthy())
      expect(screen.getByTestId('tile-cash').textContent).toContain('1,49,000.00')
    } finally {
      spy.mockRestore()
    }
  })

  it('charts are keyboard readable: ←/→ announce the focused month', async () => {
    setup()
    const chart = await waitFor(() => screen.getByTestId('chart-trade'))
    const group = within(chart).getByRole('group')
    act(() => group.focus())
    fireEvent.keyDown(group, { key: 'Home' })
    const live = chart.querySelector('[aria-live="polite"]')!
    expect(live.textContent).toMatch(/^Apr \d{4}: Sales/)
    fireEvent.keyDown(group, { key: 'ArrowRight' })
    expect(live.textContent).toMatch(/^May \d{4}: Sales/)
    // A hidden data table carries every exact value.
    expect(chart.querySelector('table caption')?.textContent).toBe('Sales vs purchases by month')
  })

  it('the onboarding card lists what is left and links to it', async () => {
    setup()
    const card = await waitFor(() => screen.getByTestId('dash-onboarding'))
    expect(card.textContent).toContain('5/6 done')
    fireEvent.click(within(card).getByTestId('onboarding-backup'))
    expect(go).toHaveBeenLastCalledWith({ name: 'settings', tab: 'backups' })
  })
})

describe('onboardingSteps', () => {
  it('drops the GSTIN step for unregistered businesses and marks progress', () => {
    const base = { companyInfoComplete: false, gstRegistered: false, gstinSet: false, userLedgers: 0, bankLedgers: 0, voucherCount: 0, userBackups: 0 }
    expect(onboardingSteps(base).map((s) => s.id)).toEqual(['company', 'ledgers', 'bank', 'voucher', 'backup'])
    expect(onboardingSteps({ ...base, gstRegistered: true, gstinSet: true, voucherCount: 3 }).filter((s) => s.done).map((s) => s.id)).toEqual(['gstin', 'voucher'])
  })
})
