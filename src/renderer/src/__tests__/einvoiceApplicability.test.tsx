// To-do §4 — e-invoice applicability from the business profile, in the UI:
//  - Company details → GST: the PAN-level turnover per FY + "other GSTINs" + exemption, saved with
//    the form through gstProfile:set (a patch); the "E-invoicing applies to you from <date> — turn
//    it on" banner only ticks the switch (never saves, never switches on by itself);
//  - the Gateway's Compliance card and the simple Taxes screen show the same notice;
//  - the e-Invoice list's 30-day IRP countdown chip (pure helper).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { CompanyInfo } from '@shared/domain'
import type { EinvoiceStatus } from '@shared/compliance'
import type { EdocListRow } from '@shared/reports'
import { bannedWordsIn } from '@shared/simple/bannedWords'
import { useNav, useSession } from '../state/stores'
import { useExplain } from '../lib/explain'
import { CompanyInfoScreen } from '../screens/CompanyInfo'
import { ComplianceCard } from '../screens/gateway/cards'
import { EinvoiceTurnOnCard, TaxesScreen } from '../simple/taxes/TaxesScreen'
import { irpCountdown } from '../screens/Edocs'

const CR = 1_000_000_000
const INFO: CompanyInfo = {
  name: 'Acme', stateCode: '27', gstin: '27AAPFU0939F1ZV', gstRegistrationType: 'regular', address: '', booksFrom: 2026, email: null, phone: null, pan: null, tan: null
}
const REQUIRED: EinvoiceStatus = {
  enabled: false,
  applicability: { required: true, reason: 'exceeded', since: '2025-04-01', fy: '2024-25', thresholdPaise: 5 * CR, notification: '10/2023-CT' },
  turnOn: { since: '2025-04-01', fy: '2024-25', thresholdPaise: 5 * CR, notification: '10/2023-CT' },
  reportingWindowDays: null
}
const NOTHING: EinvoiceStatus = { enabled: false, applicability: { required: false, reason: 'no_turnover' }, turnOn: null, reportingWindowDays: null }
const invoke = vi.fn()
let status: EinvoiceStatus
let profile: Record<string, unknown>
let enabled: boolean
const calls: { channel: string; payload: unknown }[] = []

function renderUi(ui: React.ReactNode): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

beforeEach(() => {
  localStorage.clear()
  calls.length = 0
  status = REQUIRED
  enabled = false
  profile = { filing: 'monthly', turnover: { years: [{ fy: '2024-25', paise: 6 * CR }] } }
  invoke.mockImplementation(async (channel: string, payload?: unknown) => {
    calls.push({ channel, payload })
    switch (channel) {
      case 'gst:einvoiceStatus': return { ok: true, data: status }
      case 'gst:einvoicing': return { ok: true, data: { enabled } }
      case 'einvoicing:set': enabled = (payload as { enabled: boolean }).enabled; return { ok: true, data: { enabled } }
      case 'gstProfile:get': return { ok: true, data: profile }
      case 'gstProfile:set': profile = { ...profile, ...(payload as object) }; return { ok: true, data: profile }
      case 'company:updateInfo': return { ok: true, data: { ...INFO, ...(payload as object) } }
      case 'simple:taxes': return { ok: true, data: { kind: 'unregistered', today: '2026-10-17', withholding: [] } }
      default: return { ok: false, error: `unmocked channel ${channel}` }
    }
  })
  window.total = { platform: 'test', invoke }
  act(() => {
    useSession.setState({ slug: 'acme', info: INFO, user: null, workingDate: '2026-10-17', from: '2026-04-01', to: '2027-03-31' })
    useNav.setState({ stack: [{ name: 'company-info' }] } as never)
    useExplain.setState({ ready: false, handler: null })
  })
})
afterEach(() => cleanup())

describe('Company details → e-invoice applicability', () => {
  it('shows the notice; "Turn it on" only ticks the switch — Save stores it', async () => {
    renderUi(<CompanyInfoScreen />)
    const banner = await screen.findByTestId('banner-einvoice-turn-on')
    expect(banner.textContent).toMatch(/E-invoicing applies to you from 01-Apr-25 — turn it on/)
    expect(banner.textContent).toMatch(/10\/2023-CT/)
    await waitFor(() => expect(calls.some((c) => c.channel === 'gst:einvoicing')).toBe(true))
    fireEvent.click(screen.getByTestId('btn-einvoice-turn-on'))
    expect((screen.getByTestId('input-company-einvoicing') as HTMLInputElement).checked).toBe(true)
    expect(screen.queryByTestId('banner-einvoice-turn-on')).toBeNull()
    expect(calls.some((c) => c.channel === 'einvoicing:set')).toBe(false) // nothing until Save
    fireEvent.click(screen.getByText('Save details'))
    await waitFor(() => expect(calls.find((c) => c.channel === 'einvoicing:set')?.payload).toEqual({ enabled: true }))
    expect(calls.some((c) => c.channel === 'gstProfile:set')).toBe(false) // profile unchanged
  })

  it('adds a year’s turnover and saves it with the form as a gstProfile:set patch (filing untouched)', async () => {
    status = NOTHING
    profile = { filing: 'quarterly' }
    renderUi(<CompanyInfoScreen />)
    fireEvent.click(await screen.findByTestId('btn-turnover-add'))
    fireEvent.change(screen.getByTestId('input-turnover-0'), { target: { value: '7,00,00,000' } })
    fireEvent.click(screen.getByTestId('input-turnover-other-gstins'))
    fireEvent.change(screen.getByTestId('select-einvoice-exemption'), { target: { value: 'goods_transport_agency' } })
    fireEvent.click(screen.getByText('Save details'))
    await waitFor(() => expect(calls.some((c) => c.channel === 'gstProfile:set')).toBe(true))
    const sent = calls.find((c) => c.channel === 'gstProfile:set')!.payload as Record<string, unknown>
    expect(sent).toEqual({ turnover: { years: [{ fy: '2026-27', paise: 7 * CR }], otherGstins: true }, einvoiceExemption: 'goods_transport_agency' })
  })

  it('no notice while nothing is required', async () => {
    status = NOTHING
    renderUi(<CompanyInfoScreen />)
    await screen.findByTestId('company-einvoice-profile')
    await waitFor(() => expect(screen.getByTestId('company-einvoice-applicability').textContent).toMatch(/Enter the aggregate turnover/))
    expect(screen.queryByTestId('banner-einvoice-turn-on')).toBeNull()
  })
})

describe('the Gateway Compliance card and the simple Taxes screen', () => {
  it('Gateway: the chip opens Company details', async () => {
    renderUi(<ComplianceCard gst={{ state: 'ready', data: null }} tds={null} hasPayroll={false} dashboardLoaded={false} />)
    const chip = await screen.findByTestId('chip-einvoice-turn-on')
    expect(chip.textContent).toMatch(/^E-invoicing applies to you from .+ — turn it on$/)
    act(() => useNav.setState({ stack: [{ name: 'gateway' }] } as never))
    fireEvent.click(screen.getByTestId('dash-einvoice-turn-on'))
    await waitFor(() => expect(useNav.getState().stack.at(-1)).toMatchObject({ name: 'company-info' }))
  })

  it('Gateway: nothing when the profile does not require it', async () => {
    status = NOTHING
    renderUi(<ComplianceCard gst={{ state: 'ready', data: null }} tds={null} hasPayroll={false} dashboardLoaded={false} />)
    await waitFor(() => expect(calls.some((c) => c.channel === 'gst:einvoiceStatus')).toBe(true))
    expect(screen.queryByTestId('chip-einvoice-turn-on')).toBeNull()
  })

  it('simple Taxes: plain words, no banned word, the button opens Company details', async () => {
    act(() => {
      useSession.setState({ ui: { mode: 'simple' } } as never)
      useNav.setState({ stack: [{ name: 'simple-taxes' }] } as never)
    })
    // The card the regular answer starts with (the full regular shape is simpleTaxes.test.tsx's).
    renderUi(<EinvoiceTurnOnCard />)
    const card = await screen.findByTestId('taxes-einvoice-turn-on')
    expect(card.textContent).toMatch(/E-invoicing applies to you from 1 Apr 2025 — turn it on/)
    expect(card.textContent).toMatch(/₹5,00,00,000/)
    expect(bannedWordsIn(card.textContent ?? '')).toEqual([])
    fireEvent.click(screen.getByTestId('btn-taxes-einvoice-turn-on'))
    await waitFor(() => expect(useNav.getState().stack.at(-1)).toMatchObject({ name: 'company-info' }))
  })

  it('simple Taxes: an unregistered business never asks', async () => {
    renderUi(<TaxesScreen />)
    await screen.findByTestId('taxes-unregistered')
    expect(screen.queryByTestId('taxes-einvoice-turn-on')).toBeNull()
  })
})

describe('e-Invoice list: the 30-day IRP countdown', () => {
  const row = (over: Partial<EdocListRow> = {}): EdocListRow => ({
    voucherId: 1, number: 'S/1', date: '2026-10-01', docType: 'INV', partyLedgerId: 2, partyName: 'B', partyGstin: '27AABCG3456H1ZN',
    total: 100, vehicleNo: null, hasHsn: true, irn: null, ewbNo: null, outwardDbn: false, ewbReason: null, ...over
  })
  const yes = (): boolean => true
  it('counts down to the 30th day; passed after it; never for an IRN, a challan, B2C or outside the window', () => {
    expect(irpCountdown(row(), yes, '2026-10-17')).toEqual({ days: 13, text: 'Report to the IRP in 13 days' })
    expect(irpCountdown(row(), yes, '2026-10-30')).toEqual({ days: 0, text: 'Report to the IRP today' })
    expect(irpCountdown(row(), yes, '2026-10-29')?.text).toBe('Report to the IRP in 1 day')
    expect(irpCountdown(row(), yes, '2026-10-31')).toEqual({ days: -1, text: '30-day IRP window passed' })
    expect(irpCountdown(row({ irn: 'x' }), yes, '2026-10-17')).toBeNull()
    expect(irpCountdown(row({ docType: 'CHL' }), yes, '2026-10-17')).toBeNull()
    expect(irpCountdown(row({ partyGstin: null }), yes, '2026-10-17')).toBeNull()
    expect(irpCountdown(row(), () => false, '2026-10-17')).toBeNull()
  })
})
