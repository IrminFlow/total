// WP 3.7 — payroll statutory screens: the Statutory tab (dues with status, Pay… books a payment
// with the right payload, exports per due, Form 16 data), the rates tab (citations shown,
// verified / unverified), the declarations editor (saves one FY), the pay-run preview's TDS and
// employer share with the workings, and Form 24Q on the TDS Returns tab.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Employee, PayrollLine } from '@shared/domain'
import type { Form16Data, Form24qData, StatutoryDueRow, StatutoryRate } from '@shared/payrollStatutoryTypes'
import { useNav, useSession } from '../state/stores'
import { PayrollScreen } from '../screens/Payroll'
import { Form24qPanel } from '../screens/tds/Form24qPanel'

const invoke = vi.fn()
let handlers: Record<string, (payload: unknown) => unknown> = {}
const calls = (channel: string): unknown[] => invoke.mock.calls.filter((c) => c[0] === channel).map((c) => c[1])

function renderScreen(ui: React.JSX.Element): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}
const bodyRows = (area: string): HTMLElement[] =>
  Array.from(screen.getByTestId(`rows-${area}`).querySelectorAll<HTMLElement>('tr.dt-row'))

const emp: Employee = {
  id: 1, name: 'Anil Mehta', code: 'E1', designation: 'Manager', joined: null, pan: 'ABCPM1234K', uan: '100100100100', esicNo: null,
  basic: 75_000_00, hra: 30_000_00, special: 45_000_00, pfEnabled: true, esiEnabled: true, ptEnabled: true, ptState: 'MH', active: true,
  pfNumber: null, gender: 'male', dob: null, taxRegime: 'new', vpfRateBp: 0, pfOnFullWage: false, epsEligible: true, disabled: false, metro: false, tdsEnabled: true
}

const due = (over: Partial<StatutoryDueRow>): StatutoryDueRow => ({
  key: 'pf:2026-07', kind: 'pf', period: '2026-07', state: null, runId: 5, voucherId: 50, employees: 2,
  employeePaise: 3_480_00, employerPaise: 4_125_00, payablePaise: 7_605_00, paidPaise: 0, outstandingPaise: 7_605_00,
  dueDate: '2026-08-15', status: 'overdue', ledgerId: 9, ...over
})

beforeEach(() => {
  localStorage.clear()
  handlers = {
    'payroll:employees:list': () => [emp],
    'payroll:runs': () => [],
    'payroll:preview': () => [],
    'master:ledgers:list': () => [{ id: 31, name: 'HDFC Current', groupId: 3 }],
    'master:groups:list': () => [{ id: 3, name: 'Bank Accounts', parentId: null, nature: 'asset', affectsGrossProfit: false, isSystem: true }]
  }
  invoke.mockReset()
  invoke.mockImplementation(async (channel: string, payload?: unknown) => {
    const h = handlers[channel]
    if (!h) return { ok: false, error: `unmocked channel ${channel}` }
    return { ok: true, data: h(payload) }
  })
  window.total = { platform: 'test', invoke }
  act(() => {
    useSession.setState({ slug: 'pay-co', from: '2026-04-01', to: '2027-03-31' })
    useNav.setState({ stack: [{ name: 'payroll' }] })
  })
})
afterEach(() => cleanup())

describe('Statutory tab', () => {
  beforeEach(() => {
    handlers['payroll:dues'] = () => [
      due({}),
      due({ key: 'pt:2026-07:MH', kind: 'pt', state: 'MH', employeePaise: 400_00, employerPaise: 0, payablePaise: 400_00, outstandingPaise: 0, paidPaise: 400_00, status: 'paid', dueDate: '2026-08-31' }),
      due({ key: 'tds:2026-07', kind: 'tds', employees: 1, employeePaise: 8_233_00, employerPaise: 0, payablePaise: 8_233_00, outstandingPaise: 8_233_00, dueDate: '2026-08-07' })
    ]
    handlers['payroll:payments:list'] = () => []
    handlers['payroll:form16'] = (): Form16Data => ({ deductor: { name: 'Co', address: '', pan: null, tan: null }, fyStartYear: 2026, yearLabel: '2026-27', act: '2025', formName: 'Form No. 130', employees: [] })
    handlers['payroll:payments:record'] = () => ({ id: 1 })
    handlers['payroll:ecr'] = () => ({ path: '/x/pf-ecr-2026-07.txt' })
  })

  it('lists dues with status badges and totals; Pay… posts the payment payload; ECR exports the run', async () => {
    renderScreen(<PayrollScreen />)
    fireEvent.click(await screen.findByTestId('tab-payroll-statutory'))
    await waitFor(() => expect(bodyRows('payroll-dues')).toHaveLength(3))
    expect(screen.getByTestId('due-status-pf:2026-07').textContent).toBe('Overdue')
    expect(screen.getByTestId('due-status-pt:2026-07:MH').textContent).toBe('Paid')
    expect(document.getElementById('payroll-due-pf-value')!.textContent).toContain('7,605.00')
    expect(screen.getByText(/Data for Form No\. 130/)).toBeTruthy()

    fireEvent.click(screen.getByTestId('btn-due-export-pf:2026-07'))
    await waitFor(() => expect(calls('payroll:ecr')).toEqual([{ runId: 5 }]))

    fireEvent.click(screen.getByTestId('btn-due-pay-tds:2026-07'))
    fireEvent.change(await screen.findByTestId('input-due-bsr'), { target: { value: '0510308' } })
    fireEvent.change(screen.getByTestId('input-due-challan'), { target: { value: '00042' } })
    await waitFor(() => expect((screen.getByTestId('input-due-bank') as HTMLSelectElement).value).toBe('31'))
    fireEvent.click(screen.getByTestId('btn-due-save'))
    await waitFor(() => expect(calls('payroll:payments:record')).toHaveLength(1))
    expect(calls('payroll:payments:record')[0]).toMatchObject({
      kind: 'tds', period: '2026-07', state: null, amountPaise: 8_233_00, bankLedgerId: 31, bsrCode: '0510308', challanNo: '00042'
    })
  })

  it('the gratuity helper computes 15/26 × wages × years', async () => {
    renderScreen(<PayrollScreen />)
    fireEvent.click(await screen.findByTestId('tab-payroll-statutory'))
    // Defaults: ₹30,000 × 15 / 26 × 7 years = ₹1,21,153.85 → ₹1,21,154.
    expect((await screen.findByTestId('gratuity-result')).textContent).toContain('1,21,154.00')
  })
})

describe('Statutory rates tab', () => {
  it('shows each row with its citation and a verified / unverified badge', async () => {
    const rows: StatutoryRate[] = [
      { id: 1, kind: 'epf', state: null, effectiveFrom: '2026-09-17', effectiveTo: null, rateBp: 1200, ceilingPaise: 25_000_00, thresholdPaise: null, minPaise: null, slabFromPaise: null, slabToPaise: null, amountPaise: null, basis: 'month', gender: 'any', variant: 'standard', specialMonth: null, specialAmountPaise: null, source: 'S.O. 5109(E) [SO5109]; accessed 2026-10-07', verified: true, isSeeded: true },
      { id: 2, kind: 'pt', state: 'MH', effectiveFrom: '2023-04-01', effectiveTo: null, rateBp: null, ceilingPaise: null, thresholdPaise: null, minPaise: null, slabFromPaise: 10_001_00, slabToPaise: null, amountPaise: 200_00, basis: 'month', gender: 'any', variant: 'standard', specialMonth: 2, specialAmountPaise: 300_00, source: 'MH PT Act 1975 Sch. I [PT-MH]', verified: false, isSeeded: true }
    ]
    handlers['payroll:rates:list'] = () => rows
    renderScreen(<PayrollScreen />)
    fireEvent.click(await screen.findByTestId('tab-payroll-rates'))
    await waitFor(() => expect(bodyRows('payroll-rates')).toHaveLength(2))
    const [epf, pt] = bodyRows('payroll-rates')
    expect(epf!.textContent).toContain('12%')
    expect(epf!.textContent).toContain('ceiling ₹25,000.00')
    expect(epf!.textContent).toContain('S.O. 5109(E)')
    expect(within(epf!).getByText('Verified')).toBeTruthy()
    expect(pt!.textContent).toContain('₹200.00 / month (Feb ₹300.00)')
    expect(within(pt!).getByText('Unverified')).toBeTruthy()
  })
})

describe('declarations and the pay-run preview', () => {
  it('saves the declarations for the chosen FY', async () => {
    handlers['payroll:declarations:get'] = () => [{ section: '80C', label: '80C', amountPaise: 50_000_00, proofReceived: false }]
    handlers['payroll:declarations:set'] = () => []
    renderScreen(<PayrollScreen />)
    await waitFor(() => expect(bodyRows('payroll-employees')).toHaveLength(1))
    fireEvent.click(screen.getByTestId('btn-payroll-declarations'))
    const rent = await screen.findByTestId('input-decl-RENT')
    fireEvent.change(rent, { target: { value: '2,40,000' } })
    fireEvent.click(screen.getByTestId('btn-payroll-save-declarations'))
    await waitFor(() => expect(calls('payroll:declarations:set')).toHaveLength(1))
    const sent = calls('payroll:declarations:set')[0] as { employeeId: number; rows: { section: string; amountPaise: number }[] }
    expect(sent.employeeId).toBe(1)
    expect(sent.rows).toEqual([
      { section: '80C', amountPaise: 50_000_00, proofReceived: false },
      { section: 'RENT', amountPaise: 2_40_000_00, proofReceived: false }
    ])
  })

  it('preview shows TDS and the employer share; the TDS figure opens its workings', async () => {
    const line: Omit<PayrollLine, 'id'> = {
      employeeId: 1, employeeName: 'Anil Mehta', payableDays: 31, monthDays: 31, basic: 75_000_00, hra: 30_000_00, special: 45_000_00,
      otherEarnings: 0, otherDeductions: 0, gross: 1_50_000_00, pfEmp: 1_800_00, pfEr: 1_800_00, epsEr: 1_250_00, pfAdmin: 75_00, edli: 75_00,
      esiEmp: 0, esiEr: 0, pt: 200_00, net: 1_39_767_00, headAmounts: [], vpf: 0, epfWage: 15_000_00, epsWage: 15_000_00, edliWage: 15_000_00,
      esiCovered: false, esiWage: 0, tds: 8_233_00,
      tdsWorkings: { regime: 'new', act: '2025', gross: 13_50_000_00, hraExemption: 0, standardDeduction: 75_000_00, professionalTax: 0, otherIncome: 0, housePropertyLoss: 0, deductionsTotal: 0, totalIncome: 12_75_000_00, annualTax: 74_100_00, previousEmployerTds: 0, deductedBefore: 0, monthsRemaining: 9 }
    }
    handlers['payroll:preview'] = () => [line]
    renderScreen(<PayrollScreen />)
    fireEvent.click(await screen.findByTestId('tab-payroll-runs'))
    const btn = await screen.findByTestId('btn-payroll-tds-workings')
    expect(btn.textContent).toContain('8,233.00')
    const row = screen.getByTestId('rows-payroll-preview').querySelector('tr[data-row-id="1"]')!
    expect(row.textContent).toContain('1,950.00') // employer PF 1,800 + admin 75 + EDLI 75
    fireEvent.click(btn)
    const w = await screen.findByTestId('payroll-tds-workings')
    expect(w.textContent).toContain('74,100.00')
    expect(w.textContent).toContain('Income-tax Act 2025 · s.392')
  })
})

describe('Form 24Q panel', () => {
  it('lists salary TDS rows with the return section code and exports the CSV', async () => {
    const data: Form24qData = {
      fyStartYear: 2026, quarter: 2, layout: 'form138',
      deductees: [{ serial: 1, entryId: 3, voucherId: 50, employeeId: 1, employeeName: 'Anil Mehta', pan: 'ABCPM1234K', sectionCode: '1002', paymentDate: '2026-07-31', amountPaise: 1_50_000_00, tdsPaise: 8_233_00, deductionDate: '2026-07-31', challanSerial: null, bsrCode: null, challanDate: null, challanNo: null }],
      challans: [], salaries: [], totals: { amountPaise: 1_50_000_00, tdsPaise: 8_233_00, depositedPaise: 0 }
    }
    handlers['tds:form24q'] = () => data
    handlers['tds:form24qCsv'] = () => ({ path: '/x/form24q-data-2026-Q2.csv' })
    renderScreen(<Form24qPanel fyStartYear={2026} quarter={2} label="Q2 FY2026-27" />)
    await waitFor(() => expect(bodyRows('tds-24q')).toHaveLength(1))
    expect(bodyRows('tds-24q')[0]!.textContent).toContain('1002')
    expect(screen.getByTestId('tds-24q-layout').textContent).toContain('Form 138')
    fireEvent.click(screen.getByTestId('btn-tds-24q-export'))
    await waitFor(() => expect(calls('tds:form24qCsv')).toEqual([{ fyStartYear: 2026, quarter: 2 }]))
  })
})
