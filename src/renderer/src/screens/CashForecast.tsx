// Cash-flow forecast (WP 4.4): today's cash and bank rolled forward week by week (or month by
// month) through probability-weighted receipts and payments — open bills, open orders, the
// user's known items, statutory dues and loan EMIs. The main process supplies the dated flows
// once (forecast:base); the scenario sliders re-run the pure engine here instantly.
import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  buildForecast, forecastPeriods, SCENARIO_PRESETS, SOURCE_LABELS,
  type ForecastContribution, type ForecastPeriodRow, type ForecastScenario, type ForecastSource, type ForecastUnit, type ScenarioName
} from '@shared/cashForecast'
import type { ForecastItem, ForecastItemInput } from '@shared/cashFinance'
import { toDisplayDate, todayISO } from '@shared/dates'
import { formatPaise, formatPaiseCompact } from '@shared/money'
import { cfApi } from '../lib/cashFinanceClient'
import { useToasts } from '../state/stores'
import {
  AmountInput, Badge, Banner, Button, DateInput, Drawer, DrawerSection, Field, Modal, Page, PageHeader, Panel, Segmented, Select,
  StatTile, TabBar, TextInput, Checkbox
} from '../components/ui'
import { OptionToggle, OptionsTable, useScreenOptions } from '../components/ScreenOptions'
import { DataTable, defineColumns } from '../components/table'
import { BarChart, ChartLegend, LineChart, type ChartCategory } from '../components/charts'
import { LedgerLink, VoucherLink } from '../components/links'
import { confirmDialog } from '../lib/dialogs'

type Tab = 'forecast' | 'items' | 'assumptions'
const TABS: { id: Tab; label: string }[] = [
  { id: 'forecast', label: 'Forecast' },
  { id: 'items', label: 'Known items' },
  { id: 'assumptions', label: 'Collection history' }
]

type Horizon = 'w13' | 'w26' | 'm6' | 'm12'
const HORIZONS: { value: Horizon; label: string; unit: ForecastUnit; count: number }[] = [
  { value: 'w13', label: '13 weeks', unit: 'week', count: 13 },
  { value: 'w26', label: '26 weeks', unit: 'week', count: 26 },
  { value: 'm6', label: '6 months', unit: 'month', count: 6 },
  { value: 'm12', label: '12 months', unit: 'month', count: 12 }
]
const SCENARIOS: { value: ScenarioName; label: string }[] = [
  { value: 'best', label: 'Best' },
  { value: 'expected', label: 'Expected' },
  { value: 'worst', label: 'Worst' }
]

const DEFAULT_OPTIONS = {
  horizon: 'w13' as Horizon,
  scenario: 'expected' as ScenarioName,
  bestCollection: SCENARIO_PRESETS.best.collectionPct,
  bestOrders: SCENARIO_PRESETS.best.orderPct,
  bestDelay: SCENARIO_PRESETS.best.delayDays,
  expectedCollection: SCENARIO_PRESETS.expected.collectionPct,
  expectedOrders: SCENARIO_PRESETS.expected.orderPct,
  expectedDelay: SCENARIO_PRESETS.expected.delayDays,
  worstCollection: SCENARIO_PRESETS.worst.collectionPct,
  worstOrders: SCENARIO_PRESETS.worst.orderPct,
  worstDelay: SCENARIO_PRESETS.worst.delayDays,
  minBalance: 0,
  orders: true,
  statutory: true,
  emis: true,
  items: true
}
type Options = typeof DEFAULT_OPTIONS

/** The scenario knobs stored for `name`. */
export function scenarioFrom(o: Options, name: ScenarioName): ForecastScenario {
  return { collectionPct: o[`${name}Collection`], orderPct: o[`${name}Orders`], delayDays: o[`${name}Delay`] }
}

/** One table row: a period with its flows split for display ("other" = known items + adjustments). */
export interface PeriodView extends ForecastPeriodRow {
  otherIn: number
  otherOut: number
}

export function periodViews(periods: ForecastPeriodRow[], contributions: ForecastContribution[]): PeriodView[] {
  return periods.map((p) => {
    let otherIn = 0
    let otherOut = 0
    for (const c of contributions) {
      if (c.periodKey !== p.key || (c.source !== 'item' && c.source !== 'adjustment')) continue
      if (c.direction === 'in') otherIn += c.weighted
      else otherOut += c.weighted
    }
    return { ...p, otherIn, otherOut }
  })
}

const moneyCol = (id: string, header: string, value: (r: PeriodView) => number, group?: string, defaultHidden = false) => ({
  id, header, kind: 'money' as const, value, aggregate: 'sum' as const, width: 118, group, defaultHidden
})

const PERIOD_COLUMNS = defineColumns<PeriodView>([
  { id: 'period', header: 'Period', kind: 'text', value: (r) => r.label, hideable: false, sortable: false, minWidth: 130, cell: (r) => (
    <span className="flex items-center gap-2">
      <span>{r.label}</span>
      {r.shortfall && <Badge tone="danger">Shortfall</Badge>}
    </span>
  ) },
  { id: 'opening', header: 'Opening', kind: 'money', value: (r) => r.opening, width: 124, className: 'text-muted' },
  moneyCol('receivable', 'Receivables', (r) => r.bySource.receivable, 'Inflows'),
  moneyCol('salesOrders', 'Sales orders', (r) => r.bySource.sales_order, 'Inflows'),
  moneyCol('otherIn', 'Other', (r) => r.otherIn, 'Inflows'),
  moneyCol('payable', 'Payables', (r) => r.bySource.payable, 'Outflows'),
  moneyCol('purchaseOrders', 'Purchase orders', (r) => r.bySource.purchase_order, 'Outflows'),
  moneyCol('statutory', 'Statutory', (r) => r.bySource.statutory, 'Outflows'),
  moneyCol('emi', 'Loan EMIs', (r) => r.bySource.emi, 'Outflows'),
  moneyCol('otherOut', 'Other', (r) => r.otherOut, 'Outflows'),
  { id: 'net', header: 'Net', kind: 'money', value: (r) => r.net, aggregate: 'sum', width: 124, cell: (r) => <span className={`num ${r.net < 0 ? 'text-cr' : 'text-dr'}`}>{formatPaise(r.net)}</span> },
  {
    id: 'closing', header: 'Closing', kind: 'money', value: (r) => r.closing, width: 132,
    cell: (r) => <span className={`num font-medium ${r.shortfall ? 'text-danger' : 'text-ink'}`}>{formatPaise(r.closing)}</span>
  }
])

const SOURCE_OPTIONS = (Object.keys(SOURCE_LABELS) as ForecastSource[]).map((s) => ({ value: s, label: SOURCE_LABELS[s] }))

const DETAIL_COLUMNS = defineColumns<ForecastContribution>([
  { id: 'date', header: 'Expected', kind: 'date', value: (c) => c.effectiveDate, width: 104 },
  { id: 'source', header: 'Source', kind: 'enum', value: (c) => c.source, options: SOURCE_OPTIONS, width: 120 },
  {
    id: 'label', header: 'Item', kind: 'text', value: (c) => c.label, hideable: false, minWidth: 160,
    cell: (c) => (c.voucherId ? <VoucherLink voucherId={c.voucherId} label={c.label} /> : c.ledgerId ? <LedgerLink ledgerId={c.ledgerId} name={c.label} /> : c.label)
  },
  { id: 'amount', header: 'Amount', kind: 'money', value: (c) => (c.direction === 'in' ? c.amount : -c.amount), width: 116 },
  { id: 'prob', header: 'Prob.', kind: 'number', value: (c) => c.effectiveBp / 100, text: (c) => `${Math.round(c.effectiveBp / 100)}%`, width: 70 },
  { id: 'weighted', header: 'Weighted', kind: 'money', value: (c) => (c.direction === 'in' ? c.weighted : -c.weighted), aggregate: 'sum', width: 116 }
])

export function CashForecastScreen(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('forecast')
  const opts = useScreenOptions('cash-forecast', DEFAULT_OPTIONS, {
    horizon: HORIZONS.map((h) => h.value),
    scenario: SCENARIOS.map((s) => s.value)
  })
  const o = opts.options
  return (
    <Page width="full">
      <PageHeader
        title="Cash-flow forecast"
        period={`from ${toDisplayDate(todayISO())}`}
        tabs={<TabBar screen="cash-forecast" label="Cash-flow forecast" tabs={TABS} active={tab} onSelect={setTab} />}
        options={{
          onReset: opts.reset,
          content: (
            <>
              <DrawerSection title={`Scenario · ${SCENARIOS.find((s) => s.value === o.scenario)!.label}`} testId="options-forecast-scenario">
                <Slider
                  label="Collections (% of history)"
                  hint="Scales each ageing bucket’s learned collection probability (capped at 100 %)."
                  min={0} max={150} step={5} unit="%"
                  value={o[`${o.scenario}Collection`]}
                  onChange={(v) => opts.set(`${o.scenario}Collection`, v)}
                  testId="input-forecast-collection"
                />
                <Slider
                  label="Open orders turning into cash"
                  min={0} max={100} step={5} unit="%"
                  value={o[`${o.scenario}Orders`]}
                  onChange={(v) => opts.set(`${o.scenario}Orders`, v)}
                  testId="input-forecast-orders"
                />
                <Slider
                  label="Extra days before receipts"
                  min={0} max={60} step={1} unit=" days"
                  value={o[`${o.scenario}Delay`]}
                  onChange={(v) => opts.set(`${o.scenario}Delay`, v)}
                  testId="input-forecast-delay"
                />
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="btn-forecast-scenario-reset"
                  onClick={() => {
                    const p = SCENARIO_PRESETS[o.scenario]
                    opts.set(`${o.scenario}Collection`, p.collectionPct)
                    opts.set(`${o.scenario}Orders`, p.orderPct)
                    opts.set(`${o.scenario}Delay`, p.delayDays)
                  }}
                >
                  Reset this scenario
                </Button>
              </DrawerSection>
              <DrawerSection title="Shortfall">
                <Field label="Flag periods closing below">
                  <AmountInput paise={o.minBalance || null} onPaise={(v) => opts.set('minBalance', v ?? 0)} testId="input-forecast-min-balance" />
                </Field>
              </DrawerSection>
              <DrawerSection title="Include">
                <OptionToggle label="Open sales and purchase orders" checked={o.orders} onChange={(v) => opts.set('orders', v)} testId="input-forecast-orders-on" />
                <OptionToggle label="Statutory dues (GST, TDS, TCS, PF, ESI, PT)" checked={o.statutory} onChange={(v) => opts.set('statutory', v)} testId="input-forecast-statutory-on" />
                <OptionToggle label="Loan EMIs" checked={o.emis} onChange={(v) => opts.set('emis', v)} testId="input-forecast-emis-on" />
                <OptionToggle label="Known items and adjustments" checked={o.items} onChange={(v) => opts.set('items', v)} testId="input-forecast-items-on" />
              </DrawerSection>
              <OptionsTable area="cash-forecast" label="Forecast table" />
              <DrawerSection title="How it works">
                <p className="text-hint text-muted">
                  Each receipt and payment is weighted by its probability: receivables by the collection rate the company’s own
                  history shows for their ageing bucket, orders by the conversion slider, everything else at 100 %. Overdue items
                  are expected now. Amounts are taxable values for orders (GST nets out against output tax).
                </p>
              </DrawerSection>
            </>
          )
        }}
      />
      {tab === 'forecast' && <ForecastTab options={o} set={opts.set} />}
      {tab === 'items' && <ItemsTab />}
      {tab === 'assumptions' && <AssumptionsTab horizon={o.horizon} />}
    </Page>
  )
}

function Slider({
  label, hint, min, max, step, unit, value, onChange, testId
}: {
  label: string; hint?: string; min: number; max: number; step: number; unit: string; value: number; onChange: (v: number) => void; testId: string
}): React.JSX.Element {
  return (
    <label className="flex flex-col gap-1">
      <span className="flex items-baseline justify-between text-detail text-ink">
        {label}
        <span className="num text-muted" data-testid={`${testId}-value`}>{value}{unit}</span>
      </span>
      <input
        type="range" min={min} max={max} step={step} value={value} data-testid={testId} aria-label={label}
        className="w-full accent-[var(--t-blue)]"
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {hint && <span className="text-hint text-muted">{hint}</span>}
    </label>
  )
}

function horizonEnd(h: Horizon, asOn: string): string {
  const def = HORIZONS.find((x) => x.value === h)!
  return forecastPeriods(asOn, def.unit, def.count).at(-1)!.to
}

function ForecastTab({ options: o, set }: { options: Options; set: ReturnType<typeof useScreenOptions<Options>>['set'] }): React.JSX.Element {
  const asOn = todayISO()
  const def = HORIZONS.find((x) => x.value === o.horizon)!
  const to = horizonEnd(o.horizon, asOn)
  const { data: base, isLoading } = useQuery({ queryKey: ['forecastBase', asOn, to], queryFn: () => cfApi.forecast.base(asOn, to) })
  const [detail, setDetail] = useState<PeriodView | null>(null)
  const scenario = scenarioFrom(o, o.scenario)
  const exclude: ForecastSource[] = [
    ...(o.orders ? [] : (['sales_order', 'purchase_order'] as const)),
    ...(o.statutory ? [] : (['statutory'] as const)),
    ...(o.emis ? [] : (['emi'] as const)),
    ...(o.items ? [] : (['item', 'adjustment'] as const))
  ]
  const result = useMemo(
    () => (base ? buildForecast({ asOn, unit: def.unit, count: def.count, openingCash: base.openingCash, flows: base.flows, scenario, minBalance: o.minBalance, exclude }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [base, def.unit, def.count, scenario.collectionPct, scenario.orderPct, scenario.delayDays, o.minBalance, exclude.join()]
  )
  const rows = useMemo(() => (result ? periodViews(result.periods, result.contributions) : []), [result])
  const categories: ChartCategory[] = rows.map((r) => ({ key: r.key, label: def.unit === 'week' ? r.label.split(' · ')[1]! : r.label.slice(0, 3), long: r.label }))
  const shortfall = result?.firstShortfall ? rows.find((r) => r.key === result.firstShortfall) : null

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented label="Scenario" options={SCENARIOS} value={o.scenario} onChange={(v) => set('scenario', v)} testId="seg-forecast-scenario" />
        <Segmented label="Horizon" options={HORIZONS} value={o.horizon} onChange={(v) => set('horizon', v)} testId="seg-forecast-horizon" size="sm" />
        <span className="text-caption text-muted" data-testid="forecast-scenario-summary">
          Collections {scenario.collectionPct}% of history · orders {scenario.orderPct}% · receipts +{scenario.delayDays} days
        </span>
      </div>

      {base && base.warnings.length > 0 && (
        <Banner tone="warning" title="Some sources could not be read" testId="forecast-warnings">
          {base.warnings.join(' · ')}
        </Banner>
      )}
      {shortfall && (
        <Banner tone="danger" title="Cash shortfall ahead" testId="forecast-shortfall">
          Closing cash falls to {formatPaise(shortfall.closing, { symbol: true })} in {shortfall.label} ({toDisplayDate(shortfall.from)} – {toDisplayDate(shortfall.to)})
          {o.minBalance > 0 ? `, below the ${formatPaise(o.minBalance, { symbol: true })} floor` : ''}.
        </Banner>
      )}

      <ul className="grid grid-cols-2 gap-3 lg:grid-cols-5" aria-label="Forecast figures">
        <li><StatTile label="Cash & bank today" testId="tile-forecast-opening" loading={isLoading} value={base && formatPaise(base.openingCash, { symbol: true })} footer={base && `${base.cashLedgers.length} ledgers`} /></li>
        <li><StatTile label="Expected in" testId="tile-forecast-in" tone="dr" loading={isLoading} value={result && formatPaise(result.totals.inflow, { symbol: true })} /></li>
        <li><StatTile label="Expected out" testId="tile-forecast-out" tone="cr" loading={isLoading} value={result && formatPaise(result.totals.outflow, { symbol: true })} /></li>
        <li><StatTile label={`Closing · ${def.label}`} testId="tile-forecast-closing" loading={isLoading} tone={result && result.totals.closing < o.minBalance ? 'cr' : undefined} value={result && formatPaise(result.totals.closing, { symbol: true })} footer={result && (result.beyond.inflow || result.beyond.outflow) ? `Beyond horizon: +${formatPaiseCompact(result.beyond.inflow)} / −${formatPaiseCompact(result.beyond.outflow)}` : undefined} /></li>
        <li><StatTile label="Lowest closing" testId="tile-forecast-lowest" loading={isLoading} tone={result?.firstShortfall ? 'cr' : undefined} value={result?.lowest && formatPaise(result.lowest.closing, { symbol: true })} footer={result?.lowest && rows.find((r) => r.key === result.lowest!.periodKey)?.label} /></li>
      </ul>

      {result && rows.length > 0 && (
        <Panel className="px-3 pt-2 pb-1">
          <div className="flex items-baseline justify-between px-1 pb-1">
            <ChartLegend series={[{ id: 'in', label: 'Inflows', color: 'blue' }, { id: 'out', label: 'Outflows', color: 'amber' }, { id: 'close', label: 'Closing balance', color: 'ink' }]} />
            <span className="text-caption text-muted">probability-weighted</span>
          </div>
          <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
            <BarChart
              testId="chart-forecast-flows"
              title="Forecast inflows and outflows by period"
              summary={`Expected inflows ${formatPaise(result.totals.inflow, { symbol: true })} and outflows ${formatPaise(result.totals.outflow, { symbol: true })} over ${def.label}.`}
              categories={categories}
              height={170}
              series={[
                { id: 'in', label: 'Inflows', color: 'blue', values: rows.map((r) => r.inflow) },
                { id: 'out', label: 'Outflows', color: 'amber', values: rows.map((r) => r.outflow) }
              ]}
            />
            <LineChart
              testId="chart-forecast-closing"
              title="Forecast closing cash and bank by period"
              summary={`Closing balance ends at ${formatPaise(result.totals.closing, { symbol: true })}; lowest ${formatPaise(result.lowest?.closing ?? 0, { symbol: true })}.`}
              categories={categories}
              height={170}
              negativeColor="cr"
              series={[{ id: 'close', label: 'Closing balance', color: 'ink', values: rows.map((r) => r.closing) }]}
            />
          </div>
        </Panel>
      )}

      <Panel>
        <DataTable
          viewId="cash-forecast"
          testId="cash-forecast"
          ariaLabel="Cash-flow forecast by period"
          columns={PERIOD_COLUMNS}
          rows={rows}
          rowKey={(r) => r.key}
          rowAttrs={(r) => ({ 'data-period': r.key, 'data-shortfall': r.shortfall ? 'true' : undefined })}
          rowClassName={(r) => (r.shortfall ? 'bg-danger-soft' : '')}
          loading={isLoading}
          onRowActivate={(r) => setDetail(r)}
          maxHeight="none"
          totalsLabel="Total"
          empty={{ title: 'Nothing to forecast yet', hint: 'Post bills, add known items or a loan, and come back' }}
          exportOptions={{ title: 'Cash-flow forecast', periodLabel: `${def.label} from ${toDisplayDate(asOn)} · ${SCENARIOS.find((s) => s.value === o.scenario)!.label} case`, filename: 'cash-forecast' }}
        />
      </Panel>

      {detail && result && (
        <Drawer title={detail.label} subtitle={`${toDisplayDate(detail.from)} – ${toDisplayDate(detail.to)}`} onClose={() => setDetail(null)} width={720} testId="forecast-detail">
          <DataTable
            testId="forecast-detail"
            ariaLabel={`Flows in ${detail.label}`}
            columns={DETAIL_COLUMNS}
            rows={result.contributions.filter((c) => c.periodKey === detail.key)}
            maxHeight="70vh"
            empty={{ title: 'No flows in this period' }}
            toolbarFeatures={{ groupBy: true }}
          />
        </Drawer>
      )}
    </div>
  )
}

// ---------- known items ----------

const CADENCES = [
  { value: 'once', label: 'Once' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'yearly', label: 'Yearly' }
] as const
const KINDS = [
  { value: 'outflow', label: 'Outflow' },
  { value: 'inflow', label: 'Inflow' },
  { value: 'adjustment', label: 'Adjustment (±)' }
] as const

const ITEM_COLUMNS = defineColumns<ForecastItem>([
  { id: 'name', header: 'Item', kind: 'text', value: (i) => i.name, hideable: false, minWidth: 160 },
  { id: 'kind', header: 'Kind', kind: 'enum', value: (i) => i.kind, options: KINDS.map((k) => ({ ...k })), width: 130 },
  { id: 'amount', header: 'Amount', kind: 'money', value: (i) => (i.kind === 'outflow' ? -i.amount : i.amount), width: 130 },
  { id: 'cadence', header: 'Repeats', kind: 'enum', value: (i) => i.cadence, options: CADENCES.map((c) => ({ ...c })), width: 100 },
  { id: 'start', header: 'From', kind: 'date', value: (i) => i.startDate, width: 104 },
  { id: 'end', header: 'Until', kind: 'date', value: (i) => i.endDate, width: 104, className: 'text-muted' },
  { id: 'active', header: 'Active', kind: 'enum', value: (i) => (i.active ? 'yes' : 'no'), options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'Paused' }], width: 84 }
])

function ItemsTab(): React.JSX.Element {
  const { data = [], isLoading } = useQuery({ queryKey: ['forecastItems'], queryFn: cfApi.forecast.items })
  const [editing, setEditing] = useState<{ item: ForecastItem | null } | null>(null)
  return (
    <Panel>
      <DataTable
        viewId="forecast-items"
        testId="forecast-items"
        ariaLabel="Known forecast items"
        columns={ITEM_COLUMNS}
        rows={data}
        rowKey={(i) => i.id}
        loading={isLoading}
        onRowActivate={(i) => setEditing({ item: i })}
        toolbarStart={
          <Button size="sm" variant="primary" data-testid="btn-forecast-item-new" onClick={() => setEditing({ item: null })}>
            New item
          </Button>
        }
        empty={{ title: 'No known items yet', hint: 'Add rent, salaries, a tax payment or a one-off adjustment the books can’t see' }}
        exportOptions={{ title: 'Cash forecast — known items', periodLabel: `as on ${toDisplayDate(todayISO())}`, filename: 'forecast-items' }}
      />
      {editing && <ItemModal item={editing.item} onClose={() => setEditing(null)} />}
    </Panel>
  )
}

function ItemModal({ item, onClose }: { item: ForecastItem | null; onClose: () => void }): React.JSX.Element {
  const toast = useToasts()
  const qc = useQueryClient()
  const [name, setName] = useState(item?.name ?? '')
  const [kind, setKind] = useState<ForecastItem['kind']>(item?.kind ?? 'outflow')
  const [amount, setAmount] = useState<number | null>(item ? Math.abs(item.amount) : null)
  const [negative, setNegative] = useState(item ? item.amount < 0 : false)
  const [cadence, setCadence] = useState<ForecastItem['cadence']>(item?.cadence ?? 'monthly')
  const [startDate, setStart] = useState(item?.startDate ?? todayISO())
  const [endDate, setEnd] = useState(item?.endDate ?? '')
  const [active, setActive] = useState(item?.active ?? true)
  const save = async (): Promise<void> => {
    if (!name.trim() || !amount) return toast.push('error', 'Enter a name and an amount')
    const data: ForecastItemInput = {
      name: name.trim(), kind, amount: kind === 'adjustment' && negative ? -amount : amount, cadence: kind === 'adjustment' ? 'once' : cadence,
      startDate, endDate: endDate || null, active
    }
    try {
      await cfApi.forecast.itemSave(data, item?.id)
      await qc.invalidateQueries({ queryKey: ['forecastItems'] })
      await qc.invalidateQueries({ queryKey: ['forecastBase'] })
      toast.push('success', 'Forecast item saved')
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  const remove = async (): Promise<void> => {
    if (!item || !(await confirmDialog({ title: 'Delete item', message: `Delete “${item.name}”?`, confirmLabel: 'Delete', danger: true }))) return
    try {
      await cfApi.forecast.itemDelete(item.id)
      await qc.invalidateQueries({ queryKey: ['forecastItems'] })
      await qc.invalidateQueries({ queryKey: ['forecastBase'] })
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  return (
    <Modal title={item ? 'Edit forecast item' : 'New forecast item'} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Field label="Name">
          <TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} data-testid="input-forecast-item-name" placeholder="e.g. Office rent" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Kind">
            <Select value={kind} onChange={(e) => setKind(e.target.value as ForecastItem['kind'])} data-testid="select-forecast-item-kind">
              {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
            </Select>
          </Field>
          <Field label="Amount">
            <AmountInput paise={amount} onPaise={setAmount} testId="input-forecast-item-amount" />
          </Field>
        </div>
        {kind === 'adjustment' ? (
          <Checkbox label="Reduces cash (an outflow)" checked={negative} onChange={setNegative} testId="input-forecast-item-negative" />
        ) : (
          <Field label="Repeats">
            <Select value={cadence} onChange={(e) => setCadence(e.target.value as ForecastItem['cadence'])} data-testid="select-forecast-item-cadence">
              {CADENCES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </Select>
          </Field>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label={kind === 'adjustment' || cadence === 'once' ? 'Date' : 'First date'}>
            <DateInput value={startDate} context={todayISO()} onChange={setStart} testId="input-forecast-item-start" />
          </Field>
          {kind !== 'adjustment' && cadence !== 'once' && (
            <Field label="Until (optional)">
              <DateInput value={endDate} allowEmpty context={todayISO()} onChange={setEnd} testId="input-forecast-item-end" />
            </Field>
          )}
        </div>
        <Checkbox label="Active" checked={active} onChange={setActive} testId="input-forecast-item-active" />
        <div className="flex justify-between gap-2">
          <span>{item && <Button variant="ghost" onClick={() => void remove()}>Delete</Button>}</span>
          <span className="flex gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" data-testid="btn-forecast-item-save" onClick={() => void save()}>Save</Button>
          </span>
        </div>
      </div>
    </Modal>
  )
}

// ---------- assumptions ----------

const pct = (bp: number): string => `${Math.round(bp / 100)}%`

function AssumptionsTab({ horizon }: { horizon: Horizon }): React.JSX.Element {
  const asOn = todayISO()
  const to = horizonEnd(horizon, asOn)
  const { data: base } = useQuery({ queryKey: ['forecastBase', asOn, to], queryFn: () => cfApi.forecast.base(asOn, to) })
  const p = base?.receivableProfile
  return (
    <Panel className="p-panel" testId="forecast-assumptions">
      {!p ? null : (
        <div className="flex flex-col gap-4">
          {!p.fromHistory && (
            <Banner tone="info" title="Not enough history yet">
              Fewer than five past bills have been due for 90 days, so the forecast uses default collection rates (95 / 80 / 60 / 30 %) until
              the company’s own pattern is known.
            </Banner>
          )}
          <section>
            <h3 className="mb-2 text-body-sm font-medium text-ink">Bills paid within … of falling due</h3>
            <dl className="grid grid-cols-4 gap-3">
              {(['on time', '30 days', '60 days', '90 days'] as const).map((l, i) => (
                <div key={l} className="rounded-md border border-line p-3">
                  <dt className="text-caption text-muted">{l}</dt>
                  <dd className="num text-title text-ink" data-testid={`forecast-paid-within-${i}`}>{pct(p.paidWithinBp[i]!)}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-1 text-hint text-muted">Amount-weighted, from {p.sampleSize} bills due at least 90 days ago. Median days late: {p.medianDelayDays}.</p>
          </section>
          <section>
            <h3 className="mb-2 text-body-sm font-medium text-ink">Collection probability used by ageing bucket</h3>
            <dl className="grid grid-cols-4 gap-3">
              {(['0–30 days', '31–60 days', '61–90 days', 'Over 90 days'] as const).map((l, i) => (
                <div key={l} className="rounded-md border border-line p-3">
                  <dt className="text-caption text-muted">{l} overdue</dt>
                  <dd className="num text-title text-ink" data-testid={`forecast-bucket-${i}`}>{pct(p.bucketProbabilityBp[i]!)}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-1 text-hint text-muted">
              The share of past bills that were still unpaid at that age and were then collected within 90 days. Bills not yet due use the
              first bucket. Payables, statutory dues and EMIs are assumed paid on their due dates.
            </p>
          </section>
        </div>
      )}
    </Panel>
  )
}
