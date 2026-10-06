import { useCallback, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useSession } from '../state/stores'
import { Money, Panel, SectionTitle } from '../components/ui'
import { DataTable, defineColumns, type RowKey } from '../components/table'
import { formatMilli } from '../lib/table'
import { toDisplayDate } from '@shared/dates'
import type { StockAgeingRow, StockSummaryRow } from '@shared/reports'
import { ItemLink } from '../components/links'

/** Integer milli → "12.500" at the item's own precision (integer maths, never a float divide). */
const fmtQty = (qtyMilli: number, decimals: number): string => formatMilli(qtyMilli, decimals)
const qtyText = (milli: number, r: { decimals: number; unitSymbol: string }): string =>
  `${fmtQty(milli, r.decimals)} ${r.unitSymbol}`

// Column ids match the old useReportConfig toggle keys ('stock-summary'), so users keep their
// hidden-column choices via legacyReportKey. Quantities carry per-item units and precision, so
// they have no meaningful total; closing value does.
/** Each item has its own unit and precision: the table formats quantities per row. */
const perItemQty = { decimals: (r: StockSummaryRow) => r.decimals, unit: (r: StockSummaryRow) => r.unitSymbol }

export const STOCK_SUMMARY_COLUMNS = defineColumns<StockSummaryRow>([
  {
    id: 'item',
    header: 'Item',
    kind: 'text',
    value: (r) => r.name,
    hideable: false,
    groupable: false,
    minWidth: 160,
    // The row expands its godown/batch breakdown; the item NAME opens the item editor.
    cell: (r) => (
      <>
        <ItemLink itemId={r.stockItemId} name={r.name} />
        {r.closingQtyMilli < 0 && <span className="ml-2 text-[11px]">— negative stock, check entries</span>}
      </>
    )
  },
  { id: 'opening', header: 'Opening', kind: 'quantity', value: (r) => r.openingQtyMilli, ...perItemQty, width: 124 },
  { id: 'inwards', header: 'Inwards', kind: 'quantity', value: (r) => r.inwardQtyMilli, ...perItemQty, width: 124 },
  { id: 'outwards', header: 'Outwards', kind: 'quantity', value: (r) => r.outwardQtyMilli, ...perItemQty, width: 124 },
  { id: 'closingQty', header: 'Closing qty', kind: 'quantity', value: (r) => r.closingQtyMilli, ...perItemQty, width: 148 },
  { id: 'closingValue', header: 'Closing value', kind: 'money', value: (r) => r.closingValue, aggregate: 'sum', width: 160 }
])

const bucketText = (b: number, r: StockAgeingRow): string => (b === 0 ? '–' : qtyText(b, r))
const flagsText = (r: StockAgeingRow): string =>
  [r.belowReorder && 'reorder', r.slowMoving && 'slow-moving'].filter(Boolean).join(' · ')

const AGEING_COLUMNS = defineColumns<StockAgeingRow>([
  {
    id: 'item',
    header: 'Item',
    kind: 'text',
    value: (r) => r.name,
    hideable: false,
    groupable: false,
    minWidth: 160,
    cell: (r) => <ItemLink itemId={r.stockItemId} name={r.name} />
  },
  { id: 'b0', header: '0–30 d', kind: 'quantity', value: (r) => r.buckets[0], text: (r) => bucketText(r.buckets[0], r), width: 116 },
  { id: 'b1', header: '31–60 d', kind: 'quantity', value: (r) => r.buckets[1], text: (r) => bucketText(r.buckets[1], r), width: 116 },
  { id: 'b2', header: '61–90 d', kind: 'quantity', value: (r) => r.buckets[2], text: (r) => bucketText(r.buckets[2], r), width: 116 },
  { id: 'b3', header: '90+ d', kind: 'quantity', value: (r) => r.buckets[3], text: (r) => bucketText(r.buckets[3], r), width: 116 },
  {
    id: 'flags',
    header: 'Flags',
    kind: 'text',
    value: flagsText,
    width: 176,
    cell: (r) => (
      <>
        {r.belowReorder && <span className="mr-2 text-[11.5px] text-cr">reorder</span>}
        {r.slowMoving && <span className="text-[11.5px] text-muted">slow-moving</span>}
      </>
    )
  }
])

export function StockSummaryScreen(): React.JSX.Element {
  const { to } = useSession()
  const { data, isLoading } = useQuery({ queryKey: ['stockSummary', to], queryFn: () => api.stock.summary(to) })
  const rows = data ?? []
  // Expandable item rows (user ask): one item at a time unfolds into its godown- and
  // batch-wise closing position, fetched on demand. A click on the row toggles it; → / ← too.
  const [expanded, setExpanded] = useState<ReadonlySet<RowKey>>(() => new Set())
  const onExpandedChange = useCallback((next: Set<RowKey>) => {
    setExpanded((cur) => {
      const added = [...next].filter((k) => !cur.has(k))
      return added.length ? new Set([added[added.length - 1]!]) : next
    })
  }, [])
  const toggle = useCallback((r: StockSummaryRow) => {
    setExpanded((cur) => (cur.has(r.stockItemId) ? new Set() : new Set([r.stockItemId])))
  }, [])
  const periodLabel = `as on ${toDisplayDate(to)}`

  return (
    <div className="mx-auto max-w-5xl">
      <SectionTitle right={<span className="num text-[12px] text-muted">{periodLabel}</span>}>Stock summary</SectionTitle>
      <Panel>
        <DataTable
          viewId="stock-summary"
          legacyReportKey="stock-summary"
          testId="stock-summary"
          ariaLabel="Stock summary"
          columns={STOCK_SUMMARY_COLUMNS}
          rows={rows}
          rowKey={(r) => r.stockItemId}
          rowAttrs={(r) => ({ 'data-row-id': r.stockItemId })}
          rowClassName={(r) => (r.closingQtyMilli < 0 ? 'text-cr' : '')}
          loading={isLoading}
          empty={{ title: 'No stock items yet', hint: 'Create items under Masters, or straight from a sales/purchase voucher' }}
          onRowActivate={toggle}
          expanded={expanded}
          onExpandedChange={onExpandedChange}
          renderDetail={(r) => <ItemDetail stockItemId={r.stockItemId} asOn={to} decimals={r.decimals} unitSymbol={r.unitSymbol} />}
          detailHeightEstimate={64}
          maxHeight="calc(100vh - 260px)"
          toolbarFeatures={{ groupBy: false }}
          exportOptions={{ title: 'Stock summary', periodLabel, filename: 'stock-summary' }}
        />
      </Panel>
      <StockAnalysis asOn={to} />
    </div>
  )
}

/** Godown- and batch-wise closing for one expanded item (fetched on expand). */
function ItemDetail({
  stockItemId,
  asOn,
  decimals,
  unitSymbol
}: {
  stockItemId: number
  asOn: string
  decimals: number
  unitSymbol: string
}): React.JSX.Element {
  const { data: godowns, isLoading: loadingGodowns } = useQuery({
    queryKey: ['stockByGodown', asOn],
    queryFn: () => api.stock.byGodown(asOn)
  })
  const { data: batches, isLoading: loadingBatches } = useQuery({
    queryKey: ['stockBatches', asOn, stockItemId],
    queryFn: () => api.stock.batches(asOn, stockItemId)
  })
  // Untracked stock lands in a null-godown bucket — showing it as a nameless row reads like a
  // rendering bug, and a breakdown with ONLY that bucket adds nothing over the summary row.
  const godownRows = (godowns ?? []).filter(
    (g) => g.stockItemId === stockItemId && g.closingQtyMilli !== 0 && g.godownId !== null
  )
  const batchRows = (batches ?? []).filter((b) => b.closingQtyMilli !== 0)
  if (loadingGodowns || loadingBatches) return <p className="py-1 text-[12px] text-muted">Loading breakdown…</p>
  if (godownRows.length === 0 && batchRows.length === 0) {
    return <p className="py-1 text-[12px] text-muted">No godown or batch breakdown for this item.</p>
  }
  return (
    <div className="flex flex-wrap gap-8 py-1 text-ink" data-testid="stock-item-detail">
      {godownRows.length > 0 && (
        <div>
          <p className="mb-1 text-[10.5px] font-semibold tracking-[0.08em] text-muted uppercase">By godown</p>
          {godownRows.map((g) => (
            <p key={`${g.godownId}`} className="num text-[12.5px]">
              {g.godownName}: {fmtQty(g.closingQtyMilli, decimals)} {unitSymbol} · <Money paise={g.closingValue} />
            </p>
          ))}
        </div>
      )}
      {batchRows.length > 0 && (
        <div>
          <p className="mb-1 text-[10.5px] font-semibold tracking-[0.08em] text-muted uppercase">By batch</p>
          {batchRows.map((b) => (
            <p key={b.batchId} className="num text-[12.5px]">
              {b.batchName}: {fmtQty(b.closingQtyMilli, decimals)} {unitSymbol}
              {b.expiryDate ? ` · expires ${toDisplayDate(b.expiryDate)}` : ''}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}

/** Stock analysis (v0.3 #58): age of the held quantity, slow movers, reorder breaches. */
function StockAnalysis({ asOn }: { asOn: string }): React.JSX.Element | null {
  const { data } = useQuery({ queryKey: ['stockAgeing', asOn], queryFn: () => api.reports.stockAgeing(asOn) })
  const rows = (data ?? []).filter((r) => r.closingQtyMilli > 0 || r.belowReorder)
  if (rows.length === 0) return null
  return (
    <Panel className="mt-4">
      <p className="mb-2 px-1 text-[13.5px] font-medium">Stock analysis — ageing &amp; reorder</p>
      <DataTable
        viewId="stock-ageing"
        testId="stock-ageing"
        tableTestId="stock-ageing-table"
        ariaLabel="Stock ageing and reorder"
        columns={AGEING_COLUMNS}
        rows={rows}
        rowKey={(r) => r.stockItemId}
        rowAttrs={(r) => ({ 'data-row-id': r.stockItemId })}
        maxHeight="60vh"
        exportOptions={{ title: 'Stock ageing & reorder', periodLabel: `as on ${toDisplayDate(asOn)}`, filename: 'stock-ageing' }}
      />
    </Panel>
  )
}
