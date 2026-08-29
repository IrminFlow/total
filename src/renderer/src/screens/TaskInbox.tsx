import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle, ClockCountdown, LinkSimple, Plus } from '@phosphor-icons/react'
import type { PersonalTask, PersonalTaskInput, TaskLinkType, TaskStatus } from '@shared/tasks'
import { todayISO, toDisplayDate } from '@shared/dates'
import { api } from '../lib/client'
import { useNav, useToasts } from '../state/stores'
import { Button, DateInput, EmptyState, Field, Modal, Panel, SectionTitle, Select, TextInput } from '../components/ui'
import { SCREENS } from '../lib/screens'

export function TaskInboxScreen({ compose = false, linkType = 'none', linkKey = null }: {
  compose?: boolean
  linkType?: TaskLinkType
  linkKey?: string | null
}): React.JSX.Element {
  const nav = useNav()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [filter, setFilter] = useState<'open' | 'done' | 'all'>('open')
  const [editing, setEditing] = useState<PersonalTask | null | 'new'>(compose ? 'new' : null)
  const tasks = useQuery({ queryKey: ['tasks', filter], queryFn: () => api.tasks.list(filter === 'all' ? undefined : filter) })
  const rows = tasks.data ?? []
  const today = todayISO()
  const openLink = (task: PersonalTask): void => {
    if (!task.linkKey) return
    if (task.linkType === 'voucher') nav.go({ name: 'voucher-entry', voucherId: Number(task.linkKey) })
    else if (task.linkType === 'ledger') nav.go({ name: 'ledger-statement', ledgerId: Number(task.linkKey) })
    else if (task.linkType === 'gst_return') nav.go({ name: task.linkKey.startsWith('gstr3b') ? 'gstr3b' : 'gstr1' })
    else if (task.linkType === 'screen') {
      const def = SCREENS.find((screen) => screen.name === task.linkKey)
      if (def?.screen) nav.go(def.screen)
    }
  }
  const closeTask = async (task: PersonalTask, status: 'done' | 'cancelled'): Promise<void> => {
    try {
      if (status === 'done') await api.tasks.complete(task.id)
      else await api.tasks.cancel(task.id)
      await queryClient.invalidateQueries({ queryKey: ['tasks'] })
      toast.push('success', status === 'done' ? 'Task completed' : 'Task cancelled')
    } catch (err) {
      toast.push('error', err instanceof Error ? err.message : String(err))
    }
  }
  const counts = useMemo(() => ({ overdue: rows.filter((task) => task.status === 'open' && !!task.dueDate && task.dueDate < today).length, dueToday: rows.filter((task) => task.status === 'open' && task.dueDate === today).length }), [rows, today])
  return <div className="mx-auto max-w-5xl" data-testid="task-inbox-screen">
    <SectionTitle right={<div className="flex items-center gap-2"><div className="flex rounded-md border border-line bg-panel2 p-0.5" role="group" aria-label="Task status">{([['open', 'Open'], ['done', 'Completed'], ['all', 'All']] as const).map(([value, label]) => <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)} className={`rounded px-2.5 py-1 text-[11px] ${filter === value ? 'bg-panel text-ink panel-shadow' : 'text-muted hover:text-ink'}`}>{label}</button>)}</div><Button variant="primary" data-testid="new-task" onClick={() => setEditing('new')}><Plus size={14} className="mr-1 inline" />New task</Button></div>}>Task inbox</SectionTitle>
    <div className="mb-3 grid grid-cols-3 gap-2"><TaskMetric label="Open" value={filter === 'open' ? rows.length : rows.filter((task) => task.status === 'open').length} /><TaskMetric label="Overdue" value={counts.overdue} warn={counts.overdue > 0} /><TaskMetric label="Due today" value={counts.dueToday} warn={counts.dueToday > 0} /></div>
    <Panel>
      {!rows.length ? <EmptyState title={filter === 'open' ? 'Your follow-up queue is clear' : 'No tasks in this view'} hint="Create a task from here or directly from a voucher." /> : <div className="divide-y divide-line">{rows.map((task) => {
        const overdue = task.status === 'open' && !!task.dueDate && task.dueDate < today
        return <div key={task.id} data-testid={`task-${task.id}`} className="grid grid-cols-[30px_1fr_130px_170px] items-start gap-3 px-4 py-3 hover:bg-panel2/40">
          <button aria-label={`Complete ${task.title}`} disabled={task.status !== 'open'} onClick={() => void closeTask(task, 'done')} className={`mt-0.5 ${task.status === 'done' ? 'text-dr' : 'text-muted hover:text-dr'}`}><CheckCircle size={18} weight={task.status === 'done' ? 'fill' : 'regular'} /></button>
          <button className="min-w-0 text-left" onClick={() => setEditing(task)}><span className="block truncate text-[13px] font-semibold">{task.title}</span>{task.note && <span className="mt-0.5 block truncate text-[11px] text-muted">{task.note}</span>}<span className="mt-1 flex gap-1.5">{task.priority === 'high' && <span className="rounded bg-cr/10 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase text-cr">High</span>}{task.assignedTo && <span className="rounded bg-panel2 px-1.5 py-0.5 text-[9.5px] text-muted">{task.assignedTo}</span>}</span></button>
          <span className={`num text-[11px] ${overdue ? 'font-semibold text-cr' : 'text-muted'}`}>{task.dueDate ? `${overdue ? 'Overdue · ' : ''}${toDisplayDate(task.dueDate)}` : 'No due date'}</span>
          <div className="flex justify-end gap-1">{task.linkType !== 'none' && <Button variant="ghost" onClick={() => openLink(task)}><LinkSimple size={13} className="mr-1 inline" />Open link</Button>}{task.status === 'open' && <Button variant="ghost" onClick={() => void closeTask(task, 'cancelled')}>Cancel</Button>}</div>
        </div>
      })}</div>}
    </Panel>
    {editing && <TaskModal task={editing === 'new' ? null : editing} initialLinkType={editing === 'new' ? linkType : undefined} initialLinkKey={editing === 'new' ? linkKey : undefined} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await queryClient.invalidateQueries({ queryKey: ['tasks'] }) }} />}
  </div>
}

function TaskMetric({ label, value, warn }: { label: string; value: number; warn?: boolean }): React.JSX.Element {
  return <Panel className="flex items-center gap-3 px-3 py-2"><ClockCountdown size={16} className={warn ? 'text-cr' : 'text-muted'} /><span><span className="block text-[10px] font-semibold uppercase tracking-[0.08em] text-muted">{label}</span><span className={`text-[16px] font-semibold ${warn ? 'text-cr' : ''}`}>{value}</span></span></Panel>
}

function TaskModal({ task, initialLinkType = 'none', initialLinkKey = null, onClose, onSaved }: {
  task: PersonalTask | null
  initialLinkType?: TaskLinkType
  initialLinkKey?: string | null
  onClose: () => void
  onSaved: () => Promise<void>
}): React.JSX.Element {
  const toast = useToasts()
  const [title, setTitle] = useState(task?.title ?? '')
  const [note, setNote] = useState(task?.note ?? '')
  const [dueDate, setDueDate] = useState(task?.dueDate ?? todayISO())
  const [hasDueDate, setHasDueDate] = useState(task?.dueDate != null || !task)
  const [priority, setPriority] = useState<PersonalTaskInput['priority']>(task?.priority ?? 'normal')
  const [assignedTo, setAssignedTo] = useState(task?.assignedTo ?? '')
  const [linkType, setLinkType] = useState<TaskLinkType>(task?.linkType ?? initialLinkType)
  const [linkKey, setLinkKey] = useState(task?.linkKey ?? initialLinkKey ?? '')
  const [saving, setSaving] = useState(false)
  const ledgers = useQuery({ queryKey: ['ledgers'], queryFn: api.ledgers.list, enabled: linkType === 'ledger' })
  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await api.tasks.save({ title, note: note.trim() || null, dueDate: hasDueDate ? dueDate : null, priority, assignedTo: assignedTo.trim() || null, linkType, linkKey: linkType === 'none' ? null : linkKey }, task?.id)
      toast.push('success', task ? 'Task updated' : 'Task created')
      await onSaved()
    } catch (err) {
      toast.push('error', err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }
  const linkControl = linkType === 'ledger' ? <Select value={linkKey} onChange={(event) => setLinkKey(event.target.value)}><option value="">Choose ledger…</option>{ledgers.data?.map((ledger) => <option key={ledger.id} value={ledger.id}>{ledger.name}</option>)}</Select>
    : linkType === 'screen' ? <Select value={linkKey} onChange={(event) => setLinkKey(event.target.value)}><option value="">Choose workspace…</option>{SCREENS.filter((screen) => screen.screen && screen.name !== 'task-inbox').map((screen) => <option key={screen.name} value={screen.name}>{screen.title}</option>)}</Select>
      : linkType === 'gst_return' ? <TextInput value={linkKey} placeholder="gstr1:202608" onChange={(event) => setLinkKey(event.target.value)} />
        : linkType === 'voucher' ? <TextInput value={linkKey} inputMode="numeric" placeholder="Voucher ID" onChange={(event) => setLinkKey(event.target.value)} /> : null
  return <Modal title={task ? 'Edit task' : 'New task'} onClose={onClose} dirty={!task && (title.trim().length > 0 || note.trim().length > 0)}>
    <div className="grid gap-3"><Field label="Task"><TextInput autoFocus data-testid="input-task-title" value={title} maxLength={160} placeholder="What needs to happen?" onChange={(event) => setTitle(event.target.value)} /></Field><Field label="Notes"><TextInput value={note} maxLength={2000} placeholder="Context, expected outcome, or next step" onChange={(event) => setNote(event.target.value)} /></Field>
      <div className="grid grid-cols-2 gap-3"><Field label="Priority"><Select value={priority} onChange={(event) => setPriority(event.target.value as PersonalTaskInput['priority'])}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option></Select></Field><Field label="Assigned to"><TextInput value={assignedTo} placeholder="Me or teammate" onChange={(event) => setAssignedTo(event.target.value)} /></Field></div>
      <label className="flex items-center gap-2 text-[11.5px]"><input type="checkbox" checked={hasDueDate} onChange={(event) => setHasDueDate(event.target.checked)} />Set a due date</label>{hasDueDate && <Field label="Due date"><DateInput value={dueDate} context={todayISO()} onChange={setDueDate} testId="input-task-due" /></Field>}
      <div className="grid grid-cols-2 gap-3"><Field label="Link to"><Select value={linkType} onChange={(event) => { setLinkType(event.target.value as TaskLinkType); setLinkKey('') }}><option value="none">Nothing</option><option value="voucher">Voucher</option><option value="ledger">Party / ledger</option><option value="screen">Report / workspace</option><option value="gst_return">GST return</option></Select></Field>{linkControl && <Field label="Linked record">{linkControl}</Field>}</div>
      <div className="mt-1 flex justify-end gap-2"><Button disabled={saving} onClick={onClose}>Cancel</Button><Button variant="primary" data-testid="save-task" disabled={saving || !title.trim() || (linkType !== 'none' && !linkKey.trim())} onClick={() => void save()}>{saving ? 'Saving…' : 'Save task'}</Button></div>
    </div>
  </Modal>
}
