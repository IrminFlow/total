// Stock reports (WP 2.3): reorder planning, stock ageing by inward lot, expiry, the serial-number
// register and barcode label printing — one tabbed screen reached from Stock summary (and the
// command palette). Negative stock lives in Exceptions; the tab strip links there.
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { StockAgeingRow } from '@shared/reports'
import type { ExpiryReportRow, ReorderRow, SerialListRow } from '@shared/stockPlanning'
import type { SerialStatus } from '@shared/serials'
import type { PrintTemplate } from '@shared/printTemplates'
import { toDisplayDate } from '@shared/dates'
import { api } from '../lib/client'
import { useNav, useSession, useToasts } from '../state/stores'
import { Badge, Button, Page, PageHeader, Panel, Segmented, Select, TabBar, inputCls } from '../components/ui'
import { OptionToggle, OptionsPeriod, useScreenOptions } from '../components/ScreenOptions'
import { DataTable, defineColumns } from '../components/table'
import { formatMilli } from '../lib/table'
import { ItemLink, VoucherLink } from '../components/links'
import { ItemPicker, useStockItems } from '../components/pickers'
import { PaperPreview } from '../components/print/PaperPreview'

export type StockReportTab = 'reorder' | 'ageing' | 'expiry' | 'serials' | 'labels'

const TABS: { id: StockReportTab; label: string }[] = [
  { id: 'reorder', label: 'Reorder planning' },
  { id: 'ageing', label: 'Ageing' },
  { id: 'expiry', label: 'Expiry' },
  { id: 'serials', label: 'Serial numbers' },
  { id: 'labels', label: 'Barcode labels' }
]

const perItem = <R extends { decimals: number; unitSymbol: string }>() => ({
  decimals: (r: R) => r.decimals,
  unit: (r: R) => r.unitSymbol
})

const REORDER_COLUMNS = defineColumns<ReorderRow>([
  { id: 'item', header: 'Item', kind: 'text', value: (r) => r.name, minWidth: 180, hideable: false, groupable: false, cell: (r) => <ItemLink itemId={r.stockItemId} name={r.name} /> },
  { id: 'level', header: 'Reorder level', kind: 'quantity', value: (r) => r.reorderLevelMilli, ...perItem<ReorderRow>(), width: 132 },
  { id: 'closing', header: 'Closing', kind: 'quantity', value: (r) => r.closingQtyMilli, ...perItem<ReorderRow>(), width: 124 },
  { id: 'consumed', header: 'Consumed (period)', kind: 'quantity', value: (r) => r.consumedMilli, ...perItem<ReorderRow>(), width: 150 },
  // At least one decimal: a slow mover's 0.2 / month must not read as 0.
  { id: 'avg', header: 'Avg / month', kind: 'quantity', value: (r) => r.avgMonthlyMilli, decimals: (r) => Math.max(1, r.decimals), unit: (r) => r.unitSymbol, width: 124 },
  { id: 'cover', header: 'Months of cover', kind: 'number', value: (r) => r.monthsOfCover, text: (r) => (r.monthsOfCover == null ? '–' : String(r.monthsOfCover)), width: 136 },
  {
    id: 'suggested',
    header: 'Suggested order',
    kind: 'quantity',
    value: (r) => r.suggestedMilli,
    ...perItem<ReorderRow>(),
    width: 148,
    cell: (r) => (r.below ? <span className="num font-semibold text-amber">{formatMilli(r.suggestedMilli, r.decimals)} {r.unitSymbol}</span> : <span className="text-muted">–</span>)
  }
])

const bucketText = (b: number, r: StockAgeingRow): string => (b === 0 ? '–' : `${formatMilli(b, r.decimals)} ${r.unitSymbol}`)
const AGEING_COLUMNS = defineColumns<StockAgeingRow>([
  { id: 'item', header: 'Item', kind: 'text', value: (r) => r.name, minWidth: 180, hideable: false, groupable: false, cell: (r) => <ItemLink itemId={r.stockItemId} name={r.name} /> },
  { id: 'closing', header: 'Closing', kind: 'quantity', value: (r) => r.closingQtyMilli, ...perItem<StockAgeingRow>(), width: 124 },
  { id: 'b0', header: '0–30 d', kind: 'quantity', value: (r) => r.buckets[0], text: (r) => bucketText(r.buckets[0], r), width: 116 },
  { id: 'b1', header: '31–60 d', kind: 'quantity', value: (r) => r.buckets[1], text: (r) => bucketText(r.buckets[1], r), width: 116 },
  { id: 'b2', header: '61–90 d', kind: 'quantity', value: (r) => r.buckets[2], text: (r) => bucketText(r.buckets[2], r), width: 116 },
  { id: 'b3', header: '90+ d', kind: 'quantity', value: (r) => r.buckets[3], text: (r) => bucketText(r.buckets[3], r), width: 116 },
  {
    id: 'flags',
    header: 'Flags',
    kind: 'text',
    value: (r) => [r.belowReorder && 'reorder', r.slowMoving && 'slow-moving'].filter(Boolean).join(' · '),
    width: 160,
    cell: (r) => (
      <>
        {r.belowReorder && <Badge tone="danger" className="mr-1">reorder</Badge>}
        {r.slowMoving && <Badge>slow-moving</Badge>}
      </>
    )
  }
])

const EXPIRY_COLUMNS = defineColumns<ExpiryReportRow>([
  { id: 'item', header: 'Item', kind: 'text', value: (r) => r.itemName, minWidth: 160, groupable: true, cell: (r) => <ItemLink itemId={r.stockItemId} name={r.itemName} /> },
  { id: 'batch', header: 'Batch', kind: 'text', value: (r) => r.batchName, width: 140 },
  { id: 'mfg', header: 'Mfg', kind: 'date', value: (r) => r.mfgDate, width: 110 },
  { id: 'expiry', header: 'Expiry', kind: 'date', value: (r) => r.expiryDate, width: 110 },
  {
    id: 'days',
    header: 'Days left',
    kind: 'number',
    value: (r) => r.daysToExpiry,
    width: 120,
    cell: (r) =>
      r.daysToExpiry < 0 ? <Badge tone="danger">expired {-r.daysToExpiry} d ago</Badge> : r.daysToExpiry <= 30 ? <Badge tone="warning">{r.daysToExpiry} d</Badge> : <span className="num">{r.daysToExpiry} d</span>
  },
  { id: 'qty', header: 'In stock', kind: 'quantity', value: (r) => r.closingQtyMilli, ...perItem<ExpiryReportRow>(), width: 124 }
])

const STATUS_LABEL: Record<SerialStatus, string> = { in_stock: 'In stock', sold: 'Sold', consumed: 'Consumed', returned: 'Returned to supplier' }
const SERIAL_COLUMNS = defineColumns<SerialListRow>([
  { id: 'item', header: 'Item', kind: 'text', value: (r) => r.itemName, minWidth: 160, cell: (r) => <ItemLink itemId={r.stockItemId} name={r.itemName} /> },
  { id: 'serial', header: 'Serial', kind: 'text', value: (r) => r.serial, width: 160, groupable: false, cell: (r) => <span className="num">{r.serial}</span> },
  {
    id: 'status',
    header: 'Status',
    kind: 'enum',
    value: (r) => r.status,
    options: (Object.keys(STATUS_LABEL) as SerialStatus[]).map((s) => ({ value: s, label: STATUS_LABEL[s] })),
    width: 170,
    cell: (r) => <Badge tone={r.status === 'in_stock' ? 'success' : 'neutral'}>{STATUS_LABEL[r.status]}</Badge>
  },
  { id: 'godown', header: 'Godown', kind: 'text', value: (r) => r.godownName ?? '', width: 130 },
  { id: 'batch', header: 'Batch', kind: 'text', value: (r) => r.batchName ?? '', width: 120 },
  { id: 'in', header: 'Came in', kind: 'text', value: (r) => r.inwardLabel, width: 210, groupable: false, cell: (r) => <VoucherLink voucherId={r.inwardVoucherId} label={r.inwardLabel} /> },
  { id: 'out', header: 'Went out', kind: 'text', value: (r) => r.outwardLabel ?? '', width: 210, groupable: false, cell: (r) => (r.outwardVoucherId ? <VoucherLink voucherId={r.outwardVoucherId} label={r.outwardLabel} /> : null) }
])

export function StockReportsScreen({ tab = 'reorder' }: { tab?: StockReportTab }): React.JSX.Element {
  const nav = useNav()
  const { from, to } = useSession()
  return (
    <Page>
      <PageHeader
        title="Stock reports"
        period={tab === 'reorder' ? `${toDisplayDate(from)} → ${toDisplayDate(to)}` : `as on ${toDisplayDate(to)}`}
        tabs={
          <div className="flex items-center gap-3">
            <TabBar screen="stock-reports" tabs={TABS} active={tab} onSelect={(t) => nav.replace({ name: 'stock-reports', tab: t })} />
            <Button size="sm" variant="ghost" onClick={() => nav.go({ name: 'exceptions' })} data-testid="btn-stock-reports-negative">
              Negative stock → Exceptions
            </Button>
          </div>
        }
        options={{ content: <OptionsPeriod asOn={tab !== 'reorder'} /> }}
      />
      {tab === 'reorder' && <ReorderTab />}
      {tab === 'ageing' && <AgeingTab />}
      {tab === 'expiry' && <ExpiryTab />}
      {tab === 'serials' && <SerialsTab />}
      {tab === 'labels' && <LabelsTab />}
    </Page>
  )
}

function ReorderTab(): React.JSX.Element {
  const { from, to } = useSession()
  const opts = useScreenOptions('stock-reorder', { onlyBelow: true })
  const { data, isLoading } = useQuery({ queryKey: ['stockReorder', from, to, opts.options.onlyBelow], queryFn: () => api.stock.reorder(from, to, opts.options.onlyBelow) })
  return (
    <Panel>
      <div className="flex items-center justify-between gap-3 px-3 pt-3">
        <p className="text-hint text-muted" data-testid="reorder-formula">
          Suggested order = max(0, reorder level × 2 − closing). Avg / month = outward quantity in the working period × 30 ÷ days in the period.
        </p>
        <OptionToggle label="Only items below their reorder level" checked={opts.options.onlyBelow} onChange={(v) => opts.set('onlyBelow', v)} testId="input-reorder-only-below" />
      </div>
      <DataTable
        viewId="stock-reorder"
        testId="stock-reorder"
        ariaLabel="Reorder planning"
        columns={REORDER_COLUMNS}
        rows={data ?? []}
        rowKey={(r) => r.stockItemId}
        rowAttrs={(r) => ({ 'data-row-id': r.stockItemId })}
        loading={isLoading}
        empty={{ title: opts.options.onlyBelow ? 'Nothing to reorder' : 'No reorder levels set', hint: 'Set a reorder level on stock items under Masters → Stock items.' }}
        maxHeight="calc(100vh - 300px)"
        exportOptions={{ title: 'Reorder planning', periodLabel: `${toDisplayDate(from)} → ${toDisplayDate(to)}`, filename: 'reorder-planning' }}
      />
    </Panel>
  )
}

function AgeingTab(): React.JSX.Element {
  const { to } = useSession()
  const { data, isLoading } = useQuery({ queryKey: ['stockAgeing', to], queryFn: () => api.reports.stockAgeing(to) })
  const rows = (data ?? []).filter((r) => r.closingQtyMilli > 0)
  return (
    <Panel>
      <p className="px-3 pt-3 text-hint text-muted">Closing stock aged by the inward lots it most recently came from (newest lots first), as on {toDisplayDate(to)}.</p>
      <DataTable
        viewId="stock-reports-ageing"
        testId="stock-reports-ageing"
        ariaLabel="Stock ageing"
        columns={AGEING_COLUMNS}
        rows={rows}
        rowKey={(r) => r.stockItemId}
        rowAttrs={(r) => ({ 'data-row-id': r.stockItemId })}
        loading={isLoading}
        empty={{ title: 'No stock on hand' }}
        maxHeight="calc(100vh - 300px)"
        exportOptions={{ title: 'Stock ageing', periodLabel: `as on ${toDisplayDate(to)}`, filename: 'stock-ageing' }}
      />
    </Panel>
  )
}

const EXPIRY_WINDOWS = [
  { value: '30', label: '30 days' },
  { value: '60', label: '60 days' },
  { value: '90', label: '90 days' },
  { value: '180', label: '180 days' }
] as const

function ExpiryTab(): React.JSX.Element {
  const { to } = useSession()
  const opts = useScreenOptions('stock-expiry', { within: '90' as '30' | '60' | '90' | '180' }, { within: ['30', '60', '90', '180'] })
  const days = Number(opts.options.within)
  const { data, isLoading } = useQuery({ queryKey: ['stockExpiry', to, days], queryFn: () => api.stock.expiryReport(to, days) })
  return (
    <Panel>
      <div className="flex items-center gap-3 px-3 pt-3">
        <span className="text-detail text-ink">Expired, or expiring within</span>
        <Segmented label="Expiring within" options={EXPIRY_WINDOWS} value={opts.options.within} onChange={(v) => opts.set('within', v)} testId="input-expiry-within" size="sm" />
      </div>
      <DataTable
        viewId="stock-reports-expiry"
        testId="stock-reports-expiry"
        ariaLabel="Expiry report"
        columns={EXPIRY_COLUMNS}
        rows={data ?? []}
        rowKey={(r) => r.batchId}
        rowAttrs={(r) => ({ 'data-row-id': r.batchId })}
        rowClassName={(r) => (r.daysToExpiry < 0 ? 'text-cr' : '')}
        loading={isLoading}
        empty={{ title: `Nothing expires within ${days} days`, hint: 'Batches with stock and an expiry date show here.' }}
        maxHeight="calc(100vh - 300px)"
        exportOptions={{ title: `Expiry — within ${days} days`, periodLabel: `as on ${toDisplayDate(to)}`, filename: 'expiry-report' }}
      />
    </Panel>
  )
}

function SerialsTab(): React.JSX.Element {
  const [itemId, setItemId] = useState<number | null>(null)
  const [status, setStatus] = useState<SerialStatus | ''>('')
  const { data, isLoading } = useQuery({
    queryKey: ['serialList', itemId, status],
    queryFn: () => api.serials.list({ stockItemId: itemId ?? undefined, status: status || undefined })
  })
  return (
    <Panel>
      <div className="flex items-center gap-3 px-3 pt-3">
        <ItemPicker value={itemId} onPick={setItemId} className="w-64" testId="picker-serials-item" />
        <Select value={status} onChange={(e) => setStatus(e.target.value as SerialStatus | '')} className="w-48" aria-label="Status" data-testid="input-serials-status">
          <option value="">Every status</option>
          {(Object.keys(STATUS_LABEL) as SerialStatus[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </Select>
        <span className="text-hint text-muted">Items track serial numbers when “Track serial numbers” is on in Masters → Stock items.</span>
      </div>
      <DataTable
        viewId="stock-reports-serials"
        testId="stock-reports-serials"
        ariaLabel="Serial numbers"
        columns={SERIAL_COLUMNS}
        rows={data ?? []}
        rowKey={(r) => `${r.stockItemId}|${r.serial}`}
        rowAttrs={(r) => ({ 'data-row-id': `${r.stockItemId}|${r.serial}` })}
        loading={isLoading}
        empty={{ title: 'No serial numbers yet', hint: 'They appear once a serial-tracked item is bought or received.' }}
        maxHeight="calc(100vh - 300px)"
        exportOptions={{ title: 'Serial numbers', periodLabel: '', filename: 'serial-numbers' }}
      />
    </Panel>
  )
}

const LABEL_PAGE = { size: 'A4', orientation: 'portrait', marginsMm: { top: 0, right: 0, bottom: 0, left: 0 }, pageNumbers: false } as PrintTemplate['page']

function LabelsTab(): React.JSX.Element {
  const { to } = useSession()
  const toast = useToasts()
  const items = useStockItems()
  const { data: levels } = useQuery({ queryKey: ['priceLevels'], queryFn: api.priceLevels.list })
  const [copies, setCopies] = useState<Record<number, number>>({})
  const [level, setLevel] = useState<string>('first')
  const [printing, setPrinting] = useState(false)
  const sorted = useMemo(() => [...items].sort((a, b) => Number(!a.barcode) - Number(!b.barcode) || a.name.localeCompare(b.name)), [items])
  const picked = Object.entries(copies)
    .map(([id, n]) => ({ itemId: Number(id), copies: n }))
    .filter((x) => x.copies > 0)
  const priceLevelId = level === 'first' ? undefined : level === 'none' ? null : Number(level)
  const query = { items: picked, priceLevelId, date: to }
  const { data: preview } = useQuery({
    queryKey: ['labelsPreview', JSON.stringify(query)],
    queryFn: () => api.stock.labelsHtml(query),
    enabled: picked.length > 0
  })
  const print = async (): Promise<void> => {
    setPrinting(true)
    try {
      const { path } = await api.stock.labelsPdf(query)
      toast.push('success', `Labels saved — ${path.split('/').pop()}`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setPrinting(false)
    }
  }
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-section">
      <Panel className="p-4">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-detail">
            Price from
            <Select value={level} onChange={(e) => setLevel(e.target.value)} className="w-44" data-testid="input-labels-price-level">
              <option value="first">{levels?.[0] ? `${levels[0].name} (first list)` : 'First price list'}</option>
              {(levels ?? []).slice(1).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
              <option value="none">No price</option>
            </Select>
          </label>
          <Button size="sm" variant="ghost" onClick={() => setCopies(Object.fromEntries(sorted.filter((i) => i.barcode).map((i) => [i.id, 1])))} data-testid="btn-labels-all">
            1 of each with a barcode
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setCopies({})}>
            Clear
          </Button>
          <span className="flex-1" />
          <Button variant="primary" disabled={picked.length === 0 || printing} onClick={() => void print()} data-testid="btn-labels-print">
            Print labels (PDF)
          </Button>
        </div>
        <table className="ledger-table">
          <thead>
            <tr>
              <th>Item</th>
              <th className="w-40">Barcode</th>
              <th className="r w-24">Copies</th>
            </tr>
          </thead>
          <tbody data-testid="rows-labels">
            {sorted.map((i) => (
              <tr key={i.id} data-row-id={i.id}>
                <td className="text-body-sm">{i.name}</td>
                <td className="num text-small">{i.barcode ?? <span className="text-muted" title="Set a barcode in Masters → Stock items">—</span>}</td>
                <td className="r">
                  <input
                    className={`${inputCls} num w-20 text-right`}
                    aria-label={`Copies of ${i.name}`}
                    data-testid={`input-labels-copies-${i.id}`}
                    inputMode="numeric"
                    value={copies[i.id] ? String(copies[i.id]) : ''}
                    placeholder="0"
                    onChange={(e) => {
                      const n = Math.max(0, Math.min(500, Math.floor(Number(e.target.value) || 0)))
                      setCopies((c) => ({ ...c, [i.id]: n }))
                    }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      <div className="w-[420px]" data-testid="labels-preview">
        {preview ? (
          <PaperPreview html={preview.html} page={LABEL_PAGE} zoom={0.5} title="Label sheet preview" />
        ) : (
          <Panel className="p-4">
            <p className="text-hint text-muted">Set copies for one or more items to preview the A4 label sheet (3 × 7 labels, Code-128 barcodes).</p>
          </Panel>
        )}
      </div>
    </div>
  )
}
