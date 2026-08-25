import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type ApprovalRequest } from '../lib/client'
import { useFeatures } from '../lib/useFeatures'
import { useNav, useSession, useToasts } from '../state/stores'
import { Button, EmptyState, Field, Modal, Money, Panel, SectionTitle, SkeletonRows, TextInput } from '../components/ui'
import { upcomingDeadlines, type Deadline } from '@shared/compliance'
import { toDisplayDate, todayISO } from '@shared/dates'
import type { ExceptionRow } from '@shared/reports'

type Priority = 'urgent' | 'soon' | 'review'

function PriorityMark({ priority }: { priority: Priority }): React.JSX.Element {
  const style = priority === 'urgent' ? 'bg-cr text-cr' : priority === 'soon' ? 'bg-amber text-amber' : 'bg-blue text-blue'
  return <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${style.split(' ')[0]}`} aria-label={priority} />
}

export function ActionCentreScreen(): React.JSX.Element {
  const nav = useNav()
  const { from, to, info, user } = useSession()
  const features = useFeatures()
  const today = todayISO()
  const dashboard = useQuery({ queryKey: ['dashboard', today, from], queryFn: ({ signal }) => api.reports.dashboard(today, from, signal) })
  const exceptions = useQuery({ queryKey: ['exceptions', from, to], queryFn: ({ signal }) => api.reports.exceptions(from, to, signal) })
  const collections = useQuery({ queryKey: ['collections', today], queryFn: () => api.collections.queue(today) })
  const recurring = useQuery({ queryKey: ['recurring', 'due', today], queryFn: () => api.recurring.due(today) })
  const stock = useQuery({ queryKey: ['stockAgeing', to], queryFn: ({ signal }) => api.reports.stockAgeing(to, signal), enabled: features.inventory })
  const approvals = useQuery({ queryKey: ['approvals', 'pending'], queryFn: () => api.approvals.list('pending'), enabled: user?.role !== 'viewer' })
  const tasks = useQuery({ queryKey: ['tasks', 'open'], queryFn: () => api.tasks.list('open') })
  const drafts = useQuery({ queryKey: ['voucher-drafts'], queryFn: api.voucherDrafts.list })

  const collectionRows = collections.data ?? []
  const exceptionRows = useMemo(() => (exceptions.data?.sections ?? []).flatMap((section) =>
    section.rows.map((row) => ({ section: section.label, row }))
  ), [exceptions.data])
  const lowStock = (stock.data ?? []).filter((row) => row.belowReorder)
  const deadlines = upcomingDeadlines(today, info?.gstRegistrationType ?? 'unregistered', dashboard.data?.hasEmployees ?? false, 30)
  const total = collectionRows.length + exceptionRows.length + (recurring.data?.length ?? 0) + lowStock.length + deadlines.length + (approvals.data?.length ?? 0) + (tasks.data?.length ?? 0) + (drafts.data?.length ?? 0)
  const loading = dashboard.isLoading || exceptions.isLoading || collections.isLoading || recurring.isLoading || stock.isLoading || approvals.isLoading || tasks.isLoading || drafts.isLoading

  const openDeadline = (deadline: Deadline): void => {
    if (deadline.form === 'GSTR-1') nav.go({ name: 'gstr1' })
    else if (deadline.form === 'GSTR-3B') nav.go({ name: 'gstr3b' })
    else if (deadline.kind === 'tds') nav.go({ name: 'tds' })
    else if (deadline.kind === 'pf' || deadline.kind === 'esi') nav.go({ name: 'payroll' })
    else nav.go({ name: 'gateway' })
  }
  const openException = (row: ExceptionRow): void => {
    if (row.voucherId) nav.go({ name: 'voucher-entry', voucherId: row.voucherId })
    else if (row.ledgerId) nav.go({ name: 'ledger-statement', ledgerId: row.ledgerId })
    else nav.go({ name: 'exceptions' })
  }

  return <div className="mx-auto max-w-5xl">
    <SectionTitle right={<span className="num text-[11px] text-muted">As at {toDisplayDate(to)}</span>}>Action centre</SectionTitle>
    <div className="mb-5 grid grid-cols-8 gap-px overflow-hidden rounded-lg border border-line bg-line">
      {[
        ['Collections', collectionRows.length], ['Book checks', exceptionRows.length], ['Recurring', recurring.data?.length ?? 0],
        ['Low stock', lowStock.length], ['Deadlines', deadlines.length], ['Approvals', approvals.data?.length ?? 0], ['My tasks', tasks.data?.length ?? 0], ['Drafts', drafts.data?.length ?? 0]
      ].map(([label, count]) => <div key={String(label)} className="bg-panel px-4 py-3">
        <p className="text-[10px] font-semibold tracking-[0.09em] text-muted uppercase">{label}</p>
        <p className={`num mt-1 text-[20px] font-medium ${Number(count) > 0 ? 'text-ink' : 'text-muted/50'}`}>{count}</p>
      </div>)}
    </div>
    {loading ? <Panel><SkeletonRows rows={8} /></Panel> : total === 0 ? <Panel><EmptyState title="Nothing needs attention" hint="No overdue bills, book exceptions, due templates, low-stock items or deadlines in the next 30 days" /></Panel> :
      <div className="grid grid-cols-2 gap-4">
        {(approvals.data?.length ?? 0) > 0 && <ApprovalQueue rows={approvals.data ?? []} canApprove={user?.role === 'owner'} />}
        <WorkPanel title="Unfinished vouchers" count={drafts.data?.length ?? 0} action="Open drafts" onAction={() => nav.go({ name: 'voucher-drafts' })}>
          {(drafts.data ?? []).slice(0, 8).map((draft) => <button key={draft.id} className="flex w-full items-start gap-2 border-t border-line px-4 py-2.5 text-left first:border-0 hover:bg-panel2" onClick={() => nav.go({ name: 'voucher-entry', workDraftId: draft.id })}><PriorityMark priority="review" /><span className="min-w-0 flex-1"><span className="block truncate text-[12.5px] font-medium">{draft.title}</span><span className="block truncate text-[10.5px] text-muted">{draft.voucherTypeName} · saved by {draft.createdBy}</span></span></button>)}
        </WorkPanel>
        <WorkPanel title="My follow-ups" count={tasks.data?.length ?? 0} action="Open inbox" onAction={() => nav.go({ name: 'task-inbox' })}>
          {(tasks.data ?? []).slice(0, 8).map((task) => <button key={task.id} className="flex w-full items-start gap-2 border-t border-line px-4 py-2.5 text-left first:border-0 hover:bg-panel2" onClick={() => nav.go({ name: 'task-inbox' })}>
            <PriorityMark priority={task.priority === 'high' || (!!task.dueDate && task.dueDate < today) ? 'urgent' : task.dueDate === today ? 'soon' : 'review'} /><span className="min-w-0 flex-1"><span className="block truncate text-[12.5px] font-medium">{task.title}</span><span className="block truncate text-[10.5px] text-muted">{task.assignedTo ?? 'Unassigned'}{task.dueDate ? ` · due ${toDisplayDate(task.dueDate)}` : ''}</span></span>
          </button>)}
        </WorkPanel>
        <WorkPanel title="Collections priorities" count={collectionRows.length} action="Open queue" onAction={() => nav.go({ name: 'collections' })}>
          {collectionRows.slice(0, 8).map((row) => <button key={row.ledgerId} className="flex w-full items-start gap-2 border-t border-line px-4 py-2.5 text-left first:border-0 hover:bg-panel2" onClick={() => nav.go({ name: 'collections' })}>
            <PriorityMark priority={row.priority === 'critical' ? 'urgent' : row.priority === 'high' ? 'soon' : 'review'} /><span className="min-w-0 flex-1"><span className="block truncate text-[12.5px] font-medium">{row.name}</span><span className="num text-[10.5px] text-muted">{row.reason}{row.nextPromise ? ` · promise ${toDisplayDate(row.nextPromise.promisedDate)}` : ''}</span></span><Money paise={row.pending} className="text-[12px]" />
          </button>)}
        </WorkPanel>
        <WorkPanel title="Book checks" count={exceptionRows.length} action="Inspect all" onAction={() => nav.go({ name: 'exceptions' })}>
          {exceptionRows.slice(0, 8).map(({ section, row }, index) => <button key={`${section}-${index}`} className="flex w-full items-start gap-2 border-t border-line px-4 py-2.5 text-left first:border-0 hover:bg-panel2" onClick={() => openException(row)}>
            <PriorityMark priority={section.includes('Unbalanced') || section.includes('Negative') ? 'urgent' : 'review'} /><span className="min-w-0 flex-1"><span className="block truncate text-[12.5px] font-medium">{row.label}</span><span className="block truncate text-[10.5px] text-muted">{section} · {row.detail}</span></span>{row.amount !== undefined && <Money paise={row.amount} className="text-[12px]" />}
          </button>)}
        </WorkPanel>
        <WorkPanel title="Upcoming compliance" count={deadlines.length} action="View Gateway" onAction={() => nav.go({ name: 'gateway' })}>
          {deadlines.slice(0, 8).map((deadline) => <button key={deadline.id} className="flex w-full items-start gap-2 border-t border-line px-4 py-2.5 text-left first:border-0 hover:bg-panel2" onClick={() => openDeadline(deadline)}>
            <PriorityMark priority={deadline.date <= today ? 'urgent' : 'soon'} /><span className="min-w-0 flex-1"><span className="block truncate text-[12.5px] font-medium">{deadline.form}</span><span className="block truncate text-[10.5px] text-muted">{deadline.title}</span></span><span className="num text-[10.5px] text-muted">{toDisplayDate(deadline.date)}</span>
          </button>)}
        </WorkPanel>
        <WorkPanel title="Operations" count={(recurring.data?.length ?? 0) + lowStock.length} action="Recurring" onAction={() => nav.go({ name: 'recurring' })}>
          {(recurring.data ?? []).slice(0, 4).map((template) => <button key={`r-${template.id}`} className="flex w-full items-start gap-2 border-t border-line px-4 py-2.5 text-left first:border-0 hover:bg-panel2" onClick={() => nav.go({ name: 'recurring' })}><PriorityMark priority="soon" /><span className="min-w-0 flex-1"><span className="block truncate text-[12.5px] font-medium">{template.name}</span><span className="text-[10.5px] text-muted">Recurring voucher due {toDisplayDate(template.nextDue)}</span></span></button>)}
          {lowStock.slice(0, 4).map((item) => <button key={`s-${item.stockItemId}`} className="flex w-full items-start gap-2 border-t border-line px-4 py-2.5 text-left first:border-0 hover:bg-panel2" onClick={() => nav.go({ name: 'stock-summary' })}><PriorityMark priority="review" /><span className="min-w-0 flex-1"><span className="block truncate text-[12.5px] font-medium">{item.name}</span><span className="num text-[10.5px] text-muted">Below reorder level · {(item.closingQtyMilli / 1000).toFixed(item.decimals)} {item.unitSymbol}</span></span></button>)}
        </WorkPanel>
      </div>}
  </div>
}

function ApprovalQueue({ rows, canApprove }: { rows: ApprovalRequest[]; canApprove: boolean }): React.JSX.Element {
  const queryClient = useQueryClient()
  const toast = useToasts()
  const [busy, setBusy] = useState<number | null>(null)
  const [rejecting, setRejecting] = useState<ApprovalRequest | null>(null)
  const [note, setNote] = useState('')

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['approvals'] })
    await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
  }
  const approve = async (row: ApprovalRequest): Promise<void> => {
    setBusy(row.id)
    try {
      const voucher = await api.approvals.approve(row.id)
      toast.push('success', `${voucher.number} approved and posted`)
      await refresh()
    } catch (error) {
      toast.push('error', (error as Error).message)
    } finally {
      setBusy(null)
    }
  }
  const reject = async (): Promise<void> => {
    if (!rejecting || note.trim().length < 3) return
    setBusy(rejecting.id)
    try {
      await api.approvals.reject(rejecting.id, note.trim())
      toast.push('success', `Request #${rejecting.id} rejected`)
      setRejecting(null)
      setNote('')
      await refresh()
    } catch (error) {
      toast.push('error', (error as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return <>
    <Panel className="col-span-2 overflow-hidden p-0">
      <div className="flex items-center justify-between px-4 py-3">
        <div><h3 className="text-[12.5px] font-semibold">Voucher & expense approvals</h3><p className="mt-0.5 text-[10.5px] text-muted">Validated requests outside the books until a different owner approves</p></div>
        <span className="num rounded-full border border-amber/40 px-2 py-0.5 text-[10px] text-amber">{rows.length} pending</span>
      </div>
      {rows.slice(0, 10).map((row) => <div key={row.id} className="grid grid-cols-[1fr_150px_auto] items-center gap-4 border-t border-line px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">{row.requestKind==='expense'&&<span className="rounded border border-amber/30 bg-amber/10 px-1.5 py-0.5 text-[8.5px] font-semibold uppercase text-amber">Expense</span>}<span className="truncate text-[12.5px] font-medium">{row.summary}</span><span className="num text-[10px] text-muted">#{row.id}</span></div>
          <p className="mt-0.5 text-[10.5px] text-muted">Made by {row.makerName}{row.departments.length?` · ${row.departments.join(', ')}`:''} · {new Date(row.createdAt).toLocaleString()}</p>
        </div>
        <Money paise={row.amount} className="text-right text-[12px]" />
        <div className="flex gap-2">
          <Button disabled={!canApprove || busy !== null} disabledTitle={canApprove ? undefined : 'Only an owner can check vouchers'} onClick={() => setRejecting(row)}>Reject</Button>
          <Button variant="primary" data-testid={`approval-approve-${row.id}`} disabled={!canApprove || busy !== null} disabledTitle={canApprove ? undefined : 'Only an owner can check vouchers'} onClick={() => void approve(row)}>{busy === row.id ? 'Posting…' : 'Approve & post'}</Button>
        </div>
      </div>)}
    </Panel>
    {rejecting && <Modal title={`Reject request #${rejecting.id}`} onClose={() => { setRejecting(null); setNote('') }}>
      <p className="mb-4 text-[12px] text-muted">The maker will see this decision in the permanent review history. Nothing has entered the books.</p>
      <Field label="Reason" hint="Required — at least 3 characters">
        <TextInput autoFocus value={note} onChange={(event) => setNote(event.target.value)} placeholder="What needs to be corrected?" />
      </Field>
      <div className="mt-5 flex justify-end gap-2"><Button onClick={() => { setRejecting(null); setNote('') }}>Cancel</Button><Button variant="danger" disabled={note.trim().length < 3 || busy !== null} onClick={() => void reject()}>Reject request</Button></div>
    </Modal>}
  </>
}

function WorkPanel({ title, count, action, onAction, children }: { title: string; count: number; action: string; onAction: () => void; children: React.ReactNode }): React.JSX.Element {
  return <Panel className="overflow-hidden p-0"><div className="flex items-center justify-between px-4 py-2.5"><div className="flex items-center gap-2"><h3 className="text-[12.5px] font-semibold">{title}</h3><span className="num text-[10.5px] text-muted">{count}</span></div><button className="text-[10.5px] text-blue hover:underline" onClick={onAction}>{action}</button></div>{count === 0 ? <p className="border-t border-line px-4 py-5 text-center text-[11.5px] text-muted">Nothing here</p> : children}</Panel>
}
