import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  DIMENSIONS, DIMENSION_KEYS, MEASURES, MEASURE_KEYS, defaultModel, isPeriodDimension,
  type ComparativeKind, type DimensionKey, type MeasureKey, type ReportFilters, type ReportModel
} from '@shared/reportBuilder/model'
import { GST_STATES } from '@shared/gst/states'
import { api } from '../../lib/client'
import { reportsApi } from '../../lib/reportsClient'
import { AmountInput, Button, Checkbox, Field, Segmented, Select, TextInput } from '../../components/ui'
import { MultiPick } from '../../components/MultiPick'
import { useGroups, useLedgers, useStockItems } from '../../components/pickers'
import { useGodowns } from '../../components/stockPickers'

const MAX_DIMS = 3
const GST_RATES = [0, 0.25, 3, 5, 12, 18, 28, 40]

/** Keeps a model consistent after an edit: a pivot or sort that no longer points at something
 *  the report shows falls back, so the user never sits on an invalid model by accident. */
export function tidyModel(m: ReportModel): ReportModel {
  const dimKeys = m.dimensions.map((d) => d.key)
  const pivot = m.pivot && dimKeys.includes(m.pivot) && m.comparative.kind === 'none' ? m.pivot : null
  const sort = m.sort.by !== 'dimension' && !m.measures.includes(m.sort.by) ? { by: 'dimension' as const, dir: m.sort.dir } : m.sort
  return { ...m, pivot, sort }
}

function Section({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }): React.JSX.Element {
  return (
    <section className="border-b border-line px-4 py-3 last:border-b-0" data-testid={testId}>
      <h3 className="mb-2 text-caption font-semibold tracking-[0.08em] text-muted uppercase">{title}</h3>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  )
}

export function DesignPanel({ model, onChange }: { model: ReportModel; onChange: (m: ReportModel) => void }): React.JSX.Element {
  const set = (patch: Partial<ReportModel>): void => onChange(tidyModel({ ...model, ...patch }))
  const setFilters = (patch: Partial<ReportFilters>): void => set({ filters: { ...model.filters, ...patch } })
  const [moreFilters, setMoreFilters] = useState(false)

  const ledgers = useLedgers()
  const groups = useGroups()
  const items = useStockItems()
  const godowns = useGodowns()
  const { data: stockGroups } = useQuery({ queryKey: ['stockGroups'], queryFn: api.stockGroups.list })
  const { data: centres } = useQuery({ queryKey: ['costCentres'], queryFn: api.cc.list })
  const { data: voucherTypes } = useQuery({ queryKey: ['voucherTypes'], queryFn: api.voucherTypes.list })
  const { data: budgets } = useQuery({ queryKey: ['budgets'], queryFn: api.budget.list })
  const { data: users } = useQuery({ queryKey: ['rbUsers'], queryFn: reportsApi.users })

  const groupName = useMemo(() => new Map(groups.map((g) => [g.id, g.name])), [groups])
  const partyGroupIds = useMemo(() => {
    const roots = groups.filter((g) => g.name === 'Sundry Debtors' || g.name === 'Sundry Creditors').map((g) => g.id)
    const out = new Set(roots)
    let grew = true
    while (grew) {
      grew = false
      for (const g of groups) if (g.parentId !== null && out.has(g.parentId) && !out.has(g.id)) { out.add(g.id); grew = true }
    }
    return out
  }, [groups])
  const ledgerOptions = useMemo(() => ledgers.map((l) => ({ id: l.id, label: l.name, sub: groupName.get(l.groupId) })), [ledgers, groupName])
  const partyOptions = useMemo(() => ledgerOptions.filter((o) => partyGroupIds.has(ledgers.find((l) => l.id === o.id)?.groupId ?? -1)), [ledgerOptions, ledgers, partyGroupIds])
  const groupOptions = useMemo(() => groups.map((g) => ({ id: g.id, label: g.name })), [groups])
  const itemOptions = useMemo(() => items.map((i) => ({ id: i.id, label: i.name })), [items])
  const stockGroupOptions = useMemo(() => (stockGroups ?? []).map((g) => ({ id: g.id, label: g.name })), [stockGroups])
  const godownOptions = useMemo(() => godowns.map((g) => ({ id: g.id, label: g.name })), [godowns])
  const centreOptions = useMemo(() => (centres ?? []).map((c) => ({ id: c.id, label: c.name })), [centres])
  const stateOptions = useMemo(() => Object.entries(GST_STATES).map(([code, name]) => ({ id: Number(code), label: `${code} ${name}` })), [])
  const userOptions = useMemo(() => (users ?? []).map((u, i) => ({ id: i + 1, label: u })), [users])
  const kinds = useMemo(() => {
    const seen = new Map<string, string>()
    for (const vt of voucherTypes ?? []) if (!seen.has(vt.kind)) seen.set(vt.kind, vt.name)
    return [...seen.entries()].map(([kind, label]) => ({ kind, label }))
  }, [voucherTypes])

  const src = model.source
  const dimChoices = DIMENSION_KEYS.filter((k) => DIMENSIONS[k].sources.includes(src))
  const measureChoices = MEASURE_KEYS.filter((k) => MEASURES[k].sources.includes(src))
  const usedDims = model.dimensions.map((d) => d.key)
  const hasDateDim = usedDims.some(isPeriodDimension)

  const toggleMeasure = (k: MeasureKey, on: boolean): void => {
    const measures = on ? [...model.measures, k] : model.measures.filter((x) => x !== k)
    set({ measures })
  }
  const setDim = (i: number, key: DimensionKey): void =>
    set({ dimensions: model.dimensions.map((d, j) => (j === i ? (key === 'group' ? { key, level: 1 } : { key }) : d)) })
  const removeDim = (i: number): void => set({ dimensions: model.dimensions.filter((_, j) => j !== i) })
  const moveDim = (i: number, dir: -1 | 1): void => {
    const dims = [...model.dimensions]
    const j = i + dir
    if (j < 0 || j >= dims.length) return
    ;[dims[i], dims[j]] = [dims[j]!, dims[i]!]
    set({ dimensions: dims })
  }

  const compareValue = model.comparative.kind === 'budget' ? `budget:${model.comparative.budgetId ?? ''}` : model.comparative.kind
  const setCompare = (v: string): void => {
    if (v.startsWith('budget:')) set({ comparative: { kind: 'budget', budgetId: Number(v.slice(7)) || null }, pivot: null })
    else set({ comparative: { kind: v as ComparativeKind, budgetId: null }, ...(v !== 'none' ? { pivot: null } : {}) })
  }

  return (
    <div className="flex flex-col" data-testid="rb-design">
      <Section title="Source">
        <Segmented
          label="Report source"
          size="sm"
          options={[{ value: 'accounts', label: 'Accounts' }, { value: 'inventory', label: 'Stock' }]}
          value={src}
          onChange={(s) => {
            if (s === src) return
            const fresh = defaultModel(s)
            onChange({ ...fresh, period: model.period, chart: model.chart })
          }}
          testId="rb-source"
        />
      </Section>

      <Section title="Rows — group by" testId="rb-dimensions">
        {model.dimensions.map((d, i) => (
          <div key={`${d.key}-${i}`} className="flex items-center gap-1.5">
            <Select
              aria-label={`Dimension ${i + 1}`}
              data-testid={`rb-dim-${i}`}
              value={d.key}
              onChange={(e) => setDim(i, e.target.value as DimensionKey)}
              className="min-w-0 flex-1"
            >
              {dimChoices
                .filter((k) => k === d.key || (!usedDims.includes(k) && !(isPeriodDimension(k) && hasDateDim && !isPeriodDimension(d.key))))
                .map((k) => (
                  <option key={k} value={k}>{DIMENSIONS[k].label}</option>
                ))}
            </Select>
            {d.key === 'group' && (
              <Select
                aria-label="Group level"
                data-testid={`rb-dim-${i}-level`}
                value={d.level ?? 1}
                onChange={(e) => set({ dimensions: model.dimensions.map((x, j) => (j === i ? { key: 'group', level: Number(e.target.value) } : x)) })}
                className="w-20"
                title="Depth in the chart of accounts — level 1 is the primary group"
              >
                {[1, 2, 3, 4].map((l) => <option key={l} value={l}>Lvl {l}</option>)}
              </Select>
            )}
            <button type="button" className="px-1 text-small text-muted hover:text-ink disabled:opacity-30" aria-label={`Move ${DIMENSIONS[d.key].label} up`} disabled={i === 0} onClick={() => moveDim(i, -1)}>↑</button>
            <button type="button" className="px-1 text-small text-muted hover:text-danger" aria-label={`Remove ${DIMENSIONS[d.key].label}`} data-testid={`rb-dim-${i}-remove`} onClick={() => removeDim(i)}>✕</button>
          </div>
        ))}
        {model.dimensions.length < MAX_DIMS && (
          <Select
            aria-label="Add a dimension"
            data-testid="rb-add-dimension"
            value=""
            onChange={(e) => {
              const key = e.target.value as DimensionKey
              if (key) set({ dimensions: [...model.dimensions, key === 'group' ? { key, level: 1 } : { key }] })
            }}
          >
            <option value="">+ Add a dimension…</option>
            {dimChoices.filter((k) => !usedDims.includes(k) && !(isPeriodDimension(k) && hasDateDim)).map((k) => (
              <option key={k} value={k}>{DIMENSIONS[k].label}</option>
            ))}
          </Select>
        )}
        {model.dimensions.length === 0 && <p className="text-hint text-muted">No dimension: one line of totals.</p>}
      </Section>

      <Section title="Measures" testId="rb-measures">
        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
          {measureChoices.map((k) => (
            <span key={k} title={MEASURES[k].hint}>
              <Checkbox label={MEASURES[k].label} checked={model.measures.includes(k)} onChange={(on) => toggleMeasure(k, on)} testId={`rb-measure-${k}`} />
            </span>
          ))}
        </div>
      </Section>

      <Section title="Filters" testId="rb-filters">
        {src === 'accounts' ? (
          <>
            <Field label="Groups (with sub-groups)"><MultiPick options={groupOptions} value={model.filters.groupIds} onChange={(groupIds) => setFilters({ groupIds })} placeholder="Add a group" testId="rb-filter-groups" /></Field>
            <Field label="Ledgers"><MultiPick options={ledgerOptions} value={model.filters.ledgerIds} onChange={(ledgerIds) => setFilters({ ledgerIds })} placeholder="Add a ledger" testId="rb-filter-ledgers" /></Field>
          </>
        ) : (
          <>
            <Field label="Stock items"><MultiPick options={itemOptions} value={model.filters.itemIds} onChange={(itemIds) => setFilters({ itemIds })} placeholder="Add an item" testId="rb-filter-items" /></Field>
            <Field label="Stock groups"><MultiPick options={stockGroupOptions} value={model.filters.itemGroupIds} onChange={(itemGroupIds) => setFilters({ itemGroupIds })} placeholder="Add a stock group" testId="rb-filter-stock-groups" /></Field>
            <Field label="Godowns"><MultiPick options={godownOptions} value={model.filters.godownIds} onChange={(godownIds) => setFilters({ godownIds })} placeholder="Add a godown" testId="rb-filter-godowns" /></Field>
          </>
        )}
        <Field label="Parties"><MultiPick options={partyOptions} value={model.filters.partyIds} onChange={(partyIds) => setFilters({ partyIds })} placeholder="Add a party" testId="rb-filter-parties" /></Field>
        <div>
          <span className="mb-1 block text-detail text-ink">Voucher types</span>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1" data-testid="rb-filter-kinds">
            {kinds.map(({ kind, label }) => (
              <Checkbox
                key={kind}
                label={label}
                checked={model.filters.voucherKinds.includes(kind)}
                onChange={(on) => setFilters({ voucherKinds: on ? [...model.filters.voucherKinds, kind] : model.filters.voucherKinds.filter((k) => k !== kind) })}
                testId={`rb-kind-${kind}`}
              />
            ))}
          </div>
        </div>
        <button type="button" className="self-start text-small text-blue hover:underline" aria-expanded={moreFilters} onClick={() => setMoreFilters((v) => !v)} data-testid="rb-more-filters">
          {moreFilters ? 'Fewer filters' : 'More filters…'}
        </button>
        {moreFilters && (
          <>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Amount from"><AmountInput paise={model.filters.amountMin} onPaise={(amountMin) => setFilters({ amountMin })} testId="rb-filter-amount-min" /></Field>
              <Field label="Amount to"><AmountInput paise={model.filters.amountMax} onPaise={(amountMax) => setFilters({ amountMax })} testId="rb-filter-amount-max" /></Field>
            </div>
            <Field label="Narration contains"><TextInput value={model.filters.narration} onChange={(e) => setFilters({ narration: e.target.value })} data-testid="rb-filter-narration" /></Field>
            <Field label="GST rate" hint={src === 'accounts' ? 'The ledger’s rate' : 'The item’s rate'}>
              <Select value={model.filters.gstRate ?? ''} onChange={(e) => setFilters({ gstRate: e.target.value === '' ? null : Number(e.target.value) })} data-testid="rb-filter-gst-rate">
                <option value="">Any</option>
                {GST_RATES.map((r) => <option key={r} value={r}>{r}%</option>)}
              </Select>
            </Field>
            <Field label="Party state">
              <MultiPick options={stateOptions} value={model.filters.stateCodes.map(Number)} onChange={(ids) => setFilters({ stateCodes: ids.map((i) => String(i).padStart(2, '0')) })} placeholder="Add a state" testId="rb-filter-states" />
            </Field>
            {src === 'accounts' && (
              <Field label="Cost centres"><MultiPick options={centreOptions} value={model.filters.costCentreIds} onChange={(costCentreIds) => setFilters({ costCentreIds })} placeholder="Add a cost centre" testId="rb-filter-centres" /></Field>
            )}
            <Field label="Entered by">
              <MultiPick
                options={userOptions}
                value={model.filters.users.map((u) => userOptions.find((o) => o.label === u)?.id ?? 0).filter(Boolean)}
                onChange={(ids) => setFilters({ users: ids.map((i) => userOptions.find((o) => o.id === i)!.label) })}
                placeholder="Add a user"
                testId="rb-filter-users"
              />
            </Field>
          </>
        )}
      </Section>

      <Section title="Layout" testId="rb-layout">
        <Field label="Columns (pivot)">
          <Select value={model.pivot ?? ''} onChange={(e) => set({ pivot: (e.target.value || null) as DimensionKey | null })} data-testid="rb-pivot" disabled={model.dimensions.length === 0 || model.comparative.kind !== 'none'}>
            <option value="">No pivot</option>
            {model.dimensions.map((d) => <option key={d.key} value={d.key}>{DIMENSIONS[d.key].label} across</option>)}
          </Select>
        </Field>
        <Field label="Compare with">
          <Select value={compareValue} onChange={(e) => setCompare(e.target.value)} data-testid="rb-compare">
            <option value="none">Nothing</option>
            <option value="previousPeriod">Previous period</option>
            <option value="previousYear">Same period last year</option>
            {src === 'accounts' && (budgets ?? []).map((b) => <option key={b.id} value={`budget:${b.id}`}>Budget — {b.name}</option>)}
          </Select>
        </Field>
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <Field label="Sort by">
            <Select value={model.sort.by} onChange={(e) => set({ sort: { ...model.sort, by: e.target.value as ReportModel['sort']['by'] } })} data-testid="rb-sort">
              <option value="dimension">Row order</option>
              {model.measures.map((k) => <option key={k} value={k}>{MEASURES[k].label}</option>)}
            </Select>
          </Field>
          <Field label="Order">
            <Select value={model.sort.dir} onChange={(e) => set({ sort: { ...model.sort, dir: e.target.value as 'asc' | 'desc' } })} data-testid="rb-sort-dir">
              <option value="asc">Ascending</option>
              <option value="desc">Descending</option>
            </Select>
          </Field>
        </div>
        <Field label="Top N rows" hint="Keep the first N rows after sorting (the rest add up into one row)">
          <TextInput
            inputMode="numeric"
            value={model.topN ?? ''}
            placeholder="All rows"
            onChange={(e) => {
              const n = Number(e.target.value.replace(/\D/g, ''))
              set({ topN: n > 0 ? Math.min(n, 1000) : null })
            }}
            data-testid="rb-top-n"
          />
        </Field>
        <div>
          <span className="mb-1 block text-detail text-ink">Chart of the first measure</span>
          <Segmented label="Chart" size="sm" options={[{ value: 'bar', label: 'Bars' }, { value: 'line', label: 'Line' }, { value: 'none', label: 'Off' }]} value={model.chart} onChange={(chart) => set({ chart })} testId="rb-chart" />
        </div>
      </Section>
      <div className="px-4 py-3">
        <Button size="sm" variant="ghost" onClick={() => onChange({ ...defaultModel(src), period: model.period })} data-testid="rb-reset">
          Start over
        </Button>
      </div>
    </div>
  )
}
