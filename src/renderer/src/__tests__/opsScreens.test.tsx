// WP 1.7b — the operations screens on the DataTable platform: Stock summary, Banking, Cost
// centres and Payroll. Columns render, the default order matches the service's (the old screens
// rendered rows as returned), header sorts work, row activation reaches the same target as
// before, and the totals are right.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Employee, PayrollRun } from '@shared/domain'
import type { BankRecon, StockSummaryRow } from '@shared/reports'
import type { CcReportRow, PdcRow } from '../lib/client'
import { useNav, useSession } from '../state/stores'
import { StockSummaryScreen } from '../screens/StockSummary'
import { BankingScreen } from '../screens/Banking'
import { CostCentresScreen } from '../screens/CostCentres'
import { PayrollScreen } from '../screens/Payroll'

const invoke = vi.fn()
let handlers: Record<string, (payload: unknown) => unknown> = {}

function renderScreen(ui: React.JSX.Element): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

const bodyRows = (area: string): HTMLElement[] =>
  Array.from(screen.getByTestId(`rows-${area}`).querySelectorAll<HTMLElement>('tr.dt-row'))
/** Text of one column (by header id) for every body row, in display order. */
function columnText(area: string, colId: string): string[] {
  const headers = Array.from(screen.getByTestId(`${area}-table`).querySelectorAll<HTMLElement>('thead th'))
  const idx = headers.findIndex((th) => th.dataset.col === colId)
  expect(idx).toBeGreaterThanOrEqual(0)
  return bodyRows(area).map((tr) => tr.querySelectorAll('td')[idx]?.textContent?.trim() ?? '')
}
const totalsRow = (area: string): HTMLElement => screen.getByTestId(`${area}-table-totals`)
const lastScreen = (): unknown => {
  const s = useNav.getState().stack
  return s[s.length - 1]
}

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
    useSession.setState({ slug: 'ops-co', from: '2026-04-01', to: '2027-03-31' })
    useNav.setState({ stack: [{ name: 'gateway' }] })
  })
})
afterEach(() => cleanup())

// ---------------------------------------------------------------- stock summary

const STOCK: StockSummaryRow[] = [
  // Service order (by name) — deliberately not the closing-value order.
  { stockItemId: 1, name: 'Bolt M6', unitSymbol: 'pcs', decimals: 0, openingQtyMilli: 10_000, openingValue: 0, inwardQtyMilli: 5_000, outwardQtyMilli: 3_000, closingQtyMilli: 12_000, closingValue: 120_000 },
  { stockItemId: 2, name: 'Copper wire', unitSymbol: 'kg', decimals: 3, openingQtyMilli: 0, openingValue: 0, inwardQtyMilli: 2_500, outwardQtyMilli: 3_000, closingQtyMilli: -500, closingValue: -5_000 },
  { stockItemId: 3, name: 'Drill bit', unitSymbol: 'pcs', decimals: 0, openingQtyMilli: 4_000, openingValue: 0, inwardQtyMilli: 0, outwardQtyMilli: 1_000, closingQtyMilli: 3_000, closingValue: 450_000 }
]

describe('Stock summary on DataTable', () => {
  beforeEach(() => {
    handlers['stock:summary'] = () => STOCK
    handlers['report:stockAgeing'] = () => []
    handlers['stock:byGodown'] = () => [
      { godownId: 7, godownName: 'Main store', stockItemId: 3, name: 'Drill bit', unitSymbol: 'pcs', decimals: 0, closingQtyMilli: 3_000, closingValue: 450_000 }
    ]
    handlers['stock:batches'] = () => []
  })

  it('renders every column with units, keeps the service order, flags negative stock and totals closing value', async () => {
    renderScreen(<StockSummaryScreen />)
    await waitFor(() => expect(bodyRows('stock-summary')).toHaveLength(3))
    expect(columnText('stock-summary', 'item')).toEqual(['Bolt M6', 'Copper wire— negative stock, check entries', 'Drill bit'])
    expect(columnText('stock-summary', 'opening')).toEqual(['10 pcs', '0.000 kg', '4 pcs'])
    expect(columnText('stock-summary', 'closingQty')).toEqual(['12 pcs', '-0.500 kg', '3 pcs'])
    expect(bodyRows('stock-summary')[1]!.className).toContain('text-cr')
    // Σ closing value = 1,200 − 50 + 4,500 rupees.
    expect(totalsRow('stock-summary').textContent).toContain('5,650.00')
    expect(totalsRow('stock-summary').textContent).toContain('Total')
  })

  it('sorts by a column header (closing value, by paise)', async () => {
    renderScreen(<StockSummaryScreen />)
    await waitFor(() => expect(bodyRows('stock-summary')).toHaveLength(3))
    fireEvent.click(screen.getByTestId('sort-stock-summary-closingValue'))
    expect(columnText('stock-summary', 'item').map((t) => t.split('—')[0])).toEqual(['Copper wire', 'Bolt M6', 'Drill bit'])
    fireEvent.click(screen.getByTestId('sort-stock-summary-closingValue'))
    expect(columnText('stock-summary', 'item').map((t) => t.split('—')[0])).toEqual(['Drill bit', 'Bolt M6', 'Copper wire'])
  })

  it('a row click unfolds that item (one at a time) into its godown breakdown, like before', async () => {
    renderScreen(<StockSummaryScreen />)
    await waitFor(() => expect(bodyRows('stock-summary')).toHaveLength(3))
    fireEvent.click(bodyRows('stock-summary')[2]!)
    const detail = await screen.findByTestId('stock-item-detail')
    expect(detail.textContent).toContain('Main store: 3 pcs')
    // Another row replaces it; clicking it again folds it.
    fireEvent.click(bodyRows('stock-summary')[0]!)
    await waitFor(() => expect(screen.queryByTestId('stock-item-detail')).toBeNull())
    expect(await screen.findByText('No godown or batch breakdown for this item.')).toBeTruthy()
    fireEvent.click(bodyRows('stock-summary')[0]!)
    await waitFor(() => expect(screen.queryByText('No godown or batch breakdown for this item.')).toBeNull())
  })

  it('seeds hidden columns from the old useReportConfig toggles', async () => {
    localStorage.setItem('total-reportcfg-ops-co-stock-summary', JSON.stringify({ opening: false, inwards: true }))
    renderScreen(<StockSummaryScreen />)
    await waitFor(() => expect(bodyRows('stock-summary')).toHaveLength(3))
    expect(screen.queryByTestId('sort-stock-summary-opening')).toBeNull()
    expect(screen.getByTestId('sort-stock-summary-inwards')).toBeTruthy()
  })
})

// ---------------------------------------------------------------- banking

const RECON: BankRecon = {
  ledgerId: 5,
  ledgerName: 'HDFC Bank',
  bookBalance: 1_000_000,
  unreconciledDeposits: 250_000,
  unreconciledWithdrawals: 40_000,
  bankBalance: 790_000,
  rows: [
    { lineId: 11, voucherId: 101, date: '2026-04-03', voucherType: 'Receipt', number: 'R1', particulars: 'Acme Traders', particularsLedgerId: 31, instrumentNo: null, deposit: 250_000, withdrawal: 0, bankDate: null },
    { lineId: 12, voucherId: 102, date: '2026-04-05', voucherType: 'Payment', number: 'P1', particulars: 'Office rent', particularsLedgerId: 32, instrumentNo: '000123', deposit: 0, withdrawal: 40_000, bankDate: '2026-04-06' },
    { lineId: 13, voucherId: 103, date: '2026-04-09', voucherType: 'Receipt', number: 'R2', particulars: 'Bharat Stores', particularsLedgerId: 33, instrumentNo: null, deposit: 75_000, withdrawal: 0, bankDate: null }
  ]
}

const PDC: PdcRow[] = [
  { id: 201, date: '2026-05-01', number: 'P9', voucherTypeName: 'Payment', partyLedgerId: 34, partyName: 'Landlord', instrumentNo: '445', instrumentDate: '2026-05-01', amount: 40_000 },
  { id: 202, date: '2026-05-10', number: 'R7', voucherTypeName: 'Receipt', partyLedgerId: 31, partyName: 'Acme Traders', instrumentNo: null, instrumentDate: null, amount: 90_000 }
]

describe('Banking on DataTable', () => {
  beforeEach(() => {
    handlers['bank:ledgers'] = () => [{ id: 5, name: 'HDFC Bank' }]
    handlers['bank:recon'] = () => RECON
    handlers['pdc:list'] = () => PDC
  })

  it('reconcile list: columns, date order, reconciled rows dimmed, deposit/withdrawal totals', async () => {
    renderScreen(<BankingScreen />)
    await waitFor(() => expect(bodyRows('banking')).toHaveLength(3))
    expect(columnText('banking', 'particulars')).toEqual(['Acme Traders', 'Office rent', 'Bharat Stores'])
    expect(columnText('banking', 'date')).toEqual(['03-Apr-26', '05-Apr-26', '09-Apr-26'])
    expect(columnText('banking', 'bankDate')).toEqual(['Set date', '06-Apr-26', 'Set date'])
    expect(bodyRows('banking')[1]!.className).toContain('text-muted')
    expect(bodyRows('banking').map((tr) => tr.dataset.rowId)).toEqual(['11', '12', '13'])
    const totals = totalsRow('banking').textContent ?? ''
    expect(totals).toContain('3,250.00')
    expect(totals).toContain('400.00')
  })

  it('sorts by deposit and keeps the per-row actions working', async () => {
    renderScreen(<BankingScreen />)
    await waitFor(() => expect(bodyRows('banking')).toHaveLength(3))
    fireEvent.click(screen.getByTestId('sort-banking-deposit'))
    fireEvent.click(screen.getByTestId('sort-banking-deposit'))
    expect(columnText('banking', 'particulars')).toEqual(['Acme Traders', 'Bharat Stores', 'Office rent'])
    // The bank-date cell still opens the date editor for its own line.
    fireEvent.click(within(bodyRows('banking')[0]!).getByTestId('btn-banking-edit-bank-date'))
    expect(await screen.findByTestId('input-bank-date')).toBeTruthy()
  })

  it('post-dated tab: lists PDCs with a total, and Edit opens the voucher as before', async () => {
    renderScreen(<BankingScreen />)
    await waitFor(() => expect(bodyRows('banking')).toHaveLength(3))
    fireEvent.click(screen.getByTestId('tab-banking-pdc'))
    await waitFor(() => expect(bodyRows('banking-pdc')).toHaveLength(2))
    expect(columnText('banking-pdc', 'party')).toEqual(['Landlord', 'Acme Traders'])
    expect(totalsRow('banking-pdc').textContent).toContain('1,300.00')
    fireEvent.click(within(bodyRows('banking-pdc')[1]!).getByTestId('btn-banking-pdc-edit'))
    await waitFor(() => expect(lastScreen()).toEqual({ name: 'voucher-entry', voucherId: 202 }))
  })
})

// ---------------------------------------------------------------- cost centres

const CC_REPORT: CcReportRow[] = [
  { costCentreId: 1, name: 'Branch A', income: 500_000, expense: 200_000, net: 300_000 },
  { costCentreId: 2, name: 'Branch B', income: 100_000, expense: 250_000, net: -150_000 }
]

describe('Cost centres on DataTable', () => {
  beforeEach(() => {
    handlers['cc:list'] = () => [
      { id: 1, name: 'Branch A', parentId: null, active: true },
      { id: 2, name: 'Branch B', parentId: 1, active: false }
    ]
    handlers['cc:report'] = () => CC_REPORT
    handlers['cc:statement'] = () => [{ date: '2026-04-12', voucherId: 77, number: 'S12', ledgerName: 'Sales', drCr: 'cr', amount: 500_000 }]
  })

  it('master list resolves parents; P&L totals income/expense/net; a row drills into postings that open the voucher', async () => {
    renderScreen(<CostCentresScreen />)
    await waitFor(() => expect(bodyRows('cost-centres')).toHaveLength(2))
    expect(columnText('cost-centres', 'parent')).toEqual(['', 'Branch A'])
    expect(columnText('cost-centres', 'active')).toEqual(['Yes', 'No'])
    await waitFor(() => expect(bodyRows('cost-centre-pl')).toHaveLength(2))
    expect(columnText('cost-centre-pl', 'net')).toEqual(['3,000.00 Dr', '1,500.00 Cr'])
    const totals = totalsRow('cost-centre-pl').textContent ?? ''
    expect(totals).toContain('6,000.00')
    expect(totals).toContain('4,500.00')
    expect(totals).toContain('1,500.00 Dr')
    fireEvent.click(bodyRows('cost-centre-pl')[0]!)
    const drill = await screen.findByTestId('cc-drill')
    fireEvent.click(within(drill).getByText('S12'))
    await waitFor(() => expect(lastScreen()).toEqual({ name: 'voucher-entry', voucherId: 77 }))
  })
})

// ---------------------------------------------------------------- payroll

const emp = (id: number, name: string, basic: number, active = true): Employee => ({
  id, name, code: null, designation: 'Staff', joined: null, pan: null, uan: null, esicNo: null,
  basic, hra: 0, special: 1_000_00, pfEnabled: true, esiEnabled: true, ptEnabled: true, ptState: 'MH', active
})

describe('Payroll on DataTable', () => {
  beforeEach(() => {
    handlers['payroll:employees:list'] = () => [emp(1, 'Asha', 20_000_00), emp(2, 'Ravi', 15_000_00, false), emp(3, 'Zoya', 10_000_00)]
    handlers['payroll:runs'] = (): PayrollRun[] => [
      { id: 9, month: '2026-08', voucherId: 900, createdAt: '2026-08-31', lines: [] },
      { id: 8, month: '2026-07', voucherId: 800, createdAt: '2026-07-31', lines: [] }
    ]
    handlers['payroll:preview'] = () => []
  })

  it('employees: inactive rows dimmed, gross per row, monthly totals cover active employees only', async () => {
    renderScreen(<PayrollScreen />)
    await waitFor(() => expect(bodyRows('payroll-employees')).toHaveLength(3))
    expect(columnText('payroll-employees', 'gross')).toEqual(['21,000.00', '16,000.00', '11,000.00'])
    expect(bodyRows('payroll-employees')[1]!.className).toContain('text-muted')
    const totals = totalsRow('payroll-employees').textContent ?? ''
    expect(totals).toContain('Total (active)')
    expect(totals).toContain('32,000.00') // gross: Asha + Zoya, not Ravi
    fireEvent.click(screen.getByTestId('sort-payroll-employees-basic'))
    expect(columnText('payroll-employees', 'name').map((n) => n.replace('inactive', ''))).toEqual(['Zoya', 'Ravi', 'Asha'])
  })

  it('pay runs: newest month first, Voucher opens the posting', async () => {
    renderScreen(<PayrollScreen />)
    await waitFor(() => expect(screen.getByTestId('tab-payroll-runs')).toBeTruthy())
    fireEvent.click(screen.getByTestId('tab-payroll-runs'))
    await waitFor(() => expect(bodyRows('payroll-runs')).toHaveLength(2))
    expect(columnText('payroll-runs', 'month')).toEqual(['Aug 2026', 'Jul 2026'])
    fireEvent.click(within(bodyRows('payroll-runs')[1]!).getByTestId('btn-payroll-voucher'))
    await waitFor(() => expect(lastScreen()).toEqual({ name: 'voucher-entry', voucherId: 800 }))
  })
})
