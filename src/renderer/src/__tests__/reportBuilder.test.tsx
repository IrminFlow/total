// WP 6.1 / 6.2 — the report builder screen (design → live preview → save), the pinned saved
// report as a dynamic sidebar entry, and the comparative statement's tree helpers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReportResult } from '@shared/reportBuilder/model'
import type { StatementNode } from '@shared/reports'
import { useNav, useSession } from '../state/stores'
import { ReportBuilderScreen } from '../screens/reportBuilder/ReportBuilder'
import { Shell } from '../components/Shell'
import { DialogHost } from '../components/dialogs'
import { amountIndex, unionTrees } from '../components/ComparativeStatement'

const invoke = vi.fn()
let handlers: Record<string, (payload: unknown) => unknown> = {}
const calls = (channel: string): unknown[] => invoke.mock.calls.filter((c) => c[0] === channel).map((c) => c[1])

function renderUi(ui: React.JSX.Element): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}>{ui}<DialogHost /></QueryClientProvider>)
}

const RESULT: ReportResult = {
  from: '2026-04-01', to: '2027-03-31',
  dims: [{ key: 'party', label: 'Party', link: 'ledger' }],
  measures: [{ key: 'taxable', label: 'Taxable value', kind: 'money', signed: false }],
  rows: [
    { keys: [{ id: 11, label: 'Acme Traders' }], values: [250_000] },
    { keys: [{ id: 12, label: 'Bolt & Co' }], values: [100_000] }
  ],
  totals: [350_000], compare: null, compareTotals: null, truncated: false, rowCap: 20000, warnings: []
}

beforeEach(() => {
  localStorage.clear()
  handlers = {
    'rb:run': () => RESULT,
    'rb:list': () => [],
    'rb:users': () => [],
    'master:ledgers:list': () => [],
    'master:groups:list': () => [],
    'master:stockItems:list': () => [],
    'master:godowns:list': () => [],
    'master:stockGroups:list': () => [],
    'master:voucherTypes:list': () => [{ id: 5, name: 'Sales', kind: 'sales' }],
    'cc:list': () => [],
    'budget:list': () => [],
    'config:features:get': () => ({})
  }
  invoke.mockReset()
  invoke.mockImplementation(async (channel: string, payload?: unknown) => {
    const h = handlers[channel]
    if (!h) return { ok: false, error: `unmocked channel ${channel}` }
    return { ok: true, data: h(payload) }
  })
  window.total = { platform: 'test', invoke }
  act(() => {
    useSession.setState({ slug: 'rb-co', from: '2026-04-01', to: '2027-03-31', locked: false })
    useNav.setState({ stack: [{ name: 'report-builder' }] })
  })
})
afterEach(() => cleanup())

describe('Report builder screen', () => {
  it('previews live, re-runs on a design change, and saves under a name', async () => {
    renderUi(<ReportBuilderScreen />)
    const rows = (): HTMLElement => screen.getByTestId('rows-report-builder')
    await waitFor(() => expect(within(rows()).getByText('Acme Traders')).toBeTruthy(), { timeout: 8000 })
    expect(screen.getByTestId('report-builder-table-totals').textContent).toContain('3,500.00')
    const first = calls('rb:run')[0] as { model: { source: string }; working: { from: string } }
    expect(first.model.source).toBe('accounts')
    expect(first.working.from).toBe('2026-04-01')

    // Design: switch the first dimension to Party, measure Taxable, filter to Sales vouchers.
    fireEvent.change(screen.getByTestId('rb-dim-0'), { target: { value: 'party' } })
    fireEvent.click(screen.getByTestId('rb-measure-taxable'))
    fireEvent.click(screen.getByTestId('rb-kind-sales'))
    await waitFor(() => {
      const last = calls('rb:run').at(-1) as { model: { dimensions: { key: string }[]; measures: string[]; filters: { voucherKinds: string[] } } }
      expect(last.model.dimensions[0]!.key).toBe('party')
      expect(last.model.measures).toContain('taxable')
      expect(last.model.filters.voucherKinds).toEqual(['sales'])
    }, { timeout: 8000 })
    await waitFor(() => expect(within(rows()).getByText('Bolt & Co')).toBeTruthy(), { timeout: 8000 })

    // A party cell drills to the ledger (row activation → statement).
    fireEvent.click(within(rows()).getByText('Bolt & Co').closest('tr')!)
    await waitFor(() => expect(useNav.getState().stack.at(-1)).toEqual({ name: 'ledger-statement', ledgerId: 12 }))
    act(() => useNav.setState({ stack: [{ name: 'report-builder' }] }))

    handlers['rb:save'] = (p) => ({ id: 9, name: (p as { name: string }).name, model: (p as { model: unknown }).model, problem: null, owner: null, pinned: false, createdAt: '', updatedAt: '' })
    fireEvent.click(screen.getByTestId('rb-save'))
    const input = await screen.findByTestId('prompt-input')
    fireEvent.change(input, { target: { value: 'Sales by party' } })
    fireEvent.click(screen.getByTestId('prompt-ok'))
    await waitFor(() => expect(calls('rb:save')).toHaveLength(1))
    expect(calls('rb:save')[0]).toMatchObject({ name: 'Sales by party', model: { dimensions: [{ key: 'party' }] } })
    await waitFor(() => expect(useNav.getState().stack.at(-1)).toEqual({ name: 'report-builder', reportId: 9 }))
  })

  it('shows what is missing instead of running an invalid design', async () => {
    renderUi(<ReportBuilderScreen />)
    await waitFor(() => expect(calls('rb:run').length).toBeGreaterThan(0))
    for (const k of ['debit', 'credit', 'net']) fireEvent.click(screen.getByTestId(`rb-measure-${k}`))
    expect((await screen.findByTestId('rb-problems')).textContent).toMatch(/Pick at least one measure/)
  })
})

describe('pinned reports in the sidebar', () => {
  it('a pinned saved report appears under Analysis and opens the builder with its id', async () => {
    handlers['rb:list'] = () => [
      { id: 5, name: 'Sales by party by month', model: null, problem: null, owner: null, pinned: true, createdAt: '', updatedAt: '' },
      { id: 6, name: 'Not pinned', model: null, problem: null, owner: null, pinned: false, createdAt: '', updatedAt: '' }
    ]
    act(() => useNav.setState({ stack: [{ name: 'gateway' }] }))
    renderUi(<Shell onOpenPalette={() => {}}><div /></Shell>)
    const entry = await screen.findByTestId('nav-report-5')
    expect(entry.textContent).toContain('Sales by party by month')
    expect(screen.queryByText('Not pinned')).toBeNull()
    expect(entry.closest('#nav-list-analysis')).toBeTruthy()
    fireEvent.click(entry)
    await waitFor(() => expect(useNav.getState().stack.at(-1)).toEqual({ name: 'report-builder', reportId: 5 }))
    await waitFor(() => expect(screen.getByTestId('nav-report-5').getAttribute('aria-current')).toBe('page'))
    expect(screen.getByTestId('nav-report-builder').getAttribute('aria-current')).toBeNull()
  })
})

describe('comparative statement trees', () => {
  const leaf = (id: number, name: string, amount: number): StatementNode => ({ id, kind: 'ledger', name, amount, children: [] })
  const group = (id: number, name: string, children: StatementNode[]): StatementNode => ({ id, kind: 'group', name, amount: children.reduce((s, c) => s + c.amount, 0), children })
  it('unions the columns’ trees, current amounts first, others by key', () => {
    const now = [group(1, 'Sales Accounts', [leaf(10, 'Sales', 500)])]
    const last = [group(1, 'Sales Accounts', [leaf(10, 'Sales', 300), leaf(11, 'Export sales', 80)])]
    const u = unionTrees([now, last])
    expect(u[0]!.children.map((c) => [c.name, c.amount])).toEqual([['Sales', 500], ['Export sales', 0]])
    expect(amountIndex(last).get('ledger:11:')).toBe(80)
  })
  it('a budgeted ledger with no actuals joins the tree (zero actual, its budget in the budget column)', () => {
    const actual = [group(30, 'Indirect Expenses', [leaf(20, 'Rent', 900)])]
    const budget = [group(30, 'Indirect Expenses', [leaf(20, 'Rent', 1000), leaf(22, 'Advertising', 500)])]
    const u = unionTrees([actual, budget])
    expect(u[0]!.children.map((c) => [c.name, c.amount])).toEqual([['Rent', 900], ['Advertising', 0]])
    expect(amountIndex(budget).get('ledger:22:')).toBe(500)
    expect(amountIndex(budget).get('group:30:')).toBe(1500)
  })
})
