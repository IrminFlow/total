// Phase 4 — the GST gateway's screens in test mode: the simple Taxes step 3 "send it to the GST
// portal from here" (sign in with the code → send → check → code → file; a test filing labelled in
// step 5, never as filed), the accountant GSTR panel and the e-documents modal. Every surface says
// "test mode — nothing is sent to the GST portal". No banned word on the simple screen.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { CompanyInfo } from '@shared/domain'
import type { SimpleTaxes } from '@shared/simple/taxes'
import type { GatewayReturnRecord, GatewayStatus } from '@shared/gstGateway'
import { bannedWordsIn } from '@shared/simple/bannedWords'
import { useNav, useSession } from '../state/stores'
import { useExplain } from '../lib/explain'
import { TaxesScreen } from '../simple/taxes/TaxesScreen'
import { GatewayReturnPanel } from '../screens/gst/GatewayPanel'
import { GatewayEdocModal } from '../screens/edocs/GatewayEdoc'

const invoke = vi.fn()
const info: CompanyInfo = { name: 'Mehta Traders', stateCode: '27', gstin: '27AAACT1234A1Z5', gstRegistrationType: 'regular', address: '', booksFrom: 2026, email: null, phone: null, pan: null, tan: null }
type Regular = Extract<SimpleTaxes, { kind: 'regular' }>
const SEP = { period: '2026-09', from: '2026-09-01', to: '2026-09-30', quarterly: false, soFar: false }
const REGULAR: Regular = {
  kind: 'regular', today: '2026-10-13', filing: 'monthly', period: SEP, periods: [SEP],
  figures: { collected: 18_000_00, reverseCharge: 0, onPurchases: 10_800_00, awaiting: 0, checked: 'all', toPay: 7_200_00, cashOnSales: 7_200_00, rcmCash: 0, creditUsed: 10_800_00, creditLeft: 0 },
  due: { gstr1: '2026-10-11', gstr3b: '2026-10-20', gstr3bUnverified: false, pmt06: [] },
  missing: [], supplierBills: [], prepared: { gstr1: null, gstr3b: null }, filesMonthly: false, filed: {}, withholding: []
}
const status = (signedIn: boolean): GatewayStatus => ({
  settings: { provider: 'test-gsp', live: false, username: '' }, testMode: true, liveFilingAvailable: false, providers: [],
  passwordStored: false, signedIn, testHints: { username: 'testgsp', password: 'Test@1234', otp: '575757' }
})
const record = (state: GatewayReturnRecord['state'], extra: Partial<GatewayReturnRecord> = {}): GatewayReturnRecord => ({
  provider: 'test-gsp', test: true, form: 'gstr1', period: '092026', state, referenceId: 'TST1', arn: null, filedOn: null, errors: [], savedAt: null, updatedAt: '', ...extra
})
let signedIn: boolean
let ret: GatewayReturnRecord | null
let taxes: SimpleTaxes
const calls = (ch: string): unknown[] => invoke.mock.calls.filter(([c]) => c === ch).map(([, p]) => p)

function renderUi(ui: React.ReactNode): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

beforeEach(() => {
  signedIn = false
  ret = null
  taxes = REGULAR
  invoke.mockImplementation(async (channel: string, payload: { form?: string }) => {
    switch (channel) {
      case 'simple:taxes': return { ok: true, data: taxes }
      case 'gateway:status': return { ok: true, data: status(signedIn) }
      case 'gateway:otp:request': return { ok: true, data: { sent: true } }
      case 'gateway:signIn': signedIn = true; return { ok: true, data: { signedIn: true, expiresAt: 0 } }
      case 'gateway:return:get': return { ok: true, data: payload.form === 'gstr1' ? ret : null }
      case 'gateway:return:save': ret = record('saved'); return { ok: true, data: ret }
      case 'gateway:return:status': ret = record(ret?.state === 'saved' ? 'processing' : 'processed'); return { ok: true, data: ret }
      case 'gateway:return:file': ret = record('filed', { arn: 'AA270926123456X', filedOn: '2026-10-13' }); return { ok: true, data: ret }
      case 'gateway:edoc:record': return { ok: true, data: { test: true, record: { irn: null, irnLive: false, ewbNo: null, cancelEwb: { allowed: false }, cancelIrn: { allowed: false } } } }
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

describe('simple Taxes step 3 — send it to the GST portal (test mode)', () => {
  it('says test mode, signs in with the code, sends, checks, files; the filing is labelled as a test; no banned word', async () => {
    renderUi(<TaxesScreen />)
    expect((await screen.findByTestId('taxes-portal-test-note')).textContent).toContain('nothing is sent to the GST portal')
    fireEvent.click(screen.getByTestId('taxes-portal-signin'))
    fireEvent.change(await screen.findByTestId('taxes-portal-signin-otp'), { target: { value: '575757' } })
    expect(screen.getByText('Test code: 575757')).toBeTruthy()
    // A code that failed or ran out: a new one can always be asked for.
    fireEvent.click(screen.getByTestId('taxes-portal-signin-resend'))
    await waitFor(() => expect(calls('gateway:otp:request')).toEqual([{ purpose: 'signin' }, { purpose: 'signin' }]))
    fireEvent.change(screen.getByTestId('taxes-portal-signin-otp'), { target: { value: '575757' } })
    fireEvent.click(screen.getByTestId('taxes-portal-signin-submit'))
    await waitFor(() => expect(calls('gateway:signIn')).toEqual([{ otp: '575757' }]))
    fireEvent.click(await screen.findByTestId('taxes-portal-gstr1-send'))
    await waitFor(() => expect(calls('gateway:return:save')).toEqual([{ form: 'gstr1', period: '092026' }]))
    expect((await screen.findByTestId('taxes-portal-gstr1-state')).textContent).toBe('GSTR-1: sent, waiting for the portal · test mode, nothing real')
    fireEvent.click(await screen.findByTestId('taxes-portal-gstr1-check'))
    fireEvent.click(await screen.findByTestId('taxes-portal-gstr1-check'))
    fireEvent.click(await screen.findByTestId('taxes-portal-gstr1-code'))
    await waitFor(() => expect(calls('gateway:otp:request')).toContainEqual({ purpose: 'evc', form: 'gstr1', period: '092026' }))
    fireEvent.change(await screen.findByTestId('taxes-portal-gstr1-file-otp'), { target: { value: '575757' } })
    fireEvent.click(screen.getByTestId('taxes-portal-gstr1-file-submit'))
    expect((await screen.findByTestId('taxes-portal-gstr1-filed')).textContent).toBe(
      'GSTR-1 filed in test mode — acknowledgement AA270926123456X. Nothing reached the GST portal, so it does not count as filed.'
    )
    expect(bannedWordsIn(document.body.textContent ?? '')).toEqual([])
  })

  it('a test filing is shown in step 5 only as a test (the "I\'ve filed" form stays empty)', async () => {
    taxes = { ...REGULAR, testFiled: { gstr1: { arn: 'AA270926123456X', date: '2026-10-13', by: null, at: '', via: { provider: 'test-gsp', test: true } } } }
    renderUi(<TaxesScreen />)
    expect((await screen.findByTestId('taxes-test-filed-gstr1')).textContent).toBe('GSTR-1 · Test filing only (not on the portal): AA270926123456X')
    expect(screen.queryByTestId('taxes-test-filed-gstr3b')).toBeNull()
  })

  it('a quarterly filer is told it is not ready yet (no sign-in offered)', async () => {
    taxes = { ...REGULAR, filing: 'quarterly', period: { ...SEP, quarterly: true } }
    renderUi(<TaxesScreen />)
    expect(await screen.findByTestId('taxes-portal-quarterly')).toBeTruthy()
    expect(screen.queryByTestId('taxes-portal-signin')).toBeNull()
  })
})

describe('accountant screens', () => {
  it('the GSTR panel says test mode and walks sign-in → send → check → file → ARN labelled as a test', async () => {
    act(() => useSession.setState({ ui: { mode: 'accountant' } }))
    renderUi(<GatewayReturnPanel form="gstr1" period="092026" blocked={null} />)
    expect((await screen.findByTestId('gw-gstr1-test-note')).textContent).toContain('nothing is sent to the GST portal')
    fireEvent.click(screen.getByTestId('gw-gstr1-signin'))
    fireEvent.change(await screen.findByTestId('gw-gstr1-signin-otp'), { target: { value: '575757' } })
    fireEvent.click(screen.getByTestId('gw-gstr1-signin-submit'))
    fireEvent.click(await screen.findByTestId('gw-gstr1-send'))
    fireEvent.click(await screen.findByTestId('gw-gstr1-check'))
    fireEvent.click(await screen.findByTestId('gw-gstr1-check'))
    fireEvent.click(await screen.findByTestId('gw-gstr1-evc'))
    fireEvent.change(await screen.findByTestId('gw-gstr1-file-otp'), { target: { value: '575757' } })
    fireEvent.click(screen.getByTestId('gw-gstr1-file-submit'))
    expect((await screen.findByTestId('gw-gstr1-arn')).textContent).toBe('AA270926123456X')
    expect(screen.getByTestId('gw-gstr1-filed').textContent).toContain('does not count as filed')
  })

  it('a blocked return can\'t be sent (the export gate\'s reason as the title)', async () => {
    signedIn = true
    renderUi(<GatewayReturnPanel form="gstr1" period="092026" blocked="Export blocked — 1 blocking issue" />)
    const send = await screen.findByTestId('gw-gstr1-send')
    expect((send as HTMLButtonElement).disabled).toBe(true)
  })

  it('the e-documents modal says test mode and generates the IRN through the gateway', async () => {
    renderUi(<GatewayEdocModal voucherId={7} number="GW-101" onClose={() => undefined} />)
    expect((await screen.findByTestId('gw-edoc-test-note')).textContent).toContain('never appear on the bill or its print')
    fireEvent.click(await screen.findByTestId('gw-edoc-irn-generate'))
    await waitFor(() => expect(calls('gateway:irn:generate')).toEqual([{ voucherId: 7 }]))
  })
})
