// WP 8.6: the simple Home — every tile from ONE `simple:home` call (the slower "Needs attention"
// half from `simple:homeAttention`), the "Why?" popover with the computed sentence and a link that
// opens THAT figure (same date / side / period), the task buttons' single mapping, overdue rows by
// side from the tiles' own figures, GST only for a regular registration, the "Not sure about
// GST?" card, the backup nudge, the empty-company card, and the setup checklist keyed by step id.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SimpleHome } from '../simple/SimpleHome'
import { HOME_TASKS } from '../simple/homeTasks'
import { useNav } from '../state/stores'
import { translator } from '@shared/i18n'
import { profitSentence, receivablesWhy } from '@shared/simple/explain'
import type { HomeAttention, HomeOwed, SimpleHomeData } from '@shared/simple/home'

const t = translator('en')
const invoke = vi.fn()

const owed = (o: Partial<HomeOwed>): HomeOwed => ({ total: 0, parties: 0, overdue: 0, overdueBills: 0, oldest: null, nextDue: null, advances: 0, advanceParties: 0, ...o })

function home(over: Partial<SimpleHomeData> = {}): SimpleHomeData {
  return {
    today: '2026-10-13',
    fy: { from: '2026-04-01', to: '2027-03-31' },
    moneyIn: { amount: 420000, entries: 3, loans: 0 },
    moneyOut: { amount: 120000, entries: 1, loans: 0 },
    receivables: owed({ total: 6728220, parties: 2, oldest: { ledgerId: 11, name: 'Ramesh Stores', days: 12 } }),
    payables: owed({ total: 900000, parties: 1, nextDue: { ledgerId: 21, name: 'Sharma Traders', date: '2026-10-20', amount: 900000 } }),
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
    gst: {
      kind: 'regular', filing: 'monthly', credit: { checked: 'none', awaiting: 0 },
      row: { period: '2026-09', from: '2026-09-01', to: '2026-09-30', gstr1Due: '2026-10-11', gstr3bDue: '2026-10-20', liability: 180000, outwardTax: 180000, rcmTax: 0, itc: 60000, payable: 120000, annual: [] }
    },
    deadlines: [],
    backup: { lastAt: null, days: null, nudge: false },
    setup: { companyInfoComplete: true, gstRegistered: true, gstinSet: true, userLedgers: 3, bankLedgers: 1, voucherCount: 10, userBackups: 0 },
    gstAnswer: 'regular',
    ...over
  }
}

function renderHome(data: SimpleHomeData, attention: HomeAttention = { period: '2026-09', items: [], anomaliesSkipped: false }): void {
  invoke.mockImplementation(async (channel: string) => {
    if (channel === 'simple:home') return { ok: true, data }
    if (channel === 'simple:homeAttention') return { ok: true, data: attention }
    return { ok: true, data: null }
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <SimpleHome />
    </QueryClientProvider>
  )
}

const lastScreen = (): unknown => useNav.getState().stack.at(-1)

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
    expect(screen.getByTestId('simple-home-account-1').textContent).toContain('Cash in hand')
    expect(screen.getByTestId('simple-home-account-2').textContent).toContain('HDFC Bank')
    expect(screen.getByTestId('simple-tile-profit-sentence').textContent).toBe(profitSentence(home().profit, t))
    expect(screen.getByTestId('simple-tile-profit-sentence').textContent).toContain('made a loss of ₹200.00')
    expect(screen.queryByTestId('simple-home-attention')).toBeNull()
    expect(screen.queryByTestId('simple-home-coming-up')).toBeNull()
    expect(screen.queryByTestId('simple-home-not-sure-gst')).toBeNull()
    expect(screen.queryByTestId('simple-home-empty')).toBeNull()
  })

  it('"Why?" opens the computed sentence; each link says what it opens and opens that figure', async () => {
    renderHome(home())
    fireEvent.click(await screen.findByTestId('simple-why-receivables'))
    const sentence = await screen.findByTestId('simple-why-receivables-sentence')
    expect(sentence.textContent).toBe(receivablesWhy(home().receivables, t))
    expect(sentence.textContent).toBe('₹67,282.20 is what 2 customers still owe you; the oldest bill is for Ramesh Stores, 12 days old.')
    const open = async (id: string, label: string, target: unknown): Promise<void> => {
      act(() => useNav.setState({ stack: [{ name: 'gateway' }] }))
      if (!screen.queryByTestId(`simple-why-${id}-link`)) fireEvent.click(screen.getByTestId(`simple-why-${id}`))
      const link = await screen.findByTestId(`simple-why-${id}-link`)
      expect(link.textContent).toBe(`${label} →`)
      fireEvent.click(link)
      await waitFor(() => expect(lastScreen()).toEqual(target))
    }
    await open('receivables', 'See who owes you', { name: 'outstandings', side: 'receivable' })
    await open('payables', 'See whom you owe', { name: 'outstandings', side: 'payable' })
    await open('money-in', 'See today’s entries', { name: 'daybook', date: '2026-10-13' })
    await open('money-out', 'See today’s entries', { name: 'daybook', date: '2026-10-13' })
    await open('cash', 'See each account’s balance today', { name: 'trial-balance', asOn: '2026-10-13', ledgerIds: [1, 2] })
    await open('gst', 'Open the GST return for Sep 2026', { name: 'gstr3b', month: '2026-09' })
    await open('profit', 'Open the profit and loss report', { name: 'profit-loss' })
    fireEvent.click(screen.getByTestId('simple-why-profit'))
    expect((await screen.findByTestId('simple-why-profit-sentence')).textContent).toContain('₹1,54,000.00 of goods still on your shelf')
  })

  it('task buttons go where the one mapping says', async () => {
    renderHome(home())
    expect(HOME_TASKS.map((x) => x.id)).toEqual(['sale', 'purchase', 'money-in', 'money-out'])
    for (const task of HOME_TASKS) {
      act(() => useNav.setState({ stack: [{ name: 'gateway' }] }))
      fireEvent.click(screen.getByTestId(`simple-task-${task.id}`))
      await waitFor(() => expect(lastScreen()).toEqual(task.screen))
    }
    expect(screen.getByTestId('simple-task-sale').textContent).toBe('+ Sale')
    // WP 9.2: + Sale is the simple Make a bill flow.
    expect(HOME_TASKS.find((x) => x.id === 'sale')!.screen).toEqual({ name: 'simple-sell' })
  })

  it('needs attention: overdue bills by side from the tiles, then the checklist / anomalies (own call), top three in plain words', async () => {
    renderHome(
      home({
        receivables: owed({ total: 6728220, parties: 2, overdue: 2293750, overdueBills: 3, oldest: { ledgerId: 11, name: 'Ramesh Stores', days: 40 } }),
        payables: owed({ total: 900000, parties: 1, overdue: 900000, overdueBills: 1 })
      }),
      {
        period: '2026-09',
        anomaliesSkipped: true,
        items: [
          { source: 'close', key: 'negative_stock', count: 1, amount: null, level: 'high' },
          { source: 'anomaly', key: 'duplicate_bill_number', count: 2, amount: null, level: 'high' },
          { source: 'close', key: 'drafts', count: 1, amount: null, level: 'medium' }
        ]
      }
    )
    const card = await screen.findByTestId('simple-home-attention')
    await waitFor(() => expect(screen.getByTestId('simple-home-attention-count').textContent).toBe('5 things to look at'))
    expect(invoke.mock.calls.some(([ch]) => ch === 'simple:homeAttention')).toBe(true)
    const rows = within(card).getAllByRole('button').filter((b) => b.dataset.testid?.startsWith('simple-attention-'))
    expect(rows.map((r) => r.dataset.testid)).toEqual(['simple-attention-close-negative_stock', 'simple-attention-anomaly-duplicate_bill_number', 'simple-attention-owed-receivable'])
    expect(screen.getByTestId('simple-attention-owed-receivable').textContent).toContain('3 customer bills (₹22,937.50) past the due date')
    fireEvent.click(screen.getByTestId('simple-attention-owed-receivable'))
    await waitFor(() => expect(lastScreen()).toEqual({ name: 'outstandings', side: 'receivable' }))
    fireEvent.click(screen.getByTestId('simple-attention-close-negative_stock'))
    await waitFor(() => expect(lastScreen()).toEqual({ name: 'assistants', tab: 'close', period: '2026-09' }))
    fireEvent.click(screen.getByTestId('simple-attention-anomaly-duplicate_bill_number'))
    await waitFor(() => expect(lastScreen()).toEqual({ name: 'assistants', tab: 'anomalies' }))
    expect(screen.getByTestId('simple-home-attention-all').textContent).toBe('See all 5')
    expect(screen.getByTestId('simple-home-attention-capped')).toBeTruthy()
  })

  it('GST: composition shows its return note, unregistered shows nothing; "not sure" gets its card', async () => {
    renderHome(home({ gst: { kind: 'composition' }, gstAnswer: 'composition' }))
    expect((await screen.findByTestId('simple-tile-gst-composition')).textContent).toContain('the composition return (CMP-08)')
    expect(screen.queryByTestId('simple-tile-gst')).toBeNull()
    cleanup()
    renderHome(home({ gst: null, gstAnswer: 'not_sure' }))
    await screen.findByTestId('simple-tile-receivables')
    expect(screen.queryByTestId('simple-tile-gst')).toBeNull()
    expect(screen.queryByTestId('simple-tile-gst-composition')).toBeNull()
    expect(screen.getByTestId('simple-home-not-sure-gst').textContent).toContain('Ask your CA whether you need GST registration')
  })

  it('quarterly filers: the quarter so far, the plain note, the link to the quarter’s first month; deadlines and the backup nudge', async () => {
    renderHome(
      home({
        gst: {
          kind: 'regular', filing: 'quarterly', credit: { checked: 'none', awaiting: 0 },
          row: { period: '2026-10', from: '2026-10-01', to: '2026-10-13', quarterly: true, soFar: true, gstr1Due: null, gstr3bDue: null, liability: 50000, outwardTax: 50000, rcmTax: 0, itc: 0, payable: 50000, annual: [] }
        },
        deadlines: [{ id: 'tds-2026-11', form: 'TDS', title: 'TDS deposit', date: '2026-11-07', kind: 'tds' }],
        backup: { lastAt: Date.now() - 9 * 86_400_000, days: 9, nudge: true }
      })
    )
    expect((await screen.findByTestId('simple-home-gst-quarterly')).textContent).toContain('You file GST every quarter')
    expect(screen.getByTestId('simple-home-gst-quarterly').textContent).not.toContain('QRMP')
    expect(screen.getByTestId('simple-tile-gst-value').textContent).toBe('So far this quarter: ₹500.00')
    fireEvent.click(screen.getByTestId('simple-why-gst'))
    const link = await screen.findByTestId('simple-why-gst-link')
    expect(link.textContent).toBe('Open the GST return, month by month from Oct 2026 →')
    fireEvent.click(link)
    await waitFor(() => expect(lastScreen()).toEqual({ name: 'gstr3b', month: '2026-10' }))
    expect(screen.getByTestId('simple-deadline-tds').textContent).toBe('Pay the TDS (tax deducted at source) you deducted — by 7 Nov')
    expect(screen.getByTestId('simple-home-backup-nudge').textContent).toContain('Your last backup was 9 days ago.')
    fireEvent.click(within(screen.getByTestId('simple-home-backup-nudge')).getByRole('button'))
    await waitFor(() => expect(lastScreen()).toEqual({ name: 'settings', tab: 'backups' }))
  })

  it('an empty company: one "Nothing recorded yet" card with the next setup step; the GST number step is never ticked for an unregistered business', async () => {
    renderHome(
      home({
        moneyIn: { amount: 0, entries: 0, loans: 0 },
        moneyOut: { amount: 0, entries: 0, loans: 0 },
        receivables: owed({}),
        payables: owed({}),
        cash: { accounts: [{ ledgerId: 1, name: 'Cash', kind: 'cash', balance: 0 }], cash: 0, bank: 0, total: 0 },
        gst: null,
        gstAnswer: 'no',
        setup: { companyInfoComplete: false, gstRegistered: false, gstinSet: false, userLedgers: 0, bankLedgers: 0, voucherCount: 0, userBackups: 0 }
      })
    )
    const card = await screen.findByTestId('simple-home-empty')
    expect(card.textContent).toContain('Nothing recorded yet')
    expect(screen.queryByTestId('simple-tile-receivables')).toBeNull()
    expect(screen.queryByTestId('simple-tile-money-in')).toBeNull()
    expect(screen.getByTestId('simple-home-empty-next').textContent).toBe('Add your business details')
    fireEvent.click(screen.getByTestId('simple-home-empty-next'))
    await waitFor(() => expect(lastScreen()).toEqual({ name: 'company-info' }))
    // The GST number does not apply: it is left out, not shown as done; the count leaves it out too.
    expect(screen.queryByTestId('simple-setup-gstin')).toBeNull()
    expect(screen.getByTestId('simple-home-setup-progress').textContent).toBe('0 of 5 setup steps done')
    expect(screen.queryByTestId('simple-setup-openings')).toBeNull()
  })

  it('WP 8.7: a continuing business sees "Enter what you had on day one" as its first step (not twice); once entered, the card quotes the tiles', async () => {
    const state = {
      booksBegin: '2026-04-01', startedFresh: false, stockOn: false, appliedAt: null as string | null,
      cash: { ledgerId: 1, name: 'Cash', amount: 0 }, banks: [], overdrafts: [], customers: [], suppliers: [], items: [], others: [],
      pick: { customers: [], suppliers: [], items: [], units: [] }, capitals: [], progress: { done: 0, total: 4 }
    }
    const nothing = home({
      moneyIn: { amount: 0, entries: 0, loans: 0 }, moneyOut: { amount: 0, entries: 0, loans: 0 }, receivables: owed({}), payables: owed({}),
      cash: { accounts: [{ ledgerId: 1, name: 'Cash', kind: 'cash', balance: 0 }], cash: 0, bank: 0, total: 0 },
      setup: { companyInfoComplete: false, gstRegistered: true, gstinSet: true, userLedgers: 0, bankLedgers: 0, voucherCount: 0, userBackups: 0 }
    })
    const mount = (data: SimpleHomeData): void => {
      invoke.mockImplementation(async (channel: string) => {
        if (channel === 'simple:home') return { ok: true, data }
        if (channel === 'simple:homeAttention') return { ok: true, data: { period: '2026-09', items: [], anomaliesSkipped: false } }
        if (channel === 'simple:openings:get') return { ok: true, data: state }
        return { ok: true, data: null }
      })
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      render(
        <QueryClientProvider client={client}>
          <SimpleHome />
        </QueryClientProvider>
      )
    }
    mount(nothing)
    await waitFor(() => expect(screen.getByTestId('simple-home-openings').dataset.done).toBe('false'))
    expect(screen.queryByTestId('simple-home-empty')).toBeNull()
    cleanup()
    state.appliedAt = '2026-10-13T10:00:00Z'
    mount(home({ receivables: owed({ total: 300000, parties: 1, oldest: { ledgerId: 9, name: 'Sharma Stores', days: 195 } }) }))
    await waitFor(() => expect(screen.getByTestId('simple-home-openings').dataset.done).toBe('true'))
    expect(screen.getByTestId('simple-home-customers-owe').textContent).toBe('Customers owe you ₹3,000.00')
    expect(screen.getByTestId('simple-tile-receivables-value').textContent).toBe('₹3,000.00')
  })

  it('a load error offers Try again', async () => {
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
