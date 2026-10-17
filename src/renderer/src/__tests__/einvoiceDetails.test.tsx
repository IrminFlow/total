// NIC follow-up — e-Documents → "IRN details": the stored signed copies (Copy / Save JSON), Cancel
// IRN (reason + remark behind the live-API confirmation, or why the 24-hour window is shut), and
// the e-way bill's Cancel / Extend validity with its history. Every action goes through its own
// IPC channel with exactly the answers typed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { CompanyInfo } from '@shared/domain'
import { ewbCancelWindow, ewbExtendWindow, irnCancelWindow, type NicRecord } from '@shared/gst/nicRecord'
import { useSession } from '../state/stores'
import { EinvoiceDetailsModal, extendRequestFrom } from '../screens/edocs/EinvoiceDetails'

const INFO: CompanyInfo = {
  name: 'Acme', stateCode: '27', gstin: '27AAPFU0939F1ZV', gstRegistrationType: 'regular', address: '', booksFrom: 2026, email: null, phone: null, pan: null, tan: null
}
const IRN = 'a'.repeat(64)
const ACK = '2026-08-20 11:00:00' // IST → 05:30 UTC
const ACK_MS = Date.UTC(2026, 7, 20, 5, 30)

function record(over: Partial<NicRecord> = {}, now = ACK_MS + 3600 * 1000): NicRecord {
  const base = {
    voucherId: 7, number: 'INV/1', date: '2026-08-20', irn: IRN, ackNo: '112610000000001', ackDate: ACK,
    signedInvoice: 'h.inv.s', signedQrCode: 'h.qr.s', signedInvoiceData: null, signedQrData: null,
    irnCancelledAt: null, irnCancelReason: null, irnCancelRemark: null, irnLive: true,
    ewbNo: null, ewbDate: null, ewbValidUpto: null, ewbHistory: [],
    ...over
  }
  return {
    ...base,
    cancelIrn: irnCancelWindow(base, now),
    cancelEwb: ewbCancelWindow(base, now),
    extendEwb: ewbExtendWindow(base, now),
    ...over
  } as NicRecord
}

const invoke = vi.fn()
const calls: { channel: string; payload: unknown }[] = []
let current: NicRecord

function renderModal(live = true): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><EinvoiceDetailsModal voucherId={7} live={live} onClose={() => {}} /></QueryClientProvider>)
}

beforeEach(() => {
  calls.length = 0
  current = record()
  invoke.mockImplementation(async (channel: string, payload?: unknown) => {
    calls.push({ channel, payload })
    switch (channel) {
      case 'nic:record': return { ok: true, data: current }
      case 'nic:signedCopyExport': return { ok: true, data: { path: '/x/INV-1-signed-einvoice.json' } }
      case 'nic:cancelIrn': return { ok: true, data: { irn: IRN, cancelDate: '2026-08-20 13:00:00' } }
      case 'nic:cancelEwb': return { ok: true, data: { ewbNo: '391000000001', cancelDate: '20/08/2026 01:00:00 PM' } }
      case 'nic:extendEwb': return { ok: true, data: { ewbNo: '391000000001', validUpto: '27/08/2026 11:59:00 PM' } }
      default: return { ok: false, error: `unmocked channel ${channel}` }
    }
  })
  window.total = { platform: 'test', invoke }
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } })
  act(() => {
    useSession.setState({ slug: 'acme', info: INFO, user: null })
  })
})
afterEach(() => cleanup())

describe('IRN details', () => {
  it('shows the IRN, ack and the signed copies read-only; Copy writes the clipboard, Save JSON calls nic:signedCopyExport', async () => {
    renderModal()
    await screen.findByTestId('edoc-details')
    expect(screen.getByTestId('edoc-details-irn').textContent).toBe(IRN)
    expect(screen.getByTestId('edoc-details-ack-no').textContent).toBe('112610000000001')
    const qr = screen.getByTestId('edoc-details-signed-qr') as HTMLTextAreaElement
    expect(qr.value).toBe('h.qr.s')
    expect(qr.readOnly).toBe(true)
    fireEvent.click(screen.getByTestId('edoc-details-signed-qr-copy'))
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('h.qr.s'))
    fireEvent.click(screen.getByTestId('btn-edoc-signed-save'))
    await waitFor(() => expect(calls.find((c) => c.channel === 'nic:signedCopyExport')?.payload).toEqual({ voucherId: 7 }))
    // The UNVERIFIED list is on the screen.
    expect(screen.getByTestId('edoc-details-unverified').textContent).toMatch(/never run against the real NIC portal/)
  })

  it('without signed copies it says why, and offers no Save JSON', async () => {
    current = record({ signedInvoice: null, signedQrCode: null })
    renderModal()
    await screen.findByTestId('edoc-details-no-signed')
    expect(screen.queryByTestId('btn-edoc-signed-save')).toBeNull()
  })

  it('Cancel IRN: reason + remark + the live-API confirmation, then nic:cancelIrn with exactly those', async () => {
    renderModal()
    fireEvent.click(await screen.findByTestId('btn-edoc-irn-cancel'))
    const confirm = screen.getByTestId('btn-edoc-irn-cancel-confirm') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.change(screen.getByTestId('input-edoc-irn-cancel-reason'), { target: { value: 'order_cancelled' } })
    fireEvent.change(screen.getByTestId('input-edoc-irn-cancel-remark'), { target: { value: 'Buyer cancelled' } })
    expect(confirm.disabled).toBe(true) // not until the confirmation is ticked
    fireEvent.click(screen.getByTestId('input-edoc-irn-cancel-understood'))
    expect(confirm.disabled).toBe(false)
    current = record({ irnCancelledAt: '2026-08-20 13:00:00', irnCancelReason: 'order_cancelled', irnCancelRemark: 'Buyer cancelled', irnLive: false })
    fireEvent.click(confirm)
    await waitFor(() => expect(calls.find((c) => c.channel === 'nic:cancelIrn')?.payload).toEqual({ voucherId: 7, reason: 'order_cancelled', remark: 'Buyer cancelled' }))
    const state = await screen.findByTestId('edoc-irn-cancelled-state')
    expect(state.textContent).toMatch(/Cancelled on the IRP on 2026-08-20 13:00:00 · Order cancelled · Buyer cancelled/)
    expect(screen.queryByTestId('btn-edoc-irn-cancel')).toBeNull()
  })

  it('after the 24-hour window the screen says why, and offers no Cancel IRN', async () => {
    current = record({}, ACK_MS + 25 * 3600 * 1000)
    renderModal()
    const closed = await screen.findByTestId('edoc-irn-cancel-closed')
    expect(closed.textContent).toBe('The 24-hour window to cancel this IRN closed on 21 Aug 2026, 11:00 IST — issue a credit note instead')
    expect(screen.queryByTestId('btn-edoc-irn-cancel')).toBeNull()
  })

  it('with a live e-way bill: Cancel IRN waits for it; Cancel e-way bill goes through nic:cancelEwb', async () => {
    current = record({ ewbNo: '391000000001', ewbDate: ACK, ewbValidUpto: '2026-08-22 23:59:00', ewbHistory: [{ action: 'generate', ewbNo: '391000000001', at: ACK, validUpto: '2026-08-22 23:59:00' }] })
    renderModal()
    expect((await screen.findByTestId('edoc-irn-cancel-closed')).textContent).toMatch(/Cancel the e-way bill first/)
    expect(screen.getByTestId('edoc-ewb-event-generate')).toBeTruthy()
    // Too early to extend: it says from when.
    expect(screen.getByTestId('edoc-ewb-extend-closed').textContent).toMatch(/Validity can be extended from 22 Aug 2026, 15:59 IST/)
    fireEvent.click(screen.getByTestId('btn-edoc-ewb-cancel'))
    fireEvent.change(screen.getByTestId('input-edoc-ewb-cancel-reason'), { target: { value: 'duplicate' } })
    fireEvent.change(screen.getByTestId('input-edoc-ewb-cancel-remark'), { target: { value: 'Raised twice' } })
    fireEvent.click(screen.getByTestId('input-edoc-ewb-cancel-understood'))
    fireEvent.click(screen.getByTestId('btn-edoc-ewb-cancel-confirm'))
    await waitFor(() => expect(calls.find((c) => c.channel === 'nic:cancelEwb')?.payload).toEqual({ voucherId: 7, reason: 'duplicate', remark: 'Raised twice' }))
  })

  it('Extend validity inside the window: the form says what is missing, then sends the request', async () => {
    const until = Date.UTC(2026, 7, 22, 18, 29) // 22 Aug 23:59 IST
    current = record({ ewbNo: '391000000001', ewbDate: ACK, ewbValidUpto: '2026-08-22 23:59:00' }, until - 3600 * 1000)
    renderModal()
    fireEvent.click(await screen.findByTestId('btn-edoc-ewb-extend'))
    expect(screen.getByTestId('edoc-ewb-extend-missing').textContent).toBe('Add a remark')
    fireEvent.change(screen.getByTestId('input-edoc-ewb-extend-reason'), { target: { value: '4' } })
    fireEvent.change(screen.getByTestId('input-edoc-ewb-extend-remarks'), { target: { value: 'Transshipment at Hubballi' } })
    fireEvent.change(screen.getByTestId('input-edoc-ewb-extend-place'), { target: { value: 'Hubballi' } })
    fireEvent.change(screen.getByTestId('input-edoc-ewb-extend-state'), { target: { value: '29' } })
    fireEvent.change(screen.getByTestId('input-edoc-ewb-extend-pin'), { target: { value: '580020' } })
    fireEvent.change(screen.getByTestId('input-edoc-ewb-extend-km'), { target: { value: '400' } })
    expect(screen.getByTestId('edoc-ewb-extend-missing').textContent).toBe('Road transport needs a vehicle number')
    fireEvent.change(screen.getByTestId('input-edoc-ewb-extend-vehicle'), { target: { value: 'KA25AB9999' } })
    expect(screen.queryByTestId('edoc-ewb-extend-missing')).toBeNull()
    fireEvent.click(screen.getByTestId('input-edoc-ewb-extend-understood'))
    fireEvent.click(screen.getByTestId('btn-edoc-ewb-extend-confirm'))
    await waitFor(() => expect(calls.find((c) => c.channel === 'nic:extendEwb')?.payload).toEqual({
      voucherId: 7, reasonCode: 4, remarks: 'Transshipment at Hubballi', fromPlace: 'Hubballi', fromStateCode: 29, fromPincode: 580020,
      remainingDistanceKm: 400, transMode: '1', vehicleNo: 'KA25AB9999'
    }))
  })

  it('offline (no NIC credentials): the facts show, no portal action is offered', async () => {
    current = record({ ewbNo: '391000000001', ewbDate: ACK, ewbValidUpto: '2026-08-22 23:59:00' })
    renderModal(false)
    await screen.findByTestId('edoc-details')
    expect(screen.queryByTestId('btn-edoc-irn-cancel')).toBeNull()
    expect(screen.queryByTestId('btn-edoc-ewb-cancel')).toBeNull()
    expect(screen.queryByTestId('btn-edoc-ewb-extend')).toBeNull()
  })

  it('extendRequestFrom: in transit needs the address and sends transitType', () => {
    const f = {
      reasonCode: 1 as const, remarks: 'Flood', fromPlace: 'Belagavi', fromStateCode: '29', fromPincode: '590001', remainingDistanceKm: '120',
      transMode: '5' as const, vehicleNo: '', transDocNo: '', transDocDate: '', transitType: 'W' as const, addressLine1: ''
    }
    expect(extendRequestFrom(f)).toBe('Give the address where the goods are held')
    expect(extendRequestFrom({ ...f, addressLine1: 'Godown 4, APMC Yard' })).toEqual({
      reasonCode: 1, remarks: 'Flood', fromPlace: 'Belagavi', fromStateCode: 29, fromPincode: 590001, remainingDistanceKm: 120, transMode: '5',
      transitType: 'W', addressLine1: 'Godown 4, APMC Yard'
    })
  })
})
