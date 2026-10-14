// WP 9.9 — the simple Taxes screen: three separate GST figures with their "Why?", the dates, the
// five steps (missing bills, GSTR-2B, prepare the files through the existing exports, the
// portal's steps, "I've filed" with errors under ARN / date), the period picker, a quarterly
// filer's note, unregistered / composition, TDS when on, a viewer who can't note a filing. No
// banned word ("ITC", "set-off" …) anywhere on it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { CompanyInfo } from '@shared/domain'
import type { SimpleTaxes } from '@shared/simple/taxes'
import { bannedWordsIn } from '@shared/simple/bannedWords'
import { useNav, useSession } from '../state/stores'
import { useExplain } from '../lib/explain'
import { TaxesScreen } from '../simple/taxes/TaxesScreen'

const invoke = vi.fn()
const info: CompanyInfo = { name: 'Mehta Traders', stateCode: '27', gstin: '27AAACT1234A1Z5', gstRegistrationType: 'regular', address: '', booksFrom: 2026, email: null, phone: null, pan: null, tan: null }
type Regular = Extract<SimpleTaxes, { kind: 'regular' }>
const SEP = { period: '2026-09', from: '2026-09-01', to: '2026-09-30', quarterly: false, soFar: false }
const REGULAR: Regular = {
  kind: 'regular', today: '2026-10-13', filing: 'monthly', period: SEP,
  periods: [{ period: '2026-10', from: '2026-10-01', to: '2026-10-13', quarterly: false, soFar: true }, SEP, { period: '2026-08', from: '2026-08-01', to: '2026-08-31', quarterly: false, soFar: false }],
  figures: { collected: 18_000_00, reverseCharge: 0, onPurchases: 10_800_00, awaiting: 1_200_00, checked: 'all', toPay: 7_200_00, cashOnSales: 7_200_00, rcmCash: 0, creditUsed: 10_800_00, creditLeft: 0 },
  due: { gstr1: '2026-10-11', gstr3b: '2026-10-20', gstr3bUnverified: false, pmt06: [] },
  missing: [{ key: 'unbilled_goods', count: 2 }],
  supplierBills: [{ month: '2026-09', imported: true, matched: 4, categories: [{ category: 'missing_in_2b', count: 1, tax: 1_200_00 }] }],
  prepared: { gstr1: null, gstr3b: null }, filesMonthly: false, filed: {}, withholding: []
}
let reply: SimpleTaxes
let filedReply: () => { ok: boolean; data?: unknown; error?: string; code?: string; field?: string }
const calls = (ch: string): unknown[] => invoke.mock.calls.filter(([c]) => c === ch).map(([, p]) => p)
const lastScreen = (): unknown => useNav.getState().stack.at(-1)
const visibleText = (): string => document.body.textContent ?? ''

function renderUi(ui: React.ReactNode): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

beforeEach(() => {
  reply = REGULAR
  filedReply = () => ({ ok: true, data: { gstr1: { arn: 'AA270926123456X', date: '2026-10-11', by: null, at: '' } } })
  invoke.mockImplementation(async (channel: string) => {
    switch (channel) {
      case 'simple:taxes': return { ok: true, data: reply }
      case 'simple:taxes:filed': return filedReply()
      case 'gst:exportGstr1': return { ok: true, data: { jsonPath: '/x/gstr1.json', csvPath: '/x/gstr1.csv' } }
      case 'gst:exportGstr3b': return { ok: false, error: 'Fix 1 blocking issue first', code: 'validation' }
      default: return { ok: true, data: [] }
    }
  })
  window.total = { platform: 'test', invoke }
  act(() => {
    useSession.setState({ info, slug: 'mehta', ui: { mode: 'simple' }, workingDate: '2026-10-13', from: '2026-04-01', to: '2027-03-31', user: null })
    useNav.setState({ stack: [{ name: 'simple-taxes' }] })
    useExplain.setState({ ready: false, handler: null })
  })
})
afterEach(() => {
  cleanup()
  invoke.mockReset()
})

describe('Taxes — regular GST (WP 9.9)', () => {
  it('three separate figures with their "Why?", the dates, no banned word', async () => {
    renderUi(<TaxesScreen />)
    expect((await screen.findByTestId('tile-gst-collected')).getAttribute('data-paise')).toBe(String(18_000_00))
    expect(screen.getByTestId('tile-gst-purchases-sub').textContent).toBe('of which ₹1,200.00 awaits confirmation in GSTR-2B')
    expect(screen.getByTestId('tile-gst-to-pay-value').textContent).toBe('₹7,200.00')
    expect(screen.getByTestId('tile-gst-to-pay-sub').textContent).toBe('by 20 Oct')
    // Today is 13 Oct: the 11th has gone by (and GSTR-1 is not noted as filed), the 20th not yet.
    expect(screen.getByTestId('taxes-due-gstr1').textContent).toBe('GSTR-1 (the list of your sales bills): by 11 Oct 2026— this date has passed; file it as soon as you can')
    expect(screen.getByTestId('taxes-due-gstr3b').textContent).toBe('GSTR-3B (the summary, with the payment): by 20 Oct 2026')
    expect(screen.queryByTestId('taxes-due-gstr3b-passed')).toBeNull()
    fireEvent.click(screen.getByTestId('why-gst-to-pay'))
    expect((await screen.findByTestId('why-gst-to-pay-sentence')).textContent).toContain('₹10,800.00 is covered by the GST on your purchases, so ₹7,200.00 is left — to pay by 20 Oct')
    expect(bannedWordsIn(visibleText())).toEqual([])
    fireEvent.click(screen.getByTestId('taxes-accountant-view'))
    await waitFor(() => expect(lastScreen()).toEqual({ name: 'gstr3b', month: '2026-09' }))
  })

  it('a passed date says so until that return is noted as filed', async () => {
    reply = { ...REGULAR, today: '2026-10-25', filed: { gstr1: { arn: 'AA270926123456X', date: '2026-10-11', by: null, at: '' } } }
    renderUi(<TaxesScreen />)
    expect(await screen.findByTestId('taxes-due-gstr3b-passed')).toBeTruthy()
    expect(screen.queryByTestId('taxes-due-gstr1-passed')).toBeNull()
    expect(bannedWordsIn(visibleText())).toEqual([])
  })

  it('"not checked yet" when no GSTR-2B is imported', async () => {
    reply = { ...REGULAR, figures: { ...REGULAR.figures, checked: 'none', awaiting: 0 }, supplierBills: [{ month: '2026-09', imported: false, matched: 0, categories: [] }] }
    renderUi(<TaxesScreen />)
    expect((await screen.findByTestId('tile-gst-purchases-sub')).textContent).toBe('not checked against GSTR-2B yet')
    expect(screen.getByTestId('taxes-2b-2026-09').textContent).toContain('GSTR-2B not imported yet')
    fireEvent.click(screen.getByTestId('taxes-2b-import'))
    await waitFor(() => expect(lastScreen()).toEqual({ name: 'gstr2b' }))
  })

  it('the steps: missing bills, supplier bills, prepare (existing exports; a refusal shows plain words + Details), the portal, I’ve filed', async () => {
    renderUi(<TaxesScreen />)
    expect((await screen.findByTestId('taxes-missing-unbilled_goods')).textContent).toBe('2 deliveries or goods receipts have no bill yet')
    expect(screen.getByTestId('taxes-2b-2026-09').textContent).toContain('1 difference with GSTR-2B')
    expect(screen.getByTestId('taxes-2b-2026-09').textContent).toContain('In your books but not on the portal yet: 1 bill, GST ₹1,200.00')
    expect(screen.getByTestId('taxes-steps-progress').textContent).toBe('0 of 5 done')

    fireEvent.click(screen.getByTestId('taxes-prepare-gstr1'))
    await waitFor(() => expect(calls('gst:exportGstr1')).toEqual([{ from: '2026-09-01', to: '2026-09-30', period: '092026' }]))
    fireEvent.click(screen.getByTestId('taxes-prepare-gstr3b'))
    expect((await screen.findByTestId('taxes-prepare-error')).textContent).toContain('The file could not be prepared.')
    expect(screen.getByTestId('taxes-prepare-error').textContent).toContain('Fix 1 blocking issue first')

    // I've filed: a bad ARN → under the ARN field.
    filedReply = () => ({ ok: false, error: 'bad', code: 'gst_filed_arn', field: 'arn' })
    fireEvent.change(screen.getByTestId('taxes-arn-gstr1'), { target: { value: '12' } })
    fireEvent.click(screen.getByTestId('taxes-filed-save-gstr1'))
    expect((await screen.findByTestId('field-error-arn')).textContent).toContain('acknowledgement number (ARN)')
    filedReply = () => ({ ok: true, data: {} })
    fireEvent.change(screen.getByTestId('taxes-arn-gstr1'), { target: { value: 'AA270926123456X' } })
    fireEvent.click(screen.getByTestId('taxes-filed-save-gstr1'))
    await waitFor(() => expect(calls('simple:taxes:filed').at(-1)).toEqual({ period: '2026-09', form: 'gstr1', arn: 'AA270926123456X', date: '2026-10-13' }))
    expect(bannedWordsIn(visibleText())).toEqual([])
  })

  it('a filed return shows its ARN; the period picker opens another period; a running period says it is not over', async () => {
    reply = { ...REGULAR, filed: { gstr3b: { arn: 'AA270926123456X', date: '2026-10-19', by: 'Asha', at: '2026-10-19T10:00:00Z' } } }
    renderUi(<TaxesScreen />)
    expect((await screen.findByTestId('taxes-filed-gstr3b')).textContent).toContain('Filed on 19 Oct 2026 — ARN AA270926123456X.')
    fireEvent.change(screen.getByTestId('taxes-period'), { target: { value: '2026-08' } })
    await waitFor(() => expect(lastScreen()).toEqual({ name: 'simple-taxes', period: '2026-08' }))
    cleanup()
    reply = { ...REGULAR, period: REGULAR.periods[0]! }
    renderUi(<TaxesScreen period="2026-10" />)
    expect((await screen.findByTestId('taxes-filed-not-over')).textContent).toBe('You can note the filing once the period is over.')
    expect(screen.getByTestId('taxes-files-wait')).toBeTruthy()
    expect(screen.getByTestId('taxes-so-far').textContent).toContain('still running')
    expect(calls('simple:taxes').at(-1)).toMatchObject({ period: '2026-10' })
  })

  it('a quarterly filer: the quarter, PMT-06 dates, files month by month in the full app', async () => {
    const q = { period: '2026-09', from: '2026-07-01', to: '2026-09-30', quarterly: true, soFar: false }
    reply = { ...REGULAR, filing: 'quarterly', period: q, periods: [q], filesMonthly: true, due: { gstr1: '2026-10-13', gstr3b: '2026-10-22', gstr3bUnverified: false, pmt06: ['2026-08-25', '2026-09-25'] } }
    renderUi(<TaxesScreen />)
    expect((await screen.findByTestId('taxes-filing')).textContent).toBe('You file GST every quarter.')
    expect(screen.getByTestId('taxes-period').textContent).toContain('Jul – Sep 2026')
    expect(screen.getByTestId('taxes-pmt06').textContent).toContain('25 Aug, 25 Sep')
    expect(screen.getByTestId('taxes-files-quarterly')).toBeTruthy()
  })

  it('a viewer sees the steps but can’t note a filing', async () => {
    act(() => useSession.setState({ user: { id: 2, name: 'Vik', role: 'viewer' } as never }))
    renderUi(<TaxesScreen />)
    expect((await screen.findByTestId('taxes-filed-readonly-gstr1')).textContent).toContain('Only an owner or accountant can note a filing.')
    expect(screen.queryByTestId('taxes-arn-gstr1')).toBeNull()
  })
})

describe('Taxes — not regular (WP 9.9)', () => {
  it('unregistered: nothing to file; TDS when on', async () => {
    reply = { kind: 'unregistered', today: '2026-10-13', withholding: [{ kind: 'tds', thisMonth: 300_00, thisMonthDue: '2026-11-07', totalUnpaid: 900_00, lateUnpaid: 600_00, unpaid: [{ month: '2026-09', amount: 600_00, dueDate: '2026-10-07', late: true }, { month: '2026-10', amount: 300_00, dueDate: '2026-11-07', late: false }] }] }
    renderUi(<TaxesScreen />)
    expect((await screen.findByTestId('taxes-unregistered')).textContent).toBe('You are not registered for GST, so there is nothing to file.')
    expect(screen.getByTestId('taxes-tds-this-month').textContent).toBe('TDS you deducted this month: ₹300.00, pay by 7 Nov.')
    expect(screen.getByTestId('taxes-tds').textContent).toContain('Sep 2026: ₹600.00 still to pay, due 7 Oct — late')
    expect(screen.queryByTestId('taxes-figures')).toBeNull()
    expect(bannedWordsIn(visibleText())).toEqual([])
  })

  it('composition: the CMP-08 and GSTR-4 dates, no figures', async () => {
    reply = { kind: 'composition', today: '2026-10-13', withholding: [], composition: { cmp08: { from: '2026-07-01', to: '2026-09-30', due: '2026-10-18' }, gstr4: { fyLabel: '2026-27', due: '2027-06-30' } } }
    renderUi(<TaxesScreen />)
    expect((await screen.findByTestId('taxes-cmp08')).textContent).toBe('CMP-08 — the quarter’s statement and payment (1 Jul 2026 to 30 Sep 2026): by 18 Oct 2026')
    expect(screen.getByTestId('taxes-gstr4').textContent).toBe('GSTR-4 — the yearly return for 2026-27: by 30 Jun 2027')
    expect(screen.queryByTestId('taxes-figures')).toBeNull()
  })
})
