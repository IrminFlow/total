// Phase 4: "Send to the portal (test mode)" for one document on the e-Invoice & e-way bill screen —
// the gateway's IRN / e-way bill flows (src/main/gstGateway/edocFlow.ts). In 1.0 the built-in
// Test GSP answers: the simulated IRN / e-way bill is kept apart from the bill (never printed,
// never locks it) and is shown only here.
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/client'
import { useToasts } from '../../state/stores'
import { Badge, Banner, Button, Modal } from '../../components/ui'
import { TEST_MODE_NOTE } from '@shared/gstGateway'

export function GatewayEdocModal({ voucherId, number, onClose }: { voucherId: number; number: string; onClose: () => void }): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data: status } = useQuery({ queryKey: ['gatewayStatus'], queryFn: api.gateway.status })
  const { data } = useQuery({ queryKey: ['gatewayEdoc', voucherId], queryFn: () => api.gateway.edocRecord(voucherId) })
  const [busy, setBusy] = useState(false)
  const rec = data?.record
  const test = status?.testMode ?? true
  const run = async (f: () => Promise<unknown>, done: string): Promise<void> => {
    setBusy(true)
    try {
      await f()
      toast.push('success', done)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
      await queryClient.invalidateQueries({ queryKey: ['gatewayEdoc', voucherId] })
    }
  }
  const suffix = test ? ' (test mode)' : ''
  return (
    <Modal title={`Send to the portal${suffix} — ${number}`} onClose={onClose}>
      <div className="flex flex-col gap-3" data-testid="gw-edoc">
        {test && (
          <Banner tone="warning" testId="gw-edoc-test-note">
            {TEST_MODE_NOTE} The built-in Test GSP simulates the IRN and e-way bill; they never appear on the bill or its print.
          </Banner>
        )}
        <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1 text-detail">
          <dt className="text-muted">IRN</dt>
          <dd className="num break-all" data-testid="gw-edoc-irn">{rec?.irn ?? '—'}{rec?.irnCancelledAt ? ' (cancelled)' : ''}</dd>
          <dt className="text-muted">Ack no / date</dt>
          <dd className="num" data-testid="gw-edoc-ack">{rec?.ackNo ? `${rec.ackNo} · ${rec.ackDate ?? ''}` : '—'}</dd>
          <dt className="text-muted">e-Way bill</dt>
          <dd className="num" data-testid="gw-edoc-ewb">{rec?.ewbNo ? `${rec.ewbNo} · valid till ${rec.ewbValidUpto || '— (Part A only)'}` : '—'}</dd>
        </dl>
        {rec?.irn && test && <div><Badge tone="warning" testId="gw-edoc-simulated">Simulated — not on the GST portal</Badge></div>}
        <div className="flex flex-wrap gap-2">
          {!rec?.irnLive && (
            <Button variant="primary" data-testid="gw-edoc-irn-generate" disabled={busy} onClick={() => void run(() => api.gateway.generateIrn(voucherId), `IRN generated${suffix}`)}>
              Generate IRN{suffix}
            </Button>
          )}
          {rec?.irnLive && !rec.ewbNo && (
            <Button variant="primary" data-testid="gw-edoc-ewb-generate" disabled={busy} onClick={() => void run(() => api.gateway.generateEwb(voucherId), `e-Way bill generated${suffix}`)}>
              Generate e-way bill{suffix}
            </Button>
          )}
          {rec?.ewbNo && rec.cancelEwb.allowed && (
            <Button data-testid="gw-edoc-ewb-cancel" disabled={busy} onClick={() => void run(() => api.gateway.cancelEwb(voucherId, 'data_entry_mistake', ''), `e-Way bill cancelled${suffix}`)}>
              Cancel e-way bill
            </Button>
          )}
          {rec?.irnLive && !rec.ewbNo && rec.cancelIrn.allowed && (
            <Button data-testid="gw-edoc-irn-cancel" disabled={busy} onClick={() => void run(() => api.gateway.cancelIrn(voucherId, 'data_entry_mistake', ''), `IRN cancelled${suffix}`)}>
              Cancel IRN
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </div>
      </div>
    </Modal>
  )
}
