import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type EdocEvent } from '../lib/client'
import { useNav, useSession, useToasts } from '../state/stores'
import { Button, DateInput, EmptyState, Field, Modal, Money, Panel, SectionTitle, Select, SkeletonRows, TextInput } from '../components/ui'
import { gstPeriodOf, toDisplayDate, todayISO } from '@shared/dates'
import { TransportModal } from './voucher/TransportModal'

type DocTypeFilter = 'all' | 'INV' | 'CRN' | 'DBN'

const DOC_TYPE_FILTERS: { value: DocTypeFilter; label: string }[] = [
  { value: 'all', label: 'All documents' },
  { value: 'INV', label: 'Invoices' },
  { value: 'CRN', label: 'Credit notes' },
  { value: 'DBN', label: 'Debit notes' }
]

const DOC_TYPE_CLASS: Record<'INV' | 'CRN' | 'DBN', string> = {
  INV: 'text-muted',
  CRN: 'text-dr',
  DBN: 'text-cr'
}

/** Per-session "don't ask again" for the live-API confirm gate — module-level so it survives
 *  remounts of this screen but resets on app restart (never persisted to disk). */
let liveApiConfirmed = false

export function EdocsScreen(): React.JSX.Element {
  const { from, to, info } = useSession()
  const nav = useNav()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data, isLoading } = useQuery({ queryKey: ['edocList', from, to], queryFn: () => api.edoc.list(from, to) })
  const { data: nicStatus } = useQuery({ queryKey: ['nicStatus'], queryFn: api.nic.status })
  const [busy, setBusy] = useState<number | null>(null)
  const [confirming, setConfirming] = useState<{ kind: 'irn' | 'ewb'; voucherId: number } | null>(null)
  const [transportFor, setTransportFor] = useState<{ voucherId: number; number: string } | null>(null)
  const [docTypeFilter, setDocTypeFilter] = useState<DocTypeFilter>('all')
  const [lifecycleFor,setLifecycleFor]=useState<{voucherId:number;number:string}|null>(null)
  const {data:events}=useQuery({queryKey:['edocEvents'],queryFn:()=>api.edoc.events()})
  const latestByVoucher=useMemo(()=>{const map=new Map<number,EdocEvent>();for(const event of events??[])if(!map.has(event.voucherId))map.set(event.voucherId,event);return map},[events])
  const allRows = data ?? []
  const rows = useMemo(
    () => (docTypeFilter === 'all' ? allRows : allRows.filter((r) => r.docType === docTypeFilter)),
    [allRows, docTypeFilter]
  )
  const period = gstPeriodOf(to)
  const live = nicStatus?.configured ?? false

  const exportEinv = async (): Promise<void> => {
    try {
      const r = await api.edoc.exportEInvoice(from, to, period)
      toast.push(r.count ? 'success' : 'warning', r.count ? `${r.count} B2B invoice${r.count > 1 ? 's' : ''} written for IRN generation` : 'No B2B invoices (parties need GSTINs) in this period')
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  const exportEwb = async (): Promise<void> => {
    try {
      const r = await api.edoc.exportEwb(from, to, period)
      if (r.count) {
        const skipNote = r.skipped.length ? ` · ${r.skipped.length} skipped` : ''
        toast.push(
          'success',
          `${r.count} e-way bill${r.count > 1 ? 's' : ''} written — combined ${r.path.split('/').pop()} + per-bill files in ${r.dir}${skipNote}`
        )
      } else {
        const why = r.skipped.length
          ? `all ${r.skipped.length} skipped (${r.skipped[0]!.reason}${r.skipped.length > 1 ? ', …' : ''})`
          : 'no invoices in this period'
        toast.push('warning', `No e-way bills written — ${why}`)
      }
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const perRowEwbJson = async (voucherId: number): Promise<void> => {
    setBusy(voucherId)
    try {
      const r = await api.edoc.ewbJson(voucherId)
      toast.push('success', `EWB JSON written — ${r.path}`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const requestGenerate = (kind: 'irn' | 'ewb', voucherId: number): void => {
    if (liveApiConfirmed) {
      void (kind === 'irn' ? generateIrn(voucherId) : generateEwb(voucherId))
    } else {
      setConfirming({ kind, voucherId })
    }
  }

  const generateIrn = async (voucherId: number): Promise<void> => {
    setBusy(voucherId)
    try {
      const r = await api.nic.generateIrn(voucherId)
      toast.push('success', `IRN generated — ack ${r.ackNo}`)
      await queryClient.invalidateQueries({ queryKey: ['edocList'] })
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(null)
    }
  }
  const generateEwb = async (voucherId: number): Promise<void> => {
    setBusy(voucherId)
    try {
      const r = await api.nic.generateEwb(voucherId)
      toast.push('success', `e-Way bill ${r.ewbNo} generated`)
      await queryClient.invalidateQueries({ queryKey: ['edocList'] })
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mx-auto max-w-6xl">
      <SectionTitle
        right={
          <div className="flex items-center gap-2">
            <Select
              className="w-40"
              data-testid="input-edocs-doctype"
              value={docTypeFilter}
              onChange={(e) => setDocTypeFilter(e.target.value as DocTypeFilter)}
            >
              {DOC_TYPE_FILTERS.map((f) => (
                <option key={f.value} value={f.value}>{f.label}</option>
              ))}
            </Select>
            <Button onClick={() => nav.go({ name: 'settings', tab: 'nic' })}>
              {live ? 'Live filing ✓ · Configure in Settings →' : 'Configure in Settings →'}
            </Button>
            <Button variant="primary" data-testid="btn-edocs-export-einvoice" onClick={() => void exportEinv()} disabled={!info?.gstin}>
              Export e-invoice JSON
            </Button>
            <Button data-testid="btn-edocs-export-ewb" onClick={() => void exportEwb()} disabled={!info?.gstin}>
              Export e-way bill JSON
            </Button>
          </div>
        }
      >
        e-Invoice &amp; e-Way bill
      </SectionTitle>

      {!info?.gstin && <p className="mb-3 text-[12.5px] text-amber">Add the company GSTIN under Company details to enable exports.</p>}

      <Panel scroll={{ maxH: 'calc(100vh - 15rem)' }}>
        {isLoading ? (
          <SkeletonRows />
        ) : rows.length === 0 ? (
          <EmptyState title={allRows.length === 0 ? 'No documents in this period' : 'No documents match this filter'} />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th className="w-20">Date</th>
                <th className="w-20">No.</th>
                <th className="w-16">Type</th>
                <th>Buyer</th>
                <th className="w-36">GSTIN</th>
                <th className="r w-28">Value</th>
                <th className="w-32">IRN / EWB</th>
                <th className="w-44">EWB eligibility</th>
                <th className="r w-52"></th>
              </tr>
            </thead>
            <tbody data-testid="rows-edocs">
              {rows.map((r) => (
                <tr key={r.voucherId} data-row-id={r.voucherId}>
                  <td className="num text-muted">{toDisplayDate(r.date)}</td>
                  <td className="num">
                    {r.number}
                    {!r.hasHsn && (
                      <span className="ml-1 text-amber" title="No stock item on this document carries an HSN code — e-invoice/EWB JSON will be rejected. Set HSN on the items (Masters → Items).">
                        ⚠
                      </span>
                    )}
                  </td>
                  <td>
                    <span
                      className={`inline-block rounded border border-line px-1.5 py-0.5 text-[10.5px] font-medium ${DOC_TYPE_CLASS[r.docType]}`}
                      title={r.docType === 'CRN' ? 'Credit note' : r.docType === 'DBN' ? 'Debit note' : 'Invoice'}
                    >
                      {r.docType}
                    </span>
                    {r.outwardDbn && (
                      <span
                        className="ml-1 inline-block rounded border border-amber/50 bg-amber/10 px-1.5 py-0.5 text-[10.5px] font-medium text-amber"
                        title="Outward debit note — the NIC bulk docType enum has no DBN, so it exports as 'OTH'."
                      >
                        OTH
                      </span>
                    )}
                  </td>
                  <td>{r.partyName ?? 'Cash sale'}</td>
                  <td className="num text-muted">{r.partyGstin ?? '—'}</td>
                  <td className="r"><Money paise={r.total} /></td>
                  <td className="text-[11.5px]">
                    {r.irn ? <span className="text-dr" title={r.irn}>IRN ✓</span> : <span className="text-muted">no IRN</span>}
                    {' · '}
                    {r.ewbNo ? <span className="num text-dr">{r.ewbNo}</span> : <span className="text-muted">no EWB</span>}
                    {latestByVoucher.get(r.voucherId)&&<span className="mt-0.5 block text-[9px] capitalize text-muted">{latestByVoucher.get(r.voucherId)!.kind} · {latestByVoucher.get(r.voucherId)!.status.replace('_',' ')}</span>}
                  </td>
                  <td className="text-[11.5px]">
                    {r.ewbReason == null ? (
                      <span className="text-dr">Eligible</span>
                    ) : (
                      <span className="text-muted" title={r.ewbReason}>{r.ewbReason}</span>
                    )}
                  </td>
                  <td className="r whitespace-nowrap">
                    {live && r.partyGstin && !r.irn && (
                      <button
                        className="mr-2 text-[12px] text-blue hover:underline disabled:opacity-40"
                        disabled={busy === r.voucherId}
                        onClick={() => requestGenerate('irn', r.voucherId)}
                      >
                        Generate IRN
                      </button>
                    )}
                    {live && r.irn && !r.ewbNo && (
                      <button
                        className="mr-2 text-[12px] text-blue hover:underline disabled:opacity-40"
                        disabled={busy === r.voucherId}
                        onClick={() => requestGenerate('ewb', r.voucherId)}
                      >
                        Generate EWB
                      </button>
                    )}
                    {r.docType !== 'CRN' && (
                      <button
                        className="mr-2 text-[12px] text-blue hover:underline disabled:opacity-40"
                        data-testid="btn-edocs-ewb-json"
                        disabled={busy === r.voucherId}
                        title="Write this bill's single-bill EWB JSON (overrides the ₹50,000 threshold)"
                        onClick={() => void perRowEwbJson(r.voucherId)}
                      >
                        EWB JSON
                      </button>
                    )}
                    <button
                      className="mr-2 text-[12px] text-blue hover:underline"
                      data-testid="btn-edocs-transport"
                      onClick={() => setTransportFor({ voucherId: r.voucherId, number: r.number })}
                    >
                      Transport
                    </button>
                    <button className="mr-2 text-[12px] text-blue hover:underline" onClick={()=>setLifecycleFor({voucherId:r.voucherId,number:r.number})}>Lifecycle</button>
                    <button
                      className="mr-2 text-[12px] text-blue hover:underline"
                      onClick={() => {
                        api.invoice.pdf(r.voucherId).catch((err: Error) => toast.push('error', err.message))
                      }}
                    >
                      PDF
                    </button>
                    <button className="text-[12px] text-muted hover:text-ink" onClick={() => nav.go({ name: 'voucher-entry', voucherId: r.voucherId })}>
                      Open
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      <p className="mt-2 text-[11.5px] text-muted">
        Offline route: export JSON for the government offline tools — the period export writes one combined bulk file plus a per-bill file per consignment. Live route: add your NIC API credentials once, then generate IRNs and e-way bills directly — needs internet and a registered API user (einvoice1.gst.gov.in → API registration) or GSP credentials.
      </p>

      {confirming && (
        <LiveApiConfirmModal
          onCancel={() => setConfirming(null)}
          onConfirm={(dontAskAgain) => {
            if (dontAskAgain) liveApiConfirmed = true
            const { kind, voucherId } = confirming
            setConfirming(null)
            void (kind === 'irn' ? generateIrn(voucherId) : generateEwb(voucherId))
          }}
        />
      )}

      {transportFor && (
        <TransportModal
          voucherId={transportFor.voucherId}
          voucherNumber={transportFor.number}
          onClose={() => {
            setTransportFor(null)
            void queryClient.invalidateQueries({ queryKey: ['edocList'] })
          }}
        />
      )}
      {lifecycleFor&&<EdocLifecycleModal target={lifecycleFor} events={(events??[]).filter((event)=>event.voucherId===lifecycleFor.voucherId)} onClose={()=>setLifecycleFor(null)} onSaved={async()=>{await queryClient.invalidateQueries({queryKey:['edocEvents']})}}/>}
    </div>
  )
}

function EdocLifecycleModal({target,events,onClose,onSaved}:{target:{voucherId:number;number:string};events:EdocEvent[];onClose:()=>void;onSaved:()=>Promise<void>}):React.JSX.Element{
  const toast=useToasts();const [kind,setKind]=useState<EdocEvent['kind']>('eway');const [status,setStatus]=useState<EdocEvent['status']>('vehicle_updated');const [documentNo,setDocumentNo]=useState('');const [validUntil,setValidUntil]=useState(todayISO());const [vehicleNo,setVehicleNo]=useState('');const [reason,setReason]=useState('');const [saving,setSaving]=useState(false)
  const save=async()=>{setSaving(true);try{await api.edoc.eventAdd({voucherId:target.voucherId,kind,status,requestKey:null,documentNo:documentNo.trim()||null,validUntil:status==='extended'||status==='generated'?validUntil:null,vehicleNo:status==='vehicle_updated'?vehicleNo.trim()||null:null,reason:reason.trim()||null});await onSaved();toast.push('success','Document lifecycle updated');setReason('');setSaving(false)}catch(error){toast.push('error',error instanceof Error?error.message:String(error));setSaving(false)}}
  return <Modal title={`Document lifecycle · ${target.number}`} onClose={onClose} wide><div className="grid grid-cols-[1fr_1.15fr] gap-4"><div><p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted">History</p>{!events.length?<EmptyState title="No lifecycle events yet"/>:<div className="max-h-80 overflow-y-auto rounded-md border border-line">{events.map((event)=><div key={event.id} className="border-b border-line px-3 py-2.5 last:border-0"><div className="flex justify-between"><span className="text-[11px] font-semibold capitalize">{event.kind} · {event.status.replace('_',' ')}</span><span className="num text-[9px] text-muted">{event.occurredAt.slice(0,16)}</span></div><p className="mt-1 text-[9.5px] text-muted">{event.documentNo??event.reason??event.vehicleNo??'Evidence recorded'} · {event.actor}</p></div>)}</div>}</div><div><p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted">Record portal update</p><div className="space-y-3"><div className="grid grid-cols-2 gap-3"><Field label="Document"><Select value={kind} onChange={(e)=>setKind(e.target.value as typeof kind)}><option value="einvoice">E-invoice / IRN</option><option value="eway">E-way bill</option></Select></Field><Field label="Status"><Select value={status} onChange={(e)=>setStatus(e.target.value as typeof status)}><option value="pending">Pending</option><option value="generated">Generated</option><option value="failed">Failed</option><option value="cancelled">Cancelled</option>{kind==='eway'&&<><option value="extended">Extended</option><option value="vehicle_updated">Vehicle updated</option><option value="expired">Expired</option></>}</Select></Field></div><Field label="IRN / EWB number"><TextInput value={documentNo} onChange={(e)=>setDocumentNo(e.target.value)}/></Field>{(status==='generated'||status==='extended')&&<Field label="Valid until"><DateInput value={validUntil} context={todayISO()} onChange={setValidUntil}/></Field>}{status==='vehicle_updated'&&<Field label="Vehicle number"><TextInput value={vehicleNo} onChange={(e)=>setVehicleNo(e.target.value.toUpperCase())}/></Field>}<Field label="Reason / portal note"><TextInput value={reason} onChange={(e)=>setReason(e.target.value)}/></Field><div className="flex justify-end gap-2"><Button onClick={onClose}>Close</Button><Button variant="primary" disabled={saving} onClick={()=>void save()}>Record event</Button></div></div></div></div></Modal>
}


function LiveApiConfirmModal({
  onCancel,
  onConfirm
}: {
  onCancel: () => void
  onConfirm: (dontAskAgain: boolean) => void
}): React.JSX.Element {
  const [understood, setUnderstood] = useState(false)
  const [dontAskAgain, setDontAskAgain] = useState(false)

  return (
    <Modal title="Live government API call" onClose={onCancel}>
      <p className="text-[13px] text-ink">
        This calls the live NIC e-invoice/e-way bill API — a real document will be generated with the government. This
        integration has never been tested against the live portal; verify the result there afterwards.
      </p>
      <label className="mt-4 flex items-start gap-2 text-[13px]">
        <input type="checkbox" className="mt-0.5" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
        I understand this calls the live government API
      </label>
      <label className="mt-2 flex items-start gap-2 text-[12px] text-muted">
        <input type="checkbox" className="mt-0.5" checked={dontAskAgain} onChange={(e) => setDontAskAgain(e.target.checked)} />
        Don't ask again this session
      </label>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" disabled={!understood} onClick={() => onConfirm(dontAskAgain)}>
          Continue
        </Button>
      </div>
    </Modal>
  )
}
