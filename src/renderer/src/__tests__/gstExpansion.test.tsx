// WP 3.4 — the GST expansion screens on the shared DataTable: GSTR-9 comparison highlighting and
// the GST return tab family, IMS bulk accept, ITC reversal "apply to 3B", RCM self-invoice
// generation.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { CompanyInfo } from '@shared/domain'
import type { Recon2bPair } from '@shared/gst/recon2b'
import type { Gstr9View, ItcReversalView } from '@shared/gst/views'
import type { SelfInvoiceRow } from '@shared/gst/selfInvoice'
import { useNav, useSession } from '../state/stores'
import { Gstr9Screen } from '../screens/gst/Gstr9Screen'
import { ImsTab } from '../screens/gst/ImsTab'
import { ItcReversalScreen } from '../screens/gst/ItcReversalScreen'
import { SelfInvoicesTab } from '../screens/gst/SelfInvoicesTab'

const invoke = vi.fn()
const go = vi.fn()
const Z = { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 }
const H = { igst: 0, cgst: 0, sgst: 0, cess: 0 }

const GSTR9: Gstr9View = {
  fyLabel: '2026-27', gstin: '27AAAAA0000A1Z5', fyStartYear: 2026, from: '2026-04-01', to: '2027-03-31', dueDate: '2027-12-31',
  turnover: 5_00_000_00, optional: true, gstr9cApplies: false,
  rows: [
    { id: '4B', table: '4', label: 'Supplies made to registered persons (B2B)', amounts: { ...Z, taxable: 100000, cgst: 9000, sgst: 9000 }, hasTaxable: true, kind: 'row', source: 'books',
      docs: [{ voucherId: 7, number: 'S-7', date: '2026-05-01', kind: 'sales', partyName: 'Zenith', partyLedgerId: 3, taxable: 100000, igst: 0, cgst: 9000, sgst: 9000, cess: 0 }] },
    { id: '8A', table: '8', label: 'ITC as per GSTR-2B (table 3 thereof)', amounts: Z, hasTaxable: false, kind: 'row', source: 'na', docs: [] }
  ],
  paid: [{ id: 'cgst', label: 'Central Tax', payable: 9000, paidCash: 9000, paidItc: H }],
  compare: [
    { id: 'g1-taxable', label: 'Taxable outward, tax paid', annual: { ...Z, taxable: 100000 }, monthly: { ...Z, taxable: 90000 }, diff: { ...Z, taxable: 10000 }, against: 'GSTR-1', hasTaxable: true },
    { id: '3b-out', label: 'Outward (3B)', annual: { ...Z, taxable: 100000 }, monthly: { ...Z, taxable: 100000 }, diff: Z, against: 'GSTR-3B', hasTaxable: true }
  ],
  months: [{ period: '052026', source: 'exported', exportedAt: '2026-06-01T00:00:00Z' }],
  hsnOutward: [], hsnInward: []
}

const portal = { gstin: '27ABCDE1234F1Z5', number: 'INV-1', date: '2026-04-05', value: 118000, taxable: 100000, igst: 0, cgst: 9000, sgst: 9000, cess: 0, kind: 'b2b' as const }
const PAIRS: Recon2bPair[] = [
  { bucket: 'matched', matchedBy: 'number', portal, book: { voucherId: 11, kind: 'purchase', date: '2026-04-05', number: 'P-11', supplierRef: 'INV-1', partyName: 'Acme', partyLedgerId: 4, partyGstin: portal.gstin, invoiceValue: 118000, taxable: 100000, igst: 0, cgst: 9000, sgst: 9000, cess: 0 }, valueDiffPaise: 0, taxDiffPaise: null },
  { bucket: 'missingInBooks', portal: { ...portal, number: 'INV-2' }, book: null, valueDiffPaise: null, taxDiffPaise: null }
]

const REV: ItcReversalView = {
  period: '042026', from: '2026-04-01', to: '2026-04-30',
  inputs: { T1: H, T2: H, T4: H, nonBusiness: false, exclusiveCapitalGoods: [], includeTrueUp: false, expenseBlocked: true },
  rule42: { T: { ...H, cgst: 1000, sgst: 1000 }, T3: H, C1: { ...H, cgst: 1000, sgst: 1000 }, C2: { ...H, cgst: 1000, sgst: 1000 }, D1: { ...H, cgst: 200, sgst: 200 }, D2: H, C3: { ...H, cgst: 800, sgst: 800 }, reversal: { ...H, cgst: 200, sgst: 200 }, E: 20000, F: 100000 },
  turnover: { E: 20000, F: 100000, borrowed: false },
  rule43: { goods: [], Tc: H, Tm: H, Te: H, E: 20000, F: 100000 },
  rule37: [], blocked: [],
  trueUp: { C2: H, annual: H, monthly: H, difference: H, E: 0, F: 0 },
  summary: { rule42: { ...H, cgst: 200, sgst: 200 }, rule43: H, blocked175: H, rule37: H, reclaimed: H, interest: H, trueUp: H, table4B1: { ...H, cgst: 200, sgst: 200 }, table4B2: H },
  proposal: [
    { role: 'reversal_expense', drCr: 'dr', amount: 400, ledger: { ledgerId: null, name: 'ITC Reversal', group: 'Indirect Expenses' } },
    { role: 'input_tax', head: 'cgst', drCr: 'cr', amount: 200, ledger: { ledgerId: 5, name: 'CGST Input', group: 'Duties & Taxes' } },
    { role: 'input_tax', head: 'sgst', drCr: 'cr', amount: 200, ledger: { ledgerId: 6, name: 'SGST Input', group: 'Duties & Taxes' } }
  ],
  posted: null, applied: false, missingTaxLedgers: []
}

const SELF: SelfInvoiceRow[] = [
  { voucherId: 21, voucherNumber: 'P-21', date: '2026-04-10', supplierRef: null, partyLedgerId: 8, partyName: 'Local Transporter', taxable: 200000, tax: 36000,
    selfInvoiceNumber: null, selfInvoiceDate: null, status: 'due', dueDate: '2026-05-10', daysLeft: 12 }
]

function renderWithClient(ui: React.JSX.Element): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

beforeEach(() => {
  localStorage.clear()
  go.mockReset()
  invoke.mockReset()
  invoke.mockImplementation(async (channel: string) => {
    switch (channel) {
      case 'gst:gstr9': return { ok: true, data: GSTR9 }
      case 'gst:imsList': return { ok: true, data: [] }
      case 'gst:imsSet': return { ok: true, data: { saved: 1, cleared: 0 } }
      case 'gst:itcReversal': return { ok: true, data: REV }
      case 'gst:itcReversalApply': return { ok: true, data: { ...REV, applied: true } }
      case 'gst:selfInvoices': return { ok: true, data: SELF }
      case 'gst:selfInvoiceGenerate': return { ok: true, data: { voucherId: 21, number: 'SI/26-27/0001', date: '2026-04-10' } }
      default: return { ok: false, error: `unmocked channel ${channel}` }
    }
  })
  window.total = { platform: 'test', invoke }
  act(() => {
    useSession.setState({ slug: 'alpha-co', from: '2026-04-01', to: '2026-04-30', info: { gstin: '27AAAAA0000A1Z5', booksFrom: 2026 } as CompanyInfo })
    useNav.setState({ go })
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('GSTR-9 workings screen', () => {
  it('highlights the comparison lines that differ and flags rows to fill on the portal', async () => {
    renderWithClient(<Gstr9Screen />)
    await waitFor(() => expect(screen.getByTestId('rows-gstr9-compare').querySelectorAll('tr.dt-row')).toHaveLength(2))
    const diffRows = screen.getByTestId('rows-gstr9-compare').querySelectorAll('tr[data-diff="yes"]')
    expect(diffRows).toHaveLength(1)
    expect(diffRows[0]!.getAttribute('data-compare')).toBe('g1-taxable')
    expect(screen.getByTestId('gstr9-compare-status').textContent).toMatch(/1 line differ/)
    expect(screen.getByTestId('rows-gstr9').textContent).toContain('Fill on portal')
    expect(screen.getByTestId('gstr9-unverified')).toBeTruthy()
  })

  it('the GST return tabs navigate between the return screens', async () => {
    renderWithClient(<Gstr9Screen />)
    fireEvent.click(screen.getByTestId('tab-gstr9-itc-reversal'))
    expect(go).toHaveBeenCalledWith({ name: 'itc-reversal' })
    expect(screen.getByTestId('tab-gstr9-gstr9').getAttribute('aria-selected')).toBe('true')
  })
})

describe('IMS tab', () => {
  it('bulk accept stores an accept for the matched records only', async () => {
    renderWithClient(<ImsTab period="042026" periodLabel="April 2026" pairs={PAIRS} />)
    await waitFor(() => expect(screen.getByTestId('btn-ims-bulk-accept').hasAttribute('disabled')).toBe(false))
    fireEvent.click(screen.getByTestId('btn-ims-bulk-accept'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('gst:imsSet', expect.anything()))
    const [, payload] = invoke.mock.calls.find((c) => c[0] === 'gst:imsSet')!
    expect(payload).toMatchObject({ period: '042026', decisions: [expect.objectContaining({ docNo: 'INV-1', action: 'accept', voucherId: 11, docType: 'INV' })] })
    expect((payload as { decisions: unknown[] }).decisions).toHaveLength(1)
  })
})

describe('ITC reversal screen', () => {
  it('shows the 4(B) figures and the proposal; Apply writes them to the 3B', async () => {
    renderWithClient(<ItcReversalScreen />)
    await waitFor(() => expect(screen.getByTestId('rows-itc-reversal-proposal').querySelectorAll('tr.dt-row')).toHaveLength(3))
    expect(screen.getByTestId('itc-rev-4b1').textContent).toContain('4.00')
    fireEvent.click(screen.getByTestId('btn-itc-reversal-apply'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('gst:itcReversalApply', expect.objectContaining({ period: expect.stringMatching(/^\d{6}$/) })))
  })
})

describe('RCM self-invoices', () => {
  it('lists the due purchase and generates its self-invoice', async () => {
    renderWithClient(<SelfInvoicesTab from="2026-04-01" to="2026-04-30" />)
    await waitFor(() => expect(screen.getByTestId('self-invoice-status-21').textContent).toBe('Due'))
    expect(screen.getByTestId('self-invoices-due')).toBeTruthy()
    fireEvent.click(screen.getByTestId('btn-self-invoice-generate-21'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('gst:selfInvoiceGenerate', { voucherId: 21, date: undefined }))
  })
})
