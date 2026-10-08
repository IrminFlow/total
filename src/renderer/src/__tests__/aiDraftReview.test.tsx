// WP 5.3 — the AI draft review flow in the editors: a draft opens in its own editor mode with the
// state the draft tool built, under the "AI draft — review before saving" banner (summary,
// assumptions, matched entities you can inspect, the unrequested flag, the draft set), the fields
// it filled are highlighted until edited, "Discard draft" discards it, and Save sends aiDraftId.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { AiDraftDto } from '@shared/ai'
import type { Group, Ledger, StockItem, VoucherType } from '@shared/domain'
import { emptyInvoiceState, type InvoiceFormState } from '@shared/voucherEdit'
import { VoucherEntry } from '../screens/VoucherEntry'
import { DialogHost } from '../components/dialogs'
import { elementsForField, markAiFields } from '../lib/aiHighlights'
import { screenForDraft } from '../components/ai/AiDraftReview'
import { useNav, useSession } from '../state/stores'
import { AiSection } from '../screens/settings/AiSection'

const invoke = vi.fn()

const GROUPS: Group[] = [
  { id: 1, name: 'Sundry Debtors', parentId: null, nature: 'asset', affectsGrossProfit: false, isSystem: true },
  { id: 2, name: 'Sales Accounts', parentId: null, nature: 'income', affectsGrossProfit: true, isSystem: true },
  { id: 3, name: 'Duties & Taxes', parentId: null, nature: 'liability', affectsGrossProfit: false, isSystem: true }
]
const ledger = (id: number, name: string, groupId: number, over: Partial<Ledger> = {}): Ledger => ({
  id, name, groupId, openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null,
  hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null, rcm: false, itcEligibility: 'eligible',
  priceLevelId: null, creditLimit: null, deducteeType: null, tdsPayableSectionId: null, tdsDefaultSectionId: null, isSystem: false, ...over
})
const LEDGERS: Ledger[] = [
  ledger(31, 'Umbrella Retail', 1, { stateCode: '27', gstin: '27AABCD1234E1Z8', creditDays: 30 }),
  ledger(20, 'Sales A/c', 2),
  // Both sides present, Input first by name: a sale must still post to the OUTPUT ledgers.
  ledger(38, 'CGST Input', 3, { taxType: 'cgst' }),
  ledger(39, 'SGST Input', 3, { taxType: 'sgst' }),
  ledger(40, 'CGST Output', 3, { taxType: 'cgst' }),
  ledger(41, 'SGST Output', 3, { taxType: 'sgst' })
]
const ITEMS: StockItem[] = [
  { id: 100, name: 'Laptop 14"', groupId: null, unitId: 1, hsn: '8471', gstRate: 18, cessRate: null, openingQtyMilli: 0, openingValue: 0, barcode: 'LAP14', reorderLevelMilli: null, valuationMethod: 'weighted_avg', trackSerials: false }
]
const TYPES: VoucherType[] = [
  { id: 1, name: 'Sales', kind: 'sales', numbering: 'auto', prefix: '', suffix: '', padWidth: 0, restartFy: true, isSystem: true },
  { id: 2, name: 'Journal', kind: 'journal', numbering: 'auto', prefix: '', suffix: '', padWidth: 0, restartFy: true, isSystem: true }
]

const STATE: InvoiceFormState = {
  ...emptyInvoiceState('2026-10-07'), partyId: 31, accountId: 20, billDueDate: '2026-11-06',
  rows: [{ itemId: 100, qtyText: '2', rate: 4_500_000, discount: null, godownId: null, batchId: null }]
}

function draftDto(over: Partial<AiDraftDto> = {}): AiDraftDto {
  return {
    id: 7, threadId: 3, kind: 'voucher', status: 'open', voucherId: null, unrequested: false, createdAt: '2026-10-08T05:00:00Z', consumedAt: null,
    messageId: 12, userName: 'Arun',
    summary: 'Sales invoice to Umbrella Retail on 2026-10-07: 2 × Laptop 14" @ ₹45,000.00 — taxable ₹90,000.00, CGST ₹8,100.00, SGST ₹8,100.00, total ₹1,06,200.00',
    payload: {
      voucherTypeId: 1, voucherKind: 'sales', date: '2026-10-07', partyLedgerId: 31, narration: null, reference: null, lines: [],
      form: 'invoice', state: STATE, total: 10_620_000,
      sources: [
        { field: 'party', kind: 'ledger', label: 'Umbrella Retail', id: 31, said: 'umbrella', why: 'the only name starting with that' },
        { field: 'line:0', kind: 'item', label: 'Laptop 14"', id: 100, said: 'Laptop 14', why: 'same name (ignoring case and punctuation)' }
      ],
      assumptions: ['18% GST on Laptop 14" from the item master', 'Sales ledger: Sales A/c (the only one)'],
      fields: ['party', 'date', 'account', 'line:0']
    },
    ...over
  }
}

const SETTINGS = {
  settings: {
    enabled: true, noticeAcceptedAt: '2026-10-01T10:00:00.000Z', noticeAcceptedBy: 'Owner', noticeVersion: 1, defaultModel: 'gpt-6.1-sol', fastModel: 'gpt-6-luna',
    privacy: { maskIds: true, pseudonymiseParties: false }, prices: {}, maxSteps: 8
  },
  keyPresent: true, keyHint: '…WXYZ', secureStorageAvailable: true, mock: false, ready: true, blocker: null
}

let draft: AiDraftDto
let set: AiDraftDto[]
const saved: unknown[] = []

beforeEach(() => {
  draft = draftDto()
  set = [draft]
  saved.length = 0
  useSession.setState({
    slug: 'test', user: null, workingDate: '2026-10-08',
    info: { name: 'T', stateCode: '27', gstin: '27AAPFU0939F1ZV', gstRegistrationType: 'regular', address: '', booksFrom: 2026, email: null, phone: null, pan: null, tan: null }
  })
  useNav.setState({ stack: [{ name: 'gateway' }, { name: 'voucher-entry', aiDraftId: 7 }] })
  invoke.mockImplementation(async (channel: string, payload?: unknown) => {
    switch (channel) {
      case 'master:voucherTypes:list': return { ok: true, data: TYPES }
      case 'master:ledgers:list': return { ok: true, data: LEDGERS }
      case 'master:groups:list': return { ok: true, data: GROUPS }
      case 'master:stockItems:list': return { ok: true, data: ITEMS }
      case 'master:units:list': return { ok: true, data: [{ id: 1, name: 'Numbers', symbol: 'Nos', decimals: 0, uqc: 'NOS' }] }
      case 'master:godowns:list': return { ok: true, data: [] }
      case 'voucher:nextNumber': return { ok: true, data: { number: '5' } }
      case 'voucher:numberExists': return { ok: true, data: false }
      case 'voucher:duplicates': return { ok: true, data: [] }
      case 'voucher:save': saved.push(payload); return { ok: true, data: { id: 99, number: '5', warnings: { negativeStock: [], creditLimitExceeded: null } } }
      case 'ai:draft:get': return { ok: true, data: draft }
      case 'ai:draft:set': return { ok: true, data: set }
      case 'ai:draft:discard': draft = { ...draft, status: 'discarded' }; return { ok: true, data: draft }
      case 'report:dashboard': return { ok: true, data: { voucherCount: 3 } }
      case 'ai:drafts': return { ok: true, data: [draft, draftDto({ id: 5, status: 'consumed', voucherId: 44, summary: 'Payment of ₹2,500.00', payload: { ...draftDto().payload, form: 'accounting', total: 250_000 } })] }
      case 'ai:settings:get': return { ok: true, data: SETTINGS }
      case 'ai:usage': return { ok: true, data: [] }
      case 'ai:outbound': return { ok: true, data: [] }
      case 'log:renderer': return { ok: true, data: null }
      default: return { ok: false, error: `unmocked ${channel}` }
    }
  })
  window.total = { platform: 'test', invoke }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderDraft(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <VoucherEntry aiDraftId={7} kindHint="sales" />
      <DialogHost />
    </QueryClientProvider>
  )
}

describe('an AI invoice draft opens in the invoice editor for review', () => {
  it('pre-fills the invoice form from the draft state and shows the banner', async () => {
    renderDraft()
    const mode = await screen.findByTestId('voucher-entry-mode', undefined, { timeout: 3000 })
    expect(mode.getAttribute('data-mode')).toBe('invoice')
    await waitFor(() => expect((screen.getAllByTestId('input-line-qty')[0] as HTMLInputElement).value).toBe('2'))
    const banner = screen.getByTestId('ai-draft-banner')
    expect(banner.getAttribute('data-form')).toBe('invoice')
    expect(within(banner).getByText(/Review before saving/)).toBeTruthy()
    expect(within(banner).getByTestId('ai-draft-summary').textContent).toContain('total ₹1,06,200.00')
    const assumptions = within(banner).getByTestId('ai-draft-assumptions')
    expect(assumptions.textContent).toContain('18% GST on Laptop 14" from the item master')
    const sources = within(banner).getAllByTestId('ai-draft-source')
    expect(sources[0]!.textContent).toBe('Party: “umbrella” → Umbrella Retail (the only name starting with that)')
    expect(screen.queryByTestId('ai-draft-unrequested')).toBeNull()
  })

  it('click a matched entity to inspect it (ledger facts, item facts)', async () => {
    renderDraft()
    const [party, item] = await screen.findAllByTestId('ai-draft-source', undefined, { timeout: 3000 })
    fireEvent.click(party!)
    await waitFor(() => expect(screen.getByTestId('ai-draft-source-detail').textContent).toContain('Sundry Debtors · GSTIN 27AABCD1234E1Z8 · 27 Maharashtra · 30 days\' credit'))
    fireEvent.click(item!)
    await waitFor(() => expect(screen.getByTestId('ai-draft-source-detail').textContent).toContain('HSN 8471 · 18% GST · barcode LAP14'))
  })

  it('highlights the fields the assistant set; editing one clears its mark', async () => {
    renderDraft()
    await waitFor(() => expect(document.querySelector('[data-ai-set="party"]')).not.toBeNull(), { timeout: 3000 })
    expect(document.querySelector('[data-ai-set="date"]')).not.toBeNull()
    expect(document.querySelector('[data-ai-set="account"]')).not.toBeNull()
    const row = document.querySelector('tr[data-ai-set="line:0"]')
    expect(row).not.toBeNull()
    const qty = screen.getAllByTestId('input-line-qty')[0] as HTMLInputElement
    fireEvent.input(qty, { target: { value: '3' } })
    fireEvent.change(qty, { target: { value: '3' } })
    await waitFor(() => expect(document.querySelector('tr[data-ai-set="line:0"]')).toBeNull())
    expect(document.querySelector('[data-ai-set="party"]')).not.toBeNull()
  })

  it('Save posts through voucher:save with aiDraftId (the draft is consumed by main); sales tax goes to the Output ledgers', async () => {
    renderDraft()
    await waitFor(() => expect((screen.getAllByTestId('input-line-qty')[0] as HTMLInputElement).value).toBe('2'), { timeout: 3000 })
    // The bill name follows the auto number (a draft without a bill no. leaves it to the form).
    await waitFor(() => expect((screen.getByLabelText(/Bill name/i) as HTMLInputElement).value).toBe('5'))
    await act(async () => fireEvent.click(screen.getByTestId('btn-save-voucher')))
    await waitFor(() => expect(saved).toHaveLength(1))
    const p = saved[0] as { aiDraftId?: number; data: { partyLedgerId: number; lines: { ledgerId: number; amount: number }[]; billRefs: { name: string }[] } }
    expect(p.aiDraftId).toBe(7)
    expect(p.data.partyLedgerId).toBe(31)
    expect(p.data.lines.map((l) => [l.ledgerId, l.amount])).toEqual([[31, 10_620_000], [20, 9_000_000], [40, 810_000], [41, 810_000]])
    expect(p.data.billRefs[0]!.name).toBe('5')
    await waitFor(() => expect(useNav.getState().stack.at(-1)).toEqual({ name: 'gateway' }))
  })

  it('Discard draft: confirms, discards through ai:draft:discard and leaves', async () => {
    renderDraft()
    await screen.findByTestId('ai-draft-banner', undefined, { timeout: 3000 })
    await act(async () => fireEvent.click(await screen.findByTestId('btn-ai-draft-discard', undefined, { timeout: 3000 })))
    await act(async () => fireEvent.click(await screen.findByTestId('confirm-ok')))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ai:draft:discard', { id: 7 }))
    await waitFor(() => expect(useNav.getState().stack).toEqual([{ name: 'gateway' }]))
  })

  it('an unrequested draft carries the red flag; a set of drafts can be stepped through', async () => {
    draft = draftDto({ unrequested: true })
    set = [draft, draftDto({ id: 8, summary: 'Payment of ₹2,500.00' })]
    renderDraft()
    expect((await screen.findByTestId('ai-draft-unrequested', undefined, { timeout: 3000 })).textContent).toContain('You did not ask for this entry')
    expect(screen.getByTestId('ai-draft-banner').getAttribute('data-unrequested')).toBe('true')
    await waitFor(() => expect(screen.getByTestId('ai-draft-set').textContent).toContain('Draft 1 of 2'))
    expect((screen.getByTestId('btn-ai-draft-prev') as HTMLButtonElement).disabled).toBe(true)
  })

  it('a consumed draft is not pre-filled again', async () => {
    draft = draftDto({ status: 'consumed', voucherId: 44 })
    renderDraft()
    expect((await screen.findByTestId('ai-draft-banner', undefined, { timeout: 3000 })).textContent).toContain('already consumed (saved as a voucher)')
  })
})

describe('Settings → AI drafts list', () => {
  it('lists drafts with who / when / status; an open one opens in its editor, or is discarded', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    useNav.setState({ stack: [{ name: 'settings', tab: 'ai' }] })
    render(
      <QueryClientProvider client={client}>
        <AiSection />
        <DialogHost />
      </QueryClientProvider>
    )
    const table = await screen.findByTestId('rows-ai-drafts', undefined, { timeout: 3000 })
    await waitFor(() => expect(table.querySelectorAll('[data-draft-id]')).toHaveLength(2))
    const open = table.querySelector('[data-draft-id="7"]') as HTMLElement
    expect(open.textContent).toContain('Arun')
    expect(open.textContent).toContain('Not saved')
    expect(open.textContent).toContain('₹1,06,200.00')
    expect((table.querySelector('[data-draft-id="5"]') as HTMLElement).textContent).toContain('Saved')
    fireEvent.click(within(open).getByTestId('btn-ai-drafts-open'))
    await waitFor(() => expect(useNav.getState().stack.at(-1)).toEqual({ name: 'voucher-entry', aiDraftId: 7, kindHint: 'sales' }))
    fireEvent.click(within(open).getByTestId('btn-ai-drafts-discard'))
    await act(async () => fireEvent.click(await screen.findByTestId('confirm-ok')))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ai:draft:discard', { id: 7 }))
  })
})

describe('helpers', () => {
  it('screenForDraft: trade documents open in their own editor', () => {
    expect(screenForDraft(draftDto())).toEqual({ name: 'voucher-entry', aiDraftId: 7, kindHint: 'sales' })
    const q = draftDto({ payload: { ...draftDto().payload, form: 'tradeDoc', voucherKind: 'quotation' } })
    expect(screenForDraft(q)).toEqual({ name: 'trade-doc', kind: 'quotation', aiDraftId: 7 })
  })

  it('elementsForField finds captions and line rows; markAiFields skips cleared fields', () => {
    document.body.innerHTML = `
      <div id="root">
        <label><span>Date</span><input /></label>
        <label><span>Party (buyer)</span><input /></label>
        <label><span>Narration</span><input /></label>
        <table><tbody data-testid="rows-invoice-lines"><tr data-line-key="1"><td/></tr><tr data-line-key="2"><td/></tr></tbody></table>
      </div>`
    const root = document.getElementById('root')!
    expect(elementsForField(root, 'party')).toHaveLength(1)
    expect(elementsForField(root, 'line:1')[0]!.getAttribute('data-line-key')).toBe('2')
    expect(elementsForField(root, 'line:5')).toEqual([])
    expect(markAiFields(root, ['date', 'party', 'narration', 'line:0'], new Set(['narration']))).toBe(3)
    expect(root.querySelectorAll('[data-ai-set]')).toHaveLength(3)
  })
})
