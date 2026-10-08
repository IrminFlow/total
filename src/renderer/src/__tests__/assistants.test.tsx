// WP 5.5: the Assistants screen — the close checklist (statuses, expandable rows, mark done with a
// note, viewers read only), the GST 2B tab (categories, "Draft the purchase" opens the voucher
// editor on the draft), anomalies (dismiss with a note) and a report from a question (opens the
// report builder pre-filled). "Run with AI" shows only while the assistant is on.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DEFAULT_FEATURES } from '@shared/features'
import { buildCloseChecklist, type CloseFacts } from '@shared/closeChecklist'
import { reconcile2b } from '@shared/gst/recon2b'
import { categoriseMismatches, summariseMismatches } from '@shared/gst/mismatch2b'
import { DEFAULT_ASSISTANT_SETTINGS, type AnomalyReport, type Gst2bMismatchReport } from '@shared/assistants'
import { reportModelSchema } from '@shared/reportBuilder/model'
import { AssistantsScreen } from '../screens/assistants/Assistants'
import { DialogHost } from '../components/dialogs'
import { useNav, useSession } from '../state/stores'
import { useExplain } from '../lib/explain'
import { useAssistantPanel } from '../components/ai/AssistantPanel'

const invoke = vi.fn()
const MONTH = (() => {
  const d = new Date()
  const y = d.getMonth() === 0 ? d.getFullYear() - 1 : d.getFullYear()
  const m = d.getMonth() === 0 ? 12 : d.getMonth()
  return `${y}-${String(m).padStart(2, '0')}`
})()

const facts: CloseFacts = {
  bank: [{ ledgerId: 2, name: 'HDFC', unreconciled: [{ voucherId: 41, label: 'Payment 41', date: `${MONTH}-10`, amount: 10_000_00 }], openStatementLines: [] }],
  unallocated: [], overdue: [], gst: { gstr1ExportedAt: null, gstr3bExportedAt: null }, withholding: [], withholdingMissed: [],
  negativeStock: [{ itemId: 7, name: 'Widget', qtyText: '-3 nos' }], unbilled: [], suspense: [], pdcs: [], depreciation: null, accruals: [],
  blankNarration: [], roundOff: [], unbalanced: [], drafts: [], optionalVouchers: [], lockDate: null
}
const checklist = (marked = false) =>
  buildCloseChecklist(facts, { period: MONTH, today: `${MONTH}-28` }, marked ? new Map([['negative_stock', { status: 'done' as const, note: 'late GRN', by: 'Priya', at: 'x' }]]) : new Map())

const G = '27AAPFU0939F1ZV'
const twoB = (): Gst2bMismatchReport => {
  const r = reconcile2b([{ gstin: G, number: 'A-2', date: `${MONTH}-12`, value: 5900_00, taxable: 5000_00, igst: 0, cgst: 450_00, sgst: 450_00, cess: 0, kind: 'b2b' }], [], { amountTolerancePaise: 100, dateWindowDays: 7 })
  const rows = categoriseMismatches(r, [], [{ ledgerId: 9, name: 'Acme Supplies', gstin: G }], { amountTolerancePaise: 100 }, `${MONTH}-28`)
  return { period: MONTH, returnPeriod: '000000', statement: { period: '000000', fileName: '2b.json', documents: 1, importedAt: '2026-10-01T00:00:00Z', importedBy: null }, errors: [], matched: 0, summary: summariseMismatches(rows), rows }
}
const anomalies: AnomalyReport = {
  from: '2026-04-01', to: '2027-03-31', historyFrom: '2025-04-01', settings: DEFAULT_ASSISTANT_SETTINGS, counts: { high: 1, medium: 0, low: 0, dismissed: 0 },
  rows: [{ key: 'duplicate_party_amount:5:6', kind: 'duplicate_party_amount', severity: 'high', voucherId: 6, relatedVoucherIds: [5], date: '2026-05-06', label: 'Payment 6', partyLedgerId: 9, partyName: 'Acme Supplies', ledgerId: null, itemId: null, amount: 25_000_00, detail: '₹25,000.00 to Acme Supplies on 2026-05-06, and Payment 5 for the same amount on 2026-05-05 (1 days apart)', metric: 1, dismissed: null }]
}
const MODEL = reportModelSchema.parse({ source: 'accounts', dimensions: [{ key: 'month' }], measures: ['taxable'], filters: { voucherKinds: ['sales'] } })

beforeEach(() => {
  useSession.setState({
    slug: 'test', from: '2026-04-01', to: '2027-03-31', user: null,
    info: { name: 'Acme', stateCode: '27', gstin: null, gstRegistrationType: 'regular', address: '', booksFrom: 2025, email: null, phone: null, pan: null, tan: null }
  })
  useNav.setState({ stack: [{ name: 'assistants' }] })
  useExplain.setState({ ready: false, handler: null })
  invoke.mockImplementation(async (channel: string, payload: unknown) => {
    switch (channel) {
      case 'config:features:get': return { ok: true, data: { ...DEFAULT_FEATURES } }
      case 'assist:close': return { ok: true, data: checklist() }
      case 'assist:close:mark': return { ok: true, data: checklist(true) }
      case 'assist:gst2b': return { ok: true, data: twoB() }
      case 'assist:gst2b:draft': return { ok: true, data: { id: 31, payload: { voucherKind: 'purchase' } } }
      case 'assist:anomalies': return { ok: true, data: anomalies }
      case 'assist:anomaly:dismiss': return { ok: true, data: null }
      case 'assist:nlReport': return { ok: true, data: { ok: true, title: 'Sales by month', model: MODEL, request: { title: 'Sales by month', source: 'accounts', measures: ['taxable'] } } }
      case 'rb:run':
        return { ok: true, data: { from: '2026-04-01', to: '2027-03-31', dims: [{ key: 'month', label: 'Month', link: 'month' }], measures: [{ key: 'taxable', label: 'Taxable value', kind: 'money', signed: false }], rows: [{ keys: [{ id: '2026-05', label: 'May 2026' }], values: [65_000] }], totals: [65_000], compare: null, compareTotals: null, truncated: false, rowCap: 20000, warnings: [] } }
      default: return { ok: false, error: `unmocked ${channel} ${JSON.stringify(payload)}` }
    }
  })
  window.total = { platform: 'test', invoke }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function wrap(ui: React.ReactElement): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      {ui}
      <DialogHost />
    </QueryClientProvider>
  )
}

describe('Month-end close', () => {
  it('lists every check with its status and progress; a row opens onto what was found; marks done with a note', async () => {
    wrap(<AssistantsScreen tab="close" />)
    const rows = await screen.findByTestId('rows-assistants-close')
    await waitFor(() => expect(within(rows).getByTestId('close-status-negative_stock').textContent).toBe('Action'))
    expect(within(rows).getByTestId('close-status-bank_reconciliation').textContent).toBe('Review')
    expect(screen.getByTestId('close-progress').getAttribute('data-pct')).toBe(String(checklist().progress.pct))
    expect(screen.queryByTestId('btn-assistants-close-ai')).toBeNull() // AI off: no "Run with AI"
    fireEvent.click(within(rows).getByTestId('btn-assistants-close-done-negative_stock'))
    fireEvent.change(await screen.findByTestId('prompt-input'), { target: { value: 'late GRN' } })
    fireEvent.click(screen.getByTestId('prompt-ok'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('assist:close:mark', { period: MONTH, key: 'negative_stock', status: 'done', note: 'late GRN' }))
    await waitFor(() => expect(within(rows).getByTestId('close-status-negative_stock').textContent).toBe('Done'))
  })

  it('viewers see the checklist without the mark buttons; "Run with AI" pre-calls close_checklist', async () => {
    useSession.setState({ user: { id: 1, name: 'Vik', role: 'viewer' } as never })
    useExplain.setState({ ready: true, handler: () => {} })
    wrap(<AssistantsScreen tab="close" />)
    const rows = await screen.findByTestId('rows-assistants-close')
    await waitFor(() => expect(within(rows).getByTestId('close-status-negative_stock')).toBeTruthy())
    expect(within(rows).queryByTestId('btn-assistants-close-done-negative_stock')).toBeNull()
    fireEvent.click(screen.getByTestId('btn-assistants-close-ai'))
    expect(useAssistantPanel.getState().pending).toMatchObject({ preCall: { tool: 'close_checklist', input: { period: MONTH } }, context: { screen: 'assistants', params: { tab: 'close', period: MONTH } } })
  })
})

describe('GST 2B mismatches', () => {
  it('shows the categories and drafts the missing purchase into the voucher editor', async () => {
    wrap(<AssistantsScreen tab="gst2b" />)
    const rows = await screen.findByTestId('rows-assistants-2b')
    await waitFor(() => expect(rows.textContent).toContain('A-2'))
    expect(screen.getByTestId('btn-assistants-2b-cat-missing_in_books').textContent).toContain('1')
    fireEvent.click(within(rows).getByTestId('btn-assistants-2b-draft-missing_in_books'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('assist:gst2b:draft', { period: MONTH, key: expect.stringContaining('missing_in_books:') }))
    await waitFor(() => expect(useNav.getState().stack.at(-1)).toEqual({ name: 'voucher-entry', aiDraftId: 31, kindHint: 'purchase' }))
  })
})

describe('Anomalies', () => {
  it('lists findings with the reason and dismisses one with a note', async () => {
    wrap(<AssistantsScreen tab="anomalies" />)
    const rows = await screen.findByTestId('rows-assistants-anomalies')
    await waitFor(() => expect(rows.textContent).toContain('Payment 6'))
    expect(rows.textContent).toContain('1 days apart')
    fireEvent.click(within(rows).getByTestId('btn-assistants-anomaly-dismiss'))
    fireEvent.change(await screen.findByTestId('prompt-input'), { target: { value: 'two invoices' } })
    fireEvent.click(screen.getByTestId('prompt-ok'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('assist:anomaly:dismiss', { key: 'duplicate_party_amount:5:6', dismissed: true, note: 'two invoices' }))
  })
})

describe('Report from a question', () => {
  it('maps the question, previews the report and opens it in the report builder pre-filled', async () => {
    wrap(<AssistantsScreen tab="report" />)
    fireEvent.change(screen.getByTestId('input-assistants-report-question'), { target: { value: 'sales by month' } })
    fireEvent.click(screen.getByTestId('btn-assistants-report-build'))
    expect((await screen.findByTestId('assistants-report-title')).textContent).toBe('Sales by month')
    await waitFor(() => expect(screen.getByTestId('rows-assistants-report').textContent).toContain('May 2026'))
    fireEvent.click(screen.getByTestId('btn-assistants-report-open'))
    await waitFor(() => expect(useNav.getState().stack.at(-1)).toMatchObject({ name: 'report-builder', model: MODEL, modelName: 'Sales by month' }))
  })
})

describe('assistant links', () => {
  it('build_report links open the report builder pre-filled; assistant links open their tab', async () => {
    const { screenFor } = await import('../components/ai/screenTargets')
    const s = screenFor({ kind: 'screen', screen: 'report-builder', label: 'Open', params: { model: JSON.stringify(MODEL), title: 'Sales by month' } })
    expect(s).toMatchObject({ name: 'report-builder', model: MODEL, modelName: 'Sales by month' })
    expect(screenFor({ kind: 'screen', screen: 'report-builder', label: 'Open', params: { model: '{"source":"nope"}' } })).toEqual({ name: 'report-builder' })
    expect(screenFor({ kind: 'screen', screen: 'assistants', label: 'x', params: { tab: 'gst2b', period: '2026-05' } })).toEqual({ name: 'assistants', tab: 'gst2b', period: '2026-05' })
  })
})
