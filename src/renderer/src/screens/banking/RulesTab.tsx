// Banking → Rules (WP 4.1): rules learned from confirmed matches and created vouchers (with how
// many matches they come from and how sure they are — accept, edit, ignore or delete them), and
// the hand-written pattern rules (bank_rules) that always win over learned ones.
import { useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { suggestPattern } from '@shared/bankRules'
import { api, type BankRuleRecord } from '../../lib/client'
import { bankingApi, type LearnedRuleRecord } from '../../lib/bankingClient'
import { DataTable, defineColumns, type TableColumn } from '../../components/table'
import { Badge, Button, Field, Modal, Panel, Select, TextInput, Textarea } from '../../components/ui'
import { MenuButton } from '../../components/kit'
import { LedgerPicker } from '../../components/pickers'
import { LedgerLink } from '../../components/links'
import { useToasts } from '../../state/stores'
import { confirmDialog } from '../../lib/dialogs'
import { DIRECTION_OPTIONS, pct } from './shared'

const STATUS_OPTIONS = [
  { value: 'candidate', label: 'Learning' },
  { value: 'accepted', label: 'Accepted' },
  { value: 'ignored', label: 'Ignored' }
]
const KIND_OPTIONS = [
  { value: 'payment', label: 'Payment' },
  { value: 'receipt', label: 'Receipt' },
  { value: 'contra', label: 'Contra' },
  { value: 'journal', label: 'Journal' }
]

const LEARNED_COLUMNS = defineColumns<LearnedRuleRecord>([
  {
    id: 'tokens',
    header: 'Narration words',
    kind: 'text',
    value: (r) => r.tokens.join(' '),
    hideable: false,
    minWidth: 200,
    cell: (r) => (
      <span className="flex flex-wrap gap-1">
        {r.tokens.map((t) => (
          <span key={t} className="rounded bg-panel2 px-1.5 py-0.5 font-mono text-caption text-ink">
            {t}
          </span>
        ))}
      </span>
    )
  },
  { id: 'direction', header: 'Direction', kind: 'enum', value: (r) => r.direction, options: DIRECTION_OPTIONS, width: 120 },
  {
    id: 'ledger',
    header: 'Ledger',
    kind: 'text',
    value: (r) => r.ledgerName,
    minWidth: 150,
    cell: (r) => <LedgerLink ledgerId={r.ledgerId} name={r.ledgerName} />
  },
  { id: 'party', header: 'Party', kind: 'text', value: (r) => r.partyName, width: 140, defaultHidden: true },
  { id: 'kind', header: 'Voucher', kind: 'enum', value: (r) => r.voucherKind, options: KIND_OPTIONS, width: 110 },
  { id: 'hits', header: 'Learned from', kind: 'number', value: (r) => r.hits, width: 120, text: (r) => `${r.hits} ${r.hits === 1 ? 'match' : 'matches'}` },
  { id: 'applied', header: 'Used', kind: 'number', value: (r) => r.applied, width: 80 },
  { id: 'rejected', header: 'Overruled', kind: 'number', value: (r) => r.rejected, width: 100, defaultHidden: true },
  {
    id: 'confidence',
    header: 'Confidence',
    kind: 'number',
    value: (r) => Math.round(r.confidence * 100),
    width: 116,
    cell: (r) => <Badge tone={r.confidence >= 0.8 ? 'success' : r.confidence >= 0.5 ? 'info' : 'neutral'}>{pct(r.confidence)}</Badge>
  },
  {
    id: 'status',
    header: 'Status',
    kind: 'enum',
    value: (r) => r.status,
    options: STATUS_OPTIONS,
    width: 112,
    cell: (r) => <Badge tone={r.status === 'accepted' ? 'success' : r.status === 'ignored' ? 'neutral' : 'info'}>{STATUS_OPTIONS.find((o) => o.value === r.status)?.label}</Badge>
  },
  { id: 'template', header: 'Narration template', kind: 'text', value: (r) => r.narrationTemplate, defaultHidden: true, width: 180 }
])

export function RulesTab(): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data: learned, isLoading } = useQuery({ queryKey: ['bankLearned'], queryFn: bankingApi.learned.list })
  const [editing, setEditing] = useState<LearnedRuleRecord | null>(null)

  const invalidate = (): Promise<unknown> =>
    Promise.all([queryClient.invalidateQueries({ queryKey: ['bankLearned'] }), queryClient.invalidateQueries({ queryKey: ['bankWorkspace'] })])

  const setStatus = async (r: LearnedRuleRecord, status: LearnedRuleRecord['status']): Promise<void> => {
    try {
      await bankingApi.learned.update(r.id, { status })
      await invalidate()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  const remove = async (r: LearnedRuleRecord): Promise<void> => {
    const ok = await confirmDialog({ title: 'Delete learned rule', message: `Forget “${r.tokens.join(' ')}” → ${r.ledgerName}? New matches can teach it again.`, confirmLabel: 'Delete', danger: true })
    if (!ok) return
    try {
      await bankingApi.learned.remove(r.id)
      await invalidate()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <>
      <Panel className="mb-3">
        <div className="border-b border-line px-4 py-2.5">
          <p className="text-label font-semibold tracking-[0.08em] text-muted uppercase">Learned from your matches · {learned?.length ?? 0}</p>
          <p className="text-hint text-muted">
            Each confirmed match or voucher made from a statement line teaches these. They suggest a ledger for unmatched lines on the next import; accept one to trust it.
          </p>
        </div>
        <DataTable
          viewId="banking-learned"
          testId="banking-learned"
          ariaLabel="Learned bank rules"
          columns={LEARNED_COLUMNS}
          rows={learned ?? []}
          rowKey={(r) => r.id}
          rowAttrs={(r) => ({ 'data-row-id': r.id, 'data-status': r.status })}
          rowClassName={(r) => (r.status === 'ignored' ? 'text-muted' : '')}
          loading={isLoading}
          maxHeight="44vh"
          onRowActivate={setEditing}
          empty={{ title: 'Nothing learned yet', hint: 'Confirm matches or create vouchers from imported statement lines' }}
          trailingWidth={52}
          trailing={(r) => (
            <MenuButton
              label={`Actions for rule ${r.tokens.join(' ')}`}
              testId={`banking-learned-actions-${r.id}`}
              className="px-1.5 text-muted hover:text-ink"
              items={[
                ...(r.status !== 'accepted' ? [{ label: 'Accept', onSelect: () => void setStatus(r, 'accepted'), testId: 'banking-learned-accept' }] : []),
                ...(r.status !== 'ignored' ? [{ label: 'Ignore (never suggest)', onSelect: () => void setStatus(r, 'ignored') }] : [{ label: 'Use again', onSelect: () => void setStatus(r, 'candidate') }]),
                { label: 'Edit…', onSelect: () => setEditing(r) },
                { label: 'Delete', danger: true, onSelect: () => void remove(r) }
              ]}
            >
              ⋯
            </MenuButton>
          )}
          exportOptions={{ title: 'Learned bank rules', periodLabel: '', filename: 'learned-bank-rules' }}
        />
      </Panel>

      <BankRulesPanel />

      {editing && <LearnedEditModal rule={editing} onClose={() => setEditing(null)} onSaved={() => void invalidate().then(() => setEditing(null))} />}
    </>
  )
}

function LearnedEditModal({ rule, onClose, onSaved }: { rule: LearnedRuleRecord; onClose: () => void; onSaved: () => void }): React.JSX.Element {
  const toast = useToasts()
  const [tokens, setTokens] = useState(rule.tokens.join(' '))
  const [ledgerId, setLedgerId] = useState<number | null>(rule.ledgerId)
  const [partyLedgerId, setPartyLedgerId] = useState<number | null>(rule.partyLedgerId)
  const [voucherKind, setVoucherKind] = useState(rule.voucherKind as 'payment' | 'receipt' | 'contra' | 'journal')
  const [template, setTemplate] = useState(rule.narrationTemplate ?? '')
  const [status, setStatus] = useState(rule.status)
  const save = async (): Promise<void> => {
    if (ledgerId == null) return void toast.push('error', 'Pick a ledger')
    try {
      await bankingApi.learned.update(rule.id, {
        tokens: tokens.split(/\s+/).filter(Boolean), ledgerId, partyLedgerId, voucherKind, narrationTemplate: template.trim() || null, status
      })
      toast.push('success', 'Rule saved')
      onSaved()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  return (
    <Modal title="Learned rule" onClose={onClose} wide>
      <div className="flex flex-col gap-3">
        <p className="text-hint text-muted">
          Learned from {rule.hits} {rule.hits === 1 ? 'match' : 'matches'}, used {rule.applied} {rule.applied === 1 ? 'time' : 'times'}, overruled {rule.rejected}. Confidence {pct(rule.confidence)}.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Narration words (all must appear)" hint="UPI / NEFT prefixes and reference numbers are ignored when matching.">
            <TextInput value={tokens} onChange={(e) => setTokens(e.target.value.toUpperCase())} data-testid="input-banking-learned-tokens" />
          </Field>
          <Field label="Status">
            <Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Ledger">
            <LedgerPicker value={ledgerId} onPick={setLedgerId} />
          </Field>
          <Field label="Party (optional)">
            <LedgerPicker value={partyLedgerId} onPick={setPartyLedgerId} placeholder="None" />
          </Field>
          <Field label="Voucher">
            <Select value={voucherKind} onChange={(e) => setVoucherKind(e.target.value as typeof voucherKind)}>
              {KIND_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Narration template" hint="{narration}, {reference} and {date} are replaced from the statement line.">
            <Textarea rows={2} value={template} onChange={(e) => setTemplate(e.target.value)} placeholder="{narration}" />
          </Field>
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" data-testid="btn-banking-learned-save" onClick={() => void save()}>
            Save
          </Button>
        </div>
      </div>
    </Modal>
  )
}

const RULE_KIND_OPTIONS = [
  { value: 'payment', label: 'Payment' },
  { value: 'receipt', label: 'Receipt' }
]

function ruleColumns(onToggleActive: (r: BankRuleRecord) => void): TableColumn<BankRuleRecord>[] {
  return defineColumns<BankRuleRecord>([
    { id: 'pattern', header: 'Pattern', kind: 'text', value: (r) => r.pattern, hideable: false, groupable: false, minWidth: 160 },
    { id: 'ledger', header: 'Ledger', kind: 'text', value: (r) => r.ledgerName, className: 'text-muted', minWidth: 140 },
    { id: 'kind', header: 'Kind', kind: 'enum', value: (r) => r.kind, options: RULE_KIND_OPTIONS, width: 110 },
    { id: 'hits', header: 'Hits', kind: 'number', value: (r) => r.hits, width: 80 },
    {
      id: 'active',
      header: 'Active',
      kind: 'enum',
      value: (r) => (r.active ? 'active' : 'paused'),
      options: [
        { value: 'active', label: 'Active' },
        { value: 'paused', label: 'Paused' }
      ],
      width: 96,
      cell: (r) => (
        <button
          type="button"
          className="text-small text-blue hover:underline"
          onClick={(e) => {
            e.stopPropagation()
            onToggleActive(r)
          }}
        >
          {r.active ? 'Active' : 'Paused'}
        </button>
      )
    }
  ])
}

/** Hand-written pattern rules (bank_rules): case-insensitive substring of the narration → ledger. */
export function BankRulesPanel({ prefill }: { prefill?: { pattern: string; kind: 'payment' | 'receipt' } | null }): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data: rules } = useQuery({ queryKey: ['bankRules'], queryFn: api.bankRules.list })
  const [editingId, setEditingId] = useState<number | null>(null)
  const [pattern, setPattern] = useState(prefill?.pattern ?? '')
  const [ledgerId, setLedgerId] = useState<number | null>(null)
  const [kind, setKind] = useState<'payment' | 'receipt'>(prefill?.kind ?? 'payment')
  const [active, setActive] = useState(true)
  const [saving, setSaving] = useState(false)

  const invalidate = (): Promise<unknown> =>
    Promise.all([queryClient.invalidateQueries({ queryKey: ['bankRules'] }), queryClient.invalidateQueries({ queryKey: ['bankWorkspace'] })])
  const resetForm = (): void => {
    setEditingId(null)
    setPattern('')
    setLedgerId(null)
    setKind('payment')
    setActive(true)
  }
  const edit = (r: BankRuleRecord): void => {
    setEditingId(r.id)
    setPattern(r.pattern)
    setLedgerId(r.ledgerId)
    setKind(r.kind)
    setActive(r.active)
  }
  const save = async (): Promise<void> => {
    if (pattern.trim().length < 2) return void toast.push('error', 'Pattern needs at least 2 characters')
    if (ledgerId == null) return void toast.push('error', 'Pick a ledger')
    setSaving(true)
    try {
      await api.bankRules.save({ pattern: pattern.trim(), ledgerId, kind, active }, editingId ?? undefined)
      await invalidate()
      toast.push('success', editingId ? 'Rule updated' : 'Rule created')
      resetForm()
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setSaving(false)
    }
  }
  const remove = async (r: BankRuleRecord): Promise<void> => {
    const proceed = await confirmDialog({ title: 'Delete rule', message: `Delete rule "${r.pattern}"?`, confirmLabel: 'Delete', danger: true })
    if (!proceed) return
    try {
      await api.bankRules.remove(r.id)
      await invalidate()
      if (editingId === r.id) resetForm()
      toast.push('success', 'Rule deleted')
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  const toggleActive = async (r: BankRuleRecord): Promise<void> => {
    try {
      await api.bankRules.save({ pattern: r.pattern, ledgerId: r.ledgerId, kind: r.kind, active: !r.active }, r.id)
      await invalidate()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  const toggleRef = useRef(toggleActive)
  toggleRef.current = toggleActive
  const rulesColumns = useMemo(() => ruleColumns((r) => void toggleRef.current(r)), [])

  return (
    <Panel>
      <div className="border-b border-line px-4 py-2.5">
        <p className="text-label font-semibold tracking-[0.08em] text-muted uppercase">Your pattern rules · {rules?.length ?? 0}</p>
        <p className="text-hint text-muted">Written by hand: narration contains the pattern → ledger. They win over learned rules.</p>
      </div>
      <DataTable
        testId="banking-rules"
        ariaLabel="Bank rules"
        columns={rulesColumns}
        rows={rules ?? []}
        rowKey={(r) => r.id}
        rowAttrs={(r) => ({ 'data-row-id': r.id })}
        loading={rules === undefined}
        empty={{ title: 'No pattern rules yet', hint: 'Add one below' }}
        onRowActivate={edit}
        toolbarFeatures={{ groupBy: false, density: false, views: false }}
        maxHeight="32vh"
        trailingWidth={120}
        trailing={(r) => (
          <>
            <button className="mr-3 text-small text-blue hover:underline" onClick={() => edit(r)}>
              Edit
            </button>
            <button className="text-small text-cr hover:underline" onClick={() => void remove(r)}>
              Delete
            </button>
          </>
        )}
      />
      <div className="border-t border-line p-4">
        <p className="mb-2 text-caption font-semibold tracking-[0.08em] text-muted uppercase">{editingId ? 'Edit rule' : 'Add rule'}</p>
        <div className="grid grid-cols-4 gap-3">
          <Field label="Pattern" hint={pattern && /\d/.test(pattern) ? `Tip: “${suggestPattern(pattern)}” ignores reference numbers` : undefined}>
            <TextInput value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="e.g. ACME SUPPLIES" data-testid="input-banking-rule-pattern" />
          </Field>
          <Field label="Ledger">
            <LedgerPicker value={ledgerId} onPick={setLedgerId} placeholder="Ledger" />
          </Field>
          <Field label="Kind">
            <Select value={kind} onChange={(e) => setKind(e.target.value as 'payment' | 'receipt')}>
              <option value="payment">Payment (withdrawal)</option>
              <option value="receipt">Receipt (deposit)</option>
            </Select>
          </Field>
          <div className="flex items-end pb-1.5">
            <label className="flex items-center gap-2 text-detail text-ink">
              <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
              Active
            </label>
          </div>
        </div>
        <div className="mt-3 flex justify-end gap-2">
          {editingId && <Button onClick={resetForm}>Cancel edit</Button>}
          <Button variant="primary" disabled={saving} data-testid="btn-banking-save-rule" onClick={() => void save()}>
            {editingId ? 'Save changes' : 'Add rule'}
          </Button>
        </div>
      </div>
    </Panel>
  )
}
