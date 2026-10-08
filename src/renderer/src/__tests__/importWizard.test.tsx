// WP 6.3 — the import wizard's steps (pick → map → dry-run preview → import → undo), the books
// export screen, and the DataTable Excel export.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ImportLoadResult, ImportRunResult } from '../lib/client'
import { useNav, useSession } from '../state/stores'
import { ImportWizardScreen } from '../screens/ImportWizard'
import { BooksExportScreen } from '../screens/BooksExport'
import { DataTable, defineColumns } from '../components/table'
import { buildTableModel, buildTableXlsx, defaultView } from '../lib/table'

const invoke = vi.fn()
let handlers: Record<string, (payload: unknown) => unknown> = {}
const calls = (channel: string): unknown[] => invoke.mock.calls.filter((c) => c[0] === channel).map((c) => c[1])

function renderScreen(ui: React.JSX.Element): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

beforeEach(() => {
  localStorage.clear()
  handlers = { 'importwiz:batches': () => [], 'importwiz:templates': () => [] }
  invoke.mockReset()
  invoke.mockImplementation(async (channel: string, payload?: unknown) => {
    const h = handlers[channel]
    if (!h) return { ok: false, error: `unmocked channel ${channel}` }
    return { ok: true, data: h(payload) }
  })
  window.total = { platform: 'test', invoke }
  act(() => {
    useSession.setState({ slug: 'imp-co', from: '2025-04-01', to: '2026-03-31' })
    useNav.setState({ stack: [{ name: 'data-import' }] })
  })
})
afterEach(() => cleanup())

const LOADED: ImportLoadResult = {
  token: '00000000-0000-4000-8000-000000000001',
  fileName: 'Invoice.csv',
  kind: 'table',
  manifest: null,
  busy: null,
  sheets: [{
    name: 'Invoice', rowCount: 2, headerRow: 0, headerLine: 1,
    headers: ['Invoice Date', 'Invoice ID', 'Invoice Number', 'Customer Name', 'Item Name', 'Quantity', 'Item Total', 'Item Tax %', 'Item Tax Amount', 'Total'],
    sample: [['2025-06-02', '9001', 'INV-1', 'Umbrella', 'Bracket', '2', '500', '18', '90', '590']],
    guesses: [{ profileId: 'zoho:invoices', score: 20, requiredMissing: [] }],
    templates: []
  }]
}

const DRY: ImportRunResult = {
  dryRun: true, batchId: null, outcomesTruncated: 0, openingCheck: null,
  steps: [{ target: 'vouchers', sheet: 'Invoice', created: 1, updated: 0, skipped: 0, errors: [{ line: 3, message: 'INV-2: Unknown ledger "Nobody"' }], warnings: [] }],
  outcomes: [
    { line: 2, target: 'vouchers', label: 'Sales INV-1 · 2025-06-02', action: 'create' },
    { line: 3, target: 'vouchers', label: 'Sales INV-2 · 2025-06-03', action: 'error', message: 'Unknown ledger "Nobody"' }
  ]
}

describe('ImportWizardScreen', () => {
  it('walks pick → map (auto-detected Zoho profile, UNVERIFIED notes) → dry run → import → undo', async () => {
    handlers['importwiz:load'] = () => LOADED
    handlers['importwiz:preview'] = () => DRY
    handlers['importwiz:run'] = () => ({ ...DRY, dryRun: false, batchId: 7 })
    handlers['importwiz:undo'] = () => ({ binned: 1, deleted: 0, restored: 0, kept: [] })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderScreen(<ImportWizardScreen />)

    fireEvent.click(screen.getByTestId('btn-import-pick'))
    await screen.findByTestId('import-mapping')
    expect((screen.getByTestId('import-profile') as HTMLSelectElement).value).toBe('zoho:invoices')
    expect(screen.getByTestId('import-unverified').textContent).toMatch(/UNVERIFIED/)
    // Auto-mapped from the headers.
    expect((screen.getByTestId('import-map-number') as HTMLSelectElement).value).toBe('2')
    expect((screen.getByTestId('import-map-itemTotal') as HTMLSelectElement).value).toBe('6')

    // Un-mapping a required field disables the preview.
    fireEvent.change(screen.getByTestId('import-map-number'), { target: { value: '' } })
    expect((screen.getByTestId('btn-import-preview') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByTestId('import-map-number'), { target: { value: '2' } })
    fireEvent.click(screen.getByText('Update'))

    fireEvent.click(screen.getByTestId('btn-import-preview'))
    await screen.findByTestId('import-preview-summary')
    const q = calls('importwiz:preview')[0] as { profileId: string; mapping: Record<string, number | null>; options: { duplicate: string } }
    expect(q.profileId).toBe('zoho:invoices')
    expect(q.mapping.number).toBe(2)
    expect(q.options.duplicate).toBe('update')
    expect(screen.getByTestId('import-preview-summary').textContent).toMatch(/Will create1/)
    expect(screen.getByTestId('rows-import-preview').textContent).toMatch(/Unknown ledger "Nobody"/)
    expect(screen.getByTestId('btn-import-errors')).toBeTruthy()

    fireEvent.change(screen.getByTestId('import-template-name'), { target: { value: 'Zoho invoices' } })
    fireEvent.click(screen.getByTestId('btn-import-apply'))
    await screen.findByTestId('import-done-summary')
    expect((calls('importwiz:run')[0] as { saveTemplate: { name: string } }).saveTemplate).toEqual({ name: 'Zoho invoices' })
    expect(screen.getByTestId('import-batch-id').textContent).toMatch(/Batch 7/)

    fireEvent.click(screen.getByTestId('btn-import-undo'))
    await waitFor(() => expect(calls('importwiz:undo')).toEqual([{ batchId: 7 }]))
  })

  it('a books workbook goes straight to a whole-file plan', async () => {
    handlers['importwiz:load'] = () => ({
      ...LOADED, kind: 'books', fileName: 'books.xlsx', manifest: { format: 'total-books', schemaVersion: 1, company: 'Demo Traders', booksFrom: 2025 },
      sheets: [{ name: 'Manifest', rowCount: 10 }, { name: 'Ledgers', rowCount: 12 }, { name: 'Vouchers', rowCount: 140 }, { name: 'GST (info)', rowCount: 3 }]
    })
    handlers['importwiz:planPreview'] = () => ({ ...DRY, steps: [{ ...DRY.steps[0]!, errors: [] }], outcomes: [DRY.outcomes[0]!] })
    renderScreen(<ImportWizardScreen />)
    fireEvent.click(screen.getByTestId('btn-import-pick'))
    expect((await screen.findByTestId('import-plan-title')).textContent).toMatch(/Total books workbook — Demo Traders/)
    expect(screen.queryByText('GST (info)')).toBeNull()
    fireEvent.click(screen.getByTestId('btn-import-preview'))
    await screen.findByTestId('import-preview-summary')
    expect(calls('importwiz:planPreview')[0]).toMatchObject({ token: LOADED.token, options: { applyBooksFrom: true } })
  })

  it('lists recent imports with Undo', async () => {
    handlers['importwiz:batches'] = () => [{ id: 3, source: 'generic', profileId: 'generic:ledgers', fileName: 'ledgers.csv', status: 'applied', createdAt: '2026-10-08 10:00:00', createdBy: null, undoneAt: null, errorCount: 0, created: 12, updated: 0, summary: {} }]
    renderScreen(<ImportWizardScreen />)
    expect(await screen.findByTestId('btn-import-undo-3')).toBeTruthy()
    expect(screen.getByTestId('rows-import-batches').textContent).toMatch(/ledgers\.csv/)
  })
})

describe('BooksExportScreen', () => {
  it('exports and shows the per-sheet counts', async () => {
    handlers['export:books'] = () => ({ path: '/x/books.xlsx', counts: { Ledgers: 14, Vouchers: 120 } })
    renderScreen(<BooksExportScreen />)
    fireEvent.click(screen.getByTestId('btn-export-books'))
    expect((await screen.findByTestId('export-books-done')).textContent).toMatch(/books\.xlsx/)
    expect(screen.getByTestId('export-sheet-list').textContent).toMatch(/Ledgers14/)
  })
})

type Row = { name: string; amount: number; date: string; qty: number; dec: number; unit: string }
const COLS = defineColumns<Row>([
  { id: 'name', header: 'Name', kind: 'text', value: (r) => r.name },
  { id: 'date', header: 'Date', kind: 'date', value: (r) => r.date },
  { id: 'qty', header: 'Qty', kind: 'quantity', value: (r) => r.qty, decimals: (r) => r.dec, unit: (r) => r.unit, aggregate: 'sum' },
  { id: 'amount', header: 'Balance', kind: 'money', value: (r) => r.amount, signed: true, aggregate: 'sum' }
])
const ROWS: Row[] = [
  { name: 'A', amount: 12345, date: '2026-04-01', qty: 2500, dec: 3, unit: 'kg' },
  { name: 'B', amount: -500, date: '2026-04-02', qty: 3000, dec: 0, unit: 'Nos' }
]

describe('Excel export of a DataTable', () => {
  it('builds typed cells: paise, ISO dates, quantities with per-row decimals and a unit column, bold totals', () => {
    const sheet = buildTableXlsx(buildTableModel(ROWS, COLS, defaultView(COLS), {}), { name: 'Test', totalsLabel: 'Total' })
    expect(sheet.columns.map((c) => `${c.header}:${c.kind}`)).toEqual(['Name:text', 'Date:date', 'Qty:qty', 'Qty unit:text', 'Balance (Dr + / Cr −):money'])
    expect(sheet.rows[0]).toEqual({ cells: ['A', '2026-04-01', 2500, 'kg', 12345], qtyDecimals: { 2: 3 } })
    expect(sheet.rows[2]).toEqual({ bold: true, cells: ['Total', null, 5500, null, 11845] })
  })

  it('the toolbar Excel button sends the sheet to export:xlsx', async () => {
    handlers['export:xlsx'] = () => ({ path: '/x/t.xlsx' })
    renderScreen(<DataTable testId="t" columns={COLS} rows={ROWS} rowKey={(r) => r.name} exportOptions={{ title: 'My report', periodLabel: 'April' }} />)
    fireEvent.click(screen.getByTestId('t-table-xlsx'))
    await waitFor(() => expect(calls('export:xlsx')).toHaveLength(1))
    const p = calls('export:xlsx')[0] as { filename: string; sheets: { preamble: string[]; rows: unknown[] }[] }
    expect(p.filename).toBe('my-report')
    expect(p.sheets[0]!.preamble).toEqual(['My report', 'April'])
    expect(p.sheets[0]!.rows).toHaveLength(3)
  })
})
