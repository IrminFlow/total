// WP 8.6: the simple Home — every tile from ONE `simple:home` call, the "Why?" popover with the
// computed sentence and its report link, the task buttons' single mapping, "Needs attention" only
// when there is something, GST only for a regular registration, the "Not sure about GST?" card,
// the backup nudge, and the setup checklist keyed by step id.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SimpleHome } from '../simple/SimpleHome'
import { HOME_TASKS } from '../simple/homeTasks'
import { useNav } from '../state/stores'
import { translator } from '@shared/i18n'
import { profitSentence, receivablesWhy } from '@shared/simple/explain'
import type { SimpleHomeData } from '@shared/simple/home'

const t = translator('en')
const invoke = vi.fn()

function home(over: Partial<SimpleHomeData> = {}): SimpleHomeData {
  return {
    today: '2026-10-13',
    fy: { from: '2026-04-01', to: '2027-03-31' },
    moneyIn: { amount: 420000, entries: 3 },
    moneyOut: { amount: 120000, entries: 1 },
    receivables: { total: 6728220, parties: 2, overdue: 0, overdueBills: 0, oldest: { ledgerId: 11, name: 'Ramesh Stores', days: 12 }, nextDue: null },
    payables: { total: 900000, parties: 1, overdue: 0, overdueBills: 0, oldest: null, nextDue: { ledgerId: 21, name: 'Sharma Traders', date: '2026-10-20', amount: 900000 } },
    cash: {
      accounts: [
        { ledgerId: 1, name: 'Cash', kind: 'cash', balance: 150000 },
        { ledgerId: 2, name: 'HDFC Bank', kind: 'bank', balance: 2500000 }
      ],
      cash: 150000, bank: 2500000, total: 2650000
    },
    profit: {
      month: { month: '2026-10', from: '2026-10-01', to: '2026-10-13', netProfit: -20000, openingStock: 0, closingStock: 100 },
      year: { from: '2026-04-01', to: '2026-10-13', netProfit: 8882000, openingStock: 0, closingStock: 15400000 }
    },
    gst: { kind: 'regular', filing: 'monthly', row: { period: '2026-09', gstr1Due: '2026-10-11', gstr3bDue: '2026-10-20', liability: 180000, itc: 60000, payable: 120000, annual: [] } },
    deadlines: [],
    attention: { period: '2026-09', items: [] },
    backup: { lastAt: null, days: null, nudge: false },
    setup: { companyInfoComplete: true, gstRegistered: true, gstinSet: true, userLedgers: 3, bankLedgers: 1, voucherCount: 10, userBackups: 0 },
    gstAnswer: 'regular',
    ...over
  }
}

function renderHome(data: SimpleHomeData): void {
  invoke.mockImplementation(async (channel: string) => {
    if (channel === 'simple:home') return { ok: true, data }
    return { ok: true, data: null }
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <SimpleHome />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  localStorage.clear()
  invoke.mockReset()
  window.total = { platform: 'test', invoke } as unknown as typeof window.total
  act(() => useNav.setState({ stack: [{ name: 'gateway' }] }))
})
afterEach(() => cleanup())

describe('simple Home (WP 8.6)', () => {
  it('renders every tile from one simple:home call, with money.ts amounts', async () => {
    renderHome(home())
    await screen.findByTestId('simple-tile-receivables')
    expect(invoke.mock.calls.filter(([ch]) => ch === 'simple:home')).toHaveLength(1)
    expect(invoke.mock.calls.some(([ch]) => ch === 'report:dashboardSeries')).toBe(false)
    expect(screen.getByTestId('simple-tile-money-in-value').textContent).toBe('₹4,200.00')
    expect(screen.getByTestId('simple-tile-money-out-value').textContent).toBe('₹1,200.00')
    expect(screen.getByTestId('simple-tile-receivables-value').textContent).toBe('₹67,282.20')
    expect(screen.getByTestId('simple-tile-payables-value').textContent).toBe('₹9,000.00')
    expect(screen.getByTestId('simple-tile-cash-value').textContent).toBe('₹26,500.00')
    expect(screen.getByTestId('simple-tile-gst-value').textContent).toBe('₹1,200.00 by 20 Oct')
    // Each account under cash and bank; cash in hand in plain words.
    expect(screen.getByTestId('simple-home-account-1').textContent).toContain('Cash in hand')
    expect(screen.getByTestId('simple-home-account-2').textContent).toContain('HDFC Bank')
    // How is my business doing: one signed sentence (a loss this month, a profit for the year).
    expect(screen.getByTestId('simple-tile-profit-sentence').textContent).toBe(profitSentence(home().profit, t))
    expect(screen.getByTestId('simple-tile-profit-sentence').textContent).toContain('made a loss of ₹200.00')
    // Nothing needs attention → no card; no deadlines and no nudge → no "Coming up".
    expect(screen.queryByTestId('simple-home-attention')).toBeNull()
    expect(screen.queryByTestId('simple-home-coming-up')).toBeNull()
    expect(screen.queryByTestId('simple-home-not-sure-gst')).toBeNull()
  })

  it('"Why?" opens the computed sentence; its link opens the full report', async () => {
    renderHome(home())
    fireEvent.click(await screen.findByTestId('simple-why-receivables'))
    const sentence = await screen.findByTestId('simple-why-receivables-sentence')
    expect(sentence.textContent).toBe(receivablesWhy(home().receivables, t))
    expect(sentence.textContent).toBe('₹67,282.20 is what 2 customers still owe you; the oldest bill is for Ramesh Stores, 12 days old.')
    fireEvent.click(screen.getByTestId('simple-why-receivables-link'))
    await waitFor(() => expect(useNav.getState().stack.at(-1)).toEqual({ name: 'outstandings' }))

    fireEvent.click(screen.getByTestId('simple-why-profit'))
    expect((await screen.findByTestId('simple-why-profit-sentence')).textContent).toContain('₹1,54,000.00 of goods still on your shelf')
  })

  it('task buttons go where the one mapping says', async () => {
    renderHome(home())
    expect(HOME_TASKS.map((x) => x.id)).toEqual(['sale', 'purchase', 'money-in', 'money-out'])
    for (const task of HOME_TASKS) {
      act(() => useNav.setState({ stack: [{ name: 'gateway' }] }))
      fireEvent.click(screen.getByTestId(`simple-task-${task.id}`))
      await waitFor(() => expect(useNav.getState().stack.at(-1)).toEqual(task.screen))
    }
    expect(screen.getByTestId('simple-task-sale').textContent).toBe('+ Sale')
    expect(HOME_TASKS.find((x) => x.id === 'sale')!.screen).toEqual({ name: 'voucher-entry', kindHint: 'sales' })
  })

  it('needs attention: count + the top three in plain words, each opening the Assistants screen', async () => {
    renderHome(
      home({
        attention: {
          period: '2026-09',
          items: [
            { source: 'close', key: 'negative_stock', count: 1, amount: null, level: 'high' },
            { source: 'anomaly', key: 'duplicate_bill_number', count: 2, amount: null, level: 'high' },
            { source: 'close', key: 'overdue_bills', count: 3, amount: 900, level: 'medium' },
            { source: 'anomaly', key: 'amount_outlier', count: 1, amount: null, level: 'medium' }
          ]
        }
      })
    )
    const card = await screen.findByTestId('simple-home-attention')
    expect(screen.getByTestId('simple-home-attention-count').textContent).toBe('4 things to look at')
    expect(within(card).getAllByRole('button').filter((b) => b.dataset.testid?.startsWith('simple-attention-'))).toHaveLength(3)
    expect(screen.getByTestId('simple-attention-close-overdue_bills').textContent).toContain('3 bills are past the due date')
    fireEvent.click(screen.getByTestId('simple-attention-close-overdue_bills'))
    await waitFor(() => expect(useNav.getState().stack.at(-1)).toEqual({ name: 'assistants', tab: 'close', period: '2026-09' }))
    fireEvent.click(screen.getByTestId('simple-attention-anomaly-duplicate_bill_number'))
    await waitFor(() => expect(useNav.getState().stack.at(-1)).toEqual({ name: 'assistants', tab: 'anomalies' }))
    expect(screen.getByTestId('simple-home-attention-all').textContent).toBe('See all 4')
  })

  it('GST: composition shows the CMP-08 note, unregistered shows nothing; "not sure" gets its card', async () => {
    renderHome(home({ gst: { kind: 'composition' }, gstAnswer: 'composition' }))
    expect((await screen.findByTestId('simple-tile-gst-composition')).textContent).toContain('CMP-08')
    expect(screen.queryByTestId('simple-tile-gst')).toBeNull()
    cleanup()
    renderHome(home({ gst: null, gstAnswer: 'not_sure' }))
    await screen.findByTestId('simple-tile-receivables')
    expect(screen.queryByTestId('simple-tile-gst')).toBeNull()
    expect(screen.queryByTestId('simple-tile-gst-composition')).toBeNull()
    expect(screen.getByTestId('simple-home-not-sure-gst').textContent).toContain('Ask your CA whether you need GST registration')
  })

  it('quarterly filers get the QRMP note; deadlines and the backup nudge show under "Coming up"', async () => {
    renderHome(
      home({
        gst: { kind: 'regular', filing: 'quarterly', row: { period: '2026-09', gstr1Due: null, gstr3bDue: null, liability: 0, itc: 0, payable: 0, annual: [] } },
        deadlines: [{ id: 'tds-2026-11', form: 'TDS', title: 'TDS deposit', date: '2026-11-07', kind: 'tds' }],
        backup: { lastAt: Date.now() - 9 * 86_400_000, days: 9, nudge: true }
      })
    )
    expect((await screen.findByTestId('simple-home-gst-quarterly')).textContent).toContain('22nd or 24th')
    expect(screen.getByTestId('simple-tile-gst-value').textContent).toBe('₹0.00 for Sep 2026')
    expect(screen.getByTestId('simple-deadline-tds').textContent).toBe('Pay the TDS (tax deducted at source) you deducted — by 7 Nov')
    expect(screen.getByTestId('simple-home-backup-nudge').textContent).toContain('Your last backup was 9 days ago.')
    fireEvent.click(within(screen.getByTestId('simple-home-backup-nudge')).getByRole('button'))
    await waitFor(() => expect(useNav.getState().stack.at(-1)).toEqual({ name: 'settings', tab: 'backups' }))
  })

  it('the setup checklist uses the plain labels keyed by step id; a load error offers Try again', async () => {
    renderHome(home({ setup: { companyInfoComplete: false, gstRegistered: false, gstinSet: false, userLedgers: 0, bankLedgers: 0, voucherCount: 0, userBackups: 0 } }))
    expect((await screen.findByTestId('simple-setup-company')).textContent).toContain('Add your business details')
    expect(screen.getByTestId('simple-setup-gstin').dataset.done).toBe('true')
    expect(screen.queryByTestId('simple-setup-openings')).toBeNull()
    cleanup()
    invoke.mockImplementation(async () => ({ ok: false, error: 'boom' }))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <SimpleHome />
      </QueryClientProvider>
    )
    await waitFor(() => expect(screen.getByTestId('simple-home-error').textContent).toContain('Home could not load right now.'))
  })
})
