// WP 5.4 — the Capture screen (queue table with status / duplicate / draft links, the cost
// estimate before anything is sent, the blocked banner, answering questions, viewer read-only)
// and Banking → statement "Categorise unmatched" (review table, accept all / selected / edit).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { CaptureItemDto, StatementCategorisation } from '@shared/capture/types'
import type { Workspace } from '../lib/bankingClient'
import { useNav, useSession } from '../state/stores'
import { CaptureScreen } from '../screens/Capture'
import { BankingScreen } from '../screens/Banking'
import { DialogHost } from '../components/dialogs'
import { SCREENS } from '../lib/screens'

const invoke = vi.fn()
let handlers: Record<string, (payload: unknown) => unknown> = {}
const calls = (channel: string): unknown[] => invoke.mock.calls.filter((c) => c[0] === channel).map((c) => c[1])
const bodyRows = (area: string): HTMLElement[] => Array.from(screen.getByTestId(`rows-${area}`).querySelectorAll<HTMLElement>('tr.dt-row'))

function renderUi(ui: React.JSX.Element): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      {ui}
      <DialogHost />
    </QueryClientProvider>
  )
}

const item = (over: Partial<CaptureItemDto>): CaptureItemDto => ({
  id: 1, fileName: 'bill.pdf', mime: 'application/pdf', size: 1000, pages: 1, textLayer: true, origin: 'drop', status: 'queued', error: null, attempts: 0, addedBy: 'Arun',
  supplierName: null, supplierLedgerId: null, invoiceNo: null, invoiceDate: null, total: null, duplicateKind: null, duplicateVoucherId: null, draftId: null, voucherId: null,
  costMicroUsd: null, createdAt: '2025-08-14T10:00:00Z', updatedAt: '2025-08-14T10:00:00Z', review: null, mapping: null, ...over
})

const QUEUE = [
  item({ id: 1, fileName: 'queued.pdf' }),
  item({ id: 2, fileName: 'drafted.pdf', status: 'drafted', supplierName: 'Bharat Steel Suppliers', invoiceNo: 'BSS/0142', invoiceDate: '2025-08-12', total: 3_424_000, draftId: 77, duplicateKind: 'same_amount', duplicateVoucherId: 9 }),
  item({ id: 3, fileName: 'photo.png', mime: 'image/png', textLayer: false, status: 'duplicate', error: 'Voucher P/7 already carries invoice BSS/0142', duplicateKind: 'same_invoice', duplicateVoucherId: 9 }),
  item({
    id: 4, fileName: 'navkar.pdf', status: 'needs_review', supplierName: 'Navkar Furniture',
    review: {
      mode: 'text', parsed: {} as never, totals: { taxable: 100_000, tax: 18_000, printedTotal: 118_000 } as never, duplicates: [], assumptions: [], taxCheck: null,
      suggestedParty: { name: 'Navkar Furniture', gstin: '27AAACN1234B1Z5', stateCode: '27', address: null },
      questions: [{ field: 'supplier', said: 'Navkar Furniture', question: 'There is no supplier “Navkar Furniture”.', candidates: [] }]
    }
  })
]

beforeEach(() => {
  localStorage.clear()
  handlers = {
    'capture:list': () => ({ items: QUEUE, running: false, blocker: null, inboxPath: '/data/companies/demo/capture-inbox' }),
    'capture:estimate': () => ({ items: 1, pages: 1, inputTokens: 1900, outputTokens: 1200, costMicroUsd: 13_400, model: 'gpt-6.1-sol', unmaskable: 0, blocker: null }),
    'capture:process': () => ({ approved: 1 }),
    'capture:resolve': () => item({ id: 4, status: 'drafted', draftId: 80 }),
    'capture:addFiles': () => ({ added: [5], refused: [] }),
    'master:ledgers:list': () => [{ id: 31, name: 'Navkar Furniture', groupId: 1 }],
    'master:groups:list': () => [{ id: 1, name: 'Sundry Creditors', parentId: null, nature: 'liability' }],
    'master:items:list': () => [],
    'bank:ledgers': () => [{ id: 5, name: 'HDFC Bank' }]
  }
  invoke.mockImplementation(async (channel: string, payload?: unknown) => {
    const h = handlers[channel]
    if (!h) return { ok: false, error: `unmocked channel ${channel}` }
    return { ok: true, data: h(payload) }
  })
  window.total = { platform: 'test', invoke }
  act(() => {
    useSession.setState({ slug: 'demo', from: '2025-04-01', to: '2026-03-31', user: null })
    useNav.setState({ stack: [{ name: 'capture' }] })
  })
})
afterEach(() => cleanup())

describe('Capture screen', () => {
  it('is in the sidebar under Banking', () => {
    expect(SCREENS.find((s) => s.name === 'capture')).toMatchObject({ navSection: 'banking', invalidates: ['captureQueue'] })
  })

  it('lists the queue with status, duplicate links and the draft link', async () => {
    renderUi(<CaptureScreen />)
    await waitFor(() => expect(bodyRows('capture-queue')).toHaveLength(4))
    const byFile = (n: string): HTMLElement => bodyRows('capture-queue').find((r) => r.textContent!.includes(n))!
    expect(byFile('drafted.pdf').getAttribute('data-status')).toBe('drafted')
    expect(within(byFile('drafted.pdf')).getByTestId('cell-capture-duplicate').textContent).toMatch(/Same amount\?/)
    expect(within(byFile('photo.png')).getByTestId('cell-capture-status').textContent).toMatch(/Duplicate — refused.*already carries invoice/)
    fireEvent.click(within(byFile('drafted.pdf')).getByTestId('btn-capture-open-draft'))
    await waitFor(() => expect(useNav.getState().stack.at(-1)).toEqual({ name: 'voucher-entry', aiDraftId: 77 }))
  })

  it('shows the cost estimate before sending, then approves the queue', async () => {
    renderUi(<CaptureScreen />)
    await waitFor(() => expect(screen.getByTestId('btn-capture-process')).toHaveProperty('disabled', false))
    fireEvent.click(screen.getByTestId('btn-capture-process'))
    expect((await screen.findByTestId('text-capture-cost')).textContent).toBe('≈ $0.0134')
    expect(calls('capture:process')).toEqual([])
    fireEvent.click(screen.getByTestId('btn-capture-confirm'))
    await waitFor(() => expect(calls('capture:process')).toHaveLength(1))
  })

  it('says why nothing is sent while AI is off', async () => {
    handlers['capture:list'] = () => ({ items: QUEUE, running: false, blocker: 'The assistant is off for this company', inboxPath: '/x' })
    renderUi(<CaptureScreen />)
    expect((await screen.findByTestId('banner-capture-blocked')).textContent).toMatch(/Files wait in the queue/)
  })

  it('answers a supplier question with a suggested create-party action (never automatic)', async () => {
    renderUi(<CaptureScreen />)
    await waitFor(() => expect(bodyRows('capture-queue')).toHaveLength(4))
    fireEvent.click(screen.getByTestId('capture-actions-4'))
    fireEvent.click(await screen.findByTestId('capture-review'))
    const modal = await screen.findByTestId('capture-review-modal')
    expect(within(modal).getByTestId('btn-capture-create-party').textContent).toMatch(/Create “Navkar Furniture” \(27AAACN1234B1Z5\) in Masters/)
    fireEvent.click(within(modal).getByTestId('btn-capture-resolve'))
    await waitFor(() => expect(calls('capture:resolve')).toEqual([{ id: 4, mapping: {} }]))
  })

  it('drop zone sends bytes, never a path', async () => {
    renderUi(<CaptureScreen />)
    const zone = await screen.findByTestId('capture-dropzone')
    const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'drop.pdf', { type: 'application/pdf' })
    fireEvent.drop(zone, { dataTransfer: { files: [file] } })
    await waitFor(() => expect(calls('capture:addFiles')).toEqual([{ files: [{ name: 'drop.pdf', base64: 'JVBERg==' }] }]))
  })

  it('a viewer sees the queue but no capture controls', async () => {
    act(() => useSession.setState({ user: { id: 2, name: 'Vee', role: 'viewer' } as never }))
    renderUi(<CaptureScreen />)
    await waitFor(() => expect(bodyRows('capture-queue')).toHaveLength(4))
    expect(screen.queryByTestId('capture-dropzone')).toBeNull()
    expect(screen.queryByTestId('btn-capture-process')).toBeNull()
    expect(screen.queryByTestId('capture-actions-1')).toBeNull()
  })
})

describe('Banking → Categorise unmatched', () => {
  const WS: Workspace = {
    imports: [{ id: 3, importedAt: '2025-08-10 09:00:00', fileName: 'aug.csv', format: 'csv', lineCount: 2, duplicateCount: 0, matched: 0, created: 0 }],
    openEntries: [],
    lines: [
      { id: 11, importId: 3, date: '2025-08-05', valueDate: null, description: 'ACH/MSEDCL BILL/0063311', reference: '', side: 'withdrawal', amount: 162_000, balance: null, status: 'open', matched: [], proposal: null, suggestion: null },
      { id: 12, importId: 3, date: '2025-08-07', valueDate: null, description: 'IMPS/MISC/1', reference: '', side: 'withdrawal', amount: 1_000, balance: null, status: 'open', matched: [], proposal: null, suggestion: null }
    ]
  }
  const CAT: StatementCategorisation = {
    aiUsed: true, aiNote: null, rejected: 0,
    rows: [
      { lineId: 11, date: '2025-08-05', description: 'ACH/MSEDCL BILL/0063311', reference: '', side: 'withdrawal', amount: 162_000, ledgerId: 40, ledgerName: 'Electricity Charges', partyLedgerId: null, kind: 'payment', source: 'history', confidence: 0.9, why: '“MSEDCL BILL” went to Electricity Charges all 2 times before', oldestBillsFirst: false, candidates: [] },
      { lineId: 12, date: '2025-08-07', description: 'IMPS/MISC/1', reference: '', side: 'withdrawal', amount: 1_000, ledgerId: null, ledgerName: null, partyLedgerId: null, kind: 'payment', source: 'none', confidence: 0, why: 'no rule, history or party name places this line', oldestBillsFirst: false, candidates: [{ id: 41, name: 'Bank Charges', why: 'an expense ledger' }] }
    ]
  }
  beforeEach(() => {
    handlers['bankImport:workspace'] = () => WS
    handlers['bankImport:categorise'] = () => CAT
    handlers['bankImport:categoriseAccept'] = () => ({ drafts: [{ lineId: 11, draftId: 90, summary: 'Payment of ₹1,620.00 on 2025-08-05: Dr Electricity Charges / Cr HDFC Bank' }], failed: [] })
    handlers['master:ledgers:list'] = () => [{ id: 40, name: 'Electricity Charges', groupId: 2 }, { id: 41, name: 'Bank Charges', groupId: 2 }]
    handlers['master:groups:list'] = () => [{ id: 2, name: 'Indirect Expenses', parentId: null, nature: 'expense' }]
  })

  it('reviews proposals (source shown, residual unselected) and accepts all into drafts with links', async () => {
    renderUi(<BankingScreen tab="import" />)
    await waitFor(() => expect(screen.getByTestId('btn-banking-categorise')).toHaveProperty('disabled', false))
    fireEvent.click(screen.getByTestId('btn-banking-categorise'))
    await waitFor(() => expect(bodyRows('categorise-table')).toHaveLength(2))
    const [a, b] = bodyRows('categorise-table')
    expect(within(a!).getByTestId('cell-categorise-source').getAttribute('data-source')).toBe('history')
    expect(within(b!).getByTestId('cell-categorise-source').textContent).toMatch(/No proposal/)
    expect(screen.getByTestId('btn-categorise-accept-all').textContent).toBe('Accept all (1)')
    fireEvent.click(screen.getByTestId('btn-categorise-accept-all'))
    await waitFor(() => expect(calls('bankImport:categoriseAccept')).toEqual([{ bankLedgerId: 5, items: [{ lineId: 11, ledgerId: 40, kind: 'payment', oldestBillsFirst: false }] }]))
    fireEvent.click(await screen.findByTestId('btn-categorise-open-draft'))
    await waitFor(() => expect(useNav.getState().stack.at(-1)).toEqual({ name: 'voucher-entry', aiDraftId: 90 }))
  })
})
