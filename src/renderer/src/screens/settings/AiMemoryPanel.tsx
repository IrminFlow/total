// Settings → AI → Memory (WP 5.6): what the assistant keeps in mind for this company — your own
// entries, the assistant's proposals and suggestions derived from the books — in one DataTable
// with accept / archive / edit / delete, a Suggestions filter, an "Add memory" form, the "use
// memory in answers" switch and (owner) "Forget everything". Main validates and audits every
// change; identifiers (GSTIN / PAN / IFSC / account numbers) are refused there.
import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AI_MEMORY_KIND_LABELS, AI_MEMORY_KINDS, AI_MEMORY_PURPOSE_LABELS, AI_MEMORY_PURPOSES, AI_MEMORY_SOURCE_LABELS, AI_MEMORY_STATUS_LABELS, AI_MEMORY_TEXT_MAX,
  type AiMemoryData, type AiMemoryDto, type AiMemoryKind, type AiMemoryList, type AiMemoryPurpose, type AiMemorySource, type AiMemoryStatus,
  type AiSettingsView
} from '@shared/ai'
import { toDisplayDateTime } from '@shared/dates'
import { aiApi } from '../../lib/aiClient'
import { confirmDialog } from '../../lib/dialogs'
import { useSession, useToasts } from '../../state/stores'
import { Badge, Button, Checkbox, Field, Modal, Panel, SectionTitle, Segmented, Select, TextInput } from '../../components/ui'
import { DataTable, defineColumns } from '../../components/table'
import { MenuButton } from '../../components/kit'
import { TypeAhead, useLedgers } from '../../components/pickers'

/** One table row: a stored entry, or a suggestion derived from the books (not stored yet). */
export interface MemoryRow {
  rowKey: string
  id: number | null
  derivedKey: string | null
  kind: AiMemoryKind
  text: string
  data: AiMemoryData | null
  source: AiMemorySource
  status: AiMemoryStatus
  unrequested: boolean
  reason: string | null
  details: string
  lastUsedAt: string | null
  useCount: number
}

function details(data: AiMemoryData | null, labels: AiMemoryDto['labels']): string {
  if (!data) return ''
  const parts: string[] = []
  if (data.purpose) parts.push(`${AI_MEMORY_PURPOSE_LABELS[data.purpose]}: ${labels.ledger ?? `ledger #${data.ledgerId}`}`)
  else if (data.ledgerId) parts.push(labels.ledger ?? `ledger #${data.ledgerId}`)
  if (data.partyLedgerId) parts.push(`Party: ${labels.party ?? `#${data.partyLedgerId}`}`)
  if (data.itemId) parts.push(`Item: ${labels.item ?? `#${data.itemId}`}`)
  if (data.billDay) parts.push(`Bills around day ${data.billDay}`)
  return parts.join(' · ')
}

/** Entries and derived suggestions as rows (pure; tested). */
export function memoryRows(list: AiMemoryList | null | undefined): MemoryRow[] {
  if (!list) return []
  const stored: MemoryRow[] = (list.entries ?? []).map((m) => ({
    rowKey: `m${m.id}`, id: m.id, derivedKey: null, kind: m.kind, text: m.text, data: m.data, source: m.source, status: m.status, unrequested: m.unrequested,
    reason: null, details: details(m.data, m.labels), lastUsedAt: m.lastUsedAt, useCount: m.useCount
  }))
  const derived: MemoryRow[] = (list.suggestions ?? []).map((s) => ({
    rowKey: `d${s.key}`, id: null, derivedKey: s.key, kind: s.kind, text: s.text, data: s.data, source: 'derived', status: 'suggested', unrequested: false,
    reason: s.reason, details: details(s.data, s.labels ?? {}), lastUsedAt: null, useCount: 0
  }))
  return [...derived, ...stored]
}

export type MemoryFilter = 'all' | 'active' | 'suggested' | 'archived'

const fmtAt = (iso: string | null): string => {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : toDisplayDateTime(d)
}

const COLUMNS = defineColumns<MemoryRow>([
  {
    id: 'kind', header: 'Kind', kind: 'enum', value: (r) => r.kind, width: 96,
    options: AI_MEMORY_KINDS.map((k) => ({ value: k, label: AI_MEMORY_KIND_LABELS[k] }))
  },
  {
    id: 'text', header: 'Memory', kind: 'text', value: (r) => r.text, hideable: false, minWidth: 180,
    text: (r) => [r.text, r.details, r.reason].filter(Boolean).join(' — '),
    cell: (r) => (
      // Wraps (the table's cells are single-line; this list is short and not windowed).
      <div className="flex flex-col gap-0.5 py-1 whitespace-normal">
        <span className="text-ink">
          {r.text}
          {r.unrequested && (
            <Badge tone="danger" className="ml-2" title="Your question did not ask to remember anything — text in the books may have prompted this">
              You did not ask for this
            </Badge>
          )}
        </span>
        {(r.details || r.reason) && <span className="text-caption text-muted">{[r.details, r.reason].filter(Boolean).join(' · ')}</span>}
      </div>
    )
  },
  {
    id: 'source', header: 'Source', kind: 'enum', value: (r) => r.source, width: 110,
    options: (['user', 'assistant', 'derived'] as const).map((s) => ({ value: s, label: AI_MEMORY_SOURCE_LABELS[s] }))
  },
  {
    id: 'status', header: 'Status', kind: 'enum', value: (r) => r.status, width: 96,
    options: (['active', 'suggested', 'archived'] as const).map((s) => ({ value: s, label: AI_MEMORY_STATUS_LABELS[s] })),
    cell: (r) => <Badge tone={r.status === 'active' ? 'success' : r.status === 'suggested' ? 'amber' : 'neutral'}>{AI_MEMORY_STATUS_LABELS[r.status]}</Badge>
  },
  {
    id: 'lastUsed', header: 'Last used', kind: 'text', value: (r) => r.lastUsedAt ?? '', text: (r) => fmtAt(r.lastUsedAt).slice(0, 9), className: 'num text-muted', width: 104,
    cell: (r) => <span title={fmtAt(r.lastUsedAt)}>{fmtAt(r.lastUsedAt).slice(0, 9)}</span>
  },
  { id: 'uses', header: 'Uses', kind: 'number', value: (r) => r.useCount, width: 56 }
])

export function AiMemoryPanel({ view, isOwner }: { view: AiSettingsView; isOwner: boolean }): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { user } = useSession()
  // Accountants may change memory (they may draft); owners may also forget everything.
  const canEdit = !user || user.role !== 'viewer'
  const { data, isLoading } = useQuery({ queryKey: ['aiMemory'], queryFn: aiApi.memory })
  const [filter, setFilter] = useState<MemoryFilter>('all')
  const [editing, setEditing] = useState<MemoryRow | null>(null)
  const [busy, setBusy] = useState(false)
  const all = useMemo(() => memoryRows(data), [data])
  const rows = useMemo(() => (filter === 'all' ? all : all.filter((r) => r.status === filter)), [all, filter])
  const suggestions = all.filter((r) => r.status === 'suggested').length

  const act = async (fn: () => Promise<unknown>, ok?: string): Promise<void> => {
    setBusy(true)
    try {
      await fn()
      await queryClient.invalidateQueries({ queryKey: ['aiMemory'] })
      if (ok) toast.push('success', ok)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const accept = (r: MemoryRow): Promise<void> =>
    act(() => (r.id ? aiApi.setMemoryStatus(r.id, 'active') : aiApi.resolveDerivedMemory(r.derivedKey!, true)), 'Remembered')
  const archive = (r: MemoryRow): Promise<void> =>
    act(() => (r.id ? aiApi.setMemoryStatus(r.id, 'archived') : aiApi.resolveDerivedMemory(r.derivedKey!, false)), r.status === 'suggested' ? 'Dismissed' : 'Archived')
  const remove = async (r: MemoryRow): Promise<void> => {
    if (!r.id) return
    const ok = await confirmDialog({ title: 'Delete memory', message: `Delete “${r.text}”? The assistant will no longer know it.`, confirmLabel: 'Delete', danger: true })
    if (ok) await act(() => aiApi.deleteMemory(r.id!), 'Memory deleted')
  }

  return (
    <div data-testid="ai-memory">
      <SectionTitle right={<span className="text-body-sm text-muted" data-testid="ai-memory-count">{all.filter((r) => r.status === 'active').length} active · {suggestions} suggested</span>}>
        Memory
      </SectionTitle>
      <p className="mb-2 text-body-sm text-muted">
        What the assistant keeps in mind for this company: ledgers you prefer, how you write narrations, how regular parties are booked. Only
        <strong> active</strong> entries are sent with your questions (masked like everything else); suggestions — from the assistant or from your
        books — do nothing until you accept them. Numbers such as GSTINs, PANs and bank accounts are never stored here.
      </p>
      <Panel className="mb-3 p-4">
        <Checkbox
          label="Use memory in answers and drafts"
          hint="Off: nothing below is sent; the assistant still answers."
          checked={view.settings.useMemory}
          disabled={!isOwner || busy}
          onChange={(v) => void act(async () => {
            await aiApi.setSettings({ useMemory: v })
            await queryClient.invalidateQueries({ queryKey: ['aiSettings'] })
          }, v ? 'Memory on' : 'Memory off')}
          testId="input-ai-use-memory"
        />
      </Panel>
      {canEdit && <AddMemoryForm busy={busy} onAdd={(input) => act(() => aiApi.createMemory(input), 'Remembered')} />}
      <Panel>
        <DataTable
          viewId="settings-ai-memory"
          testId="ai-memory"
          ariaLabel="AI memory"
          columns={COLUMNS}
          rows={rows}
          rowKey={(r) => r.rowKey}
          rowAttrs={(r) => ({ 'data-status': r.status, 'data-source': r.source })}
          loading={isLoading}
          maxHeight="50vh"
          virtualize={false}
          trailingWidth={164}
          empty={{
            title: filter === 'suggested' ? 'No suggestions' : 'Nothing remembered yet',
            hint: 'Add a memory above, or ask the assistant to “remember that …”. Suggestions from your books appear once there are enough vouchers.'
          }}
          toolbarStart={
            <Segmented
              label="Show"
              size="sm"
              value={filter}
              onChange={setFilter}
              testId="ai-memory-filter"
              options={[
                { value: 'all', label: 'All' },
                { value: 'active', label: 'Active' },
                { value: 'suggested', label: suggestions ? `Suggestions (${suggestions})` : 'Suggestions' },
                { value: 'archived', label: 'Archived' }
              ]}
            />
          }
          toolbarFeatures={{ groupBy: false, density: false }}
          trailing={(r) =>
            canEdit ? (
              <div className="flex items-center justify-end gap-1 whitespace-nowrap">
                {r.status !== 'active' && (
                  <Button size="sm" variant={r.status === 'suggested' ? 'primary' : 'secondary'} disabled={busy} onClick={() => void accept(r)} data-testid="btn-ai-memory-accept">
                    {r.status === 'archived' ? 'Restore' : 'Accept'}
                  </Button>
                )}
                {r.status === 'suggested' && (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void archive(r)} data-testid="btn-ai-memory-archive">
                    Dismiss
                  </Button>
                )}
                {r.id !== null && (
                  <MenuButton
                    label="More actions"
                    testId={`btn-ai-memory-more-${r.id}`}
                    width={160}
                    items={[
                      { label: 'Edit…', onSelect: () => setEditing(r), testId: 'btn-ai-memory-edit' },
                      ...(r.status === 'active' ? [{ label: 'Archive', onSelect: () => void archive(r), testId: 'btn-ai-memory-archive' }] : []),
                      { label: 'Delete…', onSelect: () => void remove(r), danger: true, testId: 'btn-ai-memory-delete' }
                    ]}
                  >
                    ⋯
                  </MenuButton>
                )}
              </div>
            ) : null
          }
        />
      </Panel>
      {isOwner && (
        <div className="mt-3 flex items-center gap-3">
          <Button
            variant="danger"
            disabled={busy || all.every((r) => r.id === null)}
            data-testid="btn-ai-memory-forget-all"
            onClick={async () => {
              const ok = await confirmDialog({
                title: 'Forget everything',
                message: 'Delete every memory of this company — active, suggested and archived? Suggestions from your books may be offered again. This is recorded in the audit trail.',
                confirmLabel: 'Forget everything',
                danger: true
              })
              if (ok) await act(() => aiApi.forgetAllMemory(), 'Memory cleared')
            }}
          >
            Forget everything…
          </Button>
          <span className="text-hint text-muted">Owner only. The audit trail keeps a record that it was done.</span>
        </div>
      )}
      {editing && (
        <EditMemoryModal
          row={editing}
          onClose={() => setEditing(null)}
          onSave={(kind, text) =>
            act(async () => {
              // A new kind drops the structured part (a purpose belongs to a preference only).
              await aiApi.updateMemory({ id: editing.id!, kind, text, ...(kind !== editing.kind ? { data: null } : {}) })
              setEditing(null)
            }, 'Memory updated')
          }
        />
      )}
    </div>
  )
}

function AddMemoryForm({ busy, onAdd }: { busy: boolean; onAdd: (input: { kind: AiMemoryKind; text: string; data: AiMemoryData | null }) => Promise<void> }): React.JSX.Element {
  const ledgers = useLedgers()
  const [kind, setKind] = useState<AiMemoryKind>('fact')
  const [text, setText] = useState('')
  const [purpose, setPurpose] = useState<AiMemoryPurpose>('payment')
  const [ledgerId, setLedgerId] = useState<number | null>(null)
  const tooLong = text.trim().length > AI_MEMORY_TEXT_MAX
  const options = useMemo(() => ledgers.map((l) => ({ id: l.id, label: l.name })), [ledgers])
  const needsLedger = kind === 'preference' && !ledgerId
  const submit = async (): Promise<void> => {
    const data: AiMemoryData | null = kind === 'preference' && ledgerId ? { purpose, ledgerId } : null
    await onAdd({ kind, text: text.trim(), data })
    setText('')
    setLedgerId(null)
  }
  return (
    <Panel className="mb-3 p-4" testId="ai-memory-add">
      <h3 className="mb-2 text-detail font-semibold">Add memory</h3>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Kind" className="w-36">
          <Select value={kind} onChange={(e) => setKind(e.target.value as AiMemoryKind)} data-testid="input-ai-memory-kind">
            {AI_MEMORY_KINDS.map((k) => (
              <option key={k} value={k}>
                {AI_MEMORY_KIND_LABELS[k]}
              </option>
            ))}
          </Select>
        </Field>
        {kind === 'preference' && (
          <>
            <Field label="For" className="w-40">
              <Select value={purpose} onChange={(e) => setPurpose(e.target.value as AiMemoryPurpose)} data-testid="input-ai-memory-purpose">
                {AI_MEMORY_PURPOSES.map((p) => (
                  <option key={p} value={p}>
                    {AI_MEMORY_PURPOSE_LABELS[p]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Ledger" className="w-56">
              <TypeAhead options={options} value={ledgerId} onPick={setLedgerId} placeholder="Pick a ledger" testId="picker-ai-memory-ledger" />
            </Field>
          </>
        )}
        <Field label="What to remember" className="min-w-64 flex-1" error={tooLong ? `At most ${AI_MEMORY_TEXT_MAX} characters` : undefined}>
          <TextInput
            value={text}
            placeholder={kind === 'preference' ? 'e.g. Pay rent from HDFC Bank' : kind === 'style' ? 'e.g. Narrations start with “Being …”' : 'e.g. Ram Traders is always booked to Purchase A/c'}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && text.trim().length >= 3 && !tooLong && !needsLedger && !busy) void submit()
            }}
            data-testid="input-ai-memory-text"
          />
        </Field>
        <Button variant="primary" disabled={busy || text.trim().length < 3 || tooLong || needsLedger} onClick={() => void submit()} data-testid="btn-ai-memory-add">
          Add
        </Button>
      </div>
    </Panel>
  )
}

function EditMemoryModal({ row, onClose, onSave }: { row: MemoryRow; onClose: () => void; onSave: (kind: AiMemoryKind, text: string) => Promise<void> }): React.JSX.Element {
  const [kind, setKind] = useState<AiMemoryKind>(row.kind)
  const [text, setText] = useState(row.text)
  const dirty = kind !== row.kind || text !== row.text
  const valid = text.trim().length >= 3 && text.trim().length <= AI_MEMORY_TEXT_MAX
  return (
    <Modal title="Edit memory" onClose={onClose} dirty={dirty}>
      <div className="flex flex-col gap-3" data-testid="ai-memory-edit">
        <Field label="Kind">
          <Select value={kind} onChange={(e) => setKind(e.target.value as AiMemoryKind)} data-testid="input-ai-memory-edit-kind">
            {AI_MEMORY_KINDS.map((k) => (
              <option key={k} value={k}>
                {AI_MEMORY_KIND_LABELS[k]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Memory" hint={row.details || undefined} error={valid ? undefined : `Between 3 and ${AI_MEMORY_TEXT_MAX} characters`}>
          <TextInput value={text} onChange={(e) => setText(e.target.value)} data-testid="input-ai-memory-edit-text" />
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!dirty || !valid} onClick={() => void onSave(kind, text.trim())} data-testid="btn-ai-memory-save">
            Save
          </Button>
        </div>
      </div>
    </Modal>
  )
}
