// WP 1.6b — screens that were held back by DataTable gaps: Banking's import-preview and
// bank-rules tables and Payroll's pay-head / employee-head / PT tables now live inside their
// modals on DataTable; GSTR-2B gets its Portal | Books header band back; Masters → Ledgers and
// e-Invoice host their pre-filters in the table toolbar (which no longer vanishes at zero rows);
// Day Book's footer is the platform's; Consolidated has one CSV, written as plain numbers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Employee, Group, Ledger, PayrollRun } from '@shared/domain'
import type { BankRecon, EdocListRow } from '@shared/reports'
import type { BankRuleRecord, PayHead } from '../lib/client'
import { useNav, useSession } from '../state/stores'
import { BankingScreen } from '../screens/Banking'
import { PayrollScreen } from '../screens/Payroll'
import { Masters } from '../screens/Masters'
import { EdocsScreen } from '../screens/Edocs'
import { ConsolidatedScreen } from '../screens/Consolidated'

const invoke = vi.fn()
let handlers: Record<string, (payload: unknown) => unknown> = {}

function renderScreen(ui: React.JSX.Element): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}
const bodyRows = (area: string): HTMLElement[] =>
  Array.from(screen.getByTestId(`rows-${area}`).querySelectorAll<HTMLElement>('tr.dt-row'))
const activeIndex = (area: string): number => bodyRows(area).findIndex((r) => r.dataset.active === 'true')
const press = (key: string): void => {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}
const dialog = (title: string): HTMLElement => document.querySelector<HTMLElement>(`[data-modal="${title}"]`)!

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
    useSession.setState({ slug: 'gap-co', from: '2026-04-01', to: '2027-03-31' })
    useNav.setState({ stack: [{ name: 'gateway' }] })
  })
})
afterEach(() => cleanup())

// ---------------------------------------------------------------- banking

const RECON: BankRecon = {
  ledgerId: 5,
  ledgerName: 'HDFC Bank',
  bookBalance: 250_000,
  unreconciledDeposits: 250_000,
  unreconciledWithdrawals: 0,
  bankBalance: 0,
  rows: [{ lineId: 11, voucherId: 101, date: '2026-04-03', voucherType: 'Receipt', number: 'R1', particulars: 'Acme Traders', particularsLedgerId: 31, instrumentNo: null, deposit: 250_000, withdrawal: 0, bankDate: null }]
}

const RULES: BankRuleRecord[] = [
  { id: 1, pattern: 'ACME', matchField: 'description', ledgerId: 7, ledgerName: 'Acme Traders', kind: 'receipt', minAmount: null, maxAmount: null, autoApply: false, active: true, hits: 4 },
  { id: 2, pattern: 'RENT', matchField: 'description', ledgerId: 8, ledgerName: 'Rent', kind: 'payment', minAmount: null, maxAmount: null, autoApply: false, active: false, hits: 1 }
]

describe('Banking tab tables', () => {
  beforeEach(() => {
    handlers['bank:ledgers'] = () => [{ id: 5, name: 'HDFC Bank' }]
    handlers['bank:recon'] = () => RECON
    handlers['bankrule:list'] = () => RULES
    handlers['bankLearned:list'] = () => []
    handlers['master:ledgers:list'] = () => []
    handlers['master:groups:list'] = () => []
    handlers['bankImport:workspace'] = () => ({ lines: [], imports: [], openEntries: [] })
    handlers['bankImport:pickFile'] = () => ({ fileName: 'stmt.csv', base64: 'eA==' })
    handlers['bankImport:preview'] = () => ({
      fileName: 'stmt.csv',
      format: 'csv',
      profile: {
        delimiter: ',', encoding: 'utf-8', headerRow: 1, dateFormat: 'auto', dateCol: 0, valueDateCol: null, descCols: [1], refCol: null,
        amountMode: 'split', debitCol: 2, creditCol: 3, amountCol: null, flagCol: null, balanceCol: null, signedNegativeIsDeposit: false
      },
      profileSource: 'detected',
      grid: [['Date', 'Narration', 'Debit', 'Credit'], ['03/04/2026', 'NEFT ACME', '', '2500.00'], ['05/04/2026', 'CHQ 445 RENT', '400.00', '']],
      lines: [
        { lineNo: 1, hash: 'a', duplicate: false, date: '2026-04-03', valueDate: null, description: 'NEFT ACME', reference: '', deposit: 250_000, withdrawal: 0, balance: null },
        { lineNo: 2, hash: 'b', duplicate: true, date: '2026-04-05', valueDate: null, description: 'CHQ 445 RENT', reference: '', deposit: 0, withdrawal: 40_000, balance: null }
      ],
      newCount: 1,
      duplicateCount: 1,
      warnings: [],
      account: null,
      openingBalance: null,
      closingBalance: null
    })
  })

  it('import preview: the raw grid, the mapping and the lines (a DataTable, sortable, duplicates marked)', async () => {
    renderScreen(<BankingScreen />)
    await waitFor(() => expect(bodyRows('banking')).toHaveLength(1))
    fireEvent.click(screen.getByTestId('btn-banking-import'))
    fireEvent.click(await screen.findByTestId('btn-banking-pick-statement'))
    await waitFor(() => expect(screen.getByTestId('rows-banking-import-lines')).toBeTruthy())
    expect(screen.getByTestId('banking-import-grid').textContent).toContain('CHQ 445 RENT')
    expect(bodyRows('banking-import-lines').map((r) => r.querySelectorAll('td')[1]!.textContent)).toEqual(['NEFT ACME', 'CHQ 445 RENT'])
    expect(bodyRows('banking-import-lines')[1]!.textContent).toContain('Already imported')
    fireEvent.click(screen.getByTestId('sort-banking-import-lines-withdrawal'))
    fireEvent.click(screen.getByTestId('sort-banking-import-lines-withdrawal'))
    expect(bodyRows('banking-import-lines')[0]!.textContent).toContain('CHQ 445 RENT')
    expect(screen.getByTestId('btn-banking-commit-import').textContent).toBe('Import 1 line')
    // Changing the mapping requires applying it before importing.
    fireEvent.change(screen.getByTestId('input-banking-map-dateFormat'), { target: { value: 'DD/MM/YYYY' } })
    expect(screen.getByTestId('btn-banking-commit-import').textContent).toBe('Apply the mapping first')
  })

  it('bank rules: a DataTable whose filter popover closes on Esc; a row loads the rule into the form; Active toggles', async () => {
    renderScreen(<BankingScreen tab="rules" />)
    await waitFor(() => expect(bodyRows('banking-rules')).toHaveLength(2))
    expect(bodyRows('banking-rules').map((r) => r.dataset.rowId)).toEqual(['1', '2'])
    fireEvent.click(screen.getByTestId('filter-banking-rules-pattern'))
    expect(document.querySelector('[data-table-popover]')).toBeTruthy()
    press('Escape')
    expect(document.querySelector('[data-table-popover]')).toBeNull()
    // Toggling Active is not an edit; clicking the row is.
    fireEvent.click(within(bodyRows('banking-rules')[1]!).getByText('Paused'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('bankrule:save', expect.objectContaining({ id: 2, data: expect.objectContaining({ active: true }) })))
    expect(screen.queryByText('Edit rule')).toBeNull()
    fireEvent.click(bodyRows('banking-rules')[0]!)
    expect(screen.getByText('Edit rule')).toBeTruthy()
    expect(screen.getByDisplayValue('ACME')).toBeTruthy()
  })
})

// ---------------------------------------------------------------- payroll

const emp = (id: number, name: string): Employee => ({
  id, name, code: null, designation: 'Staff', joined: null, pan: null, uan: null, esicNo: null,
  basic: 20_000_00, hra: 0, special: 0, pfEnabled: true, esiEnabled: true, ptEnabled: true, ptState: 'MH', active: true,
  pfNumber: null, gender: null, dob: null, taxRegime: 'new', vpfRateBp: 0, pfOnFullWage: false, epsEligible: true, disabled: false, metro: false, tdsEnabled: true
})
const HEADS: PayHead[] = [
  { id: 1, name: 'Conveyance', kind: 'earning', calc: 'flat', value: 1_600_00, active: true, inWages: false },
  { id: 2, name: 'Bonus', kind: 'earning', calc: 'percent_of_basic', value: 833, active: false, inWages: true }
]

describe('Payroll modal tables', () => {
  beforeEach(() => {
    handlers['payroll:employees:list'] = () => [emp(1, 'Asha Rao')]
    handlers['payroll:runs'] = (): PayrollRun[] => [{ id: 9, month: '2026-08', voucherId: 900, createdAt: '2026-08-31', pfAdminTopUp: 0, lines: [] }]
    handlers['payroll:preview'] = () => []
    handlers['payroll:heads:list'] = () => HEADS
    handlers['payroll:employeeHeads:get'] = () => [{ payHeadId: 1, name: 'Conveyance', kind: 'earning', calc: 'flat', value: 1_600_00, overrideValue: 2_000_00 }]
    handlers['payroll:ptSummary'] = () => [
      { state: 'MH', employees: 2, gross: 40_000_00, pt: 400_00 },
      { state: 'KA', employees: 1, gross: 25_000_00, pt: 200_00 }
    ]
  })

  it('pay heads: flat and percent values, Enter on the active row loads it for editing', async () => {
    renderScreen(<PayrollScreen />)
    await waitFor(() => expect(bodyRows('payroll-employees')).toHaveLength(1))
    fireEvent.click(screen.getByTestId('btn-payroll-pay-heads'))
    await waitFor(() => expect(bodyRows('payroll-heads')).toHaveLength(2))
    expect(bodyRows('payroll-heads').map((r) => r.querySelectorAll('td')[3]!.textContent)).toEqual(['1,600.00', '8.33%'])
    press('ArrowDown')
    press('Enter')
    expect(screen.getByText('Edit pay head')).toBeTruthy()
    expect(screen.getByDisplayValue('Bonus')).toBeTruthy()
  })

  it('employee heads: a checkbox per head (leading cell) and the override editor in its column', async () => {
    renderScreen(<PayrollScreen />)
    await waitFor(() => expect(bodyRows('payroll-employees')).toHaveLength(1))
    fireEvent.click(screen.getByTestId('btn-payroll-overrides'))
    await waitFor(() => expect(bodyRows('payroll-employee-heads')).toHaveLength(2))
    const [conv, bonus] = bodyRows('payroll-employee-heads')
    expect(within(conv!).getByLabelText('Assign Conveyance')).toHaveProperty('checked', true)
    expect((within(conv!).getByTestId('input-payroll-override') as HTMLInputElement).value).toBe('2,000.00')
    expect(bonus!.className).toContain('text-muted')
    expect(within(bonus!).queryByTestId('input-payroll-override')).toBeNull()
    fireEvent.click(within(bonus!).getByLabelText('Assign Bonus'))
    expect(within(bodyRows('payroll-employee-heads')[1]!).getByTestId('input-payroll-override')).toBeTruthy()
    expect(screen.getByText('Override for Asha')).toBeTruthy()
  })

  it('PT summary: states with a totals footer', async () => {
    renderScreen(<PayrollScreen />)
    await waitFor(() => expect(screen.getByTestId('tab-payroll-runs')).toBeTruthy())
    fireEvent.click(screen.getByTestId('tab-payroll-runs'))
    await waitFor(() => expect(bodyRows('payroll-runs')).toHaveLength(1))
    fireEvent.click(screen.getByTestId('btn-payroll-pt'))
    await waitFor(() => expect(bodyRows('payroll-pt')).toHaveLength(2))
    const totals = screen.getByTestId('payroll-pt-table-totals').textContent ?? ''
    expect(totals).toContain('Total')
    expect(totals).toContain('65,000.00')
    expect(totals).toContain('600.00')
    expect(screen.getByTestId('btn-payroll-pt-csv')).toBeTruthy()
  })
})

// ---------------------------------------------------------------- masters → ledgers

const GROUPS = [
  { id: 1, name: 'Sundry Debtors', parentId: null, nature: 'asset' },
  { id: 2, name: 'Sales Accounts', parentId: null, nature: 'income' }
] as unknown as Group[]
const LEDGERS = [
  { id: 10, name: 'Acme Traders', groupId: 1, openingBalance: 0, gstin: null, pan: null },
  { id: 11, name: 'Local Sales', groupId: 2, openingBalance: 0, gstin: null, pan: null }
] as unknown as Ledger[]

describe('Masters → Ledgers', () => {
  beforeEach(() => {
    handlers['master:groups:list'] = () => GROUPS
    handlers['master:ledgers:list'] = () => LEDGERS
  })

  it('the search and group picker live in the table toolbar and stay when nothing matches', async () => {
    renderScreen(<Masters tab="ledgers" />)
    await waitFor(() => expect(bodyRows('masters-ledgers')).toHaveLength(2))
    const toolbar = screen.getByTestId('masters-ledgers-table-toolbar')
    const search = within(toolbar).getByTestId('masters-ledgers-filter')
    expect(within(toolbar).getByTestId('masters-ledgers-group')).toBeTruthy()
    fireEvent.change(search, { target: { value: 'zzz' } })
    expect(screen.getByText('No ledgers match')).toBeTruthy()
    expect(within(screen.getByTestId('masters-ledgers-table-toolbar')).getByTestId('masters-ledgers-filter')).toBe(search)
    fireEvent.click(screen.getByTestId('masters-ledgers-clear-search'))
    expect(bodyRows('masters-ledgers')).toHaveLength(2)
    fireEvent.change(screen.getByTestId('masters-ledgers-group'), { target: { value: '2' } })
    expect(bodyRows('masters-ledgers').map((r) => r.dataset.rowId)).toEqual(['11'])
  })
})

// ---------------------------------------------------------------- e-invoice

const edoc = (voucherId: number, docType: EdocListRow['docType']): EdocListRow =>
  ({
    voucherId, number: `S${voucherId}`, date: '2026-04-0' + voucherId, docType, partyName: 'Acme', partyGstin: '27BBBBB0000B1Z5',
    total: 100_000, vehicleNo: null, hasHsn: true, irn: null, ewbNo: null, ewbReason: null, outwardDbn: false
  }) as EdocListRow

describe('e-Invoice doc-type filter', () => {
  beforeEach(() => {
    handlers['edoc:list'] = () => [edoc(1, 'INV'), edoc(2, 'INV')]
    handlers['nic:status'] = () => ({ configured: false })
    handlers['company:info'] = () => ({ gstin: '27AAAAA0000A1Z5' })
  })

  it('sits in the toolbar; a type with no documents keeps it there with a way back', async () => {
    renderScreen(<EdocsScreen />)
    await waitFor(() => expect(bodyRows('edocs')).toHaveLength(2))
    const select = within(screen.getByTestId('edocs-table-toolbar')).getByTestId('input-edocs-doctype')
    fireEvent.change(select, { target: { value: 'CRN' } })
    expect(screen.getByText('No documents match this filter')).toBeTruthy()
    expect(within(screen.getByTestId('edocs-table-toolbar')).getByTestId('input-edocs-doctype')).toBe(select)
    fireEvent.click(screen.getByTestId('edocs-clear-doctype'))
    expect(bodyRows('edocs')).toHaveLength(2)
  })
})

// ---------------------------------------------------------------- consolidated

describe('Consolidated', () => {
  it('has a single CSV (the table’s), written as plain signed numbers', async () => {
    handlers['company:list'] = () => ({ companies: [{ slug: 'a', name: 'Alpha' }, { slug: 'b', name: 'Beta' }] })
    handlers['consol:run'] = () => ({
      columns: ['Alpha', 'Beta'],
      warnings: [],
      rows: [{ name: 'Cash', group: 'Cash-in-hand', perCompany: [1_234_50, null], total: 1_234_50 }, { name: 'Capital', group: 'Capital Account', perCompany: [-5_000_00, -100], total: -5_001_00 }]
    })
    handlers['export:csv'] = () => ({ path: '/tmp/c.csv' })
    renderScreen(<ConsolidatedScreen />)
    await waitFor(() => expect(screen.getByTestId('check-consolidated-a')).toBeTruthy())
    fireEvent.click(screen.getByTestId('check-consolidated-a'))
    fireEvent.click(screen.getByTestId('check-consolidated-b'))
    fireEvent.click(screen.getByTestId('btn-consolidated-run'))
    await waitFor(() => expect(bodyRows('consolidated')).toHaveLength(2))
    expect(screen.queryByTestId('btn-consolidated-csv')).toBeNull()
    expect(bodyRows('consolidated')[1]!.textContent).toContain('5,000.00 Cr') // on screen: display format
    fireEvent.click(screen.getByTestId('consolidated-table-csv'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('export:csv', expect.anything()))
    const csv = (invoke.mock.calls.find((c) => c[0] === 'export:csv')![1] as { csv: string }).csv
    expect(csv.replace(/^﻿/, '').trim().split(/\r?\n/)).toEqual(['Name,Group,Alpha,Beta,Total', 'Cash,Cash-in-hand,1234.50,,1234.50', 'Capital,Capital Account,-5000.00,-1.00,-5001.00'])
  })
})
