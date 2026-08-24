import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarCheck, CheckCircle, ClockCountdown, PhoneCall, WarningCircle } from '@phosphor-icons/react'
import type { CollectionQueueRow } from '@shared/collections'
import { toDisplayDate, todayISO } from '@shared/dates'
import { formatPaise } from '@shared/money'
import { api } from '../lib/client'
import { useNav, useSession, useToasts } from '../state/stores'
import { AmountInput, Button, DateInput, Field, Modal, Money, Panel, SectionTitle, Select, SkeletonRows, TextInput } from '../components/ui'
import { promptDialog } from '../lib/dialogs'

export function CollectionsScreen(): React.JSX.Element {
  const asOn = todayISO()
  const nav = useNav()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [promiseFor, setPromiseFor] = useState<CollectionQueueRow | null>(null)
  const [expanded, setExpanded] = useState<number | null>(null)
  const [workspaceFor, setWorkspaceFor] = useState<CollectionQueueRow | null>(null)
  const [receiptOpen, setReceiptOpen] = useState(false)
  const [workloadOpen, setWorkloadOpen] = useState(false)
  const query = useQuery({ queryKey: ['collections', asOn], queryFn: () => api.collections.queue(asOn) })
  const rows = query.data ?? []
  const metrics = useMemo(() => ({
    total: rows.reduce((sum, row) => sum + row.pending, 0),
    overdue: rows.reduce((sum, row) => sum + row.overdueAmount, 0),
    critical: rows.filter((row) => row.priority === 'critical').length,
    promises: rows.filter((row) => row.nextPromise).length
  }), [rows])

  const resolve = async (row: CollectionQueueRow, status: 'kept' | 'broken' | 'cancelled'): Promise<void> => {
    if (!row.nextPromise) return
    const note = await promptDialog({ title: `${status === 'kept' ? 'Promise kept' : status === 'broken' ? 'Promise broken' : 'Cancel promise'}`, message: 'Add an outcome note for the collection history.', placeholder: 'Outcome note', confirmLabel: 'Record outcome' })
    if (note === null) return
    try {
      await api.collections.resolvePromise(row.nextPromise.id, status, note || null)
      await queryClient.invalidateQueries({ queryKey: ['collections'] })
      toast.push('success', 'Promise outcome recorded')
    } catch (error) { toast.push('error', (error as Error).message) }
  }

  return <div className="mx-auto max-w-5xl" data-testid="collections-screen">
    <SectionTitle right={<div className="flex items-center gap-2"><span className="num mr-2 text-[12px] text-muted">today · {toDisplayDate(asOn)}</span><Button data-testid="btn-receipt-matcher" onClick={() => setReceiptOpen(true)}>Match receipt…</Button><Button onClick={() => setWorkloadOpen(true)}>Owner workload</Button></div>}>Collections queue</SectionTitle>
    <div className="mb-3 grid grid-cols-4 gap-2">
      <Metric icon={<PhoneCall size={16} />} label="Total exposure" value={<Money paise={metrics.total} />} />
      <Metric icon={<ClockCountdown size={16} />} label="Overdue" value={<Money paise={metrics.overdue} />} />
      <Metric icon={<WarningCircle size={16} />} label="Critical parties" value={metrics.critical} />
      <Metric icon={<CalendarCheck size={16} />} label="Open promises" value={metrics.promises} />
    </div>
    <Panel>
      <div className="grid grid-cols-[68px_1fr_120px_120px_145px_110px] gap-3 border-b border-line bg-panel2 px-4 py-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted">
        <span>Priority</span><span>Party</span><span className="text-right">Overdue</span><span className="text-right">Exposure</span><span>Next promise</span><span></span>
      </div>
      {rows.length === 0 && <div className="px-4 py-12 text-center text-[12.5px] text-muted">No receivables need collection as on this date.</div>}
      {rows.map((row) => <div key={row.ledgerId} className="border-b border-line last:border-0">
        <div className="grid min-h-[68px] grid-cols-[68px_1fr_120px_120px_145px_110px] items-center gap-3 px-4 py-2.5">
          <span className={`w-fit rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${row.priority === 'critical' ? 'bg-cr/10 text-cr' : row.priority === 'high' ? 'bg-amber/15 text-amber' : 'bg-panel2 text-muted'}`}>{row.priority}</span>
          <button className="min-w-0 text-left" onClick={() => setExpanded(expanded === row.ledgerId ? null : row.ledgerId)}><span className="block truncate text-[13px] font-semibold">{row.name}</span><span className="mt-0.5 block text-[10.5px] text-muted">{row.reason} · {row.bills.length} bill{row.bills.length === 1 ? '' : 's'}</span></button>
          <span className="text-right"><Money paise={row.overdueAmount} /></span>
          <span className="text-right font-medium"><Money paise={row.pending} /></span>
          <span className="text-[11px]">{row.nextPromise ? <><span className={row.nextPromise.promisedDate < asOn ? 'text-cr' : ''}>{toDisplayDate(row.nextPromise.promisedDate)}</span><span className="block truncate text-muted"><Money paise={row.nextPromise.amount} /> · {row.nextPromise.owner}</span></> : <span className="text-muted">None</span>}</span>
          <Button data-testid={`btn-promise-${row.ledgerId}`} onClick={() => row.nextPromise ? setExpanded(row.ledgerId) : setPromiseFor(row)}>{row.nextPromise ? 'Review' : 'Set promise'}</Button>
        </div>
        {expanded === row.ledgerId && <div className="border-t border-line bg-panel2/55 px-4 py-3">
          <div className="mb-2 flex items-center justify-between"><div className="flex gap-3"><button onClick={() => nav.go({ name: 'ledger-statement', ledgerId: row.ledgerId })} className="text-[11.5px] font-medium text-blue hover:underline">Generate statement →</button><button data-testid={`btn-customer-workspace-${row.ledgerId}`} onClick={() => setWorkspaceFor(row)} className="text-[11.5px] font-medium text-blue hover:underline">Customer workspace →</button></div>{row.nextPromise && <div className="flex gap-1.5"><Button onClick={() => void resolve(row, 'kept')}>Kept</Button><Button onClick={() => void resolve(row, 'broken')}>Broken</Button><Button variant="ghost" onClick={() => void resolve(row, 'cancelled')}>Cancel promise</Button></div>}</div>
          <div className="grid gap-1">{row.bills.map((bill, index) => <button key={`${bill.number}-${index}`} onClick={() => bill.voucherId && nav.go({ name: 'voucher-entry', voucherId: bill.voucherId })} className="grid grid-cols-[1fr_120px_120px] rounded px-2 py-1 text-left text-[11.5px] hover:bg-panel"><span>{bill.number} · {toDisplayDate(bill.date)}</span><span className={bill.overdueDays ? 'text-cr' : 'text-muted'}>{bill.overdueDays ? `${bill.overdueDays}d overdue` : 'Not due'}</span><span className="text-right"><Money paise={bill.pending} /></span></button>)}</div>
        </div>}
      </div>)}
    </Panel>
    <p className="mt-2 text-[11px] text-muted">Priority is explainable: overdue value, oldest due date, broken promises and missed promise dates. Promises never change accounting balances.</p>
    {promiseFor && <PromiseModal row={promiseFor} onClose={() => setPromiseFor(null)} onSaved={async () => { setPromiseFor(null); await queryClient.invalidateQueries({ queryKey: ['collections'] }) }} />}
    {workspaceFor && <CustomerWorkspaceModal row={workspaceFor} asOn={asOn} onClose={() => setWorkspaceFor(null)} />}
    {receiptOpen && <ReceiptMatcherModal asOn={asOn} onClose={() => setReceiptOpen(false)} />}
    {workloadOpen && <OwnerWorkloadModal asOn={asOn} onClose={() => setWorkloadOpen(false)} />}
  </div>
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }): React.JSX.Element {
  return <Panel className="px-3 py-2.5"><div className="flex items-center gap-1.5 text-muted">{icon}<span className="text-[10px] font-semibold uppercase tracking-[0.08em]">{label}</span></div><p className="mt-1.5 text-[15px] font-semibold">{value}</p></Panel>
}

function PromiseModal({ row, onClose, onSaved }: { row: CollectionQueueRow; onClose: () => void; onSaved: () => Promise<void> }): React.JSX.Element {
  const { user } = useSession()
  const toast = useToasts()
  const [amount, setAmount] = useState<number | null>(row.pending)
  const [date, setDate] = useState(() => { const next = new Date(`${todayISO()}T00:00:00Z`); next.setUTCDate(next.getUTCDate() + 7); return next.toISOString().slice(0, 10) })
  const [owner, setOwner] = useState(user?.name ?? '')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  return <Modal title={`Promise to pay · ${row.name}`} onClose={onClose}>
    <div className="grid grid-cols-2 gap-3"><Field label="Amount"><AmountInput paise={amount} onPaise={setAmount} ariaLabel="Promised amount" testId="input-promise-amount" /></Field><Field label="Promised date"><DateInput value={date} context={todayISO()} onChange={setDate} testId="input-promise-date" /></Field></div>
    <div className="mt-3"><Field label="Owner"><TextInput data-testid="input-promise-owner" value={owner} onChange={(event) => setOwner(event.target.value)} placeholder="Who will follow up?" /></Field></div>
    <div className="mt-3"><Field label="Note"><TextInput data-testid="input-promise-note" value={note} onChange={(event) => setNote(event.target.value)} placeholder="Call context or commitment" /></Field></div>
    <div className="mt-5 flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button data-testid="btn-save-promise" variant="primary" disabled={saving || !amount || !owner.trim()} onClick={async () => { setSaving(true); try { await api.collections.savePromise({ ledgerId: row.ledgerId, amount: amount!, promisedDate: date, owner, note: note || null }); await onSaved(); toast.push('success', 'Promise added to the collection queue') } catch (error) { toast.push('error', (error as Error).message); setSaving(false) } }}>Save promise</Button></div>
  </Modal>
}

function CustomerWorkspaceModal({ row, asOn, onClose }: { row: CollectionQueueRow; asOn: string; onClose: () => void }): React.JSX.Element {
  const nav = useNav()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const query = useQuery({ queryKey: ['collection-workspace', row.ledgerId, asOn], queryFn: () => api.collections.workspace(row.ledgerId, asOn) })
  const data = query.data
  const [owner, setOwner] = useState('')
  const [cadence, setCadence] = useState('7,14,30')
  const [discount, setDiscount] = useState('0')
  const [earlyDays, setEarlyDays] = useState('0')
  const [seeded, setSeeded] = useState(false)
  useEffect(() => { if (data && !seeded) { setOwner(data.settings.owner); setCadence(data.settings.reminderDays.join(',')); setDiscount(String(data.settings.earlyDiscountBps / 100)); setEarlyDays(String(data.settings.earlyDays)); setSeeded(true) } }, [data, seeded])
  const refresh = async (): Promise<void> => { await queryClient.invalidateQueries({ queryKey: ['collection-workspace', row.ledgerId] }); await queryClient.invalidateQueries({ queryKey: ['collections'] }) }
  if (!data) return <Modal title={`Customer workspace · ${row.name}`} onClose={onClose}><div className="p-5"><SkeletonRows rows={6} /></div></Modal>
  const saveSettings = async (): Promise<void> => {
    try { const reminderDays = cadence.split(',').map((value) => Number(value.trim())).filter(Number.isFinite); await api.collections.saveSettings(row.ledgerId, { owner, reminderDays, earlyDiscountBps: Math.round(Number(discount || 0) * 100), earlyDays: Number(earlyDays || 0) }); await refresh(); toast.push('success', 'Collection policy saved') } catch (error) { toast.push('error', (error as Error).message) }
  }
  const openDispute = async (voucherId: number): Promise<void> => { const reason = await promptDialog({ title: 'Mark invoice disputed', message: 'State the customer’s dispute clearly. It will be excluded from normal reminder cadence.', placeholder: 'Reason', confirmLabel: 'Open dispute' }); if (!reason) return; try { await api.collections.openDispute(row.ledgerId, voucherId, reason, owner || 'Unassigned'); await refresh() } catch (error) { toast.push('error', (error as Error).message) } }
  const note = async (): Promise<void> => { const body = await promptDialog({ title: 'Add collection note', message: 'This note appears in the customer timeline without changing the books.', placeholder: 'Call, email or context', confirmLabel: 'Add note' }); if (!body) return; await api.collections.addNote(row.ledgerId, body); await refresh() }
  const draft = async (item: typeof data.remindersDue[number]): Promise<void> => { const body = `Payment reminder for ${row.name}: invoice ${item.billNumber} is ${item.overdueDays} days overdue. Please share payment status or any dispute.`; await api.collections.draftReminder({ ledgerId: row.ledgerId, voucherId: item.voucherId, channel: 'email', body, dueDate: asOn }); await api.privacy.copySensitive(body); await refresh(); toast.push('success', 'Reviewed reminder draft copied') }
  return <Modal title={`Customer workspace · ${row.name}`} onClose={onClose} wide>
    <div data-testid="customer-workspace" className="max-h-[76vh] space-y-4 overflow-y-auto pr-1">
      <div className="grid grid-cols-4 gap-2"><Mini label="Risk" value={<span className={data.risk.band === 'high' ? 'text-cr' : data.risk.band === 'medium' ? 'text-amber' : 'text-dr'}>{data.risk.band} · {data.risk.score}</span>} /><Mini label="Customer DSO" value={data.dso.customerDays == null ? '—' : `${data.dso.customerDays} days`} /><Mini label="Company DSO" value={data.dso.companyDays == null ? '—' : `${data.dso.companyDays} days`} /><Mini label="Forecast" value={<Money paise={data.forecast.reduce((sum, item) => sum + item.amount, 0)} />} /></div>
      <div className="rounded-md border border-line bg-panel2 p-3"><div className="mb-2 flex items-center justify-between"><p className="text-[11px] font-semibold uppercase tracking-[.08em] text-muted">Ownership, cadence & early-pay policy</p><Button data-testid="btn-save-collection-settings" onClick={() => void saveSettings()}>Save policy</Button></div><div className="grid grid-cols-4 gap-2"><Field label="Owner"><TextInput value={owner} onChange={(event) => setOwner(event.target.value)} placeholder="Unassigned" /></Field><Field label="Reminder days"><TextInput className="num" value={cadence} onChange={(event) => setCadence(event.target.value)} /></Field><Field label="Early discount %"><TextInput className="num" value={discount} onChange={(event) => setDiscount(event.target.value)} /></Field><Field label="Pay within days"><TextInput className="num" value={earlyDays} onChange={(event) => setEarlyDays(event.target.value)} /></Field></div>{data.earlyPayment.discountAmount > 0 && <p className="mt-2 text-[10.5px] text-muted">Offer <Money paise={data.earlyPayment.discountAmount} /> discount; collect <Money paise={data.earlyPayment.payAmount} /> by {data.earlyPayment.expiresOn ? toDisplayDate(data.earlyPayment.expiresOn) : '—'} · annualized financing cost {data.earlyPayment.annualizedCostBps == null ? '—' : `${(data.earlyPayment.annualizedCostBps / 100).toFixed(2)}%`}</p>}</div>
      <div className="grid grid-cols-2 gap-3"><Panel className="p-3"><p className="mb-2 text-[11px] font-semibold uppercase tracking-[.08em] text-muted">Six-month ageing trend</p>{data.ageingTrend.map((item) => <div key={item.asOn} className="mb-1 grid grid-cols-[72px_1fr_90px] items-center gap-2 text-[10.5px]"><span className="num text-muted">{toDisplayDate(item.asOn)}</span><div className="flex h-2 overflow-hidden rounded bg-line">{item.buckets.map((amount, index) => <span key={index} className={['bg-dr/50','bg-blue/50','bg-amber/60','bg-cr/60'][index]} style={{ width: `${item.pending ? Math.max(2, amount * 100 / item.pending) : 0}%` }} />)}</div><span className="num text-right">{formatPaise(item.pending)}</span></div>)}</Panel><Panel className="p-3"><p className="mb-2 text-[11px] font-semibold uppercase tracking-[.08em] text-muted">Expected receipts</p>{data.forecast.slice(0, 7).map((item, index) => <div key={`${item.date}-${index}`} className="flex justify-between border-b border-line py-1 text-[10.5px] last:border-0"><span>{toDisplayDate(item.date)} · {item.label}<span className="ml-1 text-muted">{item.source.replace('_',' ')}</span></span><Money paise={item.amount} /></div>)}</Panel></div>
      {!!data.remindersDue.length && <Panel className="p-3"><p className="mb-2 text-[11px] font-semibold uppercase tracking-[.08em] text-muted">Cadence review due</p>{data.remindersDue.map((item, index) => <div key={`${item.voucherId}-${item.cadenceDay}-${index}`} className="flex items-center justify-between border-b border-line py-1.5 last:border-0"><span className="text-[11px]">{item.billNumber} · {item.overdueDays}d overdue · day-{item.cadenceDay} review</span><Button onClick={() => void draft(item)}>Review & draft</Button></div>)}</Panel>}
      {!!data.disputes.length && <Panel className="p-3"><p className="mb-2 text-[11px] font-semibold uppercase tracking-[.08em] text-muted">Disputes</p>{data.disputes.map((item) => <div key={item.id} className="flex items-center justify-between border-b border-line py-1.5 text-[11px] last:border-0"><span><span className={item.status === 'open' ? 'text-cr' : 'text-muted'}>{item.status}</span> · {item.reason} · {item.owner}</span>{item.status === 'open' && <Button onClick={async () => { const resolution = await promptDialog({ title: 'Resolve dispute', message: 'Record the resolution.', placeholder: 'Resolution', confirmLabel: 'Resolve' }); if (resolution) { await api.collections.resolveDispute(item.id, resolution); await refresh() } }}>Resolve</Button>}</div>)}</Panel>}
      <Panel className="p-3"><div className="mb-2 flex items-center justify-between"><p className="text-[11px] font-semibold uppercase tracking-[.08em] text-muted">Customer timeline</p><div className="flex gap-2"><Button onClick={() => nav.go({ name: 'ledger-statement', ledgerId: row.ledgerId })}>Branded statement</Button><Button onClick={() => void note()}>Add note</Button></div></div>{data.timeline.slice(0, 40).map((item) => <div key={item.id} className="grid grid-cols-[82px_95px_1fr_auto] gap-2 border-b border-line py-1.5 text-[10.5px] last:border-0"><span className="num text-muted">{toDisplayDate(item.at)}</span><span className="capitalize">{item.kind.replace('_',' ')}</span><button className="truncate text-left hover:text-blue" onClick={() => item.voucherId && nav.go({ name: 'voucher-entry', voucherId: item.voucherId })}>{item.title}<span className="ml-2 text-muted">{item.detail}</span></button><span className="flex items-center gap-2">{item.amount != null && <Money paise={item.amount} />}{item.kind === 'invoice' && item.voucherId && item.status !== 'disputed' && <Button onClick={() => void openDispute(item.voucherId!)}>Dispute</Button>}</span></div>)}</Panel>
      <div className="rounded-md border border-line px-3 py-2 text-[10.5px] text-muted">DSO uses current receivables ÷ trailing 90-day credit sales × 90. Risk is explainable: lateness, broken promises and open disputes. No score or forecast posts accounting entries.</div>
    </div>
  </Modal>
}

function Mini({ label, value }: { label: string; value: React.ReactNode }): React.JSX.Element { return <div className="rounded-md border border-line bg-panel2 px-3 py-2"><p className="text-[9.5px] font-semibold uppercase tracking-[.08em] text-muted">{label}</p><p className="mt-1 text-[13px] font-semibold capitalize">{value}</p></div> }

function ReceiptMatcherModal({ asOn, onClose }: { asOn: string; onClose: () => void }): React.JSX.Element {
  const nav = useNav(); const [amount, setAmount] = useState<number | null>(null); const [date, setDate] = useState(asOn); const [reference, setReference] = useState(''); const [payer, setPayer] = useState(''); const [results, setResults] = useState<Awaited<ReturnType<typeof api.collections.receiptSuggestions>>>([])
  return <Modal title="Incoming receipt matcher" onClose={onClose}><p className="mb-3 text-[12px] text-muted">Rank open invoices from amount, payer, reference and date clues. Suggestions never post or allocate automatically.</p><div className="grid grid-cols-2 gap-3"><Field label="Amount"><AmountInput paise={amount} onPaise={setAmount} /></Field><Field label="Receipt date"><DateInput value={date} context={asOn} onChange={setDate} /></Field><Field label="Bank reference"><TextInput value={reference} onChange={(event) => setReference(event.target.value)} /></Field><Field label="Payer clue"><TextInput value={payer} onChange={(event) => setPayer(event.target.value)} /></Field></div><div className="mt-3 flex justify-end"><Button data-testid="btn-run-receipt-match" variant="primary" disabled={!amount} onClick={async () => setResults(await api.collections.receiptSuggestions(amount!, date, reference, payer))}>Find matches</Button></div><div data-testid="receipt-match-results" className="mt-3 max-h-64 overflow-y-auto rounded-md border border-line">{results.map((item) => <button key={`${item.partyLedgerId}-${item.billNumber}`} onClick={() => item.voucherId && nav.go({ name: 'voucher-entry', voucherId: item.voucherId })} className="grid w-full grid-cols-[1fr_80px_110px] border-b border-line px-3 py-2 text-left text-[11px] last:border-0 hover:bg-panel2"><span><span className="block font-medium">{item.partyName} · {item.billNumber}</span><span className="text-muted">{item.reasons.join(' · ')}</span></span><span className="num text-dr">{item.score}</span><span className="text-right"><Money paise={item.pending} /></span></button>)}</div></Modal>
}

function OwnerWorkloadModal({ asOn, onClose }: { asOn: string; onClose: () => void }): React.JSX.Element {
  const { data } = useQuery({ queryKey: ['collection-owner-workload', asOn], queryFn: () => api.collections.ownerWorkload(asOn) })
  return <Modal title="Collection owner workload" onClose={onClose}><div className="grid grid-cols-[1fr_80px_110px_100px_110px] border-b border-line bg-panel2 px-3 py-2 text-[10px] font-semibold uppercase text-muted"><span>Owner</span><span>Customers</span><span>Follow-ups</span><span>Overdue</span><span>Collected 90d</span></div>{data?.map((item) => <div key={item.owner} className="grid grid-cols-[1fr_80px_110px_100px_110px] border-b border-line px-3 py-2 text-[11px] last:border-0"><span>{item.owner}</span><span className="num">{item.customers}</span><span className="num">{item.followUpsDue}</span><Money paise={item.overdue} /><Money paise={item.collected90Days} /></div>)}</Modal>
}
