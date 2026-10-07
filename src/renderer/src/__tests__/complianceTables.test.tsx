// WP 1.7c — compliance screens on the shared DataTable: GSTR-2B reconciliation, the e-invoice /
// e-way bill list and the GSTR-1 section summary. Each keeps the old column set and order, gains
// header sorting, and row activation / keyboard Enter go to the same place the old rows did.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { CompanyInfo } from '@shared/domain'
import type { EdocListRow } from '@shared/reports'
import type { Recon2bPair, Recon2bResult } from '@shared/gst/recon2b'
import { useNav, useSession } from '../state/stores'
import { Gstr2bScreen } from '../screens/Gstr2b'
import { EdocsScreen } from '../screens/Edocs'
import { Gstr1Screen } from '../screens/GstReturns'

const invoke = vi.fn()
const go = vi.fn()

const tax = { igst: 0, cgst: 900, sgst: 900, cess: 0 }
const portal = (number: string, date: string, value: number): NonNullable<Recon2bPair['portal']> => ({
  gstin: '27AAAAA0000A1Z5',
  number,
  date,
  value,
  taxable: value - 1800,
  ...tax,
  kind: 'b2b'
})
const book = (voucherId: number, ref: string, date: string, value: number): NonNullable<Recon2bPair['book']> => ({
  voucherId,
  kind: 'purchase',
  date,
  number: `P-${voucherId}`,
  supplierRef: ref,
  partyName: 'Acme Supplies',
  partyGstin: '27AAAAA0000A1Z5',
  invoiceValue: value,
  taxable: value - 1800,
  ...tax
})

const PAIRS: Recon2bPair[] = [
  { bucket: 'matched', portal: portal('INV-30', '2026-04-03', 300000), book: book(31, 'INV-30', '2026-04-03', 300000), valueDiffPaise: 0, taxDiffPaise: null },
  { bucket: 'matched', portal: portal('INV-10', '2026-04-01', 500000), book: book(11, 'INV-10', '2026-04-01', 500000), valueDiffPaise: 0, taxDiffPaise: null },
  { bucket: 'matched', portal: portal('INV-20', '2026-04-02', 100000), book: book(21, 'INV-20', '2026-04-02', 100000), valueDiffPaise: 0, taxDiffPaise: null },
  { bucket: 'missingInBooks', portal: portal('INV-99', '2026-04-09', 70000), book: null, valueDiffPaise: null, taxDiffPaise: null }
]
const bucketTotals = { count: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 }
const RESULT: Recon2bResult = {
  pairs: PAIRS,
  buckets: {
    matched: { ...bucketTotals, count: 3 },
    amountMismatch: bucketTotals,
    taxMismatch: bucketTotals,
    missingInBooks: { ...bucketTotals, count: 1 },
    missingInPortal: bucketTotals
  }
} as Recon2bResult

const edoc = (voucherId: number, number: string, date: string, docType: EdocListRow['docType'], total: number, partyName: string | null): EdocListRow => ({
  voucherId,
  number,
  date,
  docType,
  partyLedgerId: partyName ? 9 : null,
  partyName,
  partyGstin: partyName ? '27BBBBB0000B1Z5' : null,
  total,
  vehicleNo: null,
  hasHsn: true,
  irn: null,
  ewbNo: null,
  outwardDbn: false,
  ewbReason: null
})
const EDOCS: EdocListRow[] = [
  edoc(1, 'S-1', '2026-04-02', 'INV', 250000, 'Zenith Retail'),
  edoc(2, 'S-2', '2026-04-05', 'INV', 75000, null),
  edoc(3, 'CN-1', '2026-04-07', 'CRN', 10000, 'Alpha Stores')
]

const GSTR1_SUMMARY = [
  { section: 'b2b', label: 'B2B invoices (Table 4)', docs: 2, taxable: 1000000, igst: 0, cgst: 90000, sgst: 90000, cess: 0 },
  { section: 'b2cs', label: 'B2C small (Table 7)', docs: 1, taxable: 200000, igst: 0, cgst: 18000, sgst: 18000, cess: 0 },
  { section: 'cdnr', label: 'Credit/debit notes (Table 9B)', docs: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 },
  { section: 'hsn_b2b', label: 'HSN summary — B2B (Table 12)', docs: 4, taxable: 1000000, igst: 0, cgst: 90000, sgst: 90000, cess: 0 },
  { section: 'doc_issue', label: 'Documents issued (Table 13)', docs: 3, taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 }
]

function renderWithClient(ui: React.JSX.Element): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

const press = (key: string): void => {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
}

const bodyRows = (area: string): HTMLElement[] =>
  Array.from(screen.getByTestId(`rows-${area}`).querySelectorAll<HTMLElement>('tr.dt-row'))
const firstCells = (area: string): string[] => bodyRows(area).map((tr) => tr.querySelector('td')!.textContent ?? '')

beforeEach(() => {
  localStorage.clear()
  go.mockReset()
  invoke.mockImplementation(async (channel: string) => {
    switch (channel) {
      case 'gst:recon2b':
        return { ok: true, data: { result: RESULT, errors: [], period: '042026' } }
      case 'edoc:list':
        return { ok: true, data: EDOCS }
      case 'nic:status':
        return { ok: true, data: { configured: false } }
      case 'gst:gstr1':
        return { ok: true, data: { period: '042026', gstin: '27AAAAA0000A1Z5', json: {}, summary: GSTR1_SUMMARY } }
      case 'gst:validate':
        return { ok: true, data: { issues: [], roundOff: [] } }
      default:
        return { ok: false, error: `unmocked channel ${channel}` }
    }
  })
  window.total = { platform: 'test', invoke }
  act(() => {
    useSession.setState({
      slug: 'alpha-co',
      from: '2026-04-01',
      to: '2026-04-30',
      info: { gstin: '27AAAAA0000A1Z5' } as CompanyInfo
    })
    useNav.setState({ go })
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

async function openGstr2b(): Promise<void> {
  renderWithClient(<Gstr2bScreen />)
  fireEvent.click(screen.getByTestId('btn-2b-paste'))
  fireEvent.change(screen.getByTestId('input-2b-paste'), { target: { value: '{"data":{}}' } })
  fireEvent.click(screen.getByTestId('btn-2b-paste-apply'))
  await waitFor(() => expect(screen.getByTestId('rows-2b-pairs')).toBeTruthy())
}

describe('GSTR-2B reconciliation table', () => {
  it('renders portal + books columns in the reconciliation order', async () => {
    await openGstr2b()
    for (const id of ['portalNo', 'portalDate', 'portalValue', 'portalTax', 'bookNo', 'bookDate', 'bookValue', 'bookTax', 'valueDiff']) {
      expect(screen.getByTestId(`sort-2b-pairs-${id}`)).toBeTruthy()
    }
    // Default = the order the service returned (no sort applied).
    expect(firstCells('2b-pairs')).toEqual(['INV-30', 'INV-10', 'INV-20'])
    // Totals sum the portal and books value columns.
    const totals = screen.getByTestId('2b-pairs-table-totals')
    expect(totals.textContent).toContain('9,000.00')
  })

  it('a Portal | Books header band names each side, so the column labels stay short', async () => {
    await openGstr2b()
    const bands = Array.from(screen.getByTestId('2b-pairs-table-bands').querySelectorAll<HTMLTableCellElement>('th[scope="colgroup"]'))
    expect(bands.map((th) => [th.textContent, th.colSpan])).toEqual([
      ['Portal', 4],
      ['Books', 4]
    ])
    expect(screen.getByTestId('sort-2b-pairs-portalNo').textContent).toBe('Invoice no.')
    expect(screen.getByTestId('sort-2b-pairs-bookValue').textContent).toBe('Value')
    expect(screen.getByTestId('sort-2b-pairs-valueDiff').textContent).toBe('Value diff')
  })

  it('sorts on a column header', async () => {
    await openGstr2b()
    fireEvent.click(screen.getByTestId('sort-2b-pairs-portalValue'))
    expect(firstCells('2b-pairs')).toEqual(['INV-20', 'INV-30', 'INV-10'])
    fireEvent.click(screen.getByTestId('sort-2b-pairs-portalNo'))
    expect(firstCells('2b-pairs')).toEqual(['INV-10', 'INV-20', 'INV-30'])
  })

  it('a click or Enter on a matched row opens the purchase voucher', async () => {
    await openGstr2b()
    fireEvent.click(bodyRows('2b-pairs')[1]!)
    expect(go).toHaveBeenLastCalledWith({ name: 'voucher-entry', voucherId: 11 })
    press('ArrowDown')
    press('Enter')
    expect(go).toHaveBeenCalledTimes(2)
    expect(go.mock.calls[1]![0]).toMatchObject({ name: 'voucher-entry' })
  })

  it('missing-in-books rows are inert but offer Create purchase', async () => {
    await openGstr2b()
    fireEvent.click(screen.getByTestId('btn-2b-bucket-missingInBooks'))
    await waitFor(() => expect(firstCells('2b-pairs')).toEqual(['INV-99']))
    fireEvent.click(bodyRows('2b-pairs')[0]!)
    expect(go).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('btn-2b-create-purchase'))
    expect(go).toHaveBeenCalledTimes(1)
    expect(go.mock.calls[0]![0]).toMatchObject({ name: 'voucher-entry', kindHint: 'purchase', draft: { date: '2026-04-09' } })
  })
})

describe('e-Invoice / e-way bill table', () => {
  it('renders the documents in date order with a value total', async () => {
    renderWithClient(<EdocsScreen />)
    await waitFor(() => expect(screen.getByTestId('rows-edocs')).toBeTruthy())
    const rows = bodyRows('edocs')
    expect(rows.map((r) => r.getAttribute('data-row-id'))).toEqual(['1', '2', '3'])
    expect(within(rows[1]!).getByText('Cash sale')).toBeTruthy()
    expect(screen.getByTestId('edocs-table-totals').textContent).toContain('3,350.00')
  })

  it('sorts by value and keeps the doc-type filter', async () => {
    renderWithClient(<EdocsScreen />)
    await waitFor(() => expect(screen.getByTestId('rows-edocs')).toBeTruthy())
    fireEvent.click(screen.getByTestId('sort-edocs-value'))
    expect(bodyRows('edocs').map((r) => r.getAttribute('data-row-id'))).toEqual(['3', '2', '1'])
    fireEvent.change(screen.getByTestId('input-edocs-doctype'), { target: { value: 'CRN' } })
    expect(bodyRows('edocs').map((r) => r.getAttribute('data-row-id'))).toEqual(['3'])
  })

  it('row click opens the voucher; action buttons do not', async () => {
    renderWithClient(<EdocsScreen />)
    await waitFor(() => expect(screen.getByTestId('rows-edocs')).toBeTruthy())
    fireEvent.click(within(bodyRows('edocs')[0]!).getByTestId('btn-edocs-ewb-json'))
    expect(go).not.toHaveBeenCalled()
    fireEvent.click(bodyRows('edocs')[2]!)
    expect(go).toHaveBeenLastCalledWith({ name: 'voucher-entry', voucherId: 3 })
  })
})

describe('GSTR-1 section summary', () => {
  it('totals only the invoice tables (HSN and Documents issued restate them)', async () => {
    renderWithClient(<Gstr1Screen />)
    await waitFor(() => expect(screen.getByTestId('rows-gstr1')).toBeTruthy())
    expect(firstCells('gstr1')).toEqual(GSTR1_SUMMARY.map((s) => s.label))
    const totals = screen.getByTestId('gstr1-table-totals')
    expect(totals.textContent).toContain('Total (invoice tables)')
    expect(totals.textContent).toContain('12,000.00') // taxable 10,000 + 2,000
    expect(totals.textContent).toContain('1,080.00') // cgst 900 + 180
    const cells = Array.from(totals.querySelectorAll('td')).map((td) => td.textContent)
    expect(cells[1]).toBe('3') // docs 2 + 1 (+0), not the HSN / doc-issue counts
    // Empty sections are dimmed as before.
    expect(bodyRows('gstr1')[2]!.className).toContain('text-muted')
  })
})
