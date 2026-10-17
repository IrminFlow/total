import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/client'
import { useToasts } from '../../state/stores'
import { Banner, Button, Checkbox, Field, Modal, Select, TextInput } from '../../components/ui'
import { CAPABILITY_REFUSED_TEXT, useCapabilityRefused } from '../../lib/capabilities'
import {
  IRN_CANCEL_REMARK_MAX, NIC_CANCEL_REASON_LABEL, NIC_CANCEL_REASONS, NIC_UNVERIFIED, istLabel, type NicCancelReason, type NicRecord
} from '@shared/gst/nicRecord'

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
