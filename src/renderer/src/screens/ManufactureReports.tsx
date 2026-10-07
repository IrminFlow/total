// Manufacturing reports (WP 2.4): production register, cost sheet per product, expected vs
// realised margin, material variance against the BOM, and material at job workers — one tabbed
// screen reached from the Manufacture register (and Manufacture's options / the palette). Every
// figure is the engine's current one (a backdated purchase re-prices them all).
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { CostSheetLine, MarginRow, ProductionRegisterRow, VarianceReportRow } from '@shared/manufactureReports'
import type { JobWorkPendingRow } from '@shared/jobWork'
import { toDisplayDate } from '@shared/dates'
import { formatPaise } from '@shared/money'
import { api } from '../lib/client'
import { useNav, useSession } from '../state/stores'
import { Badge, Button, Money, Page, PageHeader, Panel, Segmented, Select, StatGrid, StatTile, TabBar } from '../components/ui'
import { OptionsPeriod, useScreenOptions } from '../components/ScreenOptions'
import { DataTable, defineColumns } from '../components/table'
import { formatMilli } from '../lib/table'
import { ItemLink, VoucherLink } from '../components/links'
import { ItemPicker } from '../components/pickers'

export type ManufactureReportTab = 'production' | 'cost-sheet' | 'margin' | 'variance' | 'job-work'

const TABS: { id: ManufactureReportTab; label: string }[] = [
  { id: 'production', label: 'Production register' },
  { id: 'cost-sheet', label: 'Cost sheet' },
  { id: 'margin', label: 'Expected vs realised' },
  { id: 'variance', label: 'Material variance' },
  { id: 'job-work', label: 'At job workers' }
]

const perItem = <R extends { decimals: number; unitSymbol: string }>() => ({ decimals: (r: R) => r.decimals, unit: (r: R) => r.unitSymbol })
const pct = (v: number | null): string => (v == null ? '–' : `${v.toFixed(2)} %`)

const PRODUCTION_COLUMNS = defineColumns<ProductionRegisterRow>([
  { id: 'item', header: 'Item', kind: 'text', value: (r) => r.itemName, minWidth: 180, hideable: false, groupable: false, cell: (r) => <ItemLink itemId={r.finishedItemId} name={r.itemName} /> },
  { id: 'count', header: 'Runs', kind: 'number', value: (r) => r.manufactures, aggregate: 'sum', width: 80 },
  { id: 'qty', header: 'Qty made', kind: 'quantity', value: (r) => r.qtyMilli, ...perItem<ProductionRegisterRow>(), width: 120 },
  { id: 'materials', header: 'Materials', kind: 'money', value: (r) => r.materialPaise, aggregate: 'sum', width: 130 },
  { id: 'labour', header: 'Labour', kind: 'money', value: (r) => r.labourPaise, aggregate: 'sum', width: 120 },
  { id: 'byProducts', header: 'By-products', kind: 'money', value: (r) => r.byProductPaise, aggregate: 'sum', width: 130 },
  { id: 'cost', header: 'Production cost', kind: 'money', value: (r) => r.productionCost, aggregate: 'sum', width: 150 },
  { id: 'unit', header: 'Cost / unit', kind: 'money', value: (r) => r.unitCostPaise, width: 120 },
  { id: 'sale', header: 'Sale value', kind: 'money', value: (r) => r.saleAmount, aggregate: 'sum', width: 140 },
  { id: 'margin', header: 'Margin', kind: 'money', value: (r) => r.marginPaise, aggregate: 'sum', width: 140, cell: (r) => <Money paise={r.marginPaise} className={r.marginPaise < 0 ? 'text-danger' : ''} /> },
  { id: 'marginPct', header: 'Margin %', kind: 'number', value: (r) => r.marginPct, text: (r) => pct(r.marginPct), width: 110 }
])

const KIND_LABEL: Record<CostSheetLine['kind'], string> = { material: 'Material', labour: 'Labour', by_product: 'By-product', scrap: 'Scrap' }
const COST_SHEET_COLUMNS = defineColumns<CostSheetLine & { key: string }>([
  { id: 'kind', header: 'Line', kind: 'text', value: (r) => KIND_LABEL[r.kind], width: 110 },
  { id: 'name', header: 'Component', kind: 'text', value: (r) => r.name, minWidth: 180, cell: (r) => (r.itemId ? <ItemLink itemId={r.itemId} name={r.name} /> : <span>{r.name}</span>) },
  { id: 'qty', header: 'Qty', kind: 'quantity', value: (r) => r.qtyMilli, decimals: (r) => r.decimals, unit: (r) => r.unitSymbol, width: 120, text: (r) => (r.itemId ? `${formatMilli(r.qtyMilli, r.decimals)} ${r.unitSymbol}` : '–') },
  { id: 'rate', header: 'Rate', kind: 'money', value: (r) => r.ratePaise, width: 120, text: (r) => (r.itemId ? formatPaise(r.ratePaise) : '–') },
  { id: 'amount', header: 'Amount', kind: 'money', value: (r) => r.amountPaise, aggregate: 'sum', width: 140 },
  { id: 'perUnitQty', header: 'Qty / unit', kind: 'quantity', value: (r) => r.qtyPerUnitMilli, decimals: (r) => Math.max(r.decimals, 2), unit: (r) => r.unitSymbol, width: 120, text: (r) => (r.itemId ? `${formatMilli(r.qtyPerUnitMilli, 3)} ${r.unitSymbol}` : '–') },
  { id: 'perUnit', header: 'Amount / unit', kind: 'money', value: (r) => r.amountPerUnitPaise, aggregate: 'sum', width: 140 }
])

const MARGIN_COLUMNS = defineColumns<MarginRow>([
  { id: 'item', header: 'Item', kind: 'text', value: (r) => r.itemName, minWidth: 170, hideable: false, groupable: false, cell: (r) => <ItemLink itemId={r.itemId} name={r.itemName} /> },
  { id: 'made', header: 'Made', kind: 'quantity', value: (r) => r.madeQtyMilli, ...perItem<MarginRow>(), width: 110 },
  { id: 'unitCost', header: 'Cost / unit', kind: 'money', value: (r) => r.unitCostPaise, width: 120 },
  { id: 'expSale', header: 'Expected sale', kind: 'money', value: (r) => r.expectedSaleAmount, aggregate: 'sum', width: 140 },
  { id: 'expMargin', header: 'Expected margin', kind: 'money', value: (r) => r.expectedMarginPaise, aggregate: 'sum', width: 150 },
  { id: 'expPct', header: 'Expected %', kind: 'number', value: (r) => r.expectedMarginPct, text: (r) => pct(r.expectedMarginPct), width: 110 },
  { id: 'sold', header: 'Sold', kind: 'quantity', value: (r) => r.soldQtyMilli, ...perItem<MarginRow>(), width: 110 },
  { id: 'sales', header: 'Sales value', kind: 'money', value: (r) => r.salesValue, aggregate: 'sum', width: 140 },
  { id: 'cogs', header: 'COGS (engine)', kind: 'money', value: (r) => r.cogs, aggregate: 'sum', width: 140 },
  { id: 'realMargin', header: 'Realised margin', kind: 'money', value: (r) => r.realisedMarginPaise, aggregate: 'sum', width: 150 },
  { id: 'realPct', header: 'Realised %', kind: 'number', value: (r) => r.realisedMarginPct, text: (r) => pct(r.realisedMarginPct), width: 110 },
  {
    id: 'gap',
    header: 'Gap (pts)',
    kind: 'number',
    value: (r) => r.marginGapPct,
    width: 110,
    cell: (r) => (r.marginGapPct == null ? <span className="text-muted">–</span> : <span className={`num ${r.marginGapPct < 0 ? 'text-danger' : 'text-success'}`}>{r.marginGapPct > 0 ? '+' : ''}{r.marginGapPct.toFixed(2)}</span>)
  }
])

const VARIANCE_COLUMNS = defineColumns<VarianceReportRow>([
  { id: 'date', header: 'Date', kind: 'date', value: (r) => r.date, width: 110, className: 'text-muted' },
  { id: 'voucher', header: 'No.', kind: 'text', value: (r) => r.number, width: 100, groupable: false, cell: (r) => <VoucherLink voucherId={r.voucherId} label={r.number} /> },
  { id: 'item', header: 'Made', kind: 'text', value: (r) => r.itemName, width: 160, cell: (r) => <ItemLink itemId={r.finishedItemId} name={r.itemName} /> },
  { id: 'version', header: 'BOM', kind: 'text', value: (r) => r.bomVersionName ?? '', width: 90 },
  { id: 'component', header: 'Component', kind: 'text', value: (r) => r.componentName, minWidth: 160, cell: (r) => <ItemLink itemId={r.componentId} name={r.componentName} /> },
  { id: 'std', header: 'Standard qty', kind: 'quantity', value: (r) => r.standardQtyMilli, ...perItem<VarianceReportRow>(), width: 130 },
  { id: 'act', header: 'Actual qty', kind: 'quantity', value: (r) => r.actualQtyMilli, ...perItem<VarianceReportRow>(), width: 120 },
  {
    id: 'qtyVar',
    header: 'Qty variance',
    kind: 'quantity',
    value: (r) => r.qtyVarianceMilli,
    ...perItem<VarianceReportRow>(),
    width: 130,
    cell: (r) => <span className={`num ${r.qtyVarianceMilli > 0 ? 'text-danger' : r.qtyVarianceMilli < 0 ? 'text-success' : 'text-muted'}`}>{r.qtyVarianceMilli > 0 ? '+' : ''}{formatMilli(r.qtyVarianceMilli, r.decimals)} {r.unitSymbol}</span>
  },
  { id: 'stdValue', header: 'Standard value', kind: 'money', value: (r) => r.standardValuePaise, aggregate: 'sum', width: 140 },
  { id: 'actValue', header: 'Actual value', kind: 'money', value: (r) => r.actualValuePaise, aggregate: 'sum', width: 130 },
  {
    id: 'valueVar',
    header: 'Value variance',
    kind: 'money',
    value: (r) => r.valueVariancePaise,
    aggregate: 'sum',
    width: 140,
    cell: (r) => <Money paise={r.valueVariancePaise} className={r.valueVariancePaise > 0 ? 'text-danger' : ''} />
  }
])

const JOB_WORK_COLUMNS = defineColumns<JobWorkPendingRow>([
  { id: 'worker', header: 'Job worker', kind: 'text', value: (r) => r.godownName, width: 200, groupable: true, cell: (r) => <span>{r.godownName}<span className="ml-1 text-hint text-muted">{r.partyName}</span></span> },
  { id: 'item', header: 'Item', kind: 'text', value: (r) => r.itemName, minWidth: 160, cell: (r) => <ItemLink itemId={r.stockItemId} name={r.itemName} /> },
  { id: 'qty', header: 'At job worker', kind: 'quantity', value: (r) => r.qtyMilli, ...perItem<JobWorkPendingRow>(), width: 140 },
  { id: 'value', header: 'Value', kind: 'money', value: (r) => r.valuePaise, aggregate: 'sum', width: 130 },
  { id: 'oldest', header: 'Oldest sent', kind: 'date', value: (r) => r.oldestDate, width: 120 },
  { id: 'age', header: 'Age', kind: 'number', value: (r) => r.ageDays, width: 90, text: (r) => (r.ageDays == null ? '–' : `${r.ageDays} d`) },
  {
    id: 'pending',
    header: 'Pending beyond limit',
    kind: 'quantity',
    value: (r) => r.pendingQtyMilli,
    ...perItem<JobWorkPendingRow>(),
    width: 170,
    cell: (r) =>
      r.pendingQtyMilli > 0 ? (
        <Badge tone="warning" testId="job-work-pending-badge">{formatMilli(r.pendingQtyMilli, r.decimals)} {r.unitSymbol}</Badge>
      ) : (
        <span className="text-muted">–</span>
      )
  },
  { id: 'pendingValue', header: 'Pending value', kind: 'money', value: (r) => r.pendingValuePaise, aggregate: 'sum', width: 140 }
])

export function ManufactureReportsScreen({ tab = 'production' }: { tab?: ManufactureReportTab }): React.JSX.Element {
  const nav = useNav()
  const { from, to } = useSession()
  return (
    <Page width="wide">
      <PageHeader
        title="Manufacturing reports"
        period={tab === 'job-work' ? `as on ${toDisplayDate(to)}` : `${toDisplayDate(from)} → ${toDisplayDate(to)}`}
        tabs={
          <div className="flex items-center gap-3">
            <TabBar screen="manufacture-reports" tabs={TABS} active={tab} onSelect={(t) => nav.replace({ name: 'manufacture-reports', tab: t })} />
            <Button size="sm" variant="ghost" onClick={() => nav.go({ name: 'manufacture-register' })} data-testid="btn-reports-register">
              Manufacture register →
            </Button>
          </div>
        }
        options={{ content: <OptionsPeriod asOn={tab === 'job-work'} /> }}
      />
      {tab === 'production' && <ProductionTab />}
      {tab === 'cost-sheet' && <CostSheetTab />}
      {tab === 'margin' && <MarginTab />}
      {tab === 'variance' && <VarianceTab />}
      {tab === 'job-work' && <JobWorkTab />}
    </Page>
  )
}

const periodOf = (from: string, to: string): string => `${toDisplayDate(from)} → ${toDisplayDate(to)}`

function ProductionTab(): React.JSX.Element {
  const { from, to } = useSession()
  const { data, isLoading } = useQuery({ queryKey: ['manufactureProduction', from, to], queryFn: () => api.manufacture.production(from, to) })
  return (
    <Panel>
      <p className="px-3 pt-3 text-hint text-muted">
        Per finished item: production cost = materials + labour − by-products (engine cost now); margin = sale value − production cost.
      </p>
      <DataTable
        viewId="manufacture-production"
        testId="manufacture-production"
        ariaLabel="Production register"
        columns={PRODUCTION_COLUMNS}
        rows={data ?? []}
        rowKey={(r) => r.finishedItemId}
        rowAttrs={(r) => ({ 'data-row-id': r.finishedItemId })}
        loading={isLoading}
        empty={{ title: 'Nothing manufactured in this period' }}
        maxHeight="calc(100vh - 300px)"
        exportOptions={{ title: 'Production register', periodLabel: periodOf(from, to), filename: 'production-register' }}
      />
    </Panel>
  )
}

function CostSheetTab(): React.JSX.Element {
  const { from, to } = useSession()
  const { data: made } = useQuery({ queryKey: ['manufactureProduction', from, to], queryFn: () => api.manufacture.production(from, to) })
  const [picked, setPicked] = useState<number | null>(null)
  const itemId = picked ?? made?.[0]?.finishedItemId ?? null
  const [which, setWhich] = useState<string>('average')
  const { data, isLoading } = useQuery({
    queryKey: ['manufactureCostSheet', itemId, from, to],
    queryFn: () => api.manufacture.costSheet(itemId!, from, to),
    enabled: itemId != null
  })
  const sheet = which === 'average' ? data?.average : data?.manufactures.find((m) => String(m.voucherId) === which)
  const rows = useMemo(() => (sheet?.lines ?? []).map((l, i) => ({ ...l, key: `${l.kind}-${l.itemId ?? i}` })), [sheet])
  const unit = data?.unitSymbol ?? ''
  return (
    <Panel>
      <div className="flex flex-wrap items-center gap-3 px-3 pt-3">
        <ItemPicker value={itemId} onPick={(id) => { setPicked(id); setWhich('average') }} className="w-64" testId="picker-cost-sheet-item" />
        <Select value={which} onChange={(e) => setWhich(e.target.value)} className="w-72" aria-label="Manufacture" data-testid="input-cost-sheet-which">
          <option value="average">Period average ({data?.manufactures.length ?? 0} runs)</option>
          {(data?.manufactures ?? []).map((m) => (
            <option key={m.voucherId!} value={String(m.voucherId)}>
              {m.number} · {toDisplayDate(m.date!)} · {formatMilli(m.qtyMilli, data?.decimals ?? 0)} {unit}
            </option>
          ))}
        </Select>
      </div>
      {sheet && (
        <div className="px-3 pt-3">
          <StatGrid>
            <StatTile label="Quantity" value={`${formatMilli(sheet.qtyMilli, data?.decimals ?? 0)} ${unit}`} />
            <StatTile label="Production cost" value={formatPaise(sheet.productionCost, { symbol: true })} testId="cost-sheet-total" />
            <StatTile label={`Cost per ${unit || 'unit'}`} value={formatPaise(sheet.unitCostPaise, { symbol: true })} testId="cost-sheet-unit" />
            <StatTile label="Sale value" value={formatPaise(sheet.saleAmount, { symbol: true })} />
          </StatGrid>
        </div>
      )}
      <DataTable
        viewId="manufacture-cost-sheet"
        testId="manufacture-cost-sheet"
        ariaLabel="Cost sheet"
        columns={COST_SHEET_COLUMNS}
        rows={rows}
        rowKey={(r) => r.key}
        loading={isLoading && itemId != null}
        empty={{ title: itemId == null ? 'Pick an item' : 'No manufactures of this item in the period' }}
        maxHeight="calc(100vh - 380px)"
        exportOptions={{ title: `Cost sheet — ${data?.itemName ?? ''}`, periodLabel: periodOf(from, to), filename: 'cost-sheet' }}
      />
    </Panel>
  )
}

function MarginTab(): React.JSX.Element {
  const { from, to } = useSession()
  const { data, isLoading } = useQuery({ queryKey: ['manufactureMargin', from, to], queryFn: () => api.manufacture.margin(from, to) })
  return (
    <Panel>
      <p className="px-3 pt-3 text-hint text-muted">
        Expected = the manufactures’ sale values against their production cost. Realised = actual sales of the item in the period against the
        engine’s cost of goods sold.
      </p>
      <DataTable
        viewId="manufacture-margin"
        testId="manufacture-margin"
        ariaLabel="Expected vs realised margin"
        columns={MARGIN_COLUMNS}
        rows={data ?? []}
        rowKey={(r) => r.itemId}
        rowAttrs={(r) => ({ 'data-row-id': r.itemId })}
        loading={isLoading}
        empty={{ title: 'Nothing manufactured in this period' }}
        maxHeight="calc(100vh - 300px)"
        exportOptions={{ title: 'Expected vs realised margin', periodLabel: periodOf(from, to), filename: 'manufacture-margin' }}
      />
    </Panel>
  )
}

function VarianceTab(): React.JSX.Element {
  const { from, to } = useSession()
  const { data, isLoading } = useQuery({ queryKey: ['manufactureVariance', from, to], queryFn: () => api.manufacture.variance(from, to) })
  return (
    <Panel>
      <p className="px-3 pt-3 text-hint text-muted">
        Standard = the BOM version used (exploded when the manufacture was) × quantity made, scrap included. Value variance prices the
        quantity difference at the cost actually charged. Positive = more consumed than planned.
      </p>
      <DataTable
        viewId="manufacture-variance"
        testId="manufacture-variance"
        ariaLabel="Material variance"
        columns={VARIANCE_COLUMNS}
        rows={data ?? []}
        rowKey={(r) => `${r.voucherId}-${r.componentId}`}
        loading={isLoading}
        empty={{ title: 'No manufactures with a BOM in this period', hint: 'Variance needs a BOM version on the item (Masters → Items).' }}
        maxHeight="calc(100vh - 300px)"
        exportOptions={{ title: 'Material variance', periodLabel: periodOf(from, to), filename: 'material-variance' }}
      />
    </Panel>
  )
}

const PENDING_WINDOWS = [
  { value: '30', label: '30 d' },
  { value: '90', label: '90 d' },
  { value: '180', label: '180 d' },
  { value: '365', label: '1 year' }
] as const

function JobWorkTab(): React.JSX.Element {
  const { to } = useSession()
  const nav = useNav()
  const opts = useScreenOptions('manufacture-job-work', { days: '180' as '30' | '90' | '180' | '365' }, { days: ['30', '90', '180', '365'] })
  const days = Number(opts.options.days)
  const { data, isLoading } = useQuery({ queryKey: ['jobWorkPending', to, days], queryFn: () => api.jobWork.pending(to, days) })
  return (
    <Panel>
      <div className="flex flex-wrap items-center gap-3 px-3 pt-3">
        <span className="text-detail text-ink">Flag material pending beyond</span>
        <Segmented label="Pending beyond" options={PENDING_WINDOWS} value={opts.options.days} onChange={(v) => opts.set('days', v)} testId="input-job-work-days" size="sm" />
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => nav.go({ name: 'stock-journal', mode: 'jobWork' })} data-testid="btn-job-work-send">
          Send to job worker
        </Button>
        <Button size="sm" variant="ghost" onClick={() => nav.go({ name: 'manufacture', jobWork: true })} data-testid="btn-job-work-receive">
          Receive from job worker
        </Button>
      </div>
      <p className="px-3 pt-2 text-hint text-muted">
        Material is aged by the challan that sent it (oldest consumed first). Challan, processing and loss details are kept for ITC-04.
      </p>
      <DataTable
        viewId="manufacture-job-work"
        testId="manufacture-job-work"
        ariaLabel="Material at job workers"
        columns={JOB_WORK_COLUMNS}
        rows={data ?? []}
        rowKey={(r) => `${r.godownId}-${r.stockItemId}`}
        rowAttrs={(r) => ({ 'data-row-id': `${r.godownId}-${r.stockItemId}` })}
        loading={isLoading}
        empty={{ title: 'Nothing at job workers', hint: 'Stock journal → Send to job worker moves material out on a challan.' }}
        maxHeight="calc(100vh - 320px)"
        exportOptions={{ title: 'Material at job workers', periodLabel: `as on ${toDisplayDate(to)}`, filename: 'material-at-job-workers' }}
      />
    </Panel>
  )
}
