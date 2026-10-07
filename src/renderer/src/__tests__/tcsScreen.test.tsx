// WP 3.3 — the TCS screen is the TDS screen's shell and tabs with kind 'tcs': its own channels
// (tcs:*), words (Collected / Collectee / 27EQ / 27D) and test ids; plus the TCS banner text.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Form16aData, Form26qData, TdsDeductedRow, TdsEligibleRow, TdsLedgerSummaryRow } from '@shared/tdsTypes'
import { useNav, useSession } from '../state/stores'
import { TcsScreen } from '../screens/Tcs'
import { DialogHost } from '../components/dialogs'
import { TdsBanner, tcsReasonText } from '../screens/voucher/TdsBanner'
import type { TcsSuggestion } from '../lib/client'

const invoke = vi.fn()
let handlers: Record<string, (payload: unknown) => unknown> = {}
const calls = (channel: string): unknown[] => invoke.mock.calls.filter((c) => c[0] === channel).map((c) => c[1])
const bodyRows = (area: string): HTMLElement[] => Array.from(screen.getByTestId(`rows-${area}`).querySelectorAll<HTMLElement>('tr.dt-row'))

function renderScreen(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <TcsScreen />
      <DialogHost />
    </QueryClientProvider>
  )
}

const SUMMARY: TdsLedgerSummaryRow[] = [
  { sectionId: 30, sectionCode: '206C(1) SCRAP', ledgerId: 60, ledgerName: 'TCS Payable 206C(1) SCRAP', openingPaise: 0, deductedPaise: 118000, depositedPaise: 0, outstandingPaise: 118000, entriesTdsPaise: 118000, deductees: 1 }
]
const ELIGIBLE: TdsEligibleRow[] = [
  {
    voucherId: 21, voucherNumber: 'S-4', date: '2025-07-03', kind: 'sales', partyLedgerId: 14, partyName: 'Scrap Buyer Pvt Ltd', pan: 'AABCS1234D',
    deducteeType: 'company', expenseLedgerId: 25, expenseLedgerName: 'Sales', stockItemId: 9, stockItemName: 'Iron Scrap', sectionId: 30,
    sectionCode: '206C(1) SCRAP', basePaise: 5900000, rateBp: 100, tdsPaise: 59000, reason: 'none', exemptReason: null, candidates: [{ sectionId: 30, code: '206C(1) SCRAP' }]
  }
]
const COLLECTED: TdsDeductedRow[] = [
  {
    entryId: 91, voucherId: 20, voucherNumber: 'S-3', date: '2025-07-02', kind: 'sales', partyLedgerId: 15, partyName: 'Car Buyer', pan: 'ABCPK1234L',
    sectionId: 31, sectionCode: '206C(1F) VEHICLE', basePaise: 118000000, rateBp: 100, tdsPaise: 1180000, deducteeType: 'individual_huf',
    isManual: false, certificateNo: null, challanId: null, challanNo: null, challanStatus: 'unallocated'
  }
]
const F27EQ: Form26qData = {
  fyStartYear: 2025, quarter: 2, layout: 'form27eq',
  deductees: [{
    serial: 1, entryId: 91, voucherId: 20, partyLedgerId: 15, partyName: 'Car Buyer', pan: 'ABCPK1234L', deducteeCode: '02', sectionCode: '206C(1F) VEHICLE',
    returnCode: 'L', paymentDate: '2025-07-02', amountPaise: 118000000, tdsPaise: 1180000, deductionDate: '2025-07-02', rateBp: 100, reasonCode: '',
    challanSerial: null, bsrCode: null, challanDate: null, challanNo: null
  }, {
    serial: 2, entryId: -21, voucherId: 21, partyLedgerId: 14, partyName: 'Scrap Buyer Pvt Ltd', pan: 'AABCS1234D', deducteeCode: '01', sectionCode: '206C(1) SCRAP',
    returnCode: 'E', paymentDate: '2025-07-03', amountPaise: 5900000, tdsPaise: 0, deductionDate: '2025-07-03', rateBp: null, reasonCode: 'B',
    challanSerial: null, bsrCode: null, challanDate: null, challanNo: null
  }],
  challans: [],
  totals: { amountPaise: 123900000, tdsPaise: 1180000, depositedPaise: 0 }
}
const F27D: Form16aData = {
  deductor: { name: 'Demo Traders', address: 'Pune', pan: null, tan: null }, fyStartYear: 2025, quarter: 2,
  period: { from: '2025-07-01', to: '2025-09-30' }, assessmentYear: '2026-27', parties: []
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2025-08-15T10:00:00Z'))
  localStorage.clear()
  handlers = {
    'tcs:ledgerSummary': () => SUMMARY,
    'tcs:eligible': () => ELIGIBLE,
    'tcs:deducted': () => COLLECTED,
    'tcs:applyToVoucher': (p) => ({ id: (p as { voucherId: number }).voucherId, number: 'S-4', tcs: { tcsAmount: 59000 } }),
    'tcs:exempt': () => null,
    'tcs:removeFromVoucher': () => ({ id: 20, number: 'S-3', tcs: null }),
    'tcs:challanRows': () => [],
    'tcs:unallocated': () => [],
    'tcs:form27eq': () => F27EQ,
    'tcs:form27d': () => F27D,
    'tcs:export27eq': () => ({ path: '/x/tcs-27eq-2025-26-Q2.csv' }),
    'tcs:sections': () => [{ id: 30, code: '206C(1) SCRAP', description: 'Sale of scrap', rate: 2, thresholdSingle: 0, thresholdAnnual: 0, nature: 'Scrap', act: 'it_act_1961', legacyCode: '206C(1)', newReference: '394(1) Sl. 4', kind: 'tcs' }],
    'tcs:certificates': () => [],
    'master:ledgers:list': () => [{ id: 14, name: 'Scrap Buyer Pvt Ltd', groupId: 1, tdsSectionId: null, tcsSectionId: 30, pan: 'AABCS1234D', deducteeType: null }],
    'master:groups:list': () => []
  }
  invoke.mockImplementation(async (channel: string, payload?: unknown) => {
    const h = handlers[channel]
    if (!h) return { ok: false, error: `unmocked channel ${channel}` }
    return { ok: true, data: h(payload) }
  })
  window.total = { platform: 'test', invoke }
  act(() => {
    useSession.setState({ slug: 'tcs-co', info: { booksFrom: 2025 } as never, user: null })
    useNav.setState({ stack: [{ name: 'tcs' }] })
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('TCS screen', () => {
  it('summary card and Eligible list on tcs:* channels; Move to TCS', async () => {
    renderScreen()
    await waitFor(() => expect(bodyRows('tcs-summary')).toHaveLength(1))
    expect(bodyRows('tcs-summary')[0]!.textContent).toMatch(/206C\(1\) SCRAP.*TCS Payable 206C\(1\) SCRAP.*1,180\.00/)
    expect(calls('tcs:ledgerSummary')[0]).toEqual({ fyStartYear: 2025, quarter: 2 })
    expect(calls('tds:ledgerSummary')).toEqual([])
    await waitFor(() => expect(bodyRows('tcs-eligible')).toHaveLength(1))
    expect(bodyRows('tcs-eligible')[0]!.textContent).toMatch(/S-4.*Scrap Buyer Pvt Ltd.*Iron Scrap.*206C\(1\) SCRAP.*590\.00.*Section has no threshold/)
    fireEvent.click(screen.getByTestId('btn-tcs-move-21'))
    await waitFor(() => expect(calls('tcs:applyToVoucher')).toEqual([{ voucherId: 21, sectionId: 30 }]))
  })

  it('Collected tab and Returns: 27EQ collectee rows with remark B, due dates, CSV', async () => {
    renderScreen()
    fireEvent.click(await screen.findByTestId('tab-tcs-deducted'))
    expect(screen.getByTestId('tab-tcs-deducted').textContent).toContain('Collected')
    await waitFor(() => expect(bodyRows('tcs-deducted')).toHaveLength(1))
    expect(bodyRows('tcs-deducted')[0]!.textContent).toMatch(/S-3.*Car Buyer.*206C\(1F\) VEHICLE.*11,800\.00/)

    fireEvent.click(screen.getByTestId('tab-tcs-returns'))
    await waitFor(() => expect(bodyRows('tcs-26q')).toHaveLength(2))
    expect(screen.getByTestId('tcs-returns-layout').textContent).toBe('Form 27EQ')
    expect(screen.getByTestId('tcs-returns-due').textContent).toBe('Statement due 15-Oct-25 · Form 27D by 30-Oct-25')
    expect(bodyRows('tcs-26q')[1]!.textContent).toContain('B — no collection, buyer declaration')
    fireEvent.click(screen.getByTestId('btn-tcs-export'))
    await waitFor(() => expect(calls('tcs:export27eq')).toEqual([{ fyStartYear: 2025, quarter: 2 }]))
  })
})

describe('TCS banner', () => {
  const s: TcsSuggestion = {
    kind: 'tcs', sectionId: 30, code: '206C(1) SCRAP', reference: '206C(1)', rate: 1, rateBp: 100, basis: 'section', tdsPaise: 118000, basePaise: 11800000,
    payableLedgerId: null, payableLedgerName: 'TCS Payable 206C(1) SCRAP', panAvailable: true, deducteeType: 'company', thresholdCrossed: true,
    threshold: { reason: 'none', singlePaise: 0, aggregateLimitPaise: 0, basis: 'fy', priorPaise: 0 }, certificate: null, sectionFrom: 'goods',
    candidates: [{ sectionId: 30, code: '206C(1) SCRAP', from: 'goods' }], payment: null, gstInBase: true
  }
  it('reads "TCS u/s … collect" with the goods and the GST-in-base basis', () => {
    const onApply = vi.fn()
    render(<TdsBanner kind="tcs" suggestion={s} onApply={onApply} onDismiss={() => undefined} blockedReason={null} />)
    expect(screen.getByTestId('banner-tcs').textContent).toMatch(/TCS u\/s 206C\(1\) SCRAP \(206C\(1\)\): collect.*1,180\.00.*at 1%.*section from the goods.*TCS Payable 206C\(1\) SCRAP is created when you save/)
    expect(screen.getByTestId('banner-tcs-reason').textContent).toBe('TCS applies to every sale on the goods · base includes GST')
    fireEvent.click(screen.getByTestId('btn-tcs-apply'))
    expect(onApply).toHaveBeenCalled()
  })
  it('receipt reason: uncollected sales + advance', () => {
    expect(tcsReasonText({ ...s, payment: { undeductedBillsPaise: 100000, advancePaise: 50000, deductedAtCredit: false }, basePaise: 150000 }))
      .toBe('Collect on receipt: ₹1,000.00 of sales not collected on when invoiced + ₹500.00 received in advance of the invoice (TCS is due at debit or receipt, whichever is earlier)')
    expect(tcsReasonText({ ...s, threshold: { ...s.threshold, reason: 'single', singlePaise: 100000000 }, sectionFrom: 'party' })).toBe('Sale above ₹10,00,000.00 for this buyer · base includes GST')
  })
})
