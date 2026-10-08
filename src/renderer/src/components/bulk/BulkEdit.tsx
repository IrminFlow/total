// WP 6.4 — bulk edit UI: the multi-select bar a list screen shows above its DataTable, the
// change → preview → apply dialog, and the recent-bulk-edits dialog with Undo. The server does
// every check (services/bulkEdit.ts): the preview is its dry run, so what the list says is what
// the apply does.
import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { BulkRecordResult, BulkRequest, BulkResult, BulkTarget, BulkUndoResult, ItemChange, LedgerChange, VoucherChange } from '@shared/bulkEdit'
import { BULK_MAX_RECORDS } from '@shared/bulkEdit'
import { toDisplayDateTime } from '@shared/dates'
import { auditUserLabel } from '@shared/auditEntities'
import { api } from '../../lib/client'
import { bulkApi, type BulkBatchRow } from '../../lib/workspaceClient'
import { useSession, useToasts } from '../../state/stores'
import { Badge, Banner, Button, DateInput, Field, Modal, Select, TextInput } from '../ui'
import { DataTable, defineColumns } from '../table'
import { LedgerPicker, useGroups } from '../pickers'

const NOUN: Record<BulkTarget, [string, string]> = { voucher: ['voucher', 'vouchers'], ledger: ['ledger', 'ledgers'], stockItem: ['item', 'items'] }
const noun = (t: BulkTarget, n: number): string => `${n} ${NOUN[t][n === 1 ? 0 : 1]}`

/** The bar over a list while rows are selected: count, Bulk edit…, Clear. */
export function BulkBar({
  target,
  selected,
  onClear,
  onEdit,
  testId
}: {
  target: BulkTarget
  selected: ReadonlySet<number | string>
  onClear: () => void
  onEdit: () => void
  testId: string
}): React.JSX.Element | null {
  if (selected.size === 0) return null
  const over = selected.size > BULK_MAX_RECORDS
  return (
    <div
      role="region"
      aria-label="Selection"
      data-testid={`${testId}-bulkbar`}
      className="mb-2 flex flex-wrap items-center gap-3 rounded-md border border-amberbar/50 bg-amberbar/10 px-3 py-1.5"
    >
      <span className="text-body-sm font-medium text-ink" data-testid={`${testId}-bulk-count`}>
        {noun(target, selected.size)} selected
      </span>
      {over && <span className="text-hint text-warning">At most {BULK_MAX_RECORDS} per bulk edit</span>}
      <span className="flex-1" />
      <Button size="sm" variant="primary" onClick={onEdit} disabled={over} data-testid={`${testId}-bulk-edit`}>
        Bulk edit…
      </Button>
      <Button size="sm" variant="ghost" onClick={onClear} data-testid={`${testId}-bulk-clear`}>
        Clear selection
      </Button>
    </div>
  )
}

type FieldId = VoucherChange['field'] | LedgerChange['field'] | ItemChange['field']

const FIELDS: Record<BulkTarget, { id: FieldId; label: string }[]> = {
  voucher: [
    { id: 'narration', label: 'Narration' },
    { id: 'date', label: 'Date' },
    { id: 'voucherType', label: 'Voucher type (series)' },
    { id: 'party', label: 'Party' },
    { id: 'costCentre', label: 'Cost centre' },
    { id: 'godown', label: 'Godown' }
  ],
  ledger: [
    { id: 'group', label: 'Ledger group' },
    { id: 'creditDays', label: 'Credit terms (days)' },
    { id: 'priceLevel', label: 'Price level' }
  ],
  stockItem: [
    { id: 'gstRate', label: 'GST rate' },
    { id: 'hsn', label: 'HSN / SAC' },
    { id: 'stockGroup', label: 'Stock group' }
  ]
}

const GST_RATES = [0, 0.25, 3, 5, 12, 18, 28]

const STATUS_TONE: Record<string, 'success' | 'danger' | 'neutral' | 'info'> = {
  applied: 'success',
  refused: 'danger',
  unchanged: 'neutral',
  undone: 'info',
  undo_refused: 'danger'
}
const STATUS_LABEL: Record<string, string> = { applied: 'Will change', refused: 'Refused', unchanged: 'No change', undone: 'Undone', undo_refused: 'Kept' }

const RESULT_COLUMNS = defineColumns<BulkRecordResult>([
  { id: 'label', header: 'Record', kind: 'text', value: (r) => r.label, minWidth: 180 },
  {
    id: 'status',
    header: 'Result',
    kind: 'enum',
    value: (r) => r.status,
    options: [
      { value: 'applied', label: 'Will change' },
      { value: 'refused', label: 'Refused' },
      { value: 'unchanged', label: 'No change' }
    ],
    width: 116,
    cell: (r) => <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>
  },
  {
    id: 'change',
    header: 'Change / reason',
    kind: 'text',
    value: (r) =>
      r.status === 'applied' ? `${r.before ?? ''} → ${r.after ?? ''}${r.warnings.length ? ` · ${r.warnings.join('; ')}` : ''}` : (r.reason ?? ''),
    minWidth: 240,
    className: 'text-muted'
  }
])

function useNames(target: BulkTarget, field: FieldId) {
  const needTypes = target === 'voucher' && field === 'voucherType'
  const needCc = target === 'voucher' && field === 'costCentre'
  const needGodowns = target === 'voucher' && field === 'godown'
  const needLevels = target === 'ledger' && field === 'priceLevel'
  const needStockGroups = target === 'stockItem' && field === 'stockGroup'
  const types = useQuery({ queryKey: ['voucherTypes'], queryFn: api.voucherTypes.list, enabled: needTypes })
  const cc = useQuery({ queryKey: ['costCentres'], queryFn: api.cc.list, enabled: needCc })
  const godowns = useQuery({ queryKey: ['godowns'], queryFn: api.godowns.list, enabled: needGodowns })
  const levels = useQuery({ queryKey: ['priceLevels'], queryFn: api.priceLevels.list, enabled: needLevels })
  const stockGroups = useQuery({ queryKey: ['stockGroups'], queryFn: api.stockGroups.list, enabled: needStockGroups })
  return { types: types.data ?? [], cc: cc.data ?? [], godowns: godowns.data ?? [], levels: levels.data ?? [], stockGroups: stockGroups.data ?? [] }
}

/** Change → Preview (server dry run) → Apply. */
export function BulkEditModal({
  target,
  ids,
  scope,
  onClose,
  onApplied
}: {
  target: BulkTarget
  ids: number[]
  /** Voucher lists: the period shown — the server refuses vouchers no longer in it. */
  scope?: { from: string; to: string }
  onClose: () => void
  onApplied: (r: BulkResult) => void
}): React.JSX.Element {
  const toast = useToasts()
  const qc = useQueryClient()
  const { workingDate } = useSession()
  const groups = useGroups()
  const [field, setField] = useState<FieldId>(FIELDS[target][0]!.id)
  const [mode, setMode] = useState<'replace' | 'append' | 'prepend'>('append')
  const [text, setText] = useState('')
  const [date, setDate] = useState(workingDate || new Date().toISOString().slice(0, 10))
  const [fromId, setFromId] = useState<number | null>(null)
  const [toId, setToId] = useState<number | null>(null)
  const [num, setNum] = useState('')
  const [preview, setPreview] = useState<BulkResult | null>(null)
  const [busy, setBusy] = useState(false)
  const names = useNames(target, field)

  const pick = (f: FieldId): void => {
    setField(f)
    setFromId(null)
    setToId(null)
    setNum('')
    setPreview(null)
  }

  const change = useMemo((): BulkRequest['change'] | string => {
    switch (field) {
      case 'narration':
        return mode !== 'replace' && !text.trim() ? 'Type the text to add' : { field, mode, text }
      case 'date':
        return /^\d{4}-\d{2}-\d{2}$/.test(date) ? { field, date } : 'Pick a date'
      case 'voucherType':
        return toId ? { field, voucherTypeId: toId } : 'Pick a voucher type'
      case 'party':
      case 'costCentre':
      case 'godown':
        return toId ? { field, from: fromId, to: toId } : `Pick the new ${field === 'party' ? 'party' : field === 'godown' ? 'godown' : 'cost centre'}`
      case 'group':
        return toId ? { field, groupId: toId } : 'Pick a group'
      case 'creditDays': {
        if (num.trim() === '') return { field, creditDays: null }
        const n = Number(num)
        return Number.isInteger(n) && n >= 0 && n <= 365 ? { field, creditDays: n } : 'Credit days: 0–365, or blank for none'
      }
      case 'priceLevel':
        return { field, priceLevelId: toId }
      case 'gstRate':
        return num === '' ? { field, gstRate: null } : { field, gstRate: Number(num) }
      case 'hsn':
        return { field, hsn: num.trim() || null }
      case 'stockGroup':
        return { field, groupId: toId }
    }
  }, [field, mode, text, date, fromId, toId, num])

  const request = typeof change === 'string' ? null : ({ target, ids, change, ...(target === 'voucher' && scope ? { scope } : {}) } as BulkRequest)

  const runPreview = async (): Promise<void> => {
    if (!request) return void toast.push('error', change as string)
    setBusy(true)
    try {
      setPreview(await bulkApi.preview(request))
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const apply = async (): Promise<void> => {
    if (!request) return
    setBusy(true)
    try {
      const r = await bulkApi.apply(request)
      await qc.invalidateQueries()
      toast.push(r.applied > 0 ? 'success' : 'warning', `Changed ${noun(target, r.applied)}${r.refused ? ` · ${r.refused} refused` : ''}${r.unchanged ? ` · ${r.unchanged} unchanged` : ''}`)
      onApplied(r)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const idSelect = (
    label: string,
    value: number | null,
    set: (v: number | null) => void,
    options: { id: number; name: string }[],
    none: string | null,
    testId: string
  ): React.JSX.Element => (
    <Field label={label}>
      <Select value={value ?? ''} onChange={(e) => { set(e.target.value ? Number(e.target.value) : null); setPreview(null) }} data-testid={testId}>
        {none !== null ? <option value="">{none}</option> : <option value="">Choose…</option>}
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </Select>
    </Field>
  )

  return (
    <Modal title={`Bulk edit ${noun(target, ids.length)}`} onClose={onClose} wide>
      <div className="flex flex-col gap-3" data-testid="bulk-modal">
        <div className="grid grid-cols-3 gap-3">
          <Field label="Change">
            <Select value={field} onChange={(e) => pick(e.target.value as FieldId)} data-testid="bulk-field">
              {FIELDS[target].map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </Select>
          </Field>
          {field === 'narration' && (
            <>
              <Field label="How">
                <Select value={mode} onChange={(e) => { setMode(e.target.value as typeof mode); setPreview(null) }} data-testid="bulk-narration-mode">
                  <option value="append">Add at the end</option>
                  <option value="prepend">Add at the start</option>
                  <option value="replace">Replace</option>
                </Select>
              </Field>
              <Field label={mode === 'replace' ? 'New narration' : 'Text to add'}>
                <TextInput value={text} onChange={(e) => { setText(e.target.value); setPreview(null) }} data-testid="bulk-narration-text" autoFocus />
              </Field>
            </>
          )}
          {field === 'date' && (
            <Field label="New date" hint="The lock date applies to the old and the new date">
              <DateInput value={date} context={workingDate || date} onChange={(d) => { setDate(d); setPreview(null) }} testId="bulk-date" />
            </Field>
          )}
          {field === 'voucherType' && idSelect('New voucher type', toId, setToId, names.types, null, 'bulk-type')}
          {field === 'party' && (
            <>
              <Field label="Only where the party is" hint="Blank = any party">
                <LedgerPicker value={fromId} onPick={(v) => { setFromId(v); setPreview(null) }} placeholder="Any party" testId="bulk-party-from" />
              </Field>
              <Field label="New party">
                <LedgerPicker value={toId} onPick={(v) => { setToId(v); setPreview(null) }} placeholder="Party" testId="bulk-party-to" />
              </Field>
            </>
          )}
          {field === 'costCentre' && (
            <>
              {idSelect('Only allocations to', fromId, setFromId, names.cc, 'Any cost centre', 'bulk-cc-from')}
              {idSelect('Move them to', toId, setToId, names.cc, null, 'bulk-cc-to')}
            </>
          )}
          {field === 'godown' && (
            <>
              {idSelect('Only lines in', fromId, setFromId, names.godowns, 'Any godown', 'bulk-godown-from')}
              {idSelect('Move them to', toId, setToId, names.godowns, null, 'bulk-godown-to')}
            </>
          )}
          {field === 'group' && idSelect('New group', toId, setToId, groups, null, 'bulk-group')}
          {field === 'creditDays' && (
            <Field label="Credit days" hint="Blank = no credit terms">
              <TextInput className="num text-right" value={num} onChange={(e) => { setNum(e.target.value); setPreview(null) }} data-testid="bulk-credit-days" />
            </Field>
          )}
          {field === 'priceLevel' && idSelect('Price level', toId, setToId, names.levels, 'Base rate (none)', 'bulk-price-level')}
          {field === 'gstRate' && (
            <Field label="GST rate">
              <Select value={num} onChange={(e) => { setNum(e.target.value); setPreview(null) }} data-testid="bulk-gst-rate">
                <option value="">None</option>
                {GST_RATES.map((r) => (
                  <option key={r} value={String(r)}>
                    {r}%
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {field === 'hsn' && (
            <Field label="HSN / SAC" hint="4, 6 or 8 digits; blank clears it">
              <TextInput className="num" value={num} onChange={(e) => { setNum(e.target.value); setPreview(null) }} data-testid="bulk-hsn" />
            </Field>
          )}
          {field === 'stockGroup' && idSelect('Stock group', toId, setToId, names.stockGroups, 'No group', 'bulk-stock-group')}
        </div>

        {preview ? (
          <>
            <p className="text-detail text-ink" data-testid="bulk-preview-summary">
              <strong>{preview.applied}</strong> will change · <strong>{preview.refused}</strong> refused · <strong>{preview.unchanged}</strong> unchanged.{' '}
              <span className="text-muted">Each record is checked by the same rules as a single edit; you can undo the batch afterwards.</span>
            </p>
            <DataTable
              testId="bulk-preview"
              ariaLabel="Bulk edit preview"
              columns={RESULT_COLUMNS}
              rows={preview.records}
              rowKey={(r) => r.id}
              rowAttrs={(r) => ({ 'data-status': r.status })}
              maxHeight="40vh"
              toolbarFeatures={{ groupBy: false, density: false, views: false, export: false }}
            />
          </>
        ) : (
          <Banner tone="info">Preview first — nothing changes until you apply.</Banner>
        )}

        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button onClick={() => void runPreview()} loading={busy && !preview} data-testid="bulk-preview-run">
            {preview ? 'Preview again' : 'Preview'}
          </Button>
          <Button
            variant="primary"
            disabled={!preview || preview.applied === 0 || busy}
            onClick={() => void apply()}
            data-testid="bulk-apply"
          >
            {preview ? `Apply to ${noun(target, preview.applied)}` : 'Apply'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

const BATCH_STATUS: Record<BulkBatchRow['status'], { label: string; tone: 'success' | 'info' | 'warning' }> = {
  applied: { label: 'Applied', tone: 'success' },
  partly_undone: { label: 'Partly undone', tone: 'warning' },
  undone: { label: 'Undone', tone: 'info' }
}

const BATCH_COLUMNS = defineColumns<BulkBatchRow>([
  // created_at is SQLite datetime('now') — UTC; shown in local time.
  { id: 'at', header: 'When', kind: 'text', value: (b) => b.createdAt, width: 150, className: 'num text-muted', text: (b) => toDisplayDateTime(new Date(`${b.createdAt.replace(' ', 'T')}Z`)) },
  { id: 'summary', header: 'Bulk edit', kind: 'text', value: (b) => b.summary, minWidth: 220 },
  { id: 'by', header: 'By', kind: 'text', value: (b) => auditUserLabel(b.createdBy), width: 130, className: 'text-muted' },
  {
    id: 'status',
    header: 'Status',
    kind: 'enum',
    value: (b) => b.status,
    options: Object.entries(BATCH_STATUS).map(([value, s]) => ({ value, label: s.label })),
    width: 120,
    cell: (b) => <Badge tone={BATCH_STATUS[b.status].tone}>{BATCH_STATUS[b.status].label}</Badge>
  }
])

/** Recent bulk edits for a target, each with Undo (reverts what nobody changed since). */
export function BulkHistoryModal({ target, onClose }: { target: BulkTarget; onClose: () => void }): React.JSX.Element {
  const toast = useToasts()
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({ queryKey: ['bulkBatches', target], queryFn: () => bulkApi.list(target) })
  const [result, setResult] = useState<BulkUndoResult | null>(null)
  const undo = async (b: BulkBatchRow): Promise<void> => {
    try {
      const r = await bulkApi.undo(b.id)
      setResult(r)
      await qc.invalidateQueries()
      toast.push(r.refused ? 'warning' : 'success', `Undid ${noun(target, r.undone)}${r.refused ? ` · ${r.refused} changed since, kept` : ''}`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  return (
    <Modal title={`Recent bulk edits — ${NOUN[target][1]}`} onClose={onClose} wide>
      <div className="flex flex-col gap-3" data-testid="bulk-history">
        <DataTable
          testId="bulk-batches"
          ariaLabel="Recent bulk edits"
          columns={BATCH_COLUMNS}
          rows={data ?? []}
          loading={isLoading}
          rowKey={(b) => b.id}
          empty={{ title: 'No bulk edits yet', hint: 'Select rows with the checkboxes, then Bulk edit…' }}
          maxHeight="40vh"
          toolbarFeatures={{ groupBy: false, density: false, views: false, export: false }}
          trailing={(b) =>
            b.status !== 'undone' ? (
              <button type="button" className="text-hint text-blue hover:underline" onClick={() => void undo(b)} data-testid={`bulk-undo-${b.id}`}>
                Undo
              </button>
            ) : null
          }
          trailingWidth={64}
        />
        {result && (
          <div data-testid="bulk-undo-result" className="flex flex-col gap-1">
            <p className="text-detail text-ink">
              Undid <strong>{result.undone}</strong>
              {result.refused > 0 && (
                <>
                  {' '}
                  · kept <strong>{result.refused}</strong> that changed since
                </>
              )}
              .
            </p>
            {result.records
              .filter((r) => r.status === 'undo_refused')
              .map((r) => (
                <p key={`${r.entity}:${r.id}`} className="text-hint text-muted">
                  {r.label}: {r.reason}
                </p>
              ))}
          </div>
        )}
        <div className="flex justify-end">
          <Button onClick={onClose} data-testid="bulk-history-done">
            Done
          </Button>
        </div>
      </div>
    </Modal>
  )
}

/** The selection + dialogs a list screen wires up: `selection` for DataTable, the bar, and the
 *  "Bulk edits" history button for its toolbar. */
export function useBulkSelection(
  target: BulkTarget,
  testId: string,
  opts: {
    /** Keys of the rows the list currently shows: a selection is trimmed to them before editing
     *  (a period or filter change since the rows were ticked). */
    visibleIds?: readonly number[]
    scope?: { from: string; to: string }
  } = {}
) {
  const [selected, setSelected] = useState<Set<number>>(() => new Set())
  const [editing, setEditing] = useState(false)
  const [history, setHistory] = useState(false)
  const selection = {
    selected: selected as ReadonlySet<number | string>,
    onChange: (next: Set<number | string>) => setSelected(new Set([...next].map(Number)))
  }
  const bar = (
    <BulkBar target={target} selected={selected} onClear={() => setSelected(new Set())} onEdit={() => setEditing(true)} testId={testId} />
  )
  const historyButton = (
    <Button size="sm" variant="ghost" onClick={() => setHistory(true)} data-testid={`${testId}-bulk-history`} title="Recent bulk edits, with undo">
      Bulk edits
    </Button>
  )
  const dialogs = (
    <>
      {editing && (
        <BulkEditModal
          target={target}
          ids={opts.visibleIds ? [...selected].filter((id) => opts.visibleIds!.includes(id)) : [...selected]}
          scope={opts.scope}
          onClose={() => setEditing(false)}
          onApplied={() => {
            setEditing(false)
            setSelected(new Set())
          }}
        />
      )}
      {history && <BulkHistoryModal target={target} onClose={() => setHistory(false)} />}
    </>
  )
  return { selection, selected, setSelected, bar, historyButton, dialogs }
}
