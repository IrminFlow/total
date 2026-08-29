import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Bank, CalendarDots, CheckCircle, WarningCircle } from '@phosphor-icons/react'
import { todayISO, toDisplayDate } from '@shared/dates'
import { api, type PaymentFileFormat } from '../lib/client'
import { useNav, useToasts } from '../state/stores'
import { Button, DateInput, Field, Modal, Money, Panel, SectionTitle, Select, TextInput } from '../components/ui'
import type { PaymentRun, PaymentRunBillInput } from '@shared/payables'
import { confirmDialog } from '../lib/dialogs'

export function SupplierDuesScreen(): React.JSX.Element {
  const asOn = todayISO()
  const nav = useNav()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [expanded, setExpanded] = useState<number | null>(null)
  const [selected, setSelected] = useState<Map<string, PaymentRunBillInput>>(() => new Map())
  const [prepareOpen, setPrepareOpen] = useState(false)
  const [reviewRun, setReviewRun] = useState<PaymentRun | null>(null)
  const query = useQuery({ queryKey: ['supplierDues', asOn], queryFn: () => api.payables.queue(asOn) })
  const advances = useQuery({ queryKey: ['supplierAdvances', asOn], queryFn: () => api.payables.advances(asOn) })
  const runs = useQuery({ queryKey: ['paymentRuns'], queryFn: api.payables.paymentRuns })
  const data = query.data
  const gap = Math.max(0, (data?.totalPending ?? 0) - (data?.availableCash ?? 0))
  const selectedBills = useMemo(() => [...selected.values()], [selected])
  const selectedTotal = selectedBills.reduce((sum, bill) => sum + bill.amount, 0)
  const toggleBill = (bill: PaymentRunBillInput): void => {
    const key = `${bill.partyLedgerId}|${bill.billNumber}|${bill.billDate}`
    setSelected((current) => {
      const next = new Map(current)
      if (next.has(key)) next.delete(key)
      else next.set(key, bill)
      return next
    })
  }
  return <div className="mx-auto max-w-5xl" data-testid="supplier-dues-screen">
    <SectionTitle right={<span className="num text-[12px] text-muted">today · {toDisplayDate(asOn)}</span>}>Supplier due queue</SectionTitle>
    <div className="mb-3 grid grid-cols-4 gap-2">
      <Metric icon={<Bank size={16} />} label="Cash available" value={<Money paise={data?.availableCash ?? 0} />} tone="good" />
      <Metric icon={<CalendarDots size={16} />} label="Due in 7 days" value={<Money paise={data?.dueNext7 ?? 0} />} />
      <Metric icon={<WarningCircle size={16} />} label="Already overdue" value={<Money paise={data?.overdueAmount ?? 0} />} tone="warn" />
      <Metric icon={gap ? <WarningCircle size={16} /> : <CheckCircle size={16} />} label="Funding gap" value={<Money paise={gap} />} tone={gap ? 'warn' : 'good'} />
    </div>
    {(advances.data?.length ?? 0) > 0 && <Panel className="mb-3" data-testid="supplier-advances"><div className="flex items-center justify-between border-b border-line bg-panel2 px-4 py-2"><div><p className="text-[11.5px] font-semibold">Supplier advances awaiting adjustment</p><p className="text-[10.5px] text-muted">Unapplied payments automatically reduce the supplier’s next bill; ageing starts from the oldest contributing payment.</p></div><span className="text-[11px] font-semibold"><Money paise={(advances.data??[]).reduce((sum,row)=>sum+row.pendingAdjustment,0)}/></span></div>{advances.data?.map((row)=><button key={row.ledgerId} className="grid w-full grid-cols-[1fr_150px_120px_160px] items-center border-b border-line px-4 py-2 text-left last:border-0 hover:bg-panel2" onClick={()=>nav.go({name:'ledger-statement',ledgerId:row.ledgerId})}><span><b className="text-[11.5px]">{row.name}</b><span className="ml-2 text-[9.5px] text-muted">{row.paymentVoucherIds.length} source payment{row.paymentVoucherIds.length===1?'':'s'}</span></span><span className="num text-[10.5px] text-muted">Since {toDisplayDate(row.oldestDate)}</span><span className={`num text-[10.5px] ${row.ageDays>90?'text-cr':row.ageDays>30?'text-amber':'text-muted'}`}>{row.ageDays} days</span><span className="text-right text-[11.5px] font-medium"><Money paise={row.pendingAdjustment}/></span></button>)}</Panel>}
    {(runs.data?.length ?? 0) > 0 && <Panel className="mb-3">
      <div className="flex items-center justify-between border-b border-line bg-panel2 px-4 py-2">
        <div><p className="text-[11.5px] font-semibold">Payment runs</p><p className="text-[10.5px] text-muted">Drafts stay outside the books until owner review.</p></div>
        <span className="text-[10.5px] text-muted">{runs.data?.filter((run) => run.status === 'draft').length ?? 0} awaiting review</span>
      </div>
      <div className="divide-y divide-line">
        {runs.data?.slice(0, 5).map((run) => <button key={run.id} data-testid={`payment-run-${run.id}`} onClick={() => setReviewRun(run)} className="grid w-full grid-cols-[90px_1fr_120px_120px] items-center gap-3 px-4 py-2 text-left hover:bg-panel2/60">
          <span className={`w-fit rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${run.status === 'draft' ? 'bg-amber/15 text-amber' : run.status === 'posted' ? 'bg-dr/10 text-dr' : 'bg-panel2 text-muted'}`}>{run.status}</span>
          <span><span className="block text-[12px] font-medium">Run #{run.id} · {run.bankLedgerName}</span><span className="block text-[10.5px] text-muted">{run.items.length} supplier{run.items.length === 1 ? '' : 's'} · by {run.createdBy}</span></span>
          <span className="num text-[11px] text-muted">{toDisplayDate(run.date)}</span>
          <span className="text-right"><Money paise={run.totalAmount} /></span>
        </button>)}
      </div>
    </Panel>}
    <Panel>
      <div className="grid grid-cols-[72px_1fr_130px_130px_120px_100px] gap-3 border-b border-line bg-panel2 px-4 py-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted"><span>Priority</span><span>Supplier</span><span>Next due</span><span className="text-right">Overdue</span><span className="text-right">Payable</span><span>Coverage</span></div>
      {!data?.rows.length && <div className="px-4 py-12 text-center text-[12.5px] text-muted">No supplier bills are outstanding today.</div>}
      {data?.rows.map((row) => <div key={row.ledgerId} className="border-b border-line last:border-0">
        <button onClick={() => setExpanded(expanded === row.ledgerId ? null : row.ledgerId)} className="grid min-h-[68px] w-full grid-cols-[72px_1fr_130px_130px_120px_100px] items-center gap-3 px-4 py-2.5 text-left hover:bg-panel2/60">
          <span className={`w-fit rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${row.priority === 'critical' ? 'bg-cr/10 text-cr' : row.priority === 'high' ? 'bg-amber/15 text-amber' : 'bg-panel2 text-muted'}`}>{row.priority}</span>
          <span className="min-w-0"><span className="block truncate text-[13px] font-semibold">{row.name}</span><span className="mt-0.5 block text-[10.5px] text-muted">{row.reason} · {row.bills.length} bill{row.bills.length === 1 ? '' : 's'}</span></span>
          <span className="num text-[11.5px] text-muted">{row.nextDueDate ? toDisplayDate(row.nextDueDate) : '—'}</span>
          <span className="text-right"><Money paise={row.overdueAmount} /></span><span className="text-right font-medium"><Money paise={row.pending} /></span>
          <span className={`flex items-center gap-1 text-[10.5px] ${row.coveredByCash ? 'text-dr' : 'text-cr'}`}>{row.coveredByCash ? <CheckCircle size={13} weight="fill" /> : <WarningCircle size={13} weight="fill" />}{row.coveredByCash ? 'Covered' : 'Shortfall'}</span>
        </button>
        {expanded === row.ledgerId && <div className="border-t border-line bg-panel2/55 px-4 py-3"><div className="mb-2 flex items-center justify-between"><span className="text-[10.5px] text-muted">Select exact bills for a reviewable payment run.</span><Button onClick={() => nav.go({ name: 'ledger-statement', ledgerId: row.ledgerId })}>Open supplier ledger</Button></div>{row.bills.map((bill, index) => {
          const input: PaymentRunBillInput = { partyLedgerId: row.ledgerId, billNumber: bill.number, billDate: bill.date, amount: bill.pending }
          const key = `${input.partyLedgerId}|${input.billNumber}|${input.billDate}`
          return <div key={`${bill.number}-${index}`} className="grid grid-cols-[28px_1fr_130px_120px] items-center rounded px-2 py-1 hover:bg-panel">
            <input type="checkbox" aria-label={`Select ${bill.number} for payment`} data-testid={`select-payable-${row.ledgerId}-${index}`} checked={selected.has(key)} onChange={() => toggleBill(input)} className="accent-amberbar" />
            <button onClick={() => bill.voucherId && nav.go({ name: 'voucher-entry', voucherId: bill.voucherId })} className="text-left text-[11.5px] hover:underline">{bill.number} · {toDisplayDate(bill.date)}</button>
            <span className={`text-[11.5px] ${bill.overdueDays ? 'text-cr' : 'text-muted'}`}>{bill.overdueDays ? `${bill.overdueDays}d overdue` : bill.dueDate ? `Due ${toDisplayDate(bill.dueDate)}` : 'No due date'}</span>
            <span className="text-right text-[11.5px]"><Money paise={bill.pending} /></span>
          </div>
        })}</div>}
      </div>)}
    </Panel>
    {selectedBills.length > 0 && <div data-testid="payment-selection-tray" className="sticky bottom-4 z-20 mt-3 flex items-center justify-between rounded-lg border border-amberbar/40 bg-panel/95 px-3 py-2 panel-shadow backdrop-blur">
      <div className="flex items-center gap-3"><span className="grid h-8 min-w-8 place-items-center rounded-md bg-amberbar text-[12px] font-semibold text-[#2b2000]">{selectedBills.length}</span><span><span className="block text-[12px] font-semibold">Bills selected</span><span className="block text-[10.5px] text-muted">{new Set(selectedBills.map((bill) => bill.partyLedgerId)).size} suppliers · <Money paise={selectedTotal} /></span></span></div>
      <div className="flex gap-2"><Button variant="ghost" onClick={() => setSelected(new Map())}>Clear</Button><Button variant="primary" data-testid="prepare-payment-run" onClick={() => setPrepareOpen(true)}>Prepare payment run</Button></div>
    </div>}
    <p className="mt-2 text-[11px] text-muted">Cash coverage allocates today’s cash and positive bank balances down the ranked queue. It is a planning view and never initiates a payment.</p>
    {prepareOpen && <PreparePaymentRunModal bills={selectedBills} onClose={() => setPrepareOpen(false)} onCreated={async (run) => {
      setPrepareOpen(false)
      setSelected(new Map())
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['paymentRuns'] }), queryClient.invalidateQueries({ queryKey: ['supplierDues'] })])
      toast.push('success', `Payment run #${run.id} saved for review`)
      setReviewRun(run)
    }} />}
    {reviewRun && <ReviewPaymentRunModal run={reviewRun} onClose={() => setReviewRun(null)} onChanged={async (run) => {
      setReviewRun(run)
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['paymentRuns'] }), queryClient.invalidateQueries({ queryKey: ['supplierDues'] })])
    }} />}
  </div>
}

function Metric({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: React.ReactNode; tone?: 'good' | 'warn' }): React.JSX.Element {
  return <Panel className="px-3 py-2.5"><div className={`flex items-center gap-1.5 ${tone === 'good' ? 'text-dr' : tone === 'warn' ? 'text-cr' : 'text-muted'}`}>{icon}<span className="text-[10px] font-semibold uppercase tracking-[0.08em]">{label}</span></div><p className="mt-1.5 text-[15px] font-semibold">{value}</p></Panel>
}

function PreparePaymentRunModal({ bills, onClose, onCreated }: {
  bills: PaymentRunBillInput[]
  onClose: () => void
  onCreated: (run: PaymentRun) => Promise<void>
}): React.JSX.Element {
  const toast = useToasts()
  const [date, setDate] = useState(todayISO())
  const [bankLedgerId, setBankLedgerId] = useState<number | null>(null)
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const accounts = useQuery({ queryKey: ['paymentAccounts', date], queryFn: () => api.payables.paymentAccounts(date) })
  const effectiveAccountId = bankLedgerId ?? accounts.data?.[0]?.ledgerId ?? null
  const preview = useQuery({
    queryKey: ['paymentRunPreview', effectiveAccountId, date, bills],
    queryFn: () => api.payables.paymentRunPreview(effectiveAccountId!, date, bills),
    enabled: effectiveAccountId !== null
  })
  const save = async (): Promise<void> => {
    if (effectiveAccountId === null || saving) return
    setSaving(true)
    try {
      const run = await api.payables.createPaymentRun({ bankLedgerId: effectiveAccountId, date, note: note.trim() || null, bills })
      await onCreated(run)
    } catch (err) {
      toast.push('error', err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }
  return <Modal title="Prepare payment run" onClose={onClose} dirty={note.trim().length > 0} wide>
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Payment date"><DateInput value={date} context={todayISO()} onChange={setDate} testId="input-payment-run-date" /></Field>
        <Field label="Pay from">
          <Select data-testid="input-payment-run-account" value={effectiveAccountId ?? ''} onChange={(event) => setBankLedgerId(Number(event.target.value))}>
            {accounts.data?.map((account) => <option key={account.ledgerId} value={account.ledgerId}>{account.name}</option>)}
          </Select>
        </Field>
      </div>
      {preview.data && <div className="grid grid-cols-3 gap-2">
        <Metric icon={<Bank size={16} />} label="Before" value={<Money paise={preview.data.account.balance} signed />} />
        <Metric icon={<CalendarDots size={16} />} label="This run" value={<Money paise={preview.data.totalAmount} />} />
        <Metric icon={preview.data.balanceAfter < 0 ? <WarningCircle size={16} /> : <CheckCircle size={16} />} label="After" value={<Money paise={preview.data.balanceAfter} signed />} tone={preview.data.balanceAfter < 0 ? 'warn' : 'good'} />
      </div>}
      <Field label="Run note" hint="Optional internal context; each resulting payment voucher references this run."><TextInput value={note} maxLength={500} placeholder="Weekly supplier payments" onChange={(event) => setNote(event.target.value)} /></Field>
      <Panel>
        <div className="grid grid-cols-[1fr_80px_120px] border-b border-line bg-panel2 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted"><span>Bill</span><span>Date</span><span className="text-right">Amount</span></div>
        {bills.map((bill) => <div key={`${bill.partyLedgerId}-${bill.billNumber}-${bill.billDate}`} className="grid grid-cols-[1fr_80px_120px] px-3 py-1.5 text-[11.5px]"><span>{bill.billNumber}</span><span className="num text-muted">{toDisplayDate(bill.billDate)}</span><span className="text-right"><Money paise={bill.amount} /></span></div>)}
      </Panel>
      <div className="flex items-center justify-between"><p className="max-w-lg text-[10.5px] text-muted">Saving creates a durable draft only. No payment voucher or ledger balance changes until an owner reviews and posts it.</p><div className="flex gap-2"><Button disabled={saving} onClick={onClose}>Cancel</Button><Button variant="primary" data-testid="save-payment-run-draft" disabled={saving || effectiveAccountId === null || !preview.data} onClick={() => void save()}>{saving ? 'Saving…' : 'Save draft for review'}</Button></div></div>
    </div>
  </Modal>
}

function ReviewPaymentRunModal({ run, onClose, onChanged }: {
  run: PaymentRun
  onClose: () => void
  onChanged: (run: PaymentRun) => Promise<void>
}): React.JSX.Element {
  const toast = useToasts()
  const nav = useNav()
  const [busy, setBusy] = useState(false)
  const [fileFormat, setFileFormat] = useState<PaymentFileFormat>('generic_neft')
  const flattened = run.items.flatMap((item) => item.bills.map((bill) => ({
    partyLedgerId: item.partyLedgerId,
    billNumber: bill.number,
    billDate: bill.date,
    amount: bill.amount
  })))
  const preview = useQuery({
    queryKey: ['paymentRunReviewPreview', run.id, run.status],
    queryFn: () => api.payables.paymentRunPreview(run.bankLedgerId, run.date, flattened),
    enabled: run.status === 'draft'
  })
  const filePreview = useQuery({
    queryKey: ['paymentFilePreview', run.id, fileFormat, run.status],
    queryFn: () => api.payables.paymentFilePreview(run.id, fileFormat),
    enabled: run.status !== 'cancelled'
  })
  const exportPaymentFile = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await api.payables.paymentFileExport(run.id, fileFormat)
      toast.push('success', `${result.rows} bank payment row${result.rows === 1 ? '' : 's'} exported: ${result.path}`)
    } catch (error) {
      toast.push('error', error instanceof Error ? error.message : String(error))
    } finally { setBusy(false) }
  }
  const post = async (): Promise<void> => {
    const proceed = await confirmDialog({
      title: `Post payment run #${run.id}`,
      message: `Create ${run.items.length} payment voucher${run.items.length === 1 ? '' : 's'} totalling this run? Every bill will be revalidated first; the batch is all-or-nothing.`,
      confirmLabel: 'Post payment vouchers'
    })
    if (!proceed) return
    setBusy(true)
    try {
      const posted = await api.payables.postPaymentRun(run.id)
      toast.push('success', `Payment run #${run.id} posted`)
      await onChanged(posted)
    } catch (err) {
      toast.push('error', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  const cancel = async (): Promise<void> => {
    const proceed = await confirmDialog({ title: `Cancel payment run #${run.id}`, message: 'Cancel this draft? No books have been changed.', confirmLabel: 'Cancel draft', danger: true })
    if (!proceed) return
    setBusy(true)
    try {
      const cancelled = await api.payables.cancelPaymentRun(run.id)
      toast.push('success', `Payment run #${run.id} cancelled`)
      await onChanged(cancelled)
    } catch (err) {
      toast.push('error', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  return <Modal title={`Payment run #${run.id}`} onClose={onClose} wide>
    <div className="grid gap-4">
      <div className="flex items-start justify-between rounded-md border border-line bg-panel2 px-3 py-2">
        <div><span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${run.status === 'draft' ? 'bg-amber/15 text-amber' : run.status === 'posted' ? 'bg-dr/10 text-dr' : 'text-muted'}`}>{run.status}</span><p className="mt-1.5 text-[12px]">{run.bankLedgerName} · {toDisplayDate(run.date)}</p><p className="text-[10.5px] text-muted">Prepared by {run.createdBy}{run.postedBy ? ` · posted by ${run.postedBy}` : ''}</p></div>
        <div className="text-right"><p className="text-[10px] uppercase tracking-[0.08em] text-muted">Run total</p><p className="mt-1 text-[16px] font-semibold"><Money paise={run.totalAmount} /></p></div>
      </div>
      {preview.data && <div className={`rounded-md border px-3 py-2 text-[11.5px] ${preview.data.balanceAfter < 0 ? 'border-cr/30 bg-cr/5' : 'border-dr/25 bg-dr/5'}`}><b>Bank impact:</b> <Money paise={preview.data.account.balance} signed /> before → <Money paise={preview.data.balanceAfter} signed /> after this run.</div>}
      {run.status !== 'cancelled' && <div className="grid grid-cols-[190px_1fr_auto] items-end gap-3 rounded-md border border-line bg-panel2/40 p-3"><Field label="Bank upload format"><Select value={fileFormat} onChange={(e) => setFileFormat(e.target.value as PaymentFileFormat)}><option value="generic_neft">Generic NEFT CSV</option><option value="hdfc_bulk">HDFC bulk payment</option><option value="icici_bulk">ICICI bulk payment</option></Select></Field><div className={`rounded px-3 py-2 text-[10px] ${filePreview.data?.blockers.length ? 'bg-cr/5 text-cr' : 'bg-dr/5 text-dr'}`}>{filePreview.isLoading ? 'Checking verified bank details…' : filePreview.data?.blockers.length ? filePreview.data.blockers.join(' · ') : `${filePreview.data?.rows.length ?? 0} verified beneficiaries · no online banking credentials stored`}</div><Button disabled={busy || !filePreview.data || filePreview.data.blockers.length > 0} onClick={() => void exportPaymentFile()}>Export bank file</Button></div>}
      <Panel>
        {run.items.map((item) => <div key={item.id} className="border-b border-line last:border-0"><div className="flex items-center justify-between bg-panel2 px-3 py-2"><span className="text-[12px] font-semibold">{item.partyName}</span><span><Money paise={item.amount} /></span></div>{item.bills.map((bill) => <div key={`${bill.number}-${bill.date}`} className="grid grid-cols-[1fr_100px_120px] px-3 py-1.5 text-[11.5px]"><span>{bill.number}</span><span className="num text-muted">{toDisplayDate(bill.date)}</span><span className="text-right"><Money paise={bill.amount} /></span></div>)}{item.voucherId && <div className="flex justify-end gap-1 px-3 pb-2"><Button variant="ghost" onClick={() => void api.cheque.advice(item.voucherId!).then((result)=>toast.push('success',`Payment advice: ${result.path}`)).catch((error)=>toast.push('error',error instanceof Error?error.message:String(error)))}>Payment advice</Button><Button variant="ghost" onClick={() => { onClose(); nav.go({ name: 'voucher-entry', voucherId: item.voucherId! }) }}>Open payment voucher</Button></div>}</div>)}
      </Panel>
      {run.note && <p className="text-[11.5px] text-muted"><b className="text-ink">Note:</b> {run.note}</p>}
      <div className="flex justify-between"><div>{run.status === 'draft' && <Button variant="danger" disabled={busy} onClick={() => void cancel()}>Cancel draft</Button>}</div><div className="flex gap-2"><Button disabled={busy} onClick={onClose}>Close</Button>{run.status === 'draft' && <Button variant="primary" data-testid="post-payment-run" disabled={busy || !preview.data} onClick={() => void post()}>{busy ? 'Posting…' : 'Post payment vouchers'}</Button>}</div></div>
    </div>
  </Modal>
}
