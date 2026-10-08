// WP 6.5 — Consolidation → Groups: members (role, ownership, acquisition, inclusion window,
// investment ledger), the group chart mapping overrides and the inter-company pairs (with
// GSTIN / PAN auto-suggest). The definition is saved in the open company.
import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ConsolidationGroup, ConsolidationMapping, IntercompanyPair, MemberChart, MemberRole, PairKind } from '@shared/consolidation/types'
import type { Nature } from '@shared/domain'
import type { PairSuggestion } from '@shared/consolidation/suggest'
import { api } from '../../lib/client'
import { consolidationApi, type GroupInputPayload } from '../../lib/consolidationClient'
import { useToasts } from '../../state/stores'
import { confirmDialog } from '../../lib/dialogs'
import { AmountInput, Badge, Banner, Button, DateInput, EmptyState, Field, Panel, SectionTitle, Select, TextInput } from '../../components/ui'
import { DataTable, defineColumns } from '../../components/table'
import { bpToPct, KIND_LABELS, pctToBp } from './view'

interface MemberDraft {
  companySlug: string
  role: MemberRole
  ownershipPct: string
  acquiredOn: string
  includeFrom: string
  includeTo: string
  investmentLedgerId: number | null
  acquisitionEquity: number | null
}

const toDraft = (g: ConsolidationGroup | null, openSlug: string | null): MemberDraft[] =>
  g
    ? g.members.map((m) => ({
        companySlug: m.companySlug, role: m.role, ownershipPct: bpToPct(m.ownershipBp), acquiredOn: m.acquiredOn ?? '', includeFrom: m.includeFrom ?? '',
        includeTo: m.includeTo ?? '', investmentLedgerId: m.investmentLedgerId, acquisitionEquity: m.acquisitionEquity
      }))
    : openSlug
      ? [{ companySlug: openSlug, role: 'parent', ownershipPct: '100', acquiredOn: '', includeFrom: '', includeTo: '', investmentLedgerId: null, acquisitionEquity: null }]
      : []

/** Draft → save payload (exported for the renderer test). */
export function draftToPayload(name: string, currency: string, tolerance: number | null, marginPct: string, members: MemberDraft[]): GroupInputPayload {
  return {
    name: name.trim(),
    presentationCurrency: currency.trim() || 'INR',
    icTolerance: tolerance ?? 0,
    unrealisedMarginBp: pctToBp(marginPct),
    members: members.map((m) => ({
      companySlug: m.companySlug, role: m.role, ownershipBp: m.role === 'parent' ? 10000 : pctToBp(m.ownershipPct) ?? 10000,
      acquiredOn: m.acquiredOn || null, includeFrom: m.includeFrom || null, includeTo: m.includeTo || null,
      investmentLedgerId: m.role === 'parent' ? null : m.investmentLedgerId, acquisitionEquity: m.role === 'parent' ? null : m.acquisitionEquity
    }))
  }
}

export function GroupSetup({ group, openSlug, onSaved, onDeleted }: {
  group: ConsolidationGroup | null
  openSlug: string | null
  onSaved: (g: ConsolidationGroup) => void
  onDeleted: () => void
}): React.JSX.Element {
  const toast = useToasts()
  const { data: registry } = useQuery({ queryKey: ['company-registry'], queryFn: api.company.list })
  const companies = registry?.companies ?? []
  const [name, setName] = useState(group?.name ?? '')
  const [currency, setCurrency] = useState(group?.presentationCurrency ?? 'INR')
  const [tolerance, setTolerance] = useState<number | null>(group?.icTolerance ?? 100)
  const [margin, setMargin] = useState(bpToPct(group?.unrealisedMarginBp))
  const [members, setMembers] = useState<MemberDraft[]>(() => toDraft(group, openSlug))
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    setName(group?.name ?? '')
    setCurrency(group?.presentationCurrency ?? 'INR')
    setTolerance(group?.icTolerance ?? 100)
    setMargin(bpToPct(group?.unrealisedMarginBp))
    setMembers(toDraft(group, openSlug))
  }, [group, openSlug])

  const { data: charts } = useQuery({ queryKey: ['consolCharts', group?.id], queryFn: () => consolidationApi.charts(group!.id), enabled: !!group })
  const parentSlug = members.find((m) => m.role === 'parent')?.companySlug
  const parentChart = charts?.find((c) => c.slug === parentSlug)
  const investmentLedgers = (parentChart?.ledgers ?? []).filter((l) => l.nature === 'asset')
  const nameOf = (slug: string): string => companies.find((c) => c.slug === slug)?.name ?? slug

  const patch = (i: number, p: Partial<MemberDraft>): void => setMembers((ms) => ms.map((m, j) => (j === i ? { ...m, ...p } : p.role === 'parent' && m.role === 'parent' ? { ...m, role: 'subsidiary' } : m)))
  const addable = companies.filter((c) => !members.some((m) => m.companySlug === c.slug))

  const save = async (): Promise<void> => {
    if (!name.trim()) return toast.push('error', 'Name the group')
    setSaving(true)
    try {
      const saved = await consolidationApi.saveGroup(draftToPayload(name, currency, tolerance, margin, members), group?.id)
      toast.push('success', `Saved “${saved.name}”`)
      onSaved(saved)
    } catch (err) {
      toast.push('error', err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }
  const remove = async (): Promise<void> => {
    if (!group) return
    if (!(await confirmDialog({ title: `Delete “${group.name}”?`, message: 'The group definition, its mappings and pairs are removed. No company’s books change.', danger: true, confirmLabel: 'Delete' }))) return
    await consolidationApi.deleteGroup(group.id)
    onDeleted()
  }

  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <div className="flex flex-col gap-4 p-panel">
          <div className="grid gap-3 md:grid-cols-4">
            <Field label="Group name" required>
              <TextInput data-testid="input-consol-name" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Presentation currency" hint="Members' books are INR; no translation">
              <TextInput data-testid="input-consol-currency" value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
            </Field>
            <Field label="Inter-company tolerance" hint="Pairs that differ by up to this are reconciled">
              <AmountInput testId="input-consol-tolerance" paise={tolerance} onPaise={setTolerance} />
            </Field>
            <Field label="Unrealised profit margin %" hint="Blank = off; per pair overrides">
              <TextInput data-testid="input-consol-margin" value={margin} onChange={(e) => setMargin(e.target.value)} placeholder="off" />
            </Field>
          </div>

          <SectionTitle as="h3">Members</SectionTitle>
          <div className="overflow-x-auto">
            <table className="w-full text-detail" data-testid="consol-members">
              <thead className="text-left text-caption uppercase tracking-[0.08em] text-muted">
                <tr>
                  <th className="py-1 pr-2 font-semibold">Company</th>
                  <th className="py-1 pr-2 font-semibold">Role</th>
                  <th className="py-1 pr-2 font-semibold">Ownership %</th>
                  <th className="py-1 pr-2 font-semibold">Acquired on</th>
                  <th className="py-1 pr-2 font-semibold">Include from</th>
                  <th className="py-1 pr-2 font-semibold">Include to</th>
                  <th className="py-1 pr-2 font-semibold">Investment ledger (parent)</th>
                  <th className="py-1 pr-2 font-semibold">Equity at acquisition</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {members.map((m, i) => (
                  <tr key={m.companySlug} data-member={m.companySlug} className="border-t border-line align-top">
                    <td className="py-1.5 pr-2">{nameOf(m.companySlug)}</td>
                    <td className="py-1.5 pr-2">
                      <Select aria-label="Role" className="w-32" data-testid={`select-consol-role-${m.companySlug}`} value={m.role} onChange={(e) => patch(i, { role: e.target.value as MemberRole })}>
                        <option value="parent">Parent</option>
                        <option value="subsidiary">Subsidiary</option>
                        <option value="associate">Associate</option>
                      </Select>
                    </td>
                    <td className="py-1.5 pr-2">
                      <TextInput aria-label="Ownership %" data-testid={`input-consol-own-${m.companySlug}`} className="w-20" disabled={m.role === 'parent'} value={m.role === 'parent' ? '100' : m.ownershipPct} onChange={(e) => patch(i, { ownershipPct: e.target.value })} />
                    </td>
                    {(['acquiredOn', 'includeFrom', 'includeTo'] as const).map((k) => (
                      <td key={k} className="py-1.5 pr-2">
                        <DateInput ariaLabel={k} testId={`input-consol-${k}-${m.companySlug}`} allowEmpty value={m[k]} context={m[k] || '2025-04-01'} onChange={(v) => patch(i, { [k]: v })} className="w-28" />
                      </td>
                    ))}
                    <td className="py-1.5 pr-2">
                      {m.role === 'parent' ? (
                        <span className="text-muted">—</span>
                      ) : group ? (
                        <Select aria-label="Investment ledger" data-testid={`select-consol-invest-${m.companySlug}`} value={m.investmentLedgerId ?? ''} onChange={(e) => patch(i, { investmentLedgerId: e.target.value ? Number(e.target.value) : null })}>
                          <option value="">— none —</option>
                          {investmentLedgers.map((l) => (
                            <option key={l.id} value={l.id}>{l.name} ({l.groupName})</option>
                          ))}
                        </Select>
                      ) : (
                        <span className="text-hint text-muted">Save the group first</span>
                      )}
                    </td>
                    <td className="py-1.5 pr-2">
                      {m.role === 'parent' ? <span className="text-muted">—</span> : <AmountInput testId={`input-consol-equity-${m.companySlug}`} ariaLabel="Equity at acquisition" placeholder="from books" paise={m.acquisitionEquity} onPaise={(v) => patch(i, { acquisitionEquity: v })} />}
                    </td>
                    <td className="py-1.5">
                      <Button size="sm" variant="ghost" onClick={() => setMembers((ms) => ms.filter((_, j) => j !== i))} disabled={m.role === 'parent' && members.length > 1} disabledTitle="Make another member the parent first">
                        Remove
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select aria-label="Add a company" data-testid="select-consol-add" className="w-64" value="" onChange={(e) => {
              const slug = e.target.value
              if (slug) setMembers((ms) => [...ms, { companySlug: slug, role: ms.some((m) => m.role === 'parent') ? 'subsidiary' : 'parent', ownershipPct: '100', acquiredOn: '', includeFrom: '', includeTo: '', investmentLedgerId: null, acquisitionEquity: null }])
            }}>
              <option value="">Add a company…</option>
              {addable.map((c) => (
                <option key={c.slug} value={c.slug}>{c.name}</option>
              ))}
            </Select>
            <span className="flex-1" />
            {group && <Button variant="danger" onClick={() => void remove()}>Delete group</Button>}
            <Button variant="primary" data-testid="btn-consol-save" loading={saving} onClick={() => void save()}>
              {group ? 'Save group' : 'Create group'}
            </Button>
          </div>
          {charts?.filter((c) => !c.available).map((c) => (
            <Banner key={c.slug} tone="warning">{c.warning}</Banner>
          ))}
        </div>
      </Panel>
      {group && charts && <PairsPanel group={group} charts={charts} />}
      {group && charts && <MappingsPanel group={group} charts={charts} />}
    </div>
  )
}

// ---------------------------------------------------------------- pairs

interface PairRow extends IntercompanyPair { aName: string; aLedger: string; bName: string; bLedger: string }

function ledgerName(charts: MemberChart[], slug: string, id: number): string {
  return charts.find((c) => c.slug === slug)?.ledgers.find((l) => l.id === id)?.name ?? `#${id} (not found)`
}

function PairsPanel({ group, charts }: { group: ConsolidationGroup; charts: MemberChart[] }): React.JSX.Element {
  const qc = useQueryClient()
  const toast = useToasts()
  const [suggestions, setSuggestions] = useState<PairSuggestion[] | null>(null)
  const [draft, setDraft] = useState<{ a: string; la: string; b: string; lb: string; kind: PairKind; margin: string }>({ a: '', la: '', b: '', lb: '', kind: 'receivable_payable', margin: '' })
  const refresh = (): void => void qc.invalidateQueries({ queryKey: ['consolGroups'] })
  const chartName = (slug: string): string => charts.find((c) => c.slug === slug)?.name ?? slug
  const rows: PairRow[] = group.pairs.map((p) => ({ ...p, aName: chartName(p.memberA), aLedger: ledgerName(charts, p.memberA, p.ledgerAId), bName: chartName(p.memberB), bLedger: ledgerName(charts, p.memberB, p.ledgerBId) }))
  const columns = useMemo(() => defineColumns<PairRow>([
    { id: 'kind', header: 'Kind', kind: 'enum', value: (p) => p.kind, options: Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label })), width: 170 },
    { id: 'aName', header: 'Company A', kind: 'text', value: (p) => p.aName },
    { id: 'aLedger', header: 'Ledger in A', kind: 'text', value: (p) => p.aLedger },
    { id: 'bName', header: 'Company B', kind: 'text', value: (p) => p.bName },
    { id: 'bLedger', header: 'Ledger in B', kind: 'text', value: (p) => p.bLedger },
    { id: 'margin', header: 'Margin %', kind: 'number', value: (p) => (p.unrealisedMarginBp == null ? null : p.unrealisedMarginBp / 100), width: 100 }
  ]), [])

  const add = async (s: { memberA: string; ledgerAId: number; memberB: string; ledgerBId: number; kind: PairKind; unrealisedMarginBp?: number | null }): Promise<boolean> => {
    try {
      await consolidationApi.savePair({ groupId: group.id, ...s })
      return true
    } catch (err) {
      toast.push('error', err instanceof Error ? err.message : String(err))
      return false
    }
  }
  const suggest = async (): Promise<void> => setSuggestions(await consolidationApi.suggestPairs(group.id))
  const accept = async (list: PairSuggestion[]): Promise<void> => {
    for (const s of list) await add(s)
    setSuggestions((cur) => {
      const left = (cur ?? []).filter((x) => !list.includes(x))
      return left.length ? left : null
    })
    refresh()
  }
  const addManual = async (): Promise<void> => {
    if (!draft.a || !draft.b || !draft.la || !draft.lb) return toast.push('error', 'Pick both companies and both ledgers')
    if (await add({ memberA: draft.a, ledgerAId: Number(draft.la), memberB: draft.b, ledgerBId: Number(draft.lb), kind: draft.kind, unrealisedMarginBp: pctToBp(draft.margin) })) {
      setDraft({ ...draft, la: '', lb: '' })
      refresh()
    }
  }
  const linedMembers = charts.filter((c) => group.members.find((m) => m.companySlug === c.slug)?.role !== 'associate')
  const ledgersOf = (slug: string) => charts.find((c) => c.slug === slug)?.ledgers ?? []

  return (
    <Panel>
      <div className="flex flex-col gap-3 p-panel">
        <SectionTitle as="h3" right={<Button data-testid="btn-consol-suggest" size="sm" onClick={() => void suggest()}>Suggest pairs</Button>}>
          Inter-company pairs
        </SectionTitle>
        <p className="text-hint text-muted">
          A balance pair (receivable / payable, loan) eliminates the two ledgers’ balances; a sales / purchases or loan pair on party ledgers eliminates the P&amp;L lines of the vouchers booked against them. Suggestions match party ledgers by the other company’s GSTIN, PAN or name.
        </p>
        {suggestions && (
          suggestions.length === 0 ? (
            <Banner tone="info">No new pairs to suggest — give each company’s party ledger the other’s GSTIN or PAN.</Banner>
          ) : (
            <div className="rounded-md border border-line bg-panel2 p-3" data-testid="consol-suggestions">
              <div className="mb-2 flex items-center gap-2">
                <span className="text-detail font-semibold">{suggestions.length} suggested</span>
                <span className="flex-1" />
                <Button size="sm" variant="primary" data-testid="btn-consol-accept-all" onClick={() => void accept(suggestions)}>Accept all</Button>
              </div>
              <ul className="flex flex-col gap-1 text-detail">
                {suggestions.map((s, i) => (
                  <li key={i} className="flex items-center gap-2">
                    <Badge tone="info">{s.reason}</Badge>
                    <span>{KIND_LABELS[s.kind]}: {chartName(s.memberA)} · {s.ledgerAName} ↔ {chartName(s.memberB)} · {s.ledgerBName}</span>
                    <span className="flex-1" />
                    <Button size="sm" onClick={() => void accept([s])}>Accept</Button>
                  </li>
                ))}
              </ul>
            </div>
          )
        )}
        <DataTable
          viewId="consol-pairs"
          testId="consol-pairs"
          ariaLabel="Inter-company pairs"
          columns={columns}
          rows={rows}
          rowKey={(p) => p.id}
          maxHeight="none"
          trailing={(p) => (
            <Button size="sm" variant="ghost" onClick={() => void consolidationApi.deletePair(p.id).then(refresh)}>Remove</Button>
          )}
          empty={{ title: 'No pairs yet', hint: 'Suggest pairs, or add one below' }}
        />
        <div className="grid items-end gap-2 md:grid-cols-7">
          <Field label="Company A">
            <Select data-testid="select-pair-a" value={draft.a} onChange={(e) => setDraft({ ...draft, a: e.target.value, la: '' })}>
              <option value="">—</option>
              {linedMembers.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
            </Select>
          </Field>
          <Field label="Ledger in A">
            <Select data-testid="select-pair-la" value={draft.la} onChange={(e) => setDraft({ ...draft, la: e.target.value })}>
              <option value="">—</option>
              {ledgersOf(draft.a).map((l) => <option key={l.id} value={l.id}>{l.name} ({l.groupName})</option>)}
            </Select>
          </Field>
          <Field label="Company B">
            <Select data-testid="select-pair-b" value={draft.b} onChange={(e) => setDraft({ ...draft, b: e.target.value, lb: '' })}>
              <option value="">—</option>
              {linedMembers.filter((c) => c.slug !== draft.a).map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
            </Select>
          </Field>
          <Field label="Ledger in B">
            <Select data-testid="select-pair-lb" value={draft.lb} onChange={(e) => setDraft({ ...draft, lb: e.target.value })}>
              <option value="">—</option>
              {ledgersOf(draft.b).map((l) => <option key={l.id} value={l.id}>{l.name} ({l.groupName})</option>)}
            </Select>
          </Field>
          <Field label="Kind">
            <Select data-testid="select-pair-kind" value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as PairKind })}>
              {Object.entries(KIND_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </Field>
          <Field label="Margin %">
            <TextInput value={draft.margin} placeholder="group's" onChange={(e) => setDraft({ ...draft, margin: e.target.value })} />
          </Field>
          <Button data-testid="btn-pair-add" onClick={() => void addManual()}>Add pair</Button>
        </div>
      </div>
    </Panel>
  )
}

// ---------------------------------------------------------------- mappings

interface MappingRow extends ConsolidationMapping { company: string; source: string }

function MappingsPanel({ group, charts }: { group: ConsolidationGroup; charts: MemberChart[] }): React.JSX.Element {
  const qc = useQueryClient()
  const toast = useToasts()
  const [draft, setDraft] = useState<{ slug: string; by: 'group' | 'ledger'; source: string; target: string; nature: '' | Nature }>({ slug: '', by: 'group', source: '', target: '', nature: '' })
  const refresh = (): void => void qc.invalidateQueries({ queryKey: ['consolGroups'] })
  const chart = charts.find((c) => c.slug === draft.slug)
  const rows: MappingRow[] = group.mappings.map((m) => ({
    ...m,
    company: charts.find((c) => c.slug === m.companySlug)?.name ?? m.companySlug,
    source: m.ledgerId != null ? `Ledger: ${ledgerName(charts, m.companySlug, m.ledgerId)}` : `Group: ${m.groupName}`
  }))
  const columns = useMemo(() => defineColumns<MappingRow>([
    { id: 'company', header: 'Company', kind: 'text', value: (m) => m.company },
    { id: 'source', header: 'Maps', kind: 'text', value: (m) => m.source, minWidth: 200 },
    { id: 'target', header: 'To group line', kind: 'text', value: (m) => m.targetName, minWidth: 200 },
    { id: 'nature', header: 'Nature', kind: 'text', value: (m) => m.targetNature ?? 'same', width: 110 }
  ]), [])
  const add = async (): Promise<void> => {
    if (!draft.slug || !draft.source || !draft.target.trim()) return toast.push('error', 'Pick a company, what to map and the group line')
    try {
      await consolidationApi.saveMapping({
        groupId: group.id, companySlug: draft.slug,
        ledgerId: draft.by === 'ledger' ? Number(draft.source) : null, groupName: draft.by === 'group' ? draft.source : null,
        targetName: draft.target.trim(), targetNature: draft.nature || null
      })
      setDraft({ ...draft, source: '', target: '' })
      refresh()
    } catch (err) {
      toast.push('error', err instanceof Error ? err.message : String(err))
    }
  }
  return (
    <Panel>
      <div className="flex flex-col gap-3 p-panel">
        <SectionTitle as="h3">Group chart mapping</SectionTitle>
        <p className="text-hint text-muted">
          By default each ledger adds into the consolidated line named after its own group (same name and nature across members). Override a group (applies to its sub-groups) or a single ledger here.
        </p>
        <DataTable
          viewId="consol-mappings"
          testId="consol-mappings"
          ariaLabel="Ledger mappings"
          columns={columns}
          rows={rows}
          rowKey={(m) => m.id}
          maxHeight="none"
          trailing={(m) => <Button size="sm" variant="ghost" onClick={() => void consolidationApi.deleteMapping(m.id).then(refresh)}>Remove</Button>}
          empty={{ title: 'No overrides', hint: 'Every member ledger maps by its group' }}
        />
        <div className="grid items-end gap-2 md:grid-cols-6">
          <Field label="Company">
            <Select data-testid="select-map-company" value={draft.slug} onChange={(e) => setDraft({ ...draft, slug: e.target.value, source: '' })}>
              <option value="">—</option>
              {charts.filter((c) => c.available).map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
            </Select>
          </Field>
          <Field label="Map a">
            <Select value={draft.by} onChange={(e) => setDraft({ ...draft, by: e.target.value as 'group' | 'ledger', source: '' })}>
              <option value="group">Group</option>
              <option value="ledger">Ledger</option>
            </Select>
          </Field>
          <Field label={draft.by === 'group' ? 'Group' : 'Ledger'}>
            <Select data-testid="select-map-source" value={draft.source} onChange={(e) => setDraft({ ...draft, source: e.target.value })}>
              <option value="">—</option>
              {draft.by === 'group'
                ? chart?.groups.map((g) => <option key={g.name} value={g.name}>{g.name}</option>)
                : chart?.ledgers.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.groupName})</option>)}
            </Select>
          </Field>
          <Field label="Group line">
            <TextInput data-testid="input-map-target" value={draft.target} onChange={(e) => setDraft({ ...draft, target: e.target.value })} placeholder="e.g. Revenue from operations" />
          </Field>
          <Field label="Nature">
            <Select value={draft.nature} onChange={(e) => setDraft({ ...draft, nature: e.target.value as '' | Nature })}>
              <option value="">Same as source</option>
              <option value="asset">Asset</option>
              <option value="liability">Liability</option>
              <option value="income">Income</option>
              <option value="expense">Expense</option>
            </Select>
          </Field>
          <Button data-testid="btn-map-add" onClick={() => void add()}>Add mapping</Button>
        </div>
      </div>
    </Panel>
  )
}

export function NoGroups({ onNew }: { onNew: () => void }): React.JSX.Element {
  return (
    <Panel>
      <EmptyState
        title="No consolidation groups"
        hint="Define a group: this company as the parent, the other companies as subsidiaries or associates, then pair their inter-company ledgers."
        action={<Button variant="primary" data-testid="btn-consol-new-empty" onClick={onNew}>New group</Button>}
      />
    </Panel>
  )
}
