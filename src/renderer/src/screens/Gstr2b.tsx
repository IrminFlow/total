import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type ItcActionRow } from '../lib/client'
import { useNav, useToasts, nextDraftId } from '../state/stores'
import { Button, DateInput, EmptyState, Field, Modal, Money, Panel, SectionTitle, Select, TextInput } from '../components/ui'
import { ReportToolbar } from '../components/ReportToolbar'
import { toDisplayDate, todayISO } from '@shared/dates'
import type { Recon2bBucket, Recon2bPair } from '@shared/gst/recon2b'
import { MonthBar, NoMonths, useMonth } from './GstReturns'

const BUCKETS: { key: Recon2bBucket; label: string }[] = [
  { key: 'matched', label: 'Matched' },
  { key: 'amountMismatch', label: 'Amount mismatch' },
  { key: 'taxMismatch', label: 'Tax mismatch' },
  { key: 'missingInBooks', label: 'Missing in books' },
  { key: 'missingInPortal', label: 'Missing in portal' }
]

interface Imported {
  jsonText: string
  fileName?: string
}

function PasteModal({ onClose, onApply }: { onClose: () => void; onApply: (jsonText: string) => void }): React.JSX.Element {
  const [text, setText] = useState('')
  return (
    <Modal title="Paste GSTR-2B JSON" onClose={onClose}>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={10}
        autoFocus
        data-testid="input-2b-paste"
        placeholder="Paste the contents of the downloaded GSTR-2B JSON here…"
        className="num w-full rounded-md border border-line bg-panel2 px-2.5 py-1.5 text-[11px]"
      />
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          data-testid="btn-2b-paste-apply"
          disabled={text.trim().length < 2}
          onClick={() => {
            onApply(text)
            onClose()
          }}
        >
          Reconcile
        </Button>
      </div>
    </Modal>
  )
}

function taxTotal(t: { igst: number; cgst: number; sgst: number; cess: number }): number {
  return t.igst + t.cgst + t.sgst + t.cess
}

function PairRow({
  pair,
  onOpenVoucher,
  onCreatePurchase
}: {
  pair: Recon2bPair
  onOpenVoucher: (voucherId: number) => void
  onCreatePurchase: (portal: NonNullable<Recon2bPair['portal']>) => void
}): React.JSX.Element {
  const { portal, book } = pair
  const clickable = !!book
  return (
    <tr
      className={clickable ? 'kbar-row cursor-pointer' : ''}
      onClick={clickable ? () => onOpenVoucher(book!.voucherId) : undefined}
    >
      <td>{portal ? portal.number : <span className="text-muted">—</span>}</td>
      <td className="num text-muted">{portal ? toDisplayDate(portal.date) : '—'}</td>
      <td className="r">{portal ? <Money paise={portal.value} /> : '—'}</td>
      <td className="r">{portal ? <Money paise={taxTotal(portal)} /> : '—'}</td>
      <td>
        {book ? (
          book.supplierRef ?? book.number
        ) : pair.bucket === 'missingInBooks' && portal ? (
          <button
            className="text-[12px] text-blue hover:underline"
            data-testid="btn-2b-create-purchase"
            onClick={(e) => {
              e.stopPropagation()
              onCreatePurchase(portal)
            }}
          >
            Create purchase
          </button>
        ) : (
          <span className="text-muted">—</span>
        )}
      </td>
      <td className="num text-muted">{book ? toDisplayDate(book.date) : '—'}</td>
      <td className="r">{book ? <Money paise={book.invoiceValue} /> : '—'}</td>
      <td className="r">{book ? <Money paise={taxTotal(book)} /> : '—'}</td>
      <td className="r">{pair.valueDiffPaise != null ? <Money paise={pair.valueDiffPaise} signed /> : '—'}</td>
    </tr>
  )
}

export function Gstr2bScreen(): React.JSX.Element {
  const { months, month, monthKey, setMonthKey } = useMonth()
  const nav = useNav()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [imported, setImported] = useState<Imported | null>(null)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [bucket, setBucket] = useState<Recon2bBucket>('matched')
  const [saving, setSaving] = useState(false)
  const [editingAction, setEditingAction] = useState<ItcActionRow | null>(null)

  const { data, isFetching } = useQuery({
    queryKey: ['gstr2b', month?.key, imported?.jsonText],
    queryFn: () => api.gst.recon2b(imported!.jsonText, month!.from, month!.to),
    enabled: !!imported && !!month
  })

  // Toast only once per newly-imported JSON — react-query gives back a fresh `data` object on
  // every refetch (e.g. month change, window refocus) even when the underlying import hasn't
  // changed, so gate on a ref of the last jsonText we've already toasted for.
  const lastToastedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!data || !imported) return
    if (lastToastedRef.current === imported.jsonText) return
    lastToastedRef.current = imported.jsonText
    if (data.errors.length) {
      toast.push('warning', `${data.errors.length} entr${data.errors.length > 1 ? 'ies' : 'y'} in the 2B JSON could not be parsed and were skipped`)
    }
    if (month && data.period && data.period !== month.period) {
      toast.push('warning', `The JSON is for period ${data.period}, but ${month.label} is selected — showing figures for the selected month`)
    }
    const firstException = (['taxMismatch','amountMismatch','missingInPortal','missingInBooks'] as Recon2bBucket[]).find((key) => data.result.buckets[key].count > 0)
    if (data.result.buckets.matched.count === 0 && firstException) setBucket(firstException)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, imported])

  const doPick = async (): Promise<void> => {
    try {
      const r = await api.gst.recon2bPickFile()
      if (!r) return
      setImported(r)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const openVoucher = (voucherId: number): void => nav.go({ name: 'voucher-entry', voucherId })

  // Party can't be guessed from the portal's GSTIN alone (no ledger lookup by GSTIN yet) — leave
  // it to the user, just hand over what the portal already told us.
  const createPurchase = (portal: NonNullable<Recon2bPair['portal']>): void => {
    nav.go({
      name: 'voucher-entry',
      kindHint: 'purchase',
      draftId: nextDraftId(),
      draft: {
        date: portal.date,
        narration: `2B ${portal.number} ${portal.gstin}`
      }
    })
  }

  const result = data?.result
  const pairs = result?.pairs.filter((p) => p.bucket === bucket) ?? []
  const { data: imports } = useQuery({ queryKey: ['gstr2bImports', month?.period], queryFn: () => api.gst.recon2bImports(month!.period), enabled:!!month })
  const { data: actions } = useQuery({ queryKey: ['itcActions', month?.period], queryFn: () => api.gst.itcActions(month!.period), enabled:!!month })
  const persist = async (): Promise<void> => {
    if (!imported || !month) return
    setSaving(true)
    try {
      const saved = await api.gst.recon2bSave(imported.jsonText, imported.fileName ?? null, month.from, month.to, month.period)
      await Promise.all([queryClient.invalidateQueries({queryKey:['gstr2bImports']}),queryClient.invalidateQueries({queryKey:['itcActions']})])
      toast.push(saved.duplicate?'warning':'success',saved.duplicate?'This exact 2B file is already retained':'2B evidence retained and ITC exceptions added to the action queue')
    } catch(error){toast.push('error',error instanceof Error?error.message:String(error))} finally {setSaving(false)}
  }

  if (!month) {
    return (
      <div className="mx-auto max-w-6xl">
        <SectionTitle>GSTR-2B · Reconciliation</SectionTitle>
        <NoMonths />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-6xl">
      <SectionTitle>GSTR-2B · Reconciliation</SectionTitle>
      <ReportToolbar
        ariaLabel="GSTR-2B reconciliation controls"
        className="mb-3"
        status={<span className="num">{month.label}</span>}
        period={<MonthBar months={months} value={monthKey} onChange={setMonthKey} />}
        actions={
          <div className="flex items-center gap-2">
            <Button data-testid="btn-2b-pick" onClick={() => void doPick()}>Pick 2B JSON…</Button>
            <Button variant="ghost" data-testid="btn-2b-paste" onClick={() => setPasteOpen(true)}>
              Paste JSON…
            </Button>
            {imported && <Button variant="primary" disabled={saving} onClick={() => void persist()}>{saving?'Saving…':'Retain evidence'}</Button>}
          </div>
        }
      />

      {pasteOpen && (
        <PasteModal
          onClose={() => setPasteOpen(false)}
          onApply={(jsonText) => setImported({ jsonText, fileName: 'Pasted 2B JSON' })}
        />
      )}

      {!imported ? (
        <Panel>
          <EmptyState
            title="Import a GSTR-2B JSON to reconcile ITC against your books"
            hint="On the GST portal: Returns → GSTR-2B → Download JSON for the period, then pick the file here."
          />
        </Panel>
      ) : isFetching && !result ? (
        <Panel>
          <EmptyState title="Reconciling…" />
        </Panel>
      ) : result ? (
        <>
          <div className="mb-3 flex flex-wrap gap-2">
            {BUCKETS.map((b) => {
              const t = result.buckets[b.key]
              return (
                <button
                  key={b.key}
                  data-testid={`btn-2b-bucket-${b.key}`}
                  onClick={() => setBucket(b.key)}
                  className={`rounded-md border px-3 py-1.5 text-[12.5px] ${
                    bucket === b.key ? 'border-amber/60 bg-amber/15 text-amber' : 'border-line text-muted hover:bg-panel2 hover:text-ink'
                  }`}
                >
                  {b.label} <span className="num">{t.count}</span> · <Money paise={taxTotal(t)} />
                </button>
              )
            })}
          </div>

          {imported.fileName && (
            <p className="mb-2 text-[12px] text-muted">
              {imported.fileName}
              {result.pairs.length > 0 && ` · ${result.pairs.length} document${result.pairs.length > 1 ? 's' : ''} compared`}
            </p>
          )}

          <Panel>
            {pairs.length === 0 ? (
              <EmptyState title="Nothing in this bucket" />
            ) : (
              <div className="overflow-x-auto">
                <table className="ledger-table min-w-[56rem]">
                  <thead>
                    <tr>
                      <th colSpan={4}>Portal (GSTR-2B)</th>
                      <th colSpan={4}>Books</th>
                      <th className="w-24">Diff</th>
                    </tr>
                    <tr>
                      <th>No.</th>
                      <th className="w-24">Date</th>
                      <th className="r w-28">Value</th>
                      <th className="r w-28">Tax</th>
                      <th>No. (supplier ref)</th>
                      <th className="w-24">Date</th>
                      <th className="r w-28">Value</th>
                      <th className="r w-28">Tax</th>
                      <th className="r">Value</th>
                    </tr>
                  </thead>
                  <tbody data-testid="rows-2b-pairs">
                    {pairs.map((p, i) => (
                      <PairRow key={i} pair={p} onOpenVoucher={openVoucher} onCreatePurchase={createPurchase} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
          <Panel className="mt-3 overflow-hidden p-0" data-testid="itc-action-queue">
            <div className="flex items-center justify-between border-b border-line bg-panel2/55 px-4 py-3"><div><p className="text-[11.5px] font-semibold">ITC action queue</p><p className="text-[9.5px] text-muted">Missing, mismatched, blocked and reversed credit follow-up retained by period.</p></div><span className="num text-[10px] text-muted">{imports?.length??0} retained import{imports?.length===1?'':'s'} · {actions?.filter((row)=>row.status==='open'||row.status==='waiting_supplier').length??0} active</span></div>
            {!actions?.length?<EmptyState title="No retained ITC exceptions for this period" hint="Reconcile a 2B file, review it, then retain the evidence."/>:<table className="ledger-table"><thead><tr><th>Document</th><th className="w-28">Class</th><th className="w-32">Status</th><th className="w-32">Owner</th><th className="w-24">Due</th><th className="r w-24"></th></tr></thead><tbody>{actions.map((action)=><tr key={action.id}><td><span className="font-medium">{String(action.portal?.number??action.book?.supplierRef??action.book?.number??action.sourceKey)}</span><span className="block text-[9px] text-muted">{action.bucket}</span></td><td className="capitalize">{action.classification.replace('_',' ')}</td><td className="capitalize">{action.status.replace('_',' ')}</td><td>{action.owner??'—'}</td><td className="num text-muted">{action.dueDate?toDisplayDate(action.dueDate):'—'}</td><td className="r"><Button onClick={()=>setEditingAction(action)}>Review</Button></td></tr>)}</tbody></table>}
          </Panel>
        </>
      ) : null}
      {editingAction&&<ItcActionModal action={editingAction} onClose={()=>setEditingAction(null)} onSaved={async()=>{setEditingAction(null);await queryClient.invalidateQueries({queryKey:['itcActions']})}}/>}
    </div>
  )
}

function ItcActionModal({action,onClose,onSaved}:{action:ItcActionRow;onClose:()=>void;onSaved:()=>Promise<void>}):React.JSX.Element{
  const toast=useToasts();const [classification,setClassification]=useState(action.classification);const [status,setStatus]=useState(action.status);const [owner,setOwner]=useState(action.owner??'');const [dueDate,setDueDate]=useState(action.dueDate??todayISO());const [note,setNote]=useState(action.note??'');const [saving,setSaving]=useState(false)
  const save=async()=>{setSaving(true);try{await api.gst.itcActionUpdate({id:action.id,classification,status,owner:owner.trim()||null,dueDate:status==='resolved'||status==='dismissed'?null:dueDate,note:note.trim()||null});await onSaved();toast.push('success','ITC action updated')}catch(error){toast.push('error',error instanceof Error?error.message:String(error));setSaving(false)}}
  return <Modal title="Review ITC exception" onClose={onClose}><div className="space-y-3"><div className="grid grid-cols-2 gap-3"><Field label="Classification"><Select value={classification} onChange={(e)=>setClassification(e.target.value as typeof classification)}><option value="missing">Missing</option><option value="mismatched">Mismatched</option><option value="blocked">Blocked credit</option><option value="reversed">Reversed</option><option value="follow_up">Supplier follow-up</option></Select></Field><Field label="Status"><Select value={status} onChange={(e)=>setStatus(e.target.value as typeof status)}><option value="open">Open</option><option value="waiting_supplier">Waiting supplier</option><option value="resolved">Resolved</option><option value="dismissed">Dismissed</option></Select></Field></div><div className="grid grid-cols-2 gap-3"><Field label="Owner"><TextInput value={owner} onChange={(e)=>setOwner(e.target.value)}/></Field><Field label="Due date"><DateInput value={dueDate} context={todayISO()} onChange={setDueDate}/></Field></div><Field label="Review note"><TextInput value={note} onChange={(e)=>setNote(e.target.value)}/></Field><div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={saving} onClick={()=>void save()}>Save review</Button></div></div></Modal>
}
