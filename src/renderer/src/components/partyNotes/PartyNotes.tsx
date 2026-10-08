// WP 6.4 — notes and tasks on a party (party_notes). Shown on the ledger's edit window (Notes
// tab) and in Credit control. Party-level; a note about one bill is a follow-up on that bill
// (Outstandings → expand the party).
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { taskBucket, type PartyNote } from '@shared/partyNotes'
import { todayISO, toDisplayDate } from '@shared/dates'
import { partyNotesApi } from '../../lib/workspaceClient'
import { confirmDialog } from '../../lib/dialogs'
import { useToasts } from '../../state/stores'
import { Badge, Button, Checkbox, DateInput, Field, Select, Textarea } from '../ui'
import { DataTable, defineColumns, type TableColumn } from '../table'
import { LedgerLink } from '../links'
import { LedgerPicker } from '../pickers'

export const partyNotesKey = ['partyNotes'] as const

const DUE: Record<string, { label: string; tone: 'danger' | 'warning' | 'info' | 'neutral' | 'success' }> = {
  overdue: { label: 'Overdue', tone: 'danger' },
  today: { label: 'Due today', tone: 'warning' },
  week: { label: 'This week', tone: 'info' },
  later: { label: 'Later', tone: 'neutral' },
  none: { label: '', tone: 'neutral' },
  done: { label: 'Done', tone: 'success' }
}

function noteColumns(withParty: boolean, today: string): TableColumn<PartyNote>[] {
  return defineColumns<PartyNote>([
    ...(withParty
      ? [{ id: 'party', header: 'Party', kind: 'text' as const, value: (n: PartyNote) => n.ledgerName, width: 180, cell: (n: PartyNote) => <LedgerLink ledgerId={n.ledgerId} name={n.ledgerName} /> }]
      : []),
    {
      id: 'kind',
      header: 'Kind',
      kind: 'enum',
      value: (n) => n.kind,
      options: [
        { value: 'task', label: 'Task' },
        { value: 'note', label: 'Note' }
      ],
      width: 80
    },
    { id: 'text', header: 'Note / task', kind: 'text', value: (n) => n.text, minWidth: 220, className: '' },
    { id: 'due', header: 'Due', kind: 'date', value: (n) => n.dueDate, width: 104 },
    {
      id: 'status',
      header: 'Status',
      kind: 'text',
      value: (n) => DUE[taskBucket(n, today)]!.label,
      width: 104,
      cell: (n) => {
        const b = DUE[taskBucket(n, today)]!
        return b.label ? <Badge tone={b.tone}>{b.label}</Badge> : null
      }
    },
    { id: 'by', header: 'By', kind: 'text', value: (n) => (n.createdBy ?? '').replace(/^os:/, ''), width: 100, className: 'text-muted', defaultHidden: true }
  ])
}

/** Notes and tasks for one party (ledgerId) or every party (Credit control). */
export function PartyNotesPanel({
  ledgerId,
  showDone,
  onShowDone,
  testId = 'party-notes'
}: {
  ledgerId?: number
  showDone: boolean
  onShowDone?: (v: boolean) => void
  testId?: string
}): React.JSX.Element {
  const toast = useToasts()
  const qc = useQueryClient()
  const today = todayISO()
  const { data, isLoading } = useQuery({
    queryKey: [...partyNotesKey, ledgerId ?? 'all', showDone],
    queryFn: () => partyNotesApi.list({ ledgerId, includeDone: showDone, ...(ledgerId ? {} : { kind: 'task' as const }) })
  })
  const [kind, setKind] = useState<'note' | 'task'>(ledgerId ? 'note' : 'task')
  const [text, setText] = useState('')
  const [due, setDue] = useState('')
  const [party, setParty] = useState<number | null>(ledgerId ?? null)
  const refresh = (): Promise<void> => qc.invalidateQueries({ queryKey: partyNotesKey }).then(() => qc.invalidateQueries({ queryKey: ['dashboard', 'tasksDue'] }))
  const add = async (): Promise<void> => {
    if (!party) return void toast.push('error', 'Pick the party')
    if (!text.trim()) return void toast.push('error', 'Write the note or task')
    try {
      await partyNotesApi.add({ ledgerId: party, kind, text, dueDate: kind === 'task' && due ? due : null })
      setText('')
      setDue('')
      await refresh()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  const setDone = async (n: PartyNote, done: boolean): Promise<void> => {
    try {
      await partyNotesApi.update({ id: n.id, done })
      await refresh()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  const remove = async (n: PartyNote): Promise<void> => {
    if (!(await confirmDialog({ title: `Delete ${n.kind}`, message: `Delete “${n.text.slice(0, 80)}”?`, confirmLabel: 'Delete', danger: true }))) return
    try {
      await partyNotesApi.remove(n.id)
      await refresh()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  return (
    <div className="flex flex-col gap-3" data-testid={testId}>
      <div className="grid grid-cols-[110px_1fr_150px_auto] items-end gap-2">
        <Field label="Add">
          <Select value={kind} onChange={(e) => setKind(e.target.value as 'note' | 'task')} data-testid={`${testId}-kind`}>
            <option value="note">Note</option>
            <option value="task">Task</option>
          </Select>
        </Field>
        <Field label={kind === 'task' ? 'Task' : 'Note'}>
          <Textarea rows={1} value={text} onChange={(e) => setText(e.target.value)} placeholder={kind === 'task' ? 'Call about the March bills' : 'Prefers statements by email'} data-testid={`${testId}-text`} />
        </Field>
        {kind === 'task' ? (
          <Field label="Due">
            <DateInput value={due} context={today} onChange={setDue} allowEmpty testId={`${testId}-due`} placeholder="No date" />
          </Field>
        ) : (
          <span />
        )}
        <Button variant="primary" onClick={() => void add()} data-testid={`${testId}-add`}>
          Add
        </Button>
      </div>
      {!ledgerId && (
        <Field label="Party">
          <LedgerPicker value={party} onPick={setParty} placeholder="Party" testId={`${testId}-party`} />
        </Field>
      )}
      <DataTable
        testId={testId}
        ariaLabel={ledgerId ? 'Notes and tasks' : 'Party tasks'}
        columns={noteColumns(!ledgerId, today)}
        rows={data ?? []}
        loading={isLoading}
        rowKey={(n) => n.id}
        rowAttrs={(n) => ({ 'data-kind': n.kind, 'data-done': n.doneAt ? 1 : 0 })}
        empty={{ title: ledgerId ? 'No notes or tasks yet' : showDone ? 'No party tasks' : 'No open party tasks', hint: ledgerId ? undefined : 'Add one above, or on the ledger’s Notes tab' }}
        maxHeight="40vh"
        toolbarFeatures={{ groupBy: false, density: false, views: false, export: !ledgerId }}
        exportOptions={ledgerId ? undefined : { title: 'Party tasks', periodLabel: `as on ${toDisplayDate(today)}`, filename: 'party-tasks' }}
        toolbarEnd={
          onShowDone ? (
            <Checkbox label="Show done" checked={showDone} onChange={onShowDone} testId={`${testId}-show-done`} />
          ) : undefined
        }
        trailing={(n) => (
          <span className="flex items-center justify-end gap-3">
            {n.kind === 'task' && (
              <button type="button" className="text-hint text-blue hover:underline" onClick={() => void setDone(n, !n.doneAt)} data-testid="btn-note-done">
                {n.doneAt ? 'Reopen' : 'Done'}
              </button>
            )}
            <button type="button" className="text-hint text-cr hover:underline" onClick={() => void remove(n)} data-testid="btn-note-delete">
              Delete
            </button>
          </span>
        )}
        trailingWidth={110}
      />
    </div>
  )
}
