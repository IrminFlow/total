// WP 3.2 — the TDS screen: ledger summary card, Eligible (Move to TDS per row and bulk, Not
// applicable), Deducted (edit / delete), Challans (new from payment, allocate), Returns (26Q,
// 16A PDF, 27EQ placeholder) and Sections (deductees, certificates). window.total is mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type {
  Form16aData, Form26qData, TdsChallanRow, TdsDeductedRow, TdsEligibleRow, TdsLedgerSummaryRow, TdsPaymentCandidate
} from '@shared/tdsTypes'
import { useNav, useSession } from '../state/stores'
import { TdsScreen } from '../screens/Tds'
import { DialogHost } from '../components/dialogs'

const invoke = vi.fn()
let handlers: Record<string, (payload: unknown) => unknown> = {}
const calls = (channel: string): unknown[] => invoke.mock.calls.filter((c) => c[0] === channel).map((c) => c[1])

function renderScreen(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <TdsScreen />
      <DialogHost />
    </QueryClientProvider>
  )
}
const bodyRows = (area: string): HTMLElement[] => Array.from(screen.getByTestId(`rows-${area}`).querySelectorAll<HTMLElement>('tr.dt-row'))

const SUMMARY: TdsLedgerSummaryRow[] = [
  { sectionId: 3, sectionCode: '194C', ledgerId: 50, ledgerName: 'TDS Payable 194C', openingPaise: 0, deductedPaise: 100000, depositedPaise: 0, outstandingPaise: 100000, entriesTdsPaise: 100000, deductees: 1 }
]
const ELIGIBLE: TdsEligibleRow[] = [
  {
    voucherId: 11, voucherNumber: 'P-7', date: '2026-04-10', kind: 'purchase', partyLedgerId: 12, partyName: 'Acme Contractors', pan: 'ABCCE1234F',
    deducteeType: 'company', expenseLedgerId: 22, expenseLedgerName: 'Purchases', sectionId: 3, sectionCode: '194C', basePaise: 5000000,
    rateBp: 200, tdsPaise: 100000, reason: 'single', exemptReason: null, candidates: [{ sectionId: 3, code: '194C' }]
  },
  {
    voucherId: 12, voucherNumber: 'J-2', date: '2026-04-20', kind: 'journal', partyLedgerId: 13, partyName: 'Rao & Co', pan: null,
    deducteeType: null, expenseLedgerId: 23, expenseLedgerName: 'Legal Fees', sectionId: 4, sectionCode: '194J', basePaise: 6000000,
    rateBp: 2000, tdsPaise: 1200000, reason: 'aggregate_later', exemptReason: null, candidates: [{ sectionId: 4, code: '194J' }]
  }
]
const DEDUCTED: TdsDeductedRow[] = [
  {
    entryId: 90, voucherId: 11, voucherNumber: 'P-7', date: '2026-04-10', kind: 'purchase', partyLedgerId: 12, partyName: 'Acme Contractors',
    pan: 'ABCCE1234F', sectionId: 3, sectionCode: '194C', basePaise: 5000000, rateBp: 200, tdsPaise: 100000, deducteeType: 'company',
    isManual: false, certificateNo: null, challanId: null, challanNo: null, challanStatus: 'unallocated'
  }
]
const CHALLANS: TdsChallanRow[] = [
  { id: 5, date: '2026-05-07', bsrCode: '0510308', challanNo: '42', amountPaise: 100000, paymentVoucherId: 31, paymentVoucherNumber: 'PY-3', quarter: 1, fyStartYear: 2026, allocatedPaise: 100000, entryCount: 1, interestPaise: 0 }
]
const CANDIDATES: TdsPaymentCandidate[] = [
  { voucherId: 31, voucherNumber: 'PY-3', date: '2026-05-07', amountPaise: 100000, sectionIds: [3], sectionCodes: '194C', challanId: null }
]
const F26Q: Form26qData = {
  fyStartYear: 2026, quarter: 1, layout: 'form140',
  deductees: [{
    serial: 1, entryId: 90, voucherId: 11, partyLedgerId: 12, partyName: 'Acme Contractors', pan: 'ABCCE1234F', deducteeCode: '01', sectionCode: '194C',
    returnCode: '1024', paymentDate: '2026-04-10', amountPaise: 5000000, tdsPaise: 100000, deductionDate: '2026-04-10', rateBp: 200, reasonCode: '',
    challanSerial: 1, bsrCode: '0510308', challanDate: '2026-05-07', challanNo: '42'
  }],
  challans: [{ serial: 1, challanId: 5, bsrCode: '0510308', date: '2026-05-07', challanNo: '42', amountPaise: 100000, allocatedPaise: 100000, entries: 1 }],
  totals: { amountPaise: 5000000, tdsPaise: 100000, depositedPaise: 100000 }
}
const F16A: Form16aData = {
  deductor: { name: 'Demo Traders', address: 'Pune', pan: null, tan: null }, fyStartYear: 2026, quarter: 1,
  period: { from: '2026-04-01', to: '2026-06-30' }, assessmentYear: '2027-28',
  parties: [{ partyLedgerId: 12, partyName: 'Acme Contractors', pan: 'ABCCE1234F', address: null, payments: [], challans: [], totals: { amountPaise: 5000000, tdsPaise: 100000, depositedPaise: 100000 } }]
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-05-15T10:00:00Z'))
  localStorage.clear()
  handlers = {
    'tds:ledgerSummary': () => SUMMARY,
    'tds:eligible': () => ELIGIBLE,
    'tds:deducted': () => DEDUCTED,
    'tds:applyToVoucher': (p) => ({ id: (p as { voucherId: number }).voucherId, number: 'P-7', tds: { tdsAmount: 100000 } }),
    'tds:applyMany': (p) => (p as { voucherIds: number[] }).voucherIds.map((voucherId) => ({ voucherId, ok: true })),
    'tds:exempt': () => null,
    'tds:removeFromVoucher': () => ({ id: 11, number: 'P-7', tds: null }),
    'tds:challanRows': () => CHALLANS,
    'tds:unallocated': () => [],
    'tds:paymentCandidates': () => CANDIDATES,
    'tds:challanFromPayment': () => CHALLANS[0],
    'tds:challanInterest': () => [],
    'tds:form26q': () => F26Q,
    'tds:form16a': () => F16A,
    'tds:form16aPdf': () => ({ path: '/x/form16a.pdf' }),
    'tds:export26q': () => ({ path: '/x/tds-26q.csv' }),
    'tds:sections': () => [{ id: 3, code: '194C', description: 'Contractors', rate: 2, thresholdSingle: 3000000, thresholdAnnual: 10000000, nature: null, act: 'it_act_1961', legacyCode: '194C', newReference: '393(1) Sl. 6(i)' }],
    'tds:certificates': () => [{ id: 7, ledgerId: 12, sectionId: 3, certificateNo: 'LDC-1', rateBp: 50, validFrom: '2026-04-01', validTo: '2027-03-31', capPaise: null }],
    'master:ledgers:list': () => [
      { id: 12, name: 'Acme Contractors', groupId: 1, tdsSectionId: 3, pan: 'ABCCE1234F', deducteeType: null },
      { id: 13, name: 'Rao & Co', groupId: 1, tdsSectionId: null, pan: null, deducteeType: 'firm' }
    ],
    'master:groups:list': () => []
  }
  invoke.mockImplementation(async (channel: string, payload?: unknown) => {
    const h = handlers[channel]
    if (!h) return { ok: false, error: `unmocked channel ${channel}` }
    return { ok: true, data: h(payload) }
  })
  window.total = { platform: 'test', invoke }
  act(() => {
    useSession.setState({ slug: 'tds-co', info: { booksFrom: 2025 } as never, user: null })
    useNav.setState({ stack: [{ name: 'tds' }] })
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('TDS screen', () => {
  it('shows the TDS ledger summary card for the current quarter', async () => {
    renderScreen()
    await waitFor(() => expect(bodyRows('tds-summary')).toHaveLength(1))
    expect(bodyRows('tds-summary')[0]!.textContent).toMatch(/194C.*TDS Payable 194C.*1,000\.00/)
    expect(screen.getByTestId('tds-stat-outstanding').textContent).toContain('1,000.00')
    expect(calls('tds:ledgerSummary')[0]).toEqual({ fyStartYear: 2026, quarter: 1 })
    // Full year.
    fireEvent.change(screen.getByTestId('input-tds-quarter'), { target: { value: '0' } })
    await waitFor(() => expect(calls('tds:ledgerSummary').at(-1)).toEqual({ fyStartYear: 2026, quarter: 0 }))
    expect(calls('tds:eligible').at(-1)).toEqual({ from: '2026-04-01', to: '2027-03-31', includeExempt: false })
  })

  it('Eligible: lists vouchers with their reason, moves one, bulk-moves the selection and marks one not applicable', async () => {
    renderScreen()
    await waitFor(() => expect(bodyRows('tds-eligible')).toHaveLength(2))
    expect(screen.getByTestId('tab-tds-eligible').textContent).toContain('2')
    expect(bodyRows('tds-eligible')[0]!.textContent).toMatch(/P-7.*Acme Contractors.*194C.*50,000\.00.*1,000\.00.*Single payment above the limit/)
    expect(bodyRows('tds-eligible')[1]!.textContent).toContain('Aggregate crossed later in the year')

    fireEvent.click(screen.getByTestId('btn-tds-move-11'))
    await waitFor(() => expect(calls('tds:applyToVoucher')).toEqual([{ voucherId: 11, sectionId: 3 }]))

    fireEvent.click(screen.getByTestId('chk-tds-eligible-11'))
    fireEvent.click(screen.getByTestId('chk-tds-eligible-12'))
    fireEvent.click(screen.getByTestId('btn-tds-move-selected'))
    fireEvent.click(await screen.findByTestId('confirm-ok'))
    await waitFor(() => expect(calls('tds:applyMany')).toEqual([{ voucherIds: [11, 12] }]))

    fireEvent.click(screen.getByTestId('menu-tds-eligible-12'))
    fireEvent.click(await screen.findByTestId('btn-tds-na-12'))
    fireEvent.change(await screen.findByTestId('prompt-input'), { target: { value: 'Reimbursement only' } })
    fireEvent.click(screen.getByTestId('prompt-ok'))
    await waitFor(() => expect(calls('tds:exempt')).toEqual([{ voucherId: 12, reason: 'Reimbursement only' }]))
  })

  it('Deducted: edit opens the voucher, delete goes through the server after a confirm', async () => {
    renderScreen()
    fireEvent.click(await screen.findByTestId('tab-tds-deducted'))
    await waitFor(() => expect(bodyRows('tds-deducted')).toHaveLength(1))
    expect(bodyRows('tds-deducted')[0]!.textContent).toMatch(/P-7.*Acme Contractors.*194C.*2%.*1,000\.00.*Not on a challan/)
    fireEvent.click(screen.getByTestId('btn-tds-edit-90'))
    await waitFor(() => expect(useNav.getState().stack.at(-1)).toEqual({ name: 'voucher-entry', voucherId: 11 }))
    fireEvent.click(screen.getByTestId('btn-tds-delete-90'))
    fireEvent.click(await screen.findByTestId('confirm-ok'))
    await waitFor(() => expect(calls('tds:removeFromVoucher')).toEqual([{ voucherId: 11 }]))
  })

  it('Challans: lists challans with interest and creates one from a payment voucher', async () => {
    renderScreen()
    fireEvent.click(await screen.findByTestId('tab-tds-challans'))
    await waitFor(() => expect(bodyRows('tds-challans')).toHaveLength(1))
    expect(bodyRows('tds-challans')[0]!.textContent).toMatch(/42.*0510308.*Q1.*PY-3.*1,000\.00/)
    fireEvent.change(screen.getByTestId('input-tds-interest-rate'), { target: { value: '1' } })
    await waitFor(() => expect(calls('tds:challanRows').at(-1)).toEqual({ fyStartYear: 2026, quarter: 1, rateBp: 100 }))

    fireEvent.click(screen.getByTestId('btn-tds-challan-new'))
    const modal = await screen.findByRole('dialog')
    await waitFor(() => expect(within(modal).getByTestId('select-tds-challan-payment')).toBeTruthy())
    fireEvent.change(within(modal).getByTestId('input-tds-challan-bsr'), { target: { value: '0510308' } })
    fireEvent.change(within(modal).getByTestId('input-tds-challan-no'), { target: { value: '42' } })
    fireEvent.click(within(modal).getByTestId('btn-tds-challan-create'))
    await waitFor(() =>
      expect(calls('tds:challanFromPayment')).toEqual([
        { paymentVoucherId: 31, bsrCode: '0510308', challanNo: '42', date: null, quarter: null, fyStartYear: null, autoAllocate: true }
      ])
    )
  })

  it('Returns: 26Q deductee + challan data, the CSV, Form 16A PDF and the 27EQ placeholder', async () => {
    renderScreen()
    fireEvent.click(await screen.findByTestId('tab-tds-returns'))
    await waitFor(() => expect(bodyRows('tds-26q')).toHaveLength(1))
    expect(screen.getByTestId('tds-returns-layout').textContent).toContain('Form 140')
    expect(bodyRows('tds-26q')[0]!.textContent).toMatch(/Acme Contractors.*ABCCE1234F.*01.*194C.*1024/)
    expect(bodyRows('tds-26q-challans')[0]!.textContent).toMatch(/0510308.*42/)
    expect(screen.getByTestId('tds-27eq-placeholder')).toBeTruthy()
    fireEvent.click(screen.getByTestId('btn-tds-export'))
    await waitFor(() => expect(calls('tds:export26q')).toEqual([{ fyStartYear: 2026, quarter: 1 }]))
    fireEvent.click(screen.getByTestId('btn-tds-16a-pdf-12'))
    await waitFor(() => expect(calls('tds:form16aPdf')).toEqual([{ fyStartYear: 2026, quarter: 1, partyLedgerId: 12 }]))
    fireEvent.click(screen.getByTestId('tds-returns-q-2'))
    await waitFor(() => expect(calls('tds:form26q').at(-1)).toEqual({ fyStartYear: 2026, quarter: 2 }))
  })

  it('Sections: sections, deductees with PAN-derived types, certificates', async () => {
    renderScreen()
    fireEvent.click(await screen.findByTestId('tab-tds-sections'))
    await waitFor(() => expect(bodyRows('tds-sections')).toHaveLength(1))
    await waitFor(() => expect(bodyRows('tds-deductees')).toHaveLength(2))
    expect(bodyRows('tds-deductees')[0]!.textContent).toMatch(/Acme Contractors.*ABCCE1234F.*Company.*from PAN.*194C/)
    expect(bodyRows('tds-deductees')[1]!.textContent).toMatch(/Rao & Co.*Missing.*Firm \/ LLP.*set on ledger/)
    await waitFor(() => expect(bodyRows('tds-certificates')).toHaveLength(1))
    expect(bodyRows('tds-certificates')[0]!.textContent).toMatch(/Acme Contractors.*LDC-1.*194C.*0\.5%.*In force/)
  })
})
