import { Fragment, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/client'
import type { LandedCostInputRow, TransferInput } from '../lib/client'
import { useSession, useToasts } from '../state/stores'
import {
  AmountInput, Button, DateInput, EmptyState, Field, Modal, Money, Panel, SectionTitle, Select,
  SkeletonRows, TextInput, useTableNav
} from '../components/ui'
import { ReportConfigButton } from '../components/ReportConfigButton'
import { useReportConfig, type ReportColumn } from '../lib/reportConfig'
import { csvReport, printReport } from '../lib/reportExport'
import type { ReportColumn as PdfColumn, ReportRow as PdfRow } from '../lib/client'
import { toDisplayDate } from '@shared/dates'
import { formatPaise } from '@shared/money'
import { parseQtyWithUnit } from '@shared/units'
import { LANDED_COST_BASES, type LandedCostBasis } from '@shared/landedCost'
import { TabBar } from '../components/TabBar'
import { useStickyTab } from '../lib/useStickyTab'
import { SerialsTab } from './stock/SerialsTab'
import { StandardCostsTab } from './stock/StandardCostsTab'
import { JobWorkTab } from './stock/JobWorkTab'
import { LabelsTab } from './stock/LabelsTab'

type StockTab = 'summary' | 'serials' | 'costing' | 'jobwork' | 'labels'

const STOCK_TABS: { id: StockTab; label: string }[] = [
  { id: 'summary', label: 'Summary' },
  { id: 'serials', label: 'Serials' },
  { id: 'costing', label: 'Standard costing' },
  { id: 'jobwork', label: 'Job work' },
  { id: 'labels', label: 'Labels' }
]

/**
 * A sheet to walk the shelves with.
 *
 * Counted and Difference are blank on purpose — this is printed, carried, and written on. The
 * book quantity is printed beside them so a discrepancy is visible at the shelf rather than an
 * hour later at a desk.
 */
const COUNT_SHEET_COLUMNS: PdfColumn[] = [
  { label: 'Item', align: 'l' },
  { label: 'Unit', align: 'l', width: 60 },
  { label: 'Per books', align: 'r', width: 90 },
  { label: 'Counted', align: 'r', width: 110 },
  { label: 'Difference', align: 'r', width: 110 }
]

function fmtQty(qtyMilli: number, decimals: number): string {
  return (qtyMilli / 1000).toFixed(decimals)
}

const COLUMNS: ReportColumn[] = [
  { key: 'opening', label: 'Opening', defaultOn: true },
  { key: 'inwards', label: 'Inwards', defaultOn: true },
  { key: 'outwards', label: 'Outwards', defaultOn: true },
  { key: 'closingQty', label: 'Closing qty', defaultOn: true },
  { key: 'closingValue', label: 'Closing value', defaultOn: true }
]

function SummaryTab(): React.JSX.Element {
  const { to } = useSession()
  const toast = useToasts()
  const { data, isLoading } = useQuery({ queryKey: ['stockSummary', to], queryFn: () => api.reports.stockSummary(to) })
  const rows = data ?? []
  const { visible, toggle } = useReportConfig('stock-summary', COLUMNS)
  // Expandable item rows (user ask): one item at a time unfolds into its godown- and
  // batch-wise closing position, fetched on demand.
  const [expandedId, setExpandedId] = useState<number | null>(null)
  // Two things that act on stock rather than report it. They live behind buttons here because
  // this is the screen somebody is already on when they notice the reason to do either.
  const [modal, setModal] = useState<'transfer' | 'landed' | null>(null)
  // Enter, Space (A17) and the click all expand the item's godown/batch breakdown, so the
  // keyboard reaches the same detail the mouse does.
  const toggleRow = (r: { stockItemId: number }): void =>
    setExpandedId((cur) => (cur === r.stockItemId ? null : r.stockItemId))
  const nav = useTableNav(rows, {
    rowId: (r) => r.stockItemId,
    onEnter: toggleRow,
    onToggle: toggleRow
  })
  const colCount =
    1 + (visible.opening ? 1 : 0) + (visible.inwards ? 1 : 0) + (visible.outwards ? 1 : 0) +
    (visible.closingQty ? 1 : 0) + (visible.closingValue ? 1 : 0)

  const exportColumns: PdfColumn[] = [
    { label: 'Item', align: 'l' },
    ...(visible.opening ? [{ label: 'Opening', align: 'r' as const }] : []),
    ...(visible.inwards ? [{ label: 'Inwards', align: 'r' as const }] : []),
    ...(visible.outwards ? [{ label: 'Outwards', align: 'r' as const }] : []),
    ...(visible.closingQty ? [{ label: 'Closing qty', align: 'r' as const }] : []),
    ...(visible.closingValue ? [{ label: 'Closing value', align: 'r' as const }] : [])
  ]
  const exportRows: PdfRow[] = [
    ...rows.map((r) => ({
      cells: [
        r.name,
        ...(visible.opening ? [`${fmtQty(r.openingQtyMilli, r.decimals)} ${r.unitSymbol}`] : []),
        ...(visible.inwards ? [`${fmtQty(r.inwardQtyMilli, r.decimals)} ${r.unitSymbol}`] : []),
        ...(visible.outwards ? [`${fmtQty(r.outwardQtyMilli, r.decimals)} ${r.unitSymbol}`] : []),
        ...(visible.closingQty ? [`${fmtQty(r.closingQtyMilli, r.decimals)} ${r.unitSymbol}`] : []),
        ...(visible.closingValue ? [formatPaise(r.closingValue, { zeroDash: true })] : [])
      ]
    })),
    {
      cells: [
        'Total',
        ...(visible.opening ? [''] : []),
        ...(visible.inwards ? [''] : []),
        ...(visible.outwards ? [''] : []),
        ...(visible.closingQty ? [''] : []),
        ...(visible.closingValue ? [formatPaise(rows.reduce((s, r) => s + r.closingValue, 0), { zeroDash: true })] : [])
      ],
      bold: true,
      rule: true
    }
  ]
  const periodLabel = `as on ${toDisplayDate(to)}`

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-end gap-2">
        <span className="num text-small text-muted">as on {toDisplayDate(to)}</span>
        <ReportConfigButton columns={COLUMNS} visible={visible} toggle={toggle} />
        <Button
          variant="ghost"
          data-testid="btn-stock-transfer"
          title="Move stock from one godown to another — no purchase, no sale, no money"
          onClick={() => setModal('transfer')}
        >
          Transfer
        </Button>
        <Button
          variant="ghost"
          data-testid="btn-landed-cost"
          title="Carry freight, insurance and duty on a purchase into the cost of the goods"
          onClick={() => setModal('landed')}
        >
          Landed cost
        </Button>
        <Button
          variant="ghost"
          data-testid="btn-count-sheet"
          title="A printable sheet with blank columns, to walk the shelves with"
          onClick={() =>
            void printReport(
              {
                title: 'Physical stock count sheet',
                periodLabel: `as on ${toDisplayDate(to)}`,
                columns: COUNT_SHEET_COLUMNS,
                // The book quantity is deliberately included. A blind count sounds more
                // rigorous and produces a sheet nobody can check against anything while they
                // are standing at the shelf; the discrepancy column is what gets acted on.
                rows: rows.map((r) => ({
                  cells: [
                    r.name,
                    r.unitSymbol,
                    `${fmtQty(r.closingQtyMilli, r.decimals)}`,
                    '',
                    ''
                  ]
                })),
                filename: `count-sheet-${to}`
              },
              toast
            )
          }
        >
          Count sheet
        </Button>
        <Button
          variant="ghost"
          onClick={() =>
            void printReport({ title: 'Stock summary', periodLabel, columns: exportColumns, rows: exportRows }, toast)
          }
        >
          PDF
        </Button>
        <Button
          variant="ghost"
          onClick={() =>
            void csvReport(exportColumns.map((c) => c.label), exportRows.map((r) => r.cells), 'stock-summary', toast)
          }
        >
          CSV
        </Button>
      </div>
      <Panel>
        {isLoading ? (
          <SkeletonRows />
        ) : rows.length === 0 ? (
          <EmptyState title="No stock items yet" hint="Create items under Masters, or straight from a sales/purchase voucher" />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col">Item</th>
                {visible.opening && <th scope="col" className="r w-32">Opening</th>}
                {visible.inwards && <th scope="col" className="r w-32">Inwards</th>}
                {visible.outwards && <th scope="col" className="r w-32">Outwards</th>}
                {visible.closingQty && <th scope="col" className="r w-32">Closing qty</th>}
                {visible.closingValue && <th scope="col" className="r w-40">Closing value</th>}
              </tr>
            </thead>
            <tbody data-testid="rows-stock-summary">
              {rows.map((r, i) => (
                <Fragment key={r.stockItemId}>
                <tr
                  {...nav.rowProps(i, r)}
                  aria-expanded={expandedId === r.stockItemId}
                  className={`${nav.rowProps(i, r).className} ${r.closingQtyMilli < 0 ? 'text-cr' : ''}`}
                >
                  <td>
                    <span className="mr-1.5 inline-block w-3 text-label text-muted">
                      {expandedId === r.stockItemId ? '▾' : '▸'}
                    </span>
                    {r.name}
                    {r.closingQtyMilli < 0 && <span className="ml-2 text-caption">— negative stock, check entries</span>}
                  </td>
                  {visible.opening && (
                    <td className="r num">
                      {fmtQty(r.openingQtyMilli, r.decimals)} {r.unitSymbol}
                    </td>
                  )}
                  {visible.inwards && (
                    <td className="r num">
                      {fmtQty(r.inwardQtyMilli, r.decimals)} {r.unitSymbol}
                    </td>
                  )}
                  {visible.outwards && (
                    <td className="r num">
                      {fmtQty(r.outwardQtyMilli, r.decimals)} {r.unitSymbol}
                    </td>
                  )}
                  {visible.closingQty && (
                    <td className="r num">
                      {fmtQty(r.closingQtyMilli, r.decimals)} {r.unitSymbol}
                    </td>
                  )}
                  {visible.closingValue && (
                    <td className="r">
                      <Money paise={r.closingValue} />
                    </td>
                  )}
                </tr>
                {expandedId === r.stockItemId && (
                  <tr>
                    <td colSpan={colCount} className="bg-panel2/50">
                      <ItemDetail stockItemId={r.stockItemId} asOn={to} decimals={r.decimals} unitSymbol={r.unitSymbol} />
                    </td>
                  </tr>
                )}
                </Fragment>
              ))}
              <tr className="total-row">
                <td colSpan={1 + (visible.opening ? 1 : 0) + (visible.inwards ? 1 : 0) + (visible.outwards ? 1 : 0) + (visible.closingQty ? 1 : 0)}>
                  Total
                </td>
                {visible.closingValue && (
                  <td className="r">
                    <Money paise={rows.reduce((s, r) => s + r.closingValue, 0)} />
                  </td>
                )}
              </tr>
            </tbody>
          </table>
        )}
      </Panel>
      <NearExpiry asOn={to} />
      <PurchaseSuggestions asOn={to} />
      <ReorderAlerts asOn={to} />
      <StockAnalysis asOn={to} />
      {modal === 'transfer' && <TransferModal asOn={to} onClose={() => setModal(null)} />}
      {modal === 'landed' && <LandedCostModal asOn={to} onClose={() => setModal(null)} />}
    </>
  )
}

/**
 * The inventory screen, and the five things that hang off it.
 *
 * Tabs rather than five more sidebar entries: every letter A-Z is already an accelerator (see
 * `__tests__/accel.test.ts`), and more to the point these are all the same subject — a person
 * printing shelf labels, chasing a job worker or looking up a serial is doing stock work and
 * expects to find it where stock is. The tab is remembered across sessions, which is roadmap
 * A #10's rule applied here.
 */
export function StockSummaryScreen(): React.JSX.Element {
  const [tab, setTab] = useStickyTab<StockTab>('stock-summary', STOCK_TABS.map((t) => t.id), 'summary')
  return (
    <div className="flex h-full min-h-0 w-full flex-col max-w-[1440px]">
      <SectionTitle
        right={<TabBar screen="stock-summary" tabs={STOCK_TABS} active={tab} onSelect={setTab} />}
      >
        Stock
      </SectionTitle>
      {tab === 'summary' && <SummaryTab />}
      {tab === 'serials' && <SerialsTab />}
      {tab === 'costing' && <StandardCostsTab />}
      {tab === 'jobwork' && <JobWorkTab />}
      {tab === 'labels' && <LabelsTab />}
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
  if (loadingGodowns || loadingBatches) return <p className="px-6 py-2 text-small text-muted">Loading breakdown…</p>
  if (godownRows.length === 0 && batchRows.length === 0) {
    return <p className="px-6 py-2 text-small text-muted">No godown or batch breakdown for this item.</p>
  }
  return (
    <div className="flex flex-wrap gap-8 px-6 py-2" data-testid="stock-item-detail">
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
    <Panel className="mt-4">
      <p className="mb-2 px-1 text-body font-medium">Stock analysis — ageing &amp; reorder</p>
      <table className="ledger-table" data-testid="stock-ageing-table">
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col" className="r w-24">0–30 d</th>
            <th scope="col" className="r w-24">31–60 d</th>
            <th scope="col" className="r w-24">61–90 d</th>
            <th scope="col" className="r w-24">90+ d</th>
            <th scope="col" className="w-44">Flags</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.stockItemId}>
              <td>{r.name}</td>
              {r.buckets.map((b, i) => (
                <td key={i} className="r num">
                  {b === 0 ? '–' : `${fmtQty(b, r.decimals)} ${r.unitSymbol}`}
                </td>
              ))}
              <td>
                {r.belowReorder && <span className="mr-2 text-hint text-cr">reorder</span>}
                {r.slowMoving && <span className="text-hint text-muted">slow-moving</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  )
}

/**
 * What to buy, from whom, and roughly for how much.
 *
 * The analysis panel below already flags an item below its reorder level, and a flag is not an
 * action. This is the action: the shortfall, the last supplier and the last price, so the next
 * step is a phone call rather than three more screens.
 *
 * Renders nothing when nothing is below its level — a permanently visible empty panel teaches
 * people to stop looking at it.
 */
function PurchaseSuggestions({ asOn }: { asOn: string }): React.JSX.Element | null {
  const toast = useToasts()
  const { data } = useQuery({
    queryKey: ['purchaseSuggestions', asOn],
    queryFn: () => api.reports.purchaseSuggestions(asOn)
  })
  const rows = data ?? []
  if (rows.length === 0) return null

  const known = rows.filter((r) => r.estimatedCost != null)
  const total = known.reduce((s, r) => s + (r.estimatedCost ?? 0), 0)

  const columns: PdfColumn[] = [
    { label: 'Item', align: 'l' },
    { label: 'In stock', align: 'r' },
    { label: 'Reorder at', align: 'r' },
    { label: 'Buy', align: 'r' },
    { label: 'Last supplier', align: 'l' },
    { label: 'Last rate', align: 'r' },
    { label: 'Estimated', align: 'r' }
  ]
  const exportRows: PdfRow[] = rows.map((r) => ({
    cells: [
      r.name,
      `${fmtQty(r.closingQtyMilli, r.decimals)} ${r.unitSymbol}`,
      `${fmtQty(r.reorderLevelMilli, r.decimals)} ${r.unitSymbol}`,
      `${fmtQty(r.shortfallQtyMilli, r.decimals)} ${r.unitSymbol}`,
      r.lastSupplier ?? 'never bought',
      r.lastRatePaise == null ? '–' : formatPaise(r.lastRatePaise),
      r.estimatedCost == null ? '–' : formatPaise(r.estimatedCost)
    ]
  }))

  return (
    <Panel className="mt-4">
      <div className="mb-2 flex items-baseline justify-between px-1">
        <p className="text-body font-medium">
          To buy — {rows.length} item{rows.length === 1 ? '' : 's'} below reorder level
        </p>
        <span className="flex items-center gap-2">
          {total > 0 && (
            <span className="text-hint text-muted">
              about <Money paise={total} /> at last prices
            </span>
          )}
          <Button
            variant="ghost"
            onClick={() =>
              void printReport(
                {
                  title: 'Purchase suggestions',
                  periodLabel: `as on ${toDisplayDate(asOn)}`,
                  columns,
                  rows: exportRows,
                  filename: 'purchase-suggestions'
                },
                toast
              )
            }
          >
            PDF
          </Button>
        </span>
      </div>
      <table className="ledger-table" data-testid="rows-purchase-suggestions">
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col" className="r w-28">In stock</th>
            <th scope="col" className="r w-28">Reorder at</th>
            <th scope="col" className="r w-28">Buy</th>
            <th scope="col">Last supplier</th>
            <th scope="col" className="r w-28">Last rate</th>
            <th scope="col" className="r w-32">Estimated</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.stockItemId}>
              <td>{r.name}</td>
              <td className="r num">{fmtQty(r.closingQtyMilli, r.decimals)} {r.unitSymbol}</td>
              <td className="r num text-muted">{fmtQty(r.reorderLevelMilli, r.decimals)} {r.unitSymbol}</td>
              <td className="r num font-semibold">{fmtQty(r.shortfallQtyMilli, r.decimals)} {r.unitSymbol}</td>
              <td className={r.lastSupplier ? '' : 'text-muted'}>
                {r.lastSupplier ?? 'never bought'}
                {r.lastPurchaseDate && (
                  <span className="ml-2 num text-hint text-muted">{toDisplayDate(r.lastPurchaseDate)}</span>
                )}
              </td>
              <td className="r">
                {r.lastRatePaise == null ? <span className="text-muted">–</span> : <Money paise={r.lastRatePaise} />}
              </td>
              <td className="r">
                {r.estimatedCost == null ? <span className="text-muted">–</span> : <Money paise={r.estimatedCost} />}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 px-1 text-hint text-muted">
        Estimated at the last price paid, which is a starting point rather than a quote. Items
        never bought before show no estimate rather than a guessed one.
      </p>
    </Panel>
  )
}


const BUCKET_CLASS: Record<string, string> = {
  expired: 'text-cr font-semibold',
  within30: 'text-cr',
  within90: 'text-ink',
  later: 'text-muted',
  none: 'text-muted'
}

/**
 * What is about to become worthless (roadmap #114, #116).
 *
 * Sorted by how soon each batch dies, not by how much it is worth — the expensive batch with a
 * year on it is not the problem. Value is the batch's remaining stock at the item's own
 * valuation, so it agrees with the closing stock on the balance sheet rather than being a second
 * opinion about it.
 *
 * Renders nothing when no batch carries an expiry date and none is at risk, because a permanently
 * empty panel on a screen people open daily is a panel they learn to scroll past.
 */
function NearExpiry({ asOn }: { asOn: string }): React.JSX.Element | null {
  const toast = useToasts()
  const [showAll, setShowAll] = useState(false)
  const { data } = useQuery({ queryKey: ['nearExpiry', asOn], queryFn: () => api.stock.nearExpiry(asOn) })
  if (!data || (data.rows.length === 0 && data.undatedBatches === 0)) return null

  const atRisk = data.rows.filter((r) => r.bucket !== 'later')
  const shown = showAll ? data.rows : atRisk
  if (shown.length === 0 && data.undatedBatches === 0) return null

  const columns: PdfColumn[] = [
    { label: 'Item', align: 'l' },
    { label: 'Batch', align: 'l' },
    { label: 'Expires', align: 'l' },
    { label: 'Days', align: 'r' },
    { label: 'Quantity', align: 'r' },
    { label: 'Value', align: 'r' }
  ]
  const exportRows: PdfRow[] = shown.map((r) => ({
    cells: [
      r.itemName,
      r.batchName,
      r.expiryDate ? toDisplayDate(r.expiryDate) : '–',
      String(r.daysToExpiry),
      `${fmtQty(r.closingQtyMilli, r.decimals)} ${r.unitSymbol}`,
      formatPaise(r.value)
    ]
  }))

  return (
    <Panel className="mt-4">
      <div className="mb-2 flex items-baseline justify-between px-1">
        <p className="text-body font-medium">
          Shelf life — <Money paise={data.atRisk} /> expiring within 90 days
          {data.expired > 0 && (
            <span className="text-cr"> · <Money paise={data.expired} /> already expired</span>
          )}
        </p>
        <span className="flex items-center gap-2">
          <Button variant="ghost" data-testid="btn-expiry-show-all" onClick={() => setShowAll(!showAll)}>
            {showAll ? 'At risk only' : `All ${data.rows.length} batches`}
          </Button>
          <Button
            variant="ghost"
            disabled={!shown.length}
            onClick={() =>
              void printReport(
                {
                  title: 'Shelf life',
                  periodLabel: `as on ${toDisplayDate(asOn)}`,
                  columns,
                  rows: exportRows,
                  footNote: 'Value is each batch at the item\u2019s own valuation, so it foots to closing stock.',
                  filename: 'shelf-life'
                },
                toast
              )
            }
          >
            PDF
          </Button>
        </span>
      </div>

      <div className="mb-2 flex flex-wrap gap-4 px-1 text-hint text-muted">
        {data.summary
          .filter((b) => b.batches > 0)
          .map((b) => (
            <span key={b.bucket}>
              {b.label}: <Money paise={b.value} /> <span className="num">({b.batches})</span>
            </span>
          ))}
      </div>

      {shown.length > 0 && (
        <table className="ledger-table" data-testid="rows-near-expiry">
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col" className="w-40">Batch</th>
              <th scope="col" className="w-28">Expires</th>
              <th scope="col" className="r w-24">Days</th>
              <th scope="col" className="r w-32">Quantity</th>
              <th scope="col" className="r w-36">Value</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.batchId}>
                <td>{r.itemName}</td>
                <td className="num text-muted">{r.batchName}</td>
                <td className="num">{r.expiryDate ? toDisplayDate(r.expiryDate) : '–'}</td>
                <td className={`r num ${BUCKET_CLASS[r.bucket]}`}>
                  {r.daysToExpiry < 0 ? `${-r.daysToExpiry}d ago` : `${r.daysToExpiry}d`}
                </td>
                <td className="r num">
                  {fmtQty(r.closingQtyMilli, r.decimals)} {r.unitSymbol}
                </td>
                <td className="r"><Money paise={r.value} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {data.undatedBatches > 0 && (
        <p className="mt-2 px-1 text-hint text-muted" data-testid="expiry-undated">
          {data.undatedBatches} batch{data.undatedBatches === 1 ? '' : 'es'} hold stock with no
          expiry date recorded. That is a gap in the data rather than a clean bill of health.
        </p>
      )}
    </Panel>
  )
}


/**
 * Reorder alerts, addressed to somebody (roadmap #121).
 *
 * The panel above says what to buy; this says who to ask, and hands over the message already
 * written. Nothing is ever sent from here — WhatsApp or the mail client opens with the text in
 * it and a person presses send, which is the only version of this a small business trusts.
 *
 * Grouped by supplier because the message is the unit of work: five items from one supplier is
 * one enquiry, not five.
 */
function ReorderAlerts({ asOn }: { asOn: string }): React.JSX.Element | null {
  const toast = useToasts()
  const [open, setOpen] = useState<number | null>(null)
  const { data } = useQuery({ queryKey: ['reorderAlerts', asOn], queryFn: () => api.stock.reorderAlerts(asOn) })
  if (!data || (data.messages.length === 0 && data.unsourced.length === 0)) return null

  const send = async (channel: 'whatsapp' | 'email', supplierId: number): Promise<void> => {
    const message = data.messages.find((m) => m.supplierLedgerId === supplierId)
    if (!message) return
    try {
      await navigator.clipboard.writeText(message.body)
    } catch {
      // Clipboard access can fail in a sandbox; the draft still carries the whole text.
    }
    if (channel === 'whatsapp' && message.whatsapp) {
      window.open(message.whatsapp)
      toast.push('success', `WhatsApp opened for ${message.supplierName}`)
      return
    }
    window.open(message.mailto)
    toast.push('success', `Email draft opened for ${message.supplierName}`)
  }

  return (
    <Panel className="mt-4">
      <p className="mb-2 px-1 text-body font-medium">
        Reorder alerts — {data.messages.length} supplier{data.messages.length === 1 ? '' : 's'} to ask
      </p>
      <table className="ledger-table" data-testid="rows-reorder-alerts">
        <thead>
          <tr>
            <th scope="col">Supplier</th>
            <th scope="col" className="r w-24">Items</th>
            <th scope="col" className="r w-36">About</th>
            <th scope="col" className="w-64">Message</th>
          </tr>
        </thead>
        <tbody>
          {data.messages.map((m) => (
            <Fragment key={m.supplierLedgerId}>
              <tr>
                <td>{m.supplierName}</td>
                <td className="r num">{m.items.length}</td>
                <td className="r">
                  {m.estimatedTotal > 0 ? <Money paise={m.estimatedTotal} /> : <span className="text-muted">–</span>}
                </td>
                <td>
                  <span className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      disabled={!m.whatsapp}
                      disabledTitle="No number WhatsApp can use — add one on the ledger in Masters"
                      onClick={() => void send('whatsapp', m.supplierLedgerId)}
                    >
                      WhatsApp
                    </Button>
                    <Button variant="ghost" onClick={() => void send('email', m.supplierLedgerId)}>
                      Email
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => setOpen((cur) => (cur === m.supplierLedgerId ? null : m.supplierLedgerId))}
                    >
                      {open === m.supplierLedgerId ? 'Hide' : 'Preview'}
                    </Button>
                  </span>
                </td>
              </tr>
              {open === m.supplierLedgerId && (
                <tr>
                  <td colSpan={4} className="bg-panel2/50">
                    <pre className="px-6 py-2 text-body-sm whitespace-pre-wrap" data-testid="reorder-preview">
                      {m.body}
                    </pre>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
      {data.unsourced.length > 0 && (
        <p className="mt-2 px-1 text-hint text-muted" data-testid="reorder-unsourced">
          {data.unsourced.map((r) => r.name).join(', ')} — below the reorder level with no supplier on
          record. Nobody to ask is a different answer from nothing to order.
        </p>
      )}
    </Panel>
  )
}

interface TransferRow {
  stockItemId: number | null
  qty: string
}

/**
 * Move stock between godowns (roadmap #112).
 *
 * The item list is the source godown's own stock rather than every item in the company, so the
 * form cannot offer a move it will then refuse. The preview underneath is the real plan from the
 * service, which means the refusal a user sees while typing is exactly the one save would give.
 */
function TransferModal({ asOn, onClose }: { asOn: string; onClose: () => void }): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { from } = useSession()
  const [date, setDate] = useState(asOn)
  const [fromGodownId, setFromGodownId] = useState<number | null>(null)
  const [toGodownId, setToGodownId] = useState<number | null>(null)
  const [rows, setRows] = useState<TransferRow[]>([{ stockItemId: null, qty: '' }])
  const [narration, setNarration] = useState('')

  const { data: godowns } = useQuery({ queryKey: ['godowns'], queryFn: api.godowns.list })
  const { data: available } = useQuery({
    queryKey: ['godownStock', date, fromGodownId],
    queryFn: () => api.stock.godownStock(date, fromGodownId as number),
    enabled: fromGodownId != null
  })
  const stock = available ?? []

  const items = useMemo(
    () =>
      rows.flatMap((r) => {
        const item = stock.find((s) => s.stockItemId === r.stockItemId)
        if (!item) return []
        const parsed = parseQtyWithUnit(r.qty, item.unitSymbol, null)
        return parsed ? [{ stockItemId: item.stockItemId, qtyMilli: parsed.baseQtyMilli }] : []
      }),
    [rows, stock]
  )

  const input: TransferInput = {
    date,
    fromGodownId: fromGodownId ?? 0,
    toGodownId: toGodownId ?? 0,
    items,
    narration: narration.trim() || null
  }
  const ready = fromGodownId != null && toGodownId != null && items.length > 0
  const { data: plan } = useQuery({
    queryKey: ['stockTransferPreview', input],
    queryFn: () => api.stock.previewTransfer(input),
    enabled: ready
  })

  const save = useMutation({
    mutationFn: () => api.stock.saveTransfer(input),
    onSuccess: async (result) => {
      toast.push('success', `Transfer ${result.number} recorded — ${result.lineCount} item(s) moved`)
      await queryClient.invalidateQueries()
      onClose()
    },
    onError: (e: Error) => toast.push('error', e.message)
  })

  const godownOptions = (exclude: number | null): React.JSX.Element[] =>
    (godowns ?? [])
      .filter((g) => g.id !== exclude)
      .map((g) => (
        <option key={g.id} value={g.id}>
          {g.name}
        </option>
      ))

  return (
    <Modal title="Transfer stock between godowns" onClose={onClose} wide dirty={items.length > 0}>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Date">
          <DateInput value={date} context="transfer" onChange={setDate} />
        </Field>
        <Field label="From godown">
          <Select
            data-testid="select-transfer-from"
            value={fromGodownId ?? ''}
            onChange={(e) => {
              setFromGodownId(e.target.value ? Number(e.target.value) : null)
              // The item list belongs to the source godown; keeping old rows would offer stock
              // the new source does not have.
              setRows([{ stockItemId: null, qty: '' }])
            }}
          >
            <option value="">Pick a godown</option>
            {godownOptions(toGodownId)}
          </Select>
        </Field>
        <Field label="To godown">
          <Select
            data-testid="select-transfer-to"
            value={toGodownId ?? ''}
            onChange={(e) => setToGodownId(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">Pick a godown</option>
            {godownOptions(fromGodownId)}
          </Select>
        </Field>
      </div>

      <table className="ledger-table mt-3">
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col" className="r w-40">In this godown</th>
            <th scope="col" className="r w-40">Move</th>
            <th scope="col" className="w-16" />
          </tr>
        </thead>
        <tbody data-testid="rows-transfer">
          {rows.map((r, i) => {
            const item = stock.find((s) => s.stockItemId === r.stockItemId)
            return (
              <tr key={i}>
                <td>
                  <Select
                    data-testid={`select-transfer-item-${i}`}
                    value={r.stockItemId ?? ''}
                    disabled={fromGodownId == null}
                    onChange={(e) =>
                      setRows((cur) =>
                        cur.map((row, j) =>
                          j === i ? { ...row, stockItemId: e.target.value ? Number(e.target.value) : null } : row
                        )
                      )
                    }
                  >
                    <option value="">{fromGodownId == null ? 'Pick the source godown first' : 'Pick an item'}</option>
                    {stock.map((s) => (
                      <option key={s.stockItemId} value={s.stockItemId}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                </td>
                <td className="r num text-muted">
                  {item ? `${fmtQty(item.availableQtyMilli, item.decimals)} ${item.unitSymbol}` : '–'}
                </td>
                <td className="r">
                  <TextInput
                    data-testid={`input-transfer-qty-${i}`}
                    className="num text-right"
                    value={r.qty}
                    placeholder={item?.unitSymbol ?? ''}
                    onChange={(e) =>
                      setRows((cur) => cur.map((row, j) => (j === i ? { ...row, qty: e.target.value } : row)))
                    }
                  />
                </td>
                <td>
                  <Button
                    variant="ghost"
                    disabled={rows.length === 1}
                    onClick={() => setRows((cur) => cur.filter((_, j) => j !== i))}
                  >
                    ✕
                  </Button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <Button variant="ghost" onClick={() => setRows((cur) => [...cur, { stockItemId: null, qty: '' }])}>
        + Add item
      </Button>

      <div className="mt-3">
        <Field label="Narration" hint="Left blank, the voucher says where the stock went">
          <TextInput value={narration} onChange={(e) => setNarration(e.target.value)} />
        </Field>
      </div>

      {plan && plan.errors.length > 0 && (
        <ul className="mt-3 text-body-sm text-cr" data-testid="transfer-errors">
          {plan.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      {plan && plan.errors.length === 0 && (
        <p className="mt-3 text-body-sm text-muted" data-testid="transfer-preview">
          Moves <Money paise={plan.totalValue} /> of stock between godowns. Company-wide stock is
          unchanged — nothing is bought or sold, so nothing is posted to the books.
        </p>
      )}

      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          data-testid="btn-transfer-save"
          disabled={!ready || !plan || plan.errors.length > 0 || save.isPending}
          onClick={() => save.mutate()}
        >
          Record transfer
        </Button>
      </div>
      <p className="mt-2 text-hint text-muted">
        Recent transfers: <RecentTransfers from={from} to={asOn} />
      </p>
    </Modal>
  )
}

/** A one-line memory of what was moved lately, so a double entry is obvious before it is made. */
function RecentTransfers({ from, to }: { from: string; to: string }): React.JSX.Element {
  const { data } = useQuery({ queryKey: ['stockTransfers', from, to], queryFn: () => api.stock.transfers(from, to) })
  const rows = (data ?? []).slice(0, 3)
  if (rows.length === 0) return <span>none in this period.</span>
  return (
    <span data-testid="recent-transfers">
      {rows.map((r) => `${toDisplayDate(r.date)} ${r.fromGodown} → ${r.toGodown} (${r.items})`).join(' · ')}
    </span>
  )
}

interface CostDraft {
  ledgerId: number | null
  label: string
  amount: number | null
  basis: LandedCostBasis
}

/**
 * Landed cost on a purchase (roadmap #117).
 *
 * A charge may only be picked from the debits already on that purchase, so the screen cannot be
 * used to invent cost: what is being decided here is where money that was definitely spent
 * belongs, not how much of it there was. The table underneath shows the rate the goods really
 * cost once the charge is carried in, which is the number a price is set from.
 */
function LandedCostModal({ asOn, onClose }: { asOn: string; onClose: () => void }): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { from } = useSession()
  const [voucherId, setVoucherId] = useState<number | null>(null)
  const [drafts, setDrafts] = useState<CostDraft[]>([])

  const { data: purchases } = useQuery({
    queryKey: ['costablePurchases', from, asOn],
    queryFn: () => api.stock.costablePurchases(from, asOn)
  })
  const { data: view } = useQuery({
    queryKey: ['landedCosts', voucherId],
    queryFn: () => api.stock.landedCosts(voucherId as number),
    enabled: voucherId != null
  })

  const pick = (id: number | null): void => {
    setVoucherId(id)
    setDrafts([])
  }

  // Once a purchase is loaded its saved costs become the editable draft, so "save" always means
  // "this is the whole list" rather than "add these as well".
  const rows: CostDraft[] =
    drafts.length > 0 || view == null
      ? drafts
      : view.costs.map((c) => ({ ledgerId: c.ledgerId, label: c.label, amount: c.amount, basis: c.basis }))

  const save = useMutation({
    mutationFn: () => {
      const costs: LandedCostInputRow[] = rows
        .filter((r): r is CostDraft & { ledgerId: number; amount: number } => r.ledgerId != null && !!r.amount)
        .map((r) => ({ ledgerId: r.ledgerId, label: r.label.trim() || 'Landed cost', amount: r.amount, basis: r.basis }))
      return api.stock.saveLandedCosts(voucherId as number, costs)
    },
    onSuccess: async () => {
      toast.push('success', 'Landed cost carried into the value of the goods')
      setDrafts([])
      await queryClient.invalidateQueries()
    },
    onError: (e: Error) => toast.push('error', e.message)
  })

  const setRow = (i: number, patch: Partial<CostDraft>): void =>
    setDrafts(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  return (
    <Modal title="Landed cost on a purchase" onClose={onClose} wide>
      <Field label="Purchase" hint="Freight, insurance, duty and clearing already debited on this voucher">
        <Select
          data-testid="select-landed-voucher"
          value={voucherId ?? ''}
          onChange={(e) => pick(e.target.value ? Number(e.target.value) : null)}
        >
          <option value="">Pick a purchase</option>
          {(purchases ?? []).map((p) => (
            <option key={p.voucherId} value={p.voucherId}>
              {toDisplayDate(p.date)} · {p.number} · {p.partyName ?? 'no party'} ·{' '}
              {formatPaise(p.goodsValue)}
              {p.landed > 0 ? ` (+${formatPaise(p.landed)} loaded)` : ''}
            </option>
          ))}
        </Select>
      </Field>

      {view && (
        <>
          <table className="ledger-table mt-3">
            <thead>
              <tr>
                <th scope="col">Charge</th>
                <th scope="col">Ledger on this voucher</th>
                <th scope="col" className="w-40">Spread</th>
                <th scope="col" className="r w-36">Amount</th>
                <th scope="col" className="w-16" />
              </tr>
            </thead>
            <tbody data-testid="rows-landed-cost">
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>
                    <TextInput
                      value={r.label}
                      placeholder="Freight inward"
                      onChange={(e) => setRow(i, { label: e.target.value })}
                    />
                  </td>
                  <td>
                    <Select
                      data-testid={`select-landed-ledger-${i}`}
                      value={r.ledgerId ?? ''}
                      onChange={(e) => setRow(i, { ledgerId: e.target.value ? Number(e.target.value) : null })}
                    >
                      <option value="">Pick a debit on this voucher</option>
                      {view.candidates.map((c) => (
                        <option key={c.ledgerId} value={c.ledgerId}>
                          {c.ledgerName} · {formatPaise(c.amount)}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td>
                    <Select
                      value={r.basis}
                      onChange={(e) => setRow(i, { basis: e.target.value as LandedCostBasis })}
                    >
                      {LANDED_COST_BASES.map((b) => (
                        <option key={b.basis} value={b.basis} title={b.hint}>
                          {b.label}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td className="r">
                    <AmountInput
                      testId={`input-landed-amount-${i}`}
                      paise={r.amount}
                      onPaise={(paise) => setRow(i, { amount: paise })}
                    />
                  </td>
                  <td>
                    <Button variant="ghost" onClick={() => setDrafts(rows.filter((_, j) => j !== i))}>
                      ✕
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Button
            variant="ghost"
            data-testid="btn-landed-add"
            onClick={() => setDrafts([...rows, { ledgerId: null, label: '', amount: null, basis: 'value' }])}
          >
            + Add charge
          </Button>

          <p className="mt-4 mb-1 px-1 text-label font-semibold tracking-[0.08em] text-muted uppercase">
            What the goods cost once it is carried in
          </p>
          <table className="ledger-table" data-testid="rows-landed-effect">
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col" className="r w-32">Quantity</th>
                <th scope="col" className="r w-36">Billed</th>
                <th scope="col" className="r w-32">Loaded</th>
                <th scope="col" className="r w-36">Effective rate</th>
              </tr>
            </thead>
            <tbody>
              {view.lines.map((l) => (
                <tr key={l.inventoryLineId}>
                  <td>{l.name}</td>
                  <td className="r num">
                    {fmtQty(l.qtyMilli, l.decimals)} {l.unitSymbol}
                  </td>
                  <td className="r"><Money paise={l.amount} /></td>
                  <td className="r"><Money paise={l.extra} /></td>
                  <td className="r">
                    <Money paise={l.effectiveRatePaise} />
                    {l.extra > 0 && (
                      <span className="ml-2 text-hint text-muted">was {formatPaise(l.ratePaise)}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {view.unallocated > 0 && (
            <p className="mt-2 px-1 text-hint text-cr">
              {formatPaise(view.unallocated)} could not be carried anywhere — this purchase has no
              item lines to put it on.
            </p>
          )}
        </>
      )}

      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
        <Button
          variant="primary"
          data-testid="btn-landed-save"
          disabled={voucherId == null || save.isPending}
          onClick={() => save.mutate()}
        >
          Save allocation
        </Button>
      </div>
      <p className="mt-2 text-hint text-muted">
        The charge stays on the voucher exactly as the supplier billed it. Only the valuation sees
        the loaded cost, so the purchase register, the GST return and the party ledger still agree
        with the bill.
      </p>
    </Modal>
  )
}
