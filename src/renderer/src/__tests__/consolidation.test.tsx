// WP 6.5 — group consolidation screens: statements with member / elimination / consolidated
// columns and drill-down, the inter-company reconciliation, and the group definition form.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { consolidateStatement } from '@shared/consolidation/engine'
import type { ConsolidationGroup, GroupRunResult, MemberInput, StatementKind } from '@shared/consolidation/types'
import { useNav, useSession } from '../state/stores'
import { ConsolidationScreen } from '../screens/consolidation/Consolidation'
import { draftToPayload } from '../screens/consolidation/Setup'
import { pctToBp, bpToPct, sectionValue } from '../screens/consolidation/view'

const invoke = vi.fn()
let handlers: Record<string, (payload: unknown) => unknown> = {}

function renderScreen(ui: React.JSX.Element): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}
const bodyRows = (area: string): HTMLElement[] => Array.from(screen.getByTestId(`rows-${area}`).querySelectorAll<HTMLElement>('tr.dt-row'))

beforeEach(() => {
  localStorage.clear()
  handlers = {}
  invoke.mockImplementation(async (channel: string, payload?: unknown) => {
    const h = handlers[channel]
    if (!h) return { ok: false, error: `unmocked channel ${channel}` }
    return { ok: true, data: h(payload) }
  })
  window.total = { platform: 'test', invoke }
  act(() => {
    useSession.setState({ slug: 'alpha', from: '2025-04-01', to: '2026-03-31' })
    useNav.setState({ stack: [{ name: 'gateway' }] })
  })
})
afterEach(() => cleanup())

const GROUP: ConsolidationGroup = {
  id: 1, name: 'Alpha group', presentationCurrency: 'INR', icTolerance: 100, unrealisedMarginBp: null,
  members: [
    { id: 1, companySlug: 'alpha', role: 'parent', ownershipBp: 10000, acquiredOn: null, includeFrom: null, includeTo: null, investmentLedgerId: null, investmentCompanySlug: null, investmentLedgerName: null, investmentCost: null, acquisitionEquity: null },
    { id: 2, companySlug: 'beta', role: 'subsidiary', ownershipBp: 8000, acquiredOn: '2025-04-01', includeFrom: null, includeTo: null, investmentLedgerId: null, investmentCompanySlug: null, investmentLedgerName: null, investmentCost: null, acquisitionEquity: null }
  ],
  mappings: [],
  pairs: [{ id: 7, memberA: 'alpha', ledgerAId: 11, ledgerAName: 'Beta Traders', memberB: 'beta', ledgerBId: 21, ledgerBName: 'Alpha Holdings', kind: 'sales_purchase', unrealisedMarginBp: null }]
}

function member(slug: string, name: string, rows: [number, string, string, 'income' | 'expense', number][], extra: Partial<MemberInput> = {}): MemberInput {
  return {
    slug, name, role: 'parent', ownershipBp: 10000, included: true,
    ledgers: rows.map(([id, n, g, nature]) => ({ id, name: n, groupName: g, groupPath: [g], nature, gp: true, equity: false })),
    rows: rows.map(([id, n, g, nature, amount]) => ({ ledgerId: id, name: n, groupName: g, nature, gp: true, amount, equity: false })),
    periodProfit: 0, equityNow: 0, acquisitionEquity: null, closingStock: 0, purchases: 0, sales: 0, grossProfit: 0, investmentLedgerId: null, investmentCost: null, ...extra
  }
}

function runResult(): GroupRunResult {
  const members = [
    member('alpha', 'Alpha Holdings', [[11, 'Sales', 'Sales Accounts', 'income', -20000_00], [12, 'Sales to Beta', 'Sales Accounts', 'income', -50000_00]], { periodProfit: 70000_00 }),
    member('beta', 'Beta Traders', [[21, 'Sales', 'Sales Accounts', 'income', -80000_00], [22, 'Purchases', 'Purchase Accounts', 'expense', 50000_00]], { role: 'subsidiary', ownershipBp: 8000, periodProfit: 30000_00 })
  ]
  const pairs = [{ id: 7, kind: 'other' as const, a: { slug: 'alpha', ledgerId: 12 }, b: { slug: 'beta', ledgerId: 22 }, unrealisedMarginBp: null }]
  const st = (kind: StatementKind) => consolidateStatement({ kind, members, pairs, mappings: [], icTolerance: 100, unrealisedMarginBp: null })
  return {
    group: { id: 1, name: 'Alpha group', presentationCurrency: 'INR', icTolerance: 100, unrealisedMarginBp: null },
    period: { from: '2025-04-01', to: '2026-03-31' },
    openSlug: 'alpha',
    tb: st('tb'), pnl: st('pnl'), bs: st('bs'),
    recon: [{
      pairId: 7, kind: 'receivable_payable', memberA: 'alpha', memberAName: 'Alpha Holdings', ledgerAId: 11, ledgerAName: 'Beta Traders',
      memberB: 'beta', memberBName: 'Beta Traders', ledgerBId: 21, ledgerBName: 'Alpha Holdings',
      balanceA: 50000_00, balanceB: -45000_00, difference: 5000_00, status: 'unreconciled',
      flowA: null, flowB: null, flowDifference: null, flowStatus: 'n/a', ageingA: [50000_00, 0, 0, 0, 0], ageingB: [-45000_00, 0, 0, 0, 0], note: null
    }],
    warnings: []
  }
}

describe('consolidation helpers', () => {
  it('converts percentages and builds the save payload', () => {
    expect(pctToBp('80')).toBe(8000)
    expect(pctToBp('12.5 %')).toBe(1250)
    expect(pctToBp('')).toBeNull()
    expect(pctToBp('120')).toBeNull()
    expect(bpToPct(7550)).toBe('75.5')
    expect(sectionValue('income') < sectionValue('expense')).toBe(true)
    expect(draftToPayload(' G ', '', 50, '20', [
      { companySlug: 'a', role: 'parent', ownershipPct: '30', acquiredOn: '', includeFrom: '', includeTo: '', investmentLedgerId: 5, investmentCost: 7, acquisitionEquity: 1 },
      { companySlug: 'b', role: 'subsidiary', ownershipPct: '60', acquiredOn: '2025-04-01', includeFrom: '', includeTo: '', investmentLedgerId: 5, investmentCost: 300, acquisitionEquity: null }
    ])).toEqual({
      name: 'G', presentationCurrency: 'INR', icTolerance: 50, unrealisedMarginBp: 2000,
      members: [
        { companySlug: 'a', role: 'parent', ownershipBp: 10000, acquiredOn: null, includeFrom: null, includeTo: null, investmentLedgerId: null, investmentCost: null, acquisitionEquity: null },
        { companySlug: 'b', role: 'subsidiary', ownershipBp: 6000, acquiredOn: '2025-04-01', includeFrom: null, includeTo: null, investmentLedgerId: 5, investmentCost: 300, acquisitionEquity: null }
      ]
    })
  })
})

describe('Group consolidation screen', () => {
  it('shows member, elimination and consolidated columns with the profit split and a drill-down', async () => {
    handlers['consolGroup:list'] = () => [GROUP]
    handlers['consolGroup:run'] = () => runResult()
    handlers['export:csv'] = () => ({ path: '/tmp/c.csv' })
    renderScreen(<ConsolidationScreen />)
    await waitFor(() => expect(screen.getByTestId('consol-net-profit').textContent).toBe('1,00,000.00'))
    expect(screen.getByTestId('consol-minority').textContent).toBe('6,000.00')
    expect(screen.getByTestId('consol-owners').textContent).toBe('94,000.00')
    const sales = bodyRows('consol-statement').find((r) => r.dataset.line === 'income:sales accounts')!
    expect(sales.textContent).toContain('70,000.00 Cr')
    expect(sales.textContent).toContain('1,00,000.00 Cr')
    // Drill: expand the line — the open company's ledger links, the other company's stays text.
    fireEvent.click(screen.getByTestId('consol-statement-expand-income:sales accounts'))
    const drill = await screen.findByTestId('drill-income:sales accounts')
    expect(within(drill).getAllByTestId('ledger-link')).toHaveLength(2)
    expect(drill.querySelector('[data-drill-ledger="beta:21"]')!.textContent).toContain('Beta Traders')
    expect(within(drill).getByText(/Inter-company transactions/)).toBeTruthy()

    fireEvent.click(screen.getByTestId('consol-statement-table-csv'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('export:csv', expect.anything()))
    const csv = (invoke.mock.calls.find((c) => c[0] === 'export:csv')![1] as { csv: string }).csv.replace(/^﻿/, '')
    expect(csv.split(/\r?\n/)[0]).toContain('Alpha Holdings')
    expect(csv).toContain('-100000.00')
  })

  it('lists inter-company pairs with their difference and status', async () => {
    handlers['consolGroup:list'] = () => [GROUP]
    handlers['consolGroup:run'] = () => runResult()
    renderScreen(<ConsolidationScreen tab="intercompany" />)
    await waitFor(() => expect(bodyRows('consol-recon')).toHaveLength(1))
    const row = bodyRows('consol-recon')[0]!
    expect(row.dataset.status).toBe('unreconciled')
    expect(row.textContent).toContain('5,000.00 Dr')
    expect(screen.getByTestId('tab-consolidation-intercompany').textContent).toContain('1')
  })

  it('creates a group with this company as the parent', async () => {
    handlers['consolGroup:list'] = () => []
    handlers['company:list'] = () => ({ companies: [{ slug: 'alpha', name: 'Alpha Holdings' }, { slug: 'beta', name: 'Beta Traders' }] })
    const saved = vi.fn((p: unknown) => ({ ...GROUP, ...((p as { data: { name: string } }).data), id: 3, mappings: [], pairs: [], members: GROUP.members }))
    handlers['consolGroup:save'] = saved
    handlers['consolGroup:charts'] = () => []
    renderScreen(<ConsolidationScreen />)
    fireEvent.click(await screen.findByTestId('btn-consol-new-empty'))
    fireEvent.change(screen.getByTestId('input-consol-name'), { target: { value: 'Alpha group' } })
    await waitFor(() => expect(screen.getByTestId('select-consol-add').querySelectorAll('option').length).toBe(2))
    fireEvent.change(screen.getByTestId('select-consol-add'), { target: { value: 'beta' } })
    fireEvent.change(screen.getByTestId('input-consol-own-beta'), { target: { value: '80' } })
    fireEvent.click(screen.getByTestId('btn-consol-save'))
    await waitFor(() => expect(saved).toHaveBeenCalled())
    const payload = saved.mock.calls[0]![0] as { id?: number; data: { name: string; members: { companySlug: string; role: string; ownershipBp: number }[] } }
    expect(payload.id).toBeUndefined()
    expect(payload.data.name).toBe('Alpha group')
    expect(payload.data.members.map((m) => [m.companySlug, m.role, m.ownershipBp])).toEqual([['alpha', 'parent', 10000], ['beta', 'subsidiary', 8000]])
  })

  it('suggestions need a kind; name-only matches are not accepted in bulk; mapping natures stay within a statement', async () => {
    handlers['consolGroup:list'] = () => [GROUP]
    handlers['company:list'] = () => ({ companies: [{ slug: 'alpha', name: 'Alpha Holdings' }, { slug: 'beta', name: 'Beta Traders' }] })
    handlers['consolGroup:charts'] = () => [
      { slug: 'alpha', name: 'Alpha Holdings', available: true, warning: null, gstin: null, pan: null, groups: [{ name: 'Sundry Debtors', nature: 'asset' }, { name: 'Sales Accounts', nature: 'income' }], ledgers: [{ id: 11, name: 'Beta Traders', groupName: 'Sundry Debtors', nature: 'asset', gstin: null, pan: null }] },
      { slug: 'beta', name: 'Beta Traders', available: true, warning: null, gstin: null, pan: null, groups: [], ledgers: [{ id: 21, name: 'Alpha Holdings', groupName: 'Sundry Creditors', nature: 'liability', gstin: null, pan: null }] }
    ]
    handlers['consolPair:suggest'] = () => [
      { memberA: 'alpha', ledgerAId: 11, ledgerAName: 'Beta Traders', memberB: 'beta', ledgerBId: 21, ledgerBName: 'Alpha Holdings', kinds: ['receivable_payable', 'sales_purchase'], reason: 'name' }
    ]
    const saved = vi.fn(() => ({}))
    handlers['consolPair:save'] = saved
    renderScreen(<ConsolidationScreen tab="groups" />)
    fireEvent.click(await screen.findByTestId('btn-consol-suggest'))
    await screen.findByTestId('consol-sugg-0')
    expect((screen.getByTestId('btn-consol-accept-all') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('consol-sugg-0-accept') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId('consol-sugg-0-sales_purchase'))
    fireEvent.click(screen.getByTestId('consol-sugg-0-accept'))
    await waitFor(() => expect(saved).toHaveBeenCalledTimes(1))
    expect((saved.mock.calls[0] as unknown as [{ data: { kind: string } }])[0].data.kind).toBe('sales_purchase')
    // Mapping a balance-sheet group offers only balance-sheet natures.
    fireEvent.change(screen.getByTestId('select-map-company'), { target: { value: 'alpha' } })
    fireEvent.change(screen.getByTestId('select-map-source'), { target: { value: 'Sundry Debtors' } })
    const natures = Array.from(screen.getByTestId('select-map-nature').querySelectorAll('option')).map((o) => o.getAttribute('value'))
    expect(natures).toEqual(['', 'asset', 'liability'])
  })
})
