import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/client'
import { useToasts } from '../../state/stores'
import { Banner, Button, Checkbox, Field, Modal, Select, TextInput } from '../../components/ui'
import { CAPABILITY_REFUSED_TEXT, useCapabilityRefused } from '../../lib/capabilities'
import {
  EWB_CANCEL_REMARK_MAX, EWB_EXTEND_MODES, EWB_EXTEND_REASONS, IRN_CANCEL_REMARK_MAX, NIC_CANCEL_REASON_LABEL, NIC_CANCEL_REASONS, NIC_UNVERIFIED,
  istLabel, type EwbEvent, type EwbExtendReasonCode, type EwbExtendRequest, type NicCancelReason, type NicRecord
} from '@shared/gst/nicRecord'
import { GST_STATE_LIST } from '@shared/gst/states'

/**
 * e-Documents → a row's "IRN details": what the IRP returned for this voucher, as stored —
 * IRN, ack no / date and the signed invoice + signed QR (JWS strings, read-only; copy or save
 * them as JSON). EXPERIMENTAL: the live client has never run against the real portal.
 */
export function EinvoiceDetailsModal({ voucherId, live, onClose }: { voucherId: number; live: boolean; onClose: () => void }): React.JSX.Element {
  const { data: rec, isLoading } = useQuery({ queryKey: ['nicRecord', voucherId], queryFn: () => api.nic.record(voucherId) })
  return (
    <Modal title={rec ? `e-Invoice · ${rec.number}` : 'e-Invoice'} onClose={onClose} wide>
      {isLoading || !rec ? <p className="text-detail text-muted">Loading…</p> : <EinvoiceDetailsBody rec={rec} live={live} />}
    </Modal>
  )
}

function EinvoiceDetailsBody({ rec, live }: { rec: NicRecord; live: boolean }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4 text-detail" data-testid="edoc-details">
      <Banner tone="warning">Experimental — the live NIC client has never run against the real portal. Check every result on the portal.</Banner>
      {rec.irn && <SignedCopies rec={rec} />}
      {rec.irn && <IrnCancel rec={rec} live={live} />}
      {(rec.ewbNo || rec.ewbHistory.length > 0) && <EwayBill rec={rec} live={live} />}
      <details className="text-hint text-muted" data-testid="edoc-details-unverified">
        <summary className="cursor-pointer">Not verified against the live portal ({NIC_UNVERIFIED.length})</summary>
        <ul className="mt-1 list-disc pl-5">
          {NIC_UNVERIFIED.map((u) => (
            <li key={u}>{u}</li>
          ))}
        </ul>
      </details>
    </div>
  )
}

/** Refresh this record and the e-Documents list after a portal action. */
function useRefresh(voucherId: number): () => Promise<void> {
  const qc = useQueryClient()
  return async () => {
    await qc.invalidateQueries({ queryKey: ['nicRecord', voucherId] })
    await qc.invalidateQueries({ queryKey: ['edocList'] })
  }
}

function IrnCancel({ rec, live }: { rec: NicRecord; live: boolean }): React.JSX.Element {
  const toast = useToasts()
  const refresh = useRefresh(rec.voucherId)
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState<NicCancelReason>('data_entry_mistake')
  const [remark, setRemark] = useState('')
  const [understood, setUnderstood] = useState(false)
  const [busy, setBusy] = useState(false)
  if (rec.irnCancelledAt) {
    return (
      <section aria-label="IRN cancelled" className="flex flex-col gap-1" data-testid="edoc-irn-cancelled-state">
        <h3 className="text-label font-semibold uppercase text-muted">Cancelled</h3>
        <p>
          Cancelled on the IRP on <span className="num">{rec.irnCancelledAt}</span>
          {rec.irnCancelReason ? ` · ${NIC_CANCEL_REASON_LABEL[rec.irnCancelReason]}` : ''}
          {rec.irnCancelRemark ? ` · ${rec.irnCancelRemark}` : ''}
        </p>
        <p className="text-hint text-muted">
          The invoice can be altered or moved to the bin again. NIC will not issue a new IRN for the same document number — enter the corrected invoice under a new number.
        </p>
      </section>
    )
  }
  const win = rec.cancelIrn
  const submit = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await api.nic.cancelIrn(rec.voucherId, reason, remark.trim())
      toast.push('success', `IRN cancelled on the portal — ${r.cancelDate}`)
      setOpen(false)
      await refresh()
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section aria-label="Cancel IRN" className="flex flex-col gap-2" data-testid="edoc-irn-cancel">
      <h3 className="text-label font-semibold uppercase text-muted">Cancel IRN</h3>
      {!win.allowed ? (
        <p className="text-hint text-muted" data-testid="edoc-irn-cancel-closed">{win.reason}</p>
      ) : !live ? (
        <p className="text-hint text-muted">Add the NIC API credentials (Settings → Live filing) to cancel on the portal — or cancel it there by hand.</p>
      ) : !open ? (
        <div className="flex items-center gap-3">
          <Button size="sm" variant="danger" data-testid="btn-edoc-irn-cancel" onClick={() => setOpen(true)}>
            Cancel IRN…
          </Button>
          {win.closesAt !== null && <span className="text-hint text-muted">Possible until {istLabel(win.closesAt)}</span>}
        </div>
      ) : (
        <div className="flex flex-col gap-2 rounded border border-line p-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Reason">
              <Select value={reason} onChange={(e) => setReason(e.target.value as NicCancelReason)} data-testid="input-edoc-irn-cancel-reason">
                {NIC_CANCEL_REASONS.map((r) => (
                  <option key={r} value={r}>{NIC_CANCEL_REASON_LABEL[r]}</option>
                ))}
              </Select>
            </Field>
            <Field label="Remark" hint={`Sent to the IRP, up to ${IRN_CANCEL_REMARK_MAX} characters`}>
              <TextInput value={remark} maxLength={IRN_CANCEL_REMARK_MAX} onChange={(e) => setRemark(e.target.value)} data-testid="input-edoc-irn-cancel-remark" />
            </Field>
          </div>
          <Checkbox
            checked={understood}
            onChange={setUnderstood}
            testId="input-edoc-irn-cancel-understood"
            label="I understand this cancels the IRN on the live NIC portal. It can't be undone, and this document number can't be e-invoiced again."
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" onClick={() => setOpen(false)}>Back</Button>
            <Button
              size="sm"
              variant="danger"
              data-testid="btn-edoc-irn-cancel-confirm"
              disabled={!understood || !remark.trim() || busy}
              onClick={() => void submit()}
            >
              Cancel IRN on the portal
            </Button>
          </div>
        </div>
      )}
    </section>
  )
}

function Fact({ label, value, testId }: { label: string; value: string | null; testId?: string }): React.JSX.Element {
  return (
    <div className="flex gap-2">
      <span className="w-28 shrink-0 text-muted">{label}</span>
      <span className="num break-all" data-testid={testId}>{value || '—'}</span>
    </div>
  )
}

function SignedCopies({ rec }: { rec: NicRecord }): React.JSX.Element {
  const toast = useToasts()
  const exportRefused = useCapabilityRefused('canExport')
  const copy = async (label: string, value: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value)
      toast.push('success', `${label} copied`)
    } catch {
      toast.push('error', `Could not copy the ${label.toLowerCase()}`)
    }
  }
  const save = async (): Promise<void> => {
    try {
      const r = await api.nic.signedCopyExport(rec.voucherId)
      toast.push('success', `Signed e-invoice JSON written — ${r.path}`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  const hasSigned = !!(rec.signedInvoice || rec.signedQrCode)
  return (
    <section aria-label="IRN and signed copies" className="flex flex-col gap-2">
      <h3 className="text-label font-semibold uppercase text-muted">IRN</h3>
      <Fact label="IRN" value={rec.irn} testId="edoc-details-irn" />
      <Fact label="Ack no." value={rec.ackNo} testId="edoc-details-ack-no" />
      <Fact label="Ack date" value={rec.ackDate} testId="edoc-details-ack-date" />
      {!hasSigned ? (
        <p className="text-hint text-muted" data-testid="edoc-details-no-signed">
          No signed copy is stored — the IRN was generated before Total kept them, or adopted from a duplicate answer without one.
        </p>
      ) : (
        <>
          {rec.signedQrCode && (
            <SignedField label="Signed QR code" value={rec.signedQrCode} testId="edoc-details-signed-qr" onCopy={() => void copy('Signed QR code', rec.signedQrCode!)} />
          )}
          {rec.signedInvoice && (
            <SignedField label="Signed invoice" value={rec.signedInvoice} testId="edoc-details-signed-invoice" onCopy={() => void copy('Signed invoice', rec.signedInvoice!)} />
          )}
          <p className="text-hint text-muted">
            The print&apos;s QR is this signed QR code. Total does not verify the IRP&apos;s signature — the e-invoice verify app or the portal does.
          </p>
          <div>
            <Button
              size="sm"
              data-testid="btn-edoc-signed-save"
              onClick={() => void save()}
              disabled={exportRefused}
              disabledTitle={exportRefused ? CAPABILITY_REFUSED_TEXT.canExport : undefined}
            >
              Save JSON
            </Button>
          </div>
        </>
      )}
    </section>
  )
}

function SignedField({ label, value, testId, onCopy }: { label: string; value: string; testId: string; onCopy: () => void }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-muted">{label}</span>
        <button type="button" className="text-small text-blue hover:underline" data-testid={`${testId}-copy`} onClick={onCopy}>
          Copy
        </button>
      </div>
      <textarea
        readOnly
        aria-label={label}
        data-testid={testId}
        value={value}
        rows={3}
        className="num w-full resize-y rounded border border-line bg-panel2 px-2 py-1 text-hint"
      />
    </div>
  )
}

const EVENT_LABEL: Record<EwbEvent['action'], string> = { generate: 'Generated', extend: 'Extended', cancel: 'Cancelled' }

function eventDetail(e: EwbEvent): string {
  if (e.action === 'cancel') return [typeof e.reason === 'string' && e.reason in NIC_CANCEL_REASON_LABEL ? NIC_CANCEL_REASON_LABEL[e.reason as NicCancelReason] : '', e.remark ?? ''].filter(Boolean).join(' · ')
  if (e.action === 'extend') {
    const why = EWB_EXTEND_REASONS.find((r) => r.code === e.reason)?.label ?? ''
    return [why, e.remark, e.fromPlace && `at ${e.fromPlace}`, e.remainingDistanceKm != null && `${e.remainingDistanceKm} km left`, e.vehicleNo].filter(Boolean).join(' · ')
  }
  return ''
}

function EwayBill({ rec, live }: { rec: NicRecord; live: boolean }): React.JSX.Element {
  return (
    <section aria-label="e-Way bill" className="flex flex-col gap-2" data-testid="edoc-ewb">
      <h3 className="text-label font-semibold uppercase text-muted">e-Way bill</h3>
      {rec.ewbNo ? (
        <>
          <Fact label="EWB no." value={rec.ewbNo} testId="edoc-details-ewb-no" />
          <Fact label="Generated" value={rec.ewbDate} />
          <Fact label="Valid until" value={rec.ewbValidUpto} testId="edoc-details-ewb-valid" />
        </>
      ) : (
        <p className="text-hint text-muted">No live e-way bill.</p>
      )}
      {rec.ewbHistory.length > 0 && (
        <table className="w-full text-hint" data-testid="edoc-ewb-history">
          <caption className="sr-only">e-Way bill history</caption>
          <thead>
            <tr className="text-left text-muted">
              <th scope="col" className="py-0.5 font-normal">Event</th>
              <th scope="col" className="py-0.5 font-normal">EWB no.</th>
              <th scope="col" className="py-0.5 font-normal">When</th>
              <th scope="col" className="py-0.5 font-normal">Valid until</th>
              <th scope="col" className="py-0.5 font-normal">Details</th>
            </tr>
          </thead>
          <tbody>
            {rec.ewbHistory.map((e, i) => (
              <tr key={i} data-testid={`edoc-ewb-event-${e.action}`}>
                <td className="py-0.5">{EVENT_LABEL[e.action]}</td>
                <td className="num py-0.5">{e.ewbNo}</td>
                <td className="num py-0.5">{e.at || '—'}</td>
                <td className="num py-0.5">{e.validUpto || '—'}</td>
                <td className="py-0.5">{eventDetail(e) || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rec.ewbNo && <EwbCancel rec={rec} live={live} />}
      {rec.ewbNo && <EwbExtend rec={rec} live={live} />}
    </section>
  )
}

function EwbCancel({ rec, live }: { rec: NicRecord; live: boolean }): React.JSX.Element {
  const toast = useToasts()
  const refresh = useRefresh(rec.voucherId)
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState<NicCancelReason>('data_entry_mistake')
  const [remark, setRemark] = useState('')
  const [understood, setUnderstood] = useState(false)
  const [busy, setBusy] = useState(false)
  const win = rec.cancelEwb
  const submit = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await api.nic.cancelEwb(rec.voucherId, reason, remark.trim())
      toast.push('success', `e-Way bill ${r.ewbNo} cancelled on the portal`)
      setOpen(false)
      await refresh()
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  if (!win.allowed) return <p className="text-hint text-muted" data-testid="edoc-ewb-cancel-closed">{win.reason}</p>
  if (!live) return <p className="text-hint text-muted">Add the NIC API credentials (Settings → Live filing) to cancel or extend on the portal.</p>
  if (!open) {
    return (
      <div className="flex items-center gap-3">
        <Button size="sm" variant="danger" data-testid="btn-edoc-ewb-cancel" onClick={() => setOpen(true)}>
          Cancel e-way bill…
        </Button>
        {win.closesAt !== null && <span className="text-hint text-muted">Possible until {istLabel(win.closesAt)}</span>}
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2 rounded border border-line p-3" data-testid="edoc-ewb-cancel-form">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Reason">
          <Select value={reason} onChange={(e) => setReason(e.target.value as NicCancelReason)} data-testid="input-edoc-ewb-cancel-reason">
            {NIC_CANCEL_REASONS.map((r) => (
              <option key={r} value={r}>{NIC_CANCEL_REASON_LABEL[r]}</option>
            ))}
          </Select>
        </Field>
        <Field label="Remark" hint={`Up to ${EWB_CANCEL_REMARK_MAX} characters`}>
          <TextInput value={remark} maxLength={EWB_CANCEL_REMARK_MAX} onChange={(e) => setRemark(e.target.value)} data-testid="input-edoc-ewb-cancel-remark" />
        </Field>
      </div>
      <Checkbox
        checked={understood}
        onChange={setUnderstood}
        testId="input-edoc-ewb-cancel-understood"
        label="I understand this cancels the e-way bill on the live portal and can't be undone."
      />
      <div className="flex justify-end gap-2">
        <Button size="sm" onClick={() => setOpen(false)}>Back</Button>
        <Button size="sm" variant="danger" data-testid="btn-edoc-ewb-cancel-confirm" disabled={!understood || !remark.trim() || busy} onClick={() => void submit()}>
          Cancel e-way bill on the portal
        </Button>
      </div>
    </div>
  )
}

/** The extension form's fields as typed (strings until sent). */
interface ExtendForm {
  reasonCode: EwbExtendReasonCode
  remarks: string
  fromPlace: string
  fromStateCode: string
  fromPincode: string
  remainingDistanceKm: string
  transMode: EwbExtendRequest['transMode']
  vehicleNo: string
  transDocNo: string
  transDocDate: string
  transitType: 'R' | 'W' | 'O'
  addressLine1: string
}

/** The request, or the first thing missing (in the form's words). */
export function extendRequestFrom(f: ExtendForm): EwbExtendRequest | string {
  if (!f.remarks.trim()) return 'Add a remark'
  if (!f.fromPlace.trim()) return 'Say where the goods are now'
  if (!f.fromStateCode) return 'Pick the state the goods are in now'
  if (!/^\d{6}$/.test(f.fromPincode.trim())) return 'The current PIN code needs 6 digits'
  const km = Number(f.remainingDistanceKm)
  if (!Number.isInteger(km) || km < 1 || km > 4000) return 'The remaining distance is a whole number of km (1–4000)'
  if (f.transMode === '1' && !f.vehicleNo.trim()) return 'Road transport needs a vehicle number'
  if (['2', '3', '4'].includes(f.transMode) && !f.transDocNo.trim()) return 'Rail, air or ship needs the transport document number'
  if (f.transMode === '5' && !f.addressLine1.trim()) return 'Give the address where the goods are held'
  return {
    reasonCode: f.reasonCode,
    remarks: f.remarks.trim(),
    fromPlace: f.fromPlace.trim(),
    fromStateCode: Number(f.fromStateCode),
    fromPincode: Number(f.fromPincode.trim()),
    remainingDistanceKm: km,
    transMode: f.transMode,
    ...(f.vehicleNo.trim() ? { vehicleNo: f.vehicleNo.trim() } : {}),
    ...(f.transDocNo.trim() ? { transDocNo: f.transDocNo.trim() } : {}),
    ...(f.transDocDate ? { transDocDate: f.transDocDate } : {}),
    ...(f.transMode === '5' ? { transitType: f.transitType, addressLine1: f.addressLine1.trim() } : {})
  }
}

function EwbExtend({ rec, live }: { rec: NicRecord; live: boolean }): React.JSX.Element | null {
  const toast = useToasts()
  const refresh = useRefresh(rec.voucherId)
  const [open, setOpen] = useState(false)
  const [understood, setUnderstood] = useState(false)
  const [busy, setBusy] = useState(false)
  const [f, setF] = useState<ExtendForm>({
    reasonCode: 5, remarks: '', fromPlace: '', fromStateCode: '', fromPincode: '', remainingDistanceKm: '', transMode: '1',
    vehicleNo: '', transDocNo: '', transDocDate: '', transitType: 'R', addressLine1: ''
  })
  const set = (patch: Partial<ExtendForm>): void => setF((x) => ({ ...x, ...patch }))
  const win = rec.extendEwb
  if (!live) return null
  if (!win.allowed) return <p className="text-hint text-muted" data-testid="edoc-ewb-extend-closed">{win.reason}</p>
  const req = extendRequestFrom(f)
  const submit = async (): Promise<void> => {
    if (typeof req === 'string') return
    setBusy(true)
    try {
      const r = await api.nic.extendEwb(rec.voucherId, req)
      toast.push('success', `e-Way bill ${r.ewbNo} extended — valid until ${r.validUpto}`)
      setOpen(false)
      await refresh()
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  if (!open) {
    return (
      <div className="flex items-center gap-3">
        <Button size="sm" data-testid="btn-edoc-ewb-extend" onClick={() => setOpen(true)}>
          Extend validity…
        </Button>
        {win.closesAt !== null && <span className="text-hint text-muted">Possible until {istLabel(win.closesAt)}</span>}
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2 rounded border border-line p-3" data-testid="edoc-ewb-extend-form">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Reason">
          <Select value={String(f.reasonCode)} onChange={(e) => set({ reasonCode: Number(e.target.value) as EwbExtendReasonCode })} data-testid="input-edoc-ewb-extend-reason">
            {EWB_EXTEND_REASONS.map((r) => (
              <option key={r.code} value={r.code}>{r.label}</option>
            ))}
          </Select>
        </Field>
        <Field label="Remarks">
          <TextInput value={f.remarks} maxLength={50} onChange={(e) => set({ remarks: e.target.value })} data-testid="input-edoc-ewb-extend-remarks" />
        </Field>
        <Field label="Goods are now at (place)">
          <TextInput value={f.fromPlace} maxLength={50} onChange={(e) => set({ fromPlace: e.target.value })} data-testid="input-edoc-ewb-extend-place" />
        </Field>
        <Field label="State">
          <Select value={f.fromStateCode} onChange={(e) => set({ fromStateCode: e.target.value })} data-testid="input-edoc-ewb-extend-state">
            <option value="">Pick a state</option>
            {GST_STATE_LIST.map(([code, name]) => (
              <option key={code} value={String(Number(code))}>{code} · {name}</option>
            ))}
          </Select>
        </Field>
        <Field label="PIN code">
          <TextInput value={f.fromPincode} inputMode="numeric" maxLength={6} onChange={(e) => set({ fromPincode: e.target.value })} data-testid="input-edoc-ewb-extend-pin" />
        </Field>
        <Field label="Distance left (km)">
          <TextInput value={f.remainingDistanceKm} inputMode="numeric" onChange={(e) => set({ remainingDistanceKm: e.target.value })} data-testid="input-edoc-ewb-extend-km" />
        </Field>
        <Field label="Mode">
          <Select value={f.transMode} onChange={(e) => set({ transMode: e.target.value as ExtendForm['transMode'] })} data-testid="input-edoc-ewb-extend-mode">
            {EWB_EXTEND_MODES.map((m) => (
              <option key={m.code} value={m.code}>{m.label}</option>
            ))}
          </Select>
        </Field>
        {f.transMode === '1' && (
          <Field label="Vehicle no.">
            <TextInput value={f.vehicleNo} onChange={(e) => set({ vehicleNo: e.target.value })} data-testid="input-edoc-ewb-extend-vehicle" />
          </Field>
        )}
        {['2', '3', '4'].includes(f.transMode) && (
          <>
            <Field label="Transport doc no.">
              <TextInput value={f.transDocNo} maxLength={15} onChange={(e) => set({ transDocNo: e.target.value })} />
            </Field>
            <Field label="Transport doc date">
              <TextInput type="date" value={f.transDocDate} onChange={(e) => set({ transDocDate: e.target.value })} />
            </Field>
          </>
        )}
        {f.transMode === '5' && (
          <>
            <Field label="Held at">
              <Select value={f.transitType} onChange={(e) => set({ transitType: e.target.value as ExtendForm['transitType'] })}>
                <option value="R">On road</option>
                <option value="W">Warehouse</option>
                <option value="O">Others</option>
              </Select>
            </Field>
            <Field label="Address">
              <TextInput value={f.addressLine1} maxLength={120} onChange={(e) => set({ addressLine1: e.target.value })} />
            </Field>
          </>
        )}
      </div>
      {typeof req === 'string' && <p className="text-hint text-muted" data-testid="edoc-ewb-extend-missing">{req}</p>}
      <Checkbox
        checked={understood}
        onChange={setUnderstood}
        testId="input-edoc-ewb-extend-understood"
        label="I understand this extends the e-way bill on the live portal."
      />
      <div className="flex justify-end gap-2">
        <Button size="sm" onClick={() => setOpen(false)}>Back</Button>
        <Button size="sm" variant="primary" data-testid="btn-edoc-ewb-extend-confirm" disabled={!understood || typeof req === 'string' || busy} onClick={() => void submit()}>
          Extend on the portal
        </Button>
      </div>
    </div>
  )
}
