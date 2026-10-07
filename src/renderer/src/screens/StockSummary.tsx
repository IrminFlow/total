import { useCallback, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useSession } from '../state/stores'
import { DrawerSection, Money, Page, PageHeader, Panel, SectionTitle } from '../components/ui'
import { OptionToggle, OptionsPeriod, OptionsTable, useScreenOptions } from '../components/ScreenOptions'
import { DataTable, defineColumns, type RowKey } from '../components/table'
import { formatMilli } from '../lib/table'
import { toDisplayDate } from '@shared/dates'
import type { StockAgeingRow, StockSummaryRow } from '@shared/reports'
import { ItemLink, VoucherLink } from '../components/links'

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
        {r.closingQtyMilli < 0 && <span className="ml-2 text-caption">— negative stock, check entries</span>}
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
        {r.belowReorder && <span className="mr-2 text-hint text-cr">reorder</span>}
        {r.slowMoving && <span className="text-hint text-muted">slow-moving</span>}
      </>
    )
  }
])

export function StockSummaryScreen(): React.JSX.Element {
  const { from, to } = useSession()
  const { data, isLoading } = useQuery({ queryKey: ['stockSummary', to], queryFn: () => api.stock.summary(to) })
  const opts = useScreenOptions('stock-summary', { hideZero: false, showAnalysis: true })
  const rows = (data ?? []).filter((r) => !opts.options.hideZero || r.closingQtyMilli !== 0 || r.closingValue !== 0)
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
    <Page>
      <PageHeader
        title="Stock summary"
        period={periodLabel}
        options={{
          onReset: opts.reset,
          content: (
            <>
              <OptionsPeriod asOn />
              <DrawerSection title="Display">
                <OptionToggle
                  label="Hide items with no closing stock"
                  checked={opts.options.hideZero}
                  onChange={(v) => opts.set('hideZero', v)}
                  testId="input-stock-summary-hide-zero"
                />
                <OptionToggle
                  label="Show stock analysis (ageing & reorder)"
                  hint="Godown- and batch-wise closing open from each item's row."
                  checked={opts.options.showAnalysis}
                  onChange={(v) => opts.set('showAnalysis', v)}
                  testId="input-stock-summary-analysis"
                />
              </DrawerSection>
              <OptionsTable area="stock-summary" />
            </>
          )
        }}
      />
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
          renderDetail={(r) => <ItemDetail stockItemId={r.stockItemId} from={from} asOn={to} decimals={r.decimals} unitSymbol={r.unitSymbol} />}
          detailHeightEstimate={160}
          maxHeight="calc(100vh - 260px)"
          toolbarFeatures={{ groupBy: false }}
          exportOptions={{ title: 'Stock summary', periodLabel, filename: 'stock-summary' }}
        />
      </Panel>
      {opts.options.showAnalysis && <StockAnalysis asOn={to} />}
    </Page>
  )
}

/** Godown- and batch-wise closing plus the period's movements for one expanded item (fetched on
 *  expand). The movement list is the minimal read-only register of WP 2.2 — WP 2.3 replaces it
 *  with the full item movement register (rates, running quantity and value). */
function ItemDetail({
  stockItemId,
  from,
  asOn,
  decimals,
  unitSymbol
}: {
  stockItemId: number
  from: string
  asOn: string
  decimals: number
  unitSymbol: string
}): React.JSX.Element {
  const { data: movements, isLoading: loadingMoves } = useQuery({
    queryKey: ['stockMovements', stockItemId, from, asOn],
    queryFn: () => api.stock.movements(stockItemId, from, asOn)
  })
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
  if (loadingGodowns || loadingBatches || loadingMoves) return <p className="py-1 text-small text-muted">Loading breakdown…</p>
  const moves = movements ?? []
  return (
    <div className="flex flex-wrap gap-8 py-1 text-ink" data-testid="stock-item-detail">
      <div className="min-w-[22rem]" data-testid="stock-item-movements">
        <p className="mb-1 text-label font-semibold tracking-[0.08em] text-muted uppercase">Movements this period</p>
        {moves.length === 0 ? (
          <p className="text-small text-muted">No movements between {toDisplayDate(from)} and {toDisplayDate(asOn)}.</p>
        ) : (
          <table className="text-body-sm">
            <tbody>
              {moves.slice(-12).map((m, i) => (
                <tr key={`${m.voucherId}-${i}`} data-testid="stock-movement-row" data-voucher-id={m.voucherId} data-date={m.date}>
                  <td className="num pr-3 text-muted">{toDisplayDate(m.date)}</td>
                  <td className="pr-3">
                    <VoucherLink voucherId={m.voucherId} label={`${m.voucherType} ${m.number}`} />
                  </td>
                  <td className="num pr-3 text-right text-dr" data-testid="stock-movement-in">
                    {m.inQtyMilli ? `${m.isAbsolute ? '= ' : '+'}${fmtQty(m.inQtyMilli, decimals)} ${unitSymbol}` : ''}
                  </td>
                  <td className="num text-right text-cr" data-testid="stock-movement-out">
                    {m.outQtyMilli ? `−${fmtQty(m.outQtyMilli, decimals)} ${unitSymbol}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {moves.length > 12 && <p className="mt-1 text-hint text-muted">Latest 12 of {moves.length} — the full movement register is coming.</p>}
      </div>
      {godownRows.length === 0 && batchRows.length === 0 && (
        <p className="text-small text-muted">No godown or batch breakdown for this item.</p>
      )}
      {godownRows.length > 0 && (
        <div>
          <p className="mb-1 text-label font-semibold tracking-[0.08em] text-muted uppercase">By godown</p>
          {godownRows.map((g) => (
            <p key={`${g.godownId}`} className="num text-body-sm">
              {g.godownName}: {fmtQty(g.closingQtyMilli, decimals)} {unitSymbol} · <Money paise={g.closingValue} />
            </p>
          ))}
        </div>
      )}
      {batchRows.length > 0 && (
        <div>
          <p className="mb-1 text-label font-semibold tracking-[0.08em] text-muted uppercase">By batch</p>
          {batchRows.map((b) => (
            <p key={b.batchId} className="num text-body-sm">
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
    <Panel className="mt-section">
      <div className="px-3 pt-3">
        <SectionTitle as="h3">Stock analysis — ageing &amp; reorder</SectionTitle>
      </div>
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
