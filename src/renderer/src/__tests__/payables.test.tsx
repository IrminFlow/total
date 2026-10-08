// WP 4.3 — the Payables screens: the plan (bills by pay-by date, MSME flag and s.15 deadline,
// tiles; plan mode → tick → bank → preview → post → run summary), the MSME report (dues, Form 1
// view and CSV export), batch payments posting, the ledger form's MSME / terms fields, and the
// dashboard's "MSME due this week".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Group, Ledger } from '@shared/domain'
import type { MsmeReport, PayablePlanRow, PayablesPlan, PaymentRun, PaymentRunPreview } from '@shared/payables/types'
import { useNav, useSession } from '../state/stores'
import { PayablesScreen } from '../screens/Payables'
import { LedgerFormModal } from '../components/LedgerFormModal'
import { MsmeDueLine } from '../screens/gateway/MsmeDueLine'
import { initialSupplierTerms, supplierTermsError, supplierTermsPayload } from '../components/SupplierTermsFields'

const invoke = vi.fn()
let handlers: Record<string, (payload: unknown) => unknown> = {}
const calls = (channel: string): unknown[] => invoke.mock.calls.filter((c) => c[0] === channel).map((c) => c[1])

function renderScreen(ui: React.JSX.Element): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}
const bodyRows = (area: string): HTMLElement[] => Array.from(screen.getByTestId(`rows-${area}`).querySelectorAll<HTMLElement>('tr.dt-row'))

const GROUPS: Group[] = [
  { id: 1, name: 'Current Liabilities', parentId: null, nature: 'liability', affectsGrossProfit: false, isSystem: true },
  { id: 2, name: 'Sundry Creditors', parentId: 1, nature: 'liability', affectsGrossProfit: false, isSystem: true },
  { id: 3, name: 'Bank Accounts', parentId: null, nature: 'asset', affectsGrossProfit: false, isSystem: true }
]

const row = (over: Partial<PayablePlanRow>): PayablePlanRow => ({
  key: '7|101|MC-1', ledgerId: 7, partyName: 'Micro Castings', voucherId: 101, number: 'MC-1', supplierRef: 'INV-9', date: '2026-09-01',
  amount: 1_000_000, pending: 1_000_000, dueDate: '2026-10-31', msme: { category: 'micro', udyamNo: 'UDYAM-MH-33-0012345', covered: true, registeredFrom: null, agreedCreditDays: null },
  s15: { payBy: '2026-09-16', interestFrom: '2026-09-17', days: 15, basis: 'no_agreement' }, payBy: '2026-09-16', bucket: 'overdue', daysToPay: -21,
  discount: null, interestIndicative: 9_876, ...over
})

const PLAN: PayablesPlan = {
  asOn: '2026-10-07',
  rows: [
    row({}),
    row({ key: '7|102|MC-2', voucherId: 102, number: 'MC-2', date: '2026-10-01', payBy: '2026-10-16', bucket: 'next_week', daysToPay: 9, interestIndicative: 0, pending: 500_000, amount: 500_000, s15: { payBy: '2026-10-16', interestFrom: '2026-10-17', days: 15, basis: 'no_agreement' } }),
    row({
      key: '8|103|PS-1', ledgerId: 8, partyName: 'Plain Supplies', voucherId: 103, number: 'PS-1', msme: null, s15: null, payBy: '2026-10-12', bucket: 'next_week',
      daysToPay: 5, pending: 200_000, amount: 200_000, interestIndicative: 0, discount: { by: '2026-10-12', bp: 200, paise: 4_000, available: true }
    })
  ],
  totals: { pending: 1_700_000, overdue: 1_000_000, this_week: 0, next_week: 700_000, later: 0, msmeOverdue: 1_000_000, discountAvailable: 4_000 },
  cash: { ledgers: [{ ledgerId: 31, name: 'HDFC Current', kind: 'bank', balance: 50_000_000 }], total: 50_000_000 }
}

beforeEach(() => {
  localStorage.clear()
  handlers = {
    'payables:plan': () => PLAN,
    'master:ledgers:list': () => [{ id: 31, name: 'HDFC Current', groupId: 3 }, { id: 7, name: 'Micro Castings', groupId: 2 }],
    'master:groups:list': () => GROUPS
  }
  invoke.mockReset()
  invoke.mockImplementation(async (channel: string, payload?: unknown) => {
    const h = handlers[channel]
    if (!h) return { ok: false, error: `unmocked channel ${channel}` }
    return { ok: true, data: h(payload) }
  })
  window.total = { platform: 'test', invoke }
  act(() => {
    useSession.setState({ slug: 'pay-co', from: '2026-04-01', to: '2026-10-07' })
    useNav.setState({ stack: [{ name: 'payables' }] })
  })
})
afterEach(() => cleanup())

describe('Payables → Plan', () => {
  it('lists bills by pay-by date with the MSME flag, the s.15 deadline and the bucket tiles', async () => {
    renderScreen(<PayablesScreen />)
    await waitFor(() => expect(bodyRows('payables-plan')).toHaveLength(3))
    const first = bodyRows('payables-plan')[0]!
    expect(first.textContent).toContain('Micro Castings')
    expect(within(first).getByTestId('payables-msme-badge').textContent).toBe('Micro')
    expect(first.textContent).toContain('Overdue')
    expect(screen.getByTestId('payables-tile-overdue').textContent).toContain('10,000.00')
    expect(screen.getByTestId('payables-tile-msme').textContent).toContain('10,000.00')
    expect(screen.getByTestId('payables-tile-cash').textContent).toContain('5,00,000.00')
    // Filter to next week.
    fireEvent.click(screen.getByTestId('payables-filter-next_week'))
    await waitFor(() => expect(bodyRows('payables-plan')).toHaveLength(2))
  })

  it('plan mode: tick bills → total → pick the bank → preview groups by supplier → post shows the run', async () => {
    const preview: PaymentRunPreview = {
      lines: [
        { partyLedgerId: 7, partyName: 'Micro Castings', bankLedgerId: 31, bankName: 'HDFC Current', amount: 1_500_000, tds: null, bankAmount: 1_500_000, bills: [{ name: 'MC-1', amount: 1_000_000 }, { name: 'MC-2', amount: 500_000 }], onAccount: 0, instrumentNo: null, errors: [] }
      ],
      totals: { amount: 1_500_000, tds: 0, bank: 1_500_000, vouchers: 1 },
      banks: [{ ledgerId: 31, name: 'HDFC Current', before: 50_000_000, after: 48_500_000 }],
      ok: true
    }
    const run: PaymentRun = { id: 1, runNo: 'PR-0001', kind: 'plan', date: '2026-10-07', createdAt: '', note: null, vouchers: 1, amount: 1_500_000, lines: [{ ...preview.lines[0]!, voucherId: 501, voucherNumber: 'PV-12' }] }
    handlers['payables:previewRun'] = () => preview
    handlers['payables:createRun'] = () => run
    renderScreen(<PayablesScreen />)
    await waitFor(() => expect(bodyRows('payables-plan')).toHaveLength(3))
    fireEvent.click(screen.getByTestId('btn-payables-plan-mode'))
    fireEvent.click(await screen.findByTestId('pick-payables-7-MC-1'))
    fireEvent.click(screen.getByTestId('pick-payables-7-MC-2'))
    expect(screen.getByTestId('payables-selected-total').textContent).toContain('15,000.00')
    expect((screen.getByTestId('btn-payables-create') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByTestId('input-payables-bank'), { target: { value: '31' } })
    fireEvent.click(screen.getByTestId('btn-payables-create'))
    await screen.findByTestId('rows-payables-run-preview')
    expect(calls('payables:previewRun')[0]).toMatchObject({
      date: '2026-10-07', kind: 'plan', applyTds: true,
      items: [{ partyLedgerId: 7, bankLedgerId: 31, amount: 1_500_000, bills: [{ name: 'MC-1', amount: 1_000_000 }, { name: 'MC-2', amount: 500_000 }] }]
    })
    await waitFor(() => expect((screen.getByTestId('btn-payables-post-run') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('btn-payables-post-run'))
    expect((await screen.findByTestId('payables-run-no')).textContent).toBe('PR-0001')
    expect(screen.getByTestId('rows-payables-run-summary').textContent).toContain('PV-12')
    expect(calls('payables:createRun')).toHaveLength(1)
  })

  it('a preview with problems cannot be posted', async () => {
    handlers['payables:previewRun'] = (): PaymentRunPreview => ({
      lines: [{ partyLedgerId: 8, partyName: 'Plain Supplies', bankLedgerId: 31, bankName: 'HDFC Current', amount: 200_000, tds: null, bankAmount: 200_000, bills: [{ name: 'PS-1', amount: 200_000 }], onAccount: 0, instrumentNo: null, errors: ['Bill PS-1 is not open on 2026-10-07'] }],
      totals: { amount: 200_000, tds: 0, bank: 200_000, vouchers: 1 }, banks: [], ok: false
    })
    renderScreen(<PayablesScreen />)
    await waitFor(() => expect(bodyRows('payables-plan')).toHaveLength(3))
    fireEvent.click(screen.getByTestId('btn-payables-plan-mode'))
    fireEvent.click(await screen.findByTestId('pick-payables-8-PS-1'))
    fireEvent.change(screen.getByTestId('input-payables-bank'), { target: { value: '31' } })
    fireEvent.click(screen.getByTestId('btn-payables-create'))
    expect((await screen.findByTestId('payables-run-error')).textContent).toContain('not open')
    expect(screen.getByTestId('payables-preview-blocked')).toBeTruthy()
    expect((screen.getByTestId('btn-payables-post-run') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('Payables → MSME', () => {
  const report: MsmeReport = {
    asOn: '2026-10-07',
    rows: [{
      key: '7|101|MC-1', ledgerId: 7, partyName: 'Micro Castings', category: 'micro', udyamNo: 'UDYAM-MH-33-0012345', pan: 'AAAPM1234C', voucherId: 101,
      number: 'MC-1', supplierRef: null, date: '2026-09-01', amount: 1_000_000, pending: 1_000_000,
      s15: { payBy: '2026-09-16', interestFrom: '2026-09-17', days: 15, basis: 'no_agreement' }, bucket: 'late_1_30', daysLate: 21, ageDays: 36,
      interest: { paise: 9_876, rateBp: 1725, months: 0, days: 21 }
    }],
    buckets: { within: 0, late_1_30: 1_000_000, late_31_60: 0, late_61_plus: 0 },
    totalPending: 1_000_000, totalInterest: 9_876,
    bankRate: { fromDate: '2026-10-07', rateBp: 575, source: 'RBI' }, s16RateBp: 1725,
    disallowance: { fyStartYear: 2026, fyEnd: '2027-03-31', disallowed: 0, atRisk: 0, bills: [], carriedFromEarlier: { bills: 0, amount: 0 } },
    form1: {
      period: { label: 'Apr–Sep 2026', from: '2026-04-01', to: '2026-09-30', dueDate: '2026-10-31', half: 'H1' },
      rows: [], total: 0, mustFile: false,
      suppliers: [{ ledgerId: 7, partyName: 'Micro Castings', pan: 'AAAPM1234C', udyamNo: null, paidWithin45: { count: 2, amount: 300_000 }, paidAfter45: { count: 0, amount: 0 }, debitNotes: { count: 0, amount: 0 }, outstandingUpTo45: 1_000_000, outstandingOver45: 0 }]
    },
    gaps: [{ ledgerId: 9, name: 'Unclassified MSME', issue: 'No Udyam registration number' }]
  }

  it('shows dues against the s.15 deadline with interest, data gaps, and Form 1 per supplier; exports the CSV', async () => {
    handlers['payables:msmeReport'] = () => report
    handlers['payables:msmeForm1Csv'] = () => ({ path: '/x/msme-form-1.csv', rows: 1 })
    handlers['payables:bankRates'] = () => [{ id: 1, fromDate: '2026-10-07', rateBp: 575, source: 'RBI press release' }]
    renderScreen(<PayablesScreen tab="msme" />)
    await waitFor(() => expect(bodyRows('msme-dues')).toHaveLength(1))
    expect(bodyRows('msme-dues')[0]!.textContent).toContain('1–30 days late')
    expect(screen.getByTestId('msme-tile-interest').textContent).toContain('17.25 %')
    expect(screen.getByTestId('msme-gaps').textContent).toContain('Unclassified MSME')
    expect(calls('payables:msmeReport')[0]).toMatchObject({ asOn: '2026-10-07', fyStartYear: 2026, formPeriodDate: '2026-04-01' })
    fireEvent.click(screen.getByTestId('msme-view-form1'))
    await waitFor(() => expect(bodyRows('msme-form1')).toHaveLength(1))
    expect(bodyRows('msme-form1')[0]!.textContent).toContain('AAAPM1234C')
    fireEvent.click(screen.getByTestId('btn-msme-form1-csv'))
    await waitFor(() => expect(calls('payables:msmeForm1Csv')).toHaveLength(1))
  })
})

describe('Payables → Batch payments', () => {
  it('posts one row per supplier through the run preview', async () => {
    handlers['payables:previewRun'] = (p): PaymentRunPreview => {
      const items = (p as { items: { partyLedgerId: number; amount: number }[] }).items
      return {
        lines: items.map((i) => ({ partyLedgerId: i.partyLedgerId, partyName: 'Micro Castings', bankLedgerId: 31, bankName: 'HDFC Current', amount: i.amount, tds: null, bankAmount: i.amount, bills: [], onAccount: 0, instrumentNo: '778899', errors: [] })),
        totals: { amount: 250_000, tds: 0, bank: 250_000, vouchers: 1 }, banks: [], ok: true
      }
    }
    renderScreen(<PayablesScreen tab="batch" />)
    const input = (await screen.findByTestId('picker-payables-batch-supplier-0')) as HTMLInputElement
    await waitFor(() => {
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: 'Micro' } })
      expect(screen.getAllByRole('option').some((o) => o.textContent?.includes('Micro Castings'))).toBe(true)
    })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(input.value).toBe('Micro Castings'))
    fireEvent.change(screen.getByTestId('input-payables-batch-amount-0'), { target: { value: '2500' } })
    fireEvent.change(screen.getByTestId('input-payables-batch-instrument-0'), { target: { value: '778899' } })
    await waitFor(() => expect(screen.getByTestId('payables-batch-total').textContent).toBe('2,500.00'))
    fireEvent.click(screen.getByTestId('btn-payables-batch-preview'))
    await screen.findByTestId('rows-payables-run-preview')
    expect(calls('payables:previewRun')[0]).toMatchObject({
      kind: 'batch', items: [{ partyLedgerId: 7, bankLedgerId: 31, amount: 250_000, bills: [], instrumentNo: '778899' }]
    })
  })
})

describe('ledger form: supplier MSME and payment terms', () => {
  const SUPPLIER: Ledger = {
    id: 42, name: 'Micro Castings', groupId: 2, openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null,
    tdsSectionId: null, pan: null, creditDays: 60, exportType: null, rcm: false, itcEligibility: 'eligible', priceLevelId: null, creditLimit: null,
    deducteeType: null, tdsPayableSectionId: null, tdsDefaultSectionId: null, isSystem: false
  }
  it('shows the MSME fields for a creditor and saves them', async () => {
    handlers['tds:sections'] = () => []
    handlers['master:ledgers:list'] = () => [SUPPLIER]
    handlers['master:ledgers:update'] = (p) => ({ ...SUPPLIER, ...(p as { data: Partial<Ledger> }).data })
    const onClose = vi.fn()
    renderScreen(<LedgerFormModal ledger={SUPPLIER} onClose={onClose} />)
    fireEvent.click(await screen.findByTestId('ledger-msme-registered'))
    fireEvent.change(screen.getByTestId('ledger-msme-category'), { target: { value: 'micro' } })
    fireEvent.change(screen.getByTestId('ledger-udyam-no'), { target: { value: 'udyam-mh-33-0012345' } })
    fireEvent.change(screen.getByTestId('ledger-agreed-days'), { target: { value: '30' } })
    fireEvent.change(screen.getByTestId('ledger-discount-pct'), { target: { value: '2' } })
    fireEvent.change(screen.getByTestId('ledger-discount-days'), { target: { value: '10' } })
    fireEvent.click(screen.getByTestId('btn-ledger-save'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect((calls('master:ledgers:update')[0] as { data: Record<string, unknown> }).data).toMatchObject({
      msmeRegistered: true, msmeCategory: 'micro', udyamNo: 'UDYAM-MH-33-0012345', agreedCreditDays: 30, earlyPaymentDiscountBp: 200, earlyPaymentDiscountDays: 10
    })
  })
  it('helpers: blank terms, a bad Udyam number', () => {
    expect(supplierTermsPayload(initialSupplierTerms(null))).toEqual({
      msmeRegistered: false, msmeRegisteredFrom: null, udyamNo: null, msmeCategory: null, agreedCreditDays: null, earlyPaymentDiscountBp: null, earlyPaymentDiscountDays: null
    })
    expect(supplierTermsError({ ...initialSupplierTerms(null), udyamNo: 'UDYAM-12' })).toMatch(/UDYAM-XX-00-0000000/)
  })
})

describe('dashboard: MSME due this week', () => {
  it('shows the amounts and opens the MSME tab', async () => {
    handlers['payables:msmeDue'] = () => ({ asOn: '2026-10-07', dueThisWeek: 70_000, dueThisWeekBills: 1, overdue: 1_000_000, overdueBills: 1 })
    renderScreen(<MsmeDueLine />)
    const line = await screen.findByTestId('dash-msme-due')
    expect(line.textContent).toMatch(/MSME due this week/)
    expect(line.textContent).toMatch(/late/)
    fireEvent.click(line)
    await waitFor(() => expect(useNav.getState().stack.at(-1)).toEqual({ name: 'payables', tab: 'msme' }))
  })
  it('stays out of the way when nothing is due', async () => {
    handlers['payables:msmeDue'] = () => ({ asOn: '2026-10-07', dueThisWeek: 0, dueThisWeekBills: 0, overdue: 0, overdueBills: 0 })
    renderScreen(<MsmeDueLine />)
    await waitFor(() => expect(calls('payables:msmeDue')).toHaveLength(1))
    expect(screen.queryByTestId('dash-msme-due')).toBeNull()
  })
})
