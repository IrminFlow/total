// WP 2.6 — discount schemes: quantity slabs, value slabs, buy-x-get-y and flat discounts on an
// item, a stock group (and its sub-groups) or everything, for a date range, ranked by priority.
// The editor has a live "try it" calculator running the same pure evaluator the resolver uses.
import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { bestScheme, evaluateScheme, lineGross, type DiscountScheme, type SchemeSlab } from '@shared/pricing'
import { SCHEME_KIND_LABELS, SCHEME_KINDS, discountSchemeInputSchema, type DiscountSchemeInput } from '@shared/pricingSchemas'
import { formatPaise, parseRupees } from '@shared/money'
import { toDisplayDate } from '@shared/dates'
import { api } from '../../lib/client'
import { pricingApi, type DiscountSchemeRow } from '../../lib/pricingClient'
import { useSession, useToasts } from '../../state/stores'
import { AmountInput, Button, Checkbox, DateInput, Field, Modal, PageActions, Panel, Select, TextInput } from '../../components/ui'
import { Badge } from '../../components/kit'
import { DataTable, defineColumns } from '../../components/table'
import { ItemPicker } from '../../components/pickers'
import { confirmDialog } from '../../lib/dialogs'

type Kind = (typeof SCHEME_KINDS)[number]

export function slabSummary(s: Pick<DiscountScheme, 'kind' | 'slabs'>): string {
  return s.slabs
    .map((sl) =>
      s.kind === 'buy_x_get_y'
        ? `buy ${(sl.minQtyMilli ?? 0) / 1000} get ${(sl.freeQtyMilli ?? 0) / 1000}`
        : s.kind === 'value_slab'
          ? `≥ ${formatPaise(sl.minValuePaise ?? 0, { symbol: true })}: ${(sl.discountBp ?? 0) / 100}%`
          : s.kind === 'flat'
            ? `${(sl.discountBp ?? 0) / 100}%`
            : `≥ ${(sl.minQtyMilli ?? 0) / 1000}: ${(sl.discountBp ?? 0) / 100}%`
    )
    .join(' · ')
}

const COLUMNS = defineColumns<DiscountSchemeRow>([
  { id: 'name', header: 'Scheme', kind: 'text', value: (s) => s.name, hideable: false, minWidth: 160 },
  {
    id: 'kind', header: 'Kind', kind: 'enum', value: (s) => s.kind, width: 150,
    options: SCHEME_KINDS.map((k) => ({ value: k, label: SCHEME_KIND_LABELS[k] }))
  },
  { id: 'target', header: 'Applies to', kind: 'text', value: (s) => (s.appliesTo === 'all' ? 'Everything' : `${s.appliesTo === 'group' ? 'Group ' : ''}${s.targetName ?? '—'}`), minWidth: 140 },
  { id: 'slabs', header: 'Slabs', kind: 'text', value: (s) => slabSummary(s), className: 'num', minWidth: 180, groupable: false },
  { id: 'from', header: 'From', kind: 'date', value: (s) => s.fromDate, width: 110 },
  { id: 'to', header: 'To', kind: 'date', value: (s) => s.toDate, width: 110 },
  { id: 'priority', header: 'Priority', kind: 'number', value: (s) => s.priority, width: 90 },
  {
    id: 'active', header: 'Status', kind: 'enum', value: (s) => (s.active ? 'on' : 'off'), width: 100,
    options: [{ value: 'on', label: 'Active' }, { value: 'off', label: 'Paused' }],
    cell: (s) => (s.active ? <Badge tone="success">Active</Badge> : <Badge tone="neutral">Paused</Badge>)
  }
])

export function SchemesTab(): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data, isLoading } = useQuery({ queryKey: ['discountSchemes'], queryFn: pricingApi.schemes })
  const [editing, setEditing] = useState<DiscountSchemeRow | 'new' | null>(null)
  return (
    <>
      <PageActions>
        <Button variant="primary" data-testid="btn-scheme-new" onClick={() => setEditing('new')}>
          New scheme
        </Button>
      </PageActions>
      <Panel>
        <DataTable
          viewId="masters-schemes"
          testId="masters-schemes"
          ariaLabel="Discount schemes"
          columns={COLUMNS}
          rows={data ?? []}
          rowKey={(s) => s.id}
          rowAttrs={(s) => ({ 'data-row-id': s.id })}
          loading={isLoading}
          onRowActivate={(s) => setEditing(s)}
          empty={{ title: 'No discount schemes', hint: 'A scheme discounts sales priced from the default level or MRP — "Diwali 10%", "Buy 2 get 1", "10+ boxes 5% off"' }}
          trailing={(s) => (
            <button
              type="button"
              className="text-small text-cr hover:underline"
              onClick={async () => {
                if (!(await confirmDialog({ title: 'Delete scheme', message: `Delete ${s.name}?`, confirmLabel: 'Delete', danger: true }))) return
                try {
                  await pricingApi.deleteScheme(s.id)
                  await queryClient.invalidateQueries({ queryKey: ['discountSchemes'] })
                } catch (err) {
                  toast.push('error', (err as Error).message)
                }
              }}
            >
              Delete
            </button>
          )}
          trailingWidth={84}
          exportOptions={{ title: 'Discount schemes', periodLabel: 'Masters', filename: 'discount-schemes' }}
        />
      </Panel>
      {editing && <SchemeModal scheme={editing === 'new' ? null : editing} others={(data ?? []).filter((s) => editing === 'new' || s.id !== editing.id)} onClose={() => setEditing(null)} />}
    </>
  )
}

interface SlabDraft {
  min: string
  discount: string
  free: string
}

const toDraft = (kind: Kind, sl: SchemeSlab): SlabDraft => ({
  min: kind === 'value_slab' ? (sl.minValuePaise != null ? String(sl.minValuePaise / 100) : '') : sl.minQtyMilli != null ? String(sl.minQtyMilli / 1000) : '',
  discount: sl.discountBp != null ? String(sl.discountBp / 100) : '',
  free: sl.freeQtyMilli != null ? String(sl.freeQtyMilli / 1000) : ''
})

function fromDraft(kind: Kind, d: SlabDraft): SchemeSlab {
  const n = (s: string, k: number): number | null => (s.trim() === '' ? null : Math.round(Number(s) * k))
  if (kind === 'buy_x_get_y') return { minQtyMilli: n(d.min, 1000), minValuePaise: null, discountBp: null, freeQtyMilli: n(d.free, 1000) }
  if (kind === 'value_slab') return { minQtyMilli: null, minValuePaise: parseRupees(d.min), discountBp: n(d.discount, 100), freeQtyMilli: null }
  return { minQtyMilli: kind === 'flat' ? 0 : n(d.min, 1000), minValuePaise: null, discountBp: n(d.discount, 100), freeQtyMilli: null }
}

function SchemeModal({ scheme, others, onClose }: { scheme: DiscountSchemeRow | null; others: DiscountSchemeRow[]; onClose: () => void }): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { workingDate } = useSession()
  const { data: groups } = useQuery({ queryKey: ['stockGroups'], queryFn: api.stockGroups.list })
  const [name, setName] = useState(scheme?.name ?? '')
  const [kind, setKind] = useState<Kind>(scheme?.kind ?? 'qty_slab')
  const [appliesTo, setAppliesTo] = useState<'item' | 'group' | 'all'>(scheme?.appliesTo ?? 'all')
  const [itemId, setItemId] = useState<number | null>(scheme?.appliesTo === 'item' ? scheme.targetId : null)
  const [groupId, setGroupId] = useState<number | ''>(scheme?.appliesTo === 'group' ? (scheme.targetId ?? '') : '')
  const [from, setFrom] = useState(scheme?.fromDate ?? '')
  const [to, setTo] = useState(scheme?.toDate ?? '')
  const [priority, setPriority] = useState(String(scheme?.priority ?? 0))
  const [active, setActive] = useState(scheme?.active ?? true)
  const [slabs, setSlabs] = useState<SlabDraft[]>(() => (scheme ? scheme.slabs.map((sl) => toDraft(scheme.kind, sl)) : [{ min: '', discount: '', free: '' }]))
  // "Try it": a base rate (₹, as the line is priced before the scheme) and a quantity.
  const [tryRate, setTryRate] = useState<number | null>(10000)
  const [tryQty, setTryQty] = useState('10')

  const input: DiscountSchemeInput = {
    name: name.trim(), kind, appliesTo, targetId: appliesTo === 'item' ? itemId : appliesTo === 'group' ? (groupId === '' ? null : groupId) : null,
    fromDate: from || null, toDate: to || null, priority: Number(priority) || 0, active,
    slabs: (kind === 'flat' ? slabs.slice(0, 1) : slabs).map((d) => fromDraft(kind, d))
  }
  const parsed = discountSchemeInputSchema.safeParse(input)
  const issue = parsed.success ? null : parsed.error.issues[0]?.message ?? 'Check the scheme'

  // The draft as the resolver would see it.
  const draft: DiscountScheme = useMemo(
    () => ({ id: scheme?.id ?? -1, name: name || 'This scheme', kind, appliesTo, targetId: input.targetId ?? null, fromDate: input.fromDate ?? null, toDate: input.toDate ?? null, priority: input.priority ?? 0, active, slabs: input.slabs as SchemeSlab[] }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(input), scheme?.id]
  )
  const qtyMilli = Math.max(0, Math.round(Number(tryQty || '0') * 1000)) || 0
  const hit = tryRate != null && qtyMilli > 0 ? evaluateScheme(draft, qtyMilli, tryRate) : null
  const gross = tryRate != null ? lineGross(qtyMilli, tryRate) : 0
  // Among the other active schemes that would match "everything" or this target, who wins?
  const contest = tryRate != null && qtyMilli > 0
    ? bestScheme([draft, ...others.filter((o) => o.active && (o.appliesTo === 'all' || (o.appliesTo === draft.appliesTo && o.targetId === draft.targetId)))].map((s) => ({ ...s, fromDate: null, toDate: null })), { date: workingDate, qtyMilli, item: { id: draft.appliesTo === 'item' ? (draft.targetId ?? -1) : -1, groupIds: draft.appliesTo === 'group' && draft.targetId ? [draft.targetId] : [], gstRate: null, cessRate: null, mrpPaise: null, lastPurchaseRatePaise: null } }, tryRate)
    : null
  const loses = contest?.hit && contest.hit.scheme.id !== draft.id ? contest.hit.scheme.name : null

  const save = async (): Promise<void> => {
    if (!parsed.success) return void toast.push('error', issue ?? 'Check the scheme')
    try {
      await pricingApi.saveScheme(input, scheme?.id)
      await queryClient.invalidateQueries({ queryKey: ['discountSchemes'] })
      toast.push('success', `Scheme ${input.name} saved`)
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const minLabel = kind === 'value_slab' ? 'Line value from (₹)' : kind === 'buy_x_get_y' ? 'Buy (qty)' : 'From qty'
  return (
    <Modal title={scheme ? `Edit ${scheme.name}` : 'New discount scheme'} onClose={onClose} wide>
      <div className="grid grid-cols-[1fr_17rem] gap-5">
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-3 gap-3">
            <Field label="Name">
              <TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Diwali 10%" data-testid="input-scheme-name" />
            </Field>
            <Field label="Kind">
              <Select value={kind} onChange={(e) => setKind(e.target.value as Kind)} data-testid="input-scheme-kind">
                {SCHEME_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {SCHEME_KIND_LABELS[k]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Priority" hint="Higher wins when schemes overlap">
              <TextInput value={priority} onChange={(e) => setPriority(e.target.value)} className="num text-right" data-testid="input-scheme-priority" />
            </Field>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Applies to">
              <Select value={appliesTo} onChange={(e) => setAppliesTo(e.target.value as 'item' | 'group' | 'all')} data-testid="input-scheme-applies">
                <option value="all">Everything</option>
                <option value="item">One item</option>
                <option value="group">A stock group</option>
              </Select>
            </Field>
            {appliesTo === 'item' && (
              <Field label="Item" className="col-span-2">
                <ItemPicker value={itemId} onPick={setItemId} testId="picker-scheme-item" />
              </Field>
            )}
            {appliesTo === 'group' && (
              <Field label="Stock group (and its sub-groups)" className="col-span-2">
                <Select value={groupId} onChange={(e) => setGroupId(e.target.value ? Number(e.target.value) : '')}>
                  <option value="">Pick a group</option>
                  {(groups ?? []).map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </div>
          <div className="grid grid-cols-3 items-end gap-3">
            <Field label="From">
              <DateInput value={from} context={workingDate} onChange={setFrom} allowEmpty placeholder="Any date" />
            </Field>
            <Field label="To">
              <DateInput value={to} context={workingDate} onChange={setTo} allowEmpty placeholder="Open" />
            </Field>
            <Checkbox label="Active" checked={active} onChange={setActive} testId="input-scheme-active" />
          </div>

          <table className="ledger-table" data-testid="table-scheme-slabs">
            <thead>
              <tr>
                {kind !== 'flat' && <th className="r">{minLabel}</th>}
                {kind === 'buy_x_get_y' ? <th className="r">Get free (qty)</th> : <th className="r">Discount %</th>}
                <th className="w-16" />
              </tr>
            </thead>
            <tbody>
              {(kind === 'flat' ? slabs.slice(0, 1) : slabs).map((d, i) => (
                <tr key={i}>
                  {kind !== 'flat' && (
                    <td className="r">
                      <TextInput value={d.min} onChange={(e) => setSlabs((ss) => ss.map((x, j) => (j === i ? { ...x, min: e.target.value } : x)))} className="num text-right" data-testid="input-scheme-slab-min" aria-label={minLabel} />
                    </td>
                  )}
                  <td className="r">
                    {kind === 'buy_x_get_y' ? (
                      <TextInput value={d.free} onChange={(e) => setSlabs((ss) => ss.map((x, j) => (j === i ? { ...x, free: e.target.value } : x)))} className="num text-right" data-testid="input-scheme-slab-free" aria-label="Free quantity" />
                    ) : (
                      <TextInput value={d.discount} onChange={(e) => setSlabs((ss) => ss.map((x, j) => (j === i ? { ...x, discount: e.target.value } : x)))} className="num text-right" data-testid="input-scheme-slab-discount" aria-label="Discount %" />
                    )}
                  </td>
                  <td className="r">
                    {slabs.length > 1 && kind !== 'flat' && (
                      <button type="button" className="text-small text-cr hover:underline" onClick={() => setSlabs((ss) => ss.filter((_x, j) => j !== i))}>
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {kind !== 'flat' && (
            <button type="button" className="self-start text-hint text-blue hover:underline" data-testid="btn-scheme-slab-add" onClick={() => setSlabs((ss) => [...ss, { min: '', discount: '', free: '' }])}>
              + Add a slab
            </button>
          )}
          {issue && <p className="text-hint text-cr" data-testid="scheme-issue">{issue}</p>}
        </div>

        <aside className="flex flex-col gap-3 rounded-lg border border-line bg-panel2 p-3" data-testid="scheme-try-it">
          <h3 className="text-caption font-semibold tracking-[0.08em] text-muted uppercase">Try it</h3>
          <Field label="Rate before the scheme">
            <AmountInput paise={tryRate} onPaise={setTryRate} testId="input-scheme-try-rate" />
          </Field>
          <Field label="Quantity">
            <TextInput value={tryQty} onChange={(e) => setTryQty(e.target.value)} className="num text-right" data-testid="input-scheme-try-qty" />
          </Field>
          <div className="num flex flex-col gap-1 text-detail">
            <Row label="Line value" paise={gross} />
            <Row label={hit?.freeQtyMilli ? `Free (${hit.freeQtyMilli / 1000})` : `Discount${hit ? ` ${hit.discountBp / 100}%` : ''}`} paise={-(hit?.discountPaise ?? 0)} testId="scheme-try-discount" />
            <div className="flex justify-between border-t border-line pt-1 font-semibold">
              <span>Net (before GST)</span>
              <span data-testid="scheme-try-net">{formatPaise(gross - (hit?.discountPaise ?? 0))}</span>
            </div>
          </div>
          <p className="text-hint text-muted" data-testid="scheme-try-why">
            {!hit ? 'No slab reached at this quantity.' : hit.why}
            {from || to ? ` Runs ${from ? toDisplayDate(from) : 'any date'} → ${to ? toDisplayDate(to) : 'open'}.` : ''}
          </p>
          {loses && <p className="text-hint text-cr">“{loses}” outranks this scheme on such a line (priority / bigger discount).</p>}
        </aside>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => void save()} disabled={!!issue} data-testid="btn-scheme-save">
          Save scheme
        </Button>
      </div>
    </Modal>
  )
}

function Row({ label, paise, testId }: { label: string; paise: number; testId?: string }): React.JSX.Element {
  return (
    <div className="flex justify-between">
      <span className="text-muted">{label}</span>
      <span data-testid={testId}>{formatPaise(paise)}</span>
    </div>
  )
}
