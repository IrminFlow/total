import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/client'
import { useToasts } from '../../state/stores'
import { Banner, Button, Modal } from '../../components/ui'
import { CAPABILITY_REFUSED_TEXT, useCapabilityRefused } from '../../lib/capabilities'
import type { NicRecord } from '@shared/gst/nicRecord'

/**
 * e-Documents → a row's "IRN details": what the IRP returned for this voucher, as stored —
 * IRN, ack no / date and the signed invoice + signed QR (JWS strings, read-only; copy or save
 * them as JSON). EXPERIMENTAL: the live client has never run against the real portal.
 */
export function EinvoiceDetailsModal({ voucherId, onClose }: { voucherId: number; onClose: () => void }): React.JSX.Element {
  const { data: rec, isLoading } = useQuery({ queryKey: ['nicRecord', voucherId], queryFn: () => api.nic.record(voucherId) })
  return (
    <Modal title={rec ? `e-Invoice · ${rec.number}` : 'e-Invoice'} onClose={onClose} wide>
      {isLoading || !rec ? <p className="text-detail text-muted">Loading…</p> : <EinvoiceDetailsBody rec={rec} />}
    </Modal>
  )
}

function EinvoiceDetailsBody({ rec }: { rec: NicRecord }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4 text-detail" data-testid="edoc-details">
      <Banner tone="warning">Experimental — the live NIC client has never run against the real portal. Check every result on the portal.</Banner>
      <SignedCopies rec={rec} />
    </div>
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
