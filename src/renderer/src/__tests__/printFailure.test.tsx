// to-do §4 (shots-86): a failed Print on the simple Sales list / a bill's view said nothing. Now it
// is an error toast in plain words (simple.bill.printFailed), plus the 8.5 mapping's own plain
// message when the refusal has one — never the service's English.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { CompanyInfo } from '@shared/domain'
import type { SaleRow, SaleView } from '@shared/simple/sell'
import { translator } from '@shared/i18n'
import { useNav, useSession, useToasts } from '../state/stores'
import { SalesList } from '../simple/sell/SalesList'
import { printFailureText } from '../simple/printFailure'

const invoke = vi.fn()
const info: CompanyInfo = { name: 'Sharma Kirana', stateCode: '27', gstin: null, gstRegistrationType: 'unregistered', address: '', booksFrom: 2026, email: null, phone: null, pan: null, tan: null }
const ROW: SaleRow = { voucherId: 7, number: '3', date: '2026-10-12', partyId: 10, partyName: 'Ramesh', walkIn: false, total: 118_000, tax: 0, paid: 0, due: 118_000, dueDate: null, overdueDays: 0, returned: 0 }
const VIEW: SaleView = {
  voucherId: 7, number: '3', date: '2026-10-12', partyId: 10, partyName: 'Ramesh', walkIn: false, items: [], amounts: [], note: null,
  total: 118_000, tax: 0, rounding: 0, paid: 0, due: 118_000, dueDate: null, overdueDays: 0, returned: 0
}
let pdfReply: { ok: boolean; data?: unknown; error?: string; code?: string }

function renderUi(ui: React.JSX.Element): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}
const errorToasts = (): string[] => useToasts.getState().toasts.filter((x) => x.kind === 'error').map((x) => x.text)

beforeEach(() => {
  pdfReply = { ok: false, error: 'ENOENT: no such file or directory, open /tmp/x.pdf' }
  invoke.mockImplementation(async (channel: string) => {
    switch (channel) {
      case 'simple:sales': return { ok: true, data: [ROW] }
      case 'simple:sale': return { ok: true, data: VIEW }
      case 'invoice:pdf': return pdfReply
      default: return { ok: true, data: [] }
    }
  })
  window.total = { platform: 'test', invoke }
  act(() => {
    useSession.setState({ info, slug: 'sharma', ui: { mode: 'simple' }, workingDate: '2026-10-13', from: '2026-04-01', to: '2027-03-31' })
    useNav.setState({ stack: [{ name: 'simple-sales' }] })
    useToasts.setState({ toasts: [] })
  })
})
afterEach(() => {
  cleanup()
  invoke.mockReset()
  act(() => useToasts.setState({ toasts: [] }))
})

describe('a failed Print says so (simple Sales)', () => {
  it('the list row’s Print: an error toast in plain words, not the file error', async () => {
    renderUi(<SalesList />)
    fireEvent.click(await screen.findByTestId('btn-sale-print'))
    await waitFor(() => expect(errorToasts()).toEqual(['The bill could not be printed. Try again in a moment.']))
    expect(invoke.mock.calls.filter(([c]) => c === 'invoice:pdf').map(([, p]) => p)).toEqual([{ voucherId: 7 }])
  })

  it('the bill view’s Print: the plain line plus the mapped reason (a bill gone to the bin)', async () => {
    pdfReply = { ok: false, error: 'Voucher 7 not found', code: 'voucher_not_found' }
    renderUi(<SalesList billId={7} />)
    fireEvent.click(await screen.findByTestId('btn-bill-print'))
    const en = translator('en')
    await waitFor(() => expect(errorToasts()).toEqual([`The bill could not be printed. Try again in a moment. ${en('errors.entryMissing')}`]))
  })

  it('a Print that works raises no error', async () => {
    pdfReply = { ok: true, data: { path: '/tmp/3.pdf' } }
    renderUi(<SalesList billId={7} />)
    fireEvent.click(await screen.findByTestId('btn-bill-print'))
    await waitFor(() => expect(invoke.mock.calls.some(([c]) => c === 'invoice:pdf')).toBe(true))
    expect(errorToasts()).toEqual([])
  })

  it('in Hindi and Hinglish too (the statement’s line as well)', () => {
    const err = Object.assign(new Error('boom'), {})
    expect(printFailureText(err, translator('hi'), translator('hi')('simple.bill.printFailed'))).toBe('बिल प्रिंट नहीं हो सका। थोड़ी देर में फिर कोशिश करें।')
    expect(printFailureText(err, translator('hinglish'), translator('hinglish')('simple.people.statementFailed'))).toBe('Statement nahi ban saka. Thodi der mein phir koshish karein.')
  })
})
