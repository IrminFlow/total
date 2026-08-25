import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useNav, useSession, useToasts } from '../state/stores'
import {
  Button,
  EmptyState,
  InteractiveReportRow,
  Money,
  Panel,
  QueryErrorState,
  SectionTitle,
  SkeletonRows,
} from '../components/ui'
import { TabBar } from '../components/TabBar'
import { ReportToolbar } from '../components/ReportToolbar'
import { SavedReportViews } from '../components/SavedReportViews'
import { useSavedReportViews } from '../lib/reportConfig'
import { csvReport, printReport } from '../lib/reportExport'
import type {
  ReportColumn as PdfColumn,
  ReportRow as PdfRow,
} from '../lib/client'
import { toDisplayDate } from '@shared/dates'
import { formatPaise } from '@shared/money'
import type { RegisterGranularity } from '@shared/reports'

const EXPORT_COLUMNS: PdfColumn[] = [
  { label: 'Period', align: 'l' },
  { label: 'Vouchers', align: 'r' },
  { label: 'Taxable value', align: 'r' },
  { label: 'GST', align: 'r' },
  { label: 'Invoice total', align: 'r' },
]

const ITEM_COLUMNS: PdfColumn[] = [
  { label: 'Item', align: 'l' },
  { label: 'Qty sold', align: 'r' },
  { label: 'Sales', align: 'r' },
  { label: 'COGS', align: 'r' },
  { label: 'Profit', align: 'r' },
  { label: 'Margin', align: 'r' },
]

function fmtQty(qtyMilli: number, decimals: number): string {
  return (qtyMilli / 1000).toFixed(decimals)
}

type Tab = 'sales' | 'purchase' | 'items'

interface RegisterView {
  tab: Tab
  granularity: RegisterGranularity
  from: string
  to: string
}

const TAB_LABELS: Record<Tab, string> = {
  sales: 'Sales',
  purchase: 'Purchase',
  items: 'Item profit',
}

export function RegistersScreen(): React.JSX.Element {
  const { from, to, setPeriod } = useSession()
  const toast = useToasts()
  const [tab, setTab] = useState<Tab>('sales')
  const [granularity, setGranularity] = useState<RegisterGranularity>('month')
  const savedViews = useSavedReportViews<RegisterView>('registers')
  const [busy, setBusy] = useState<'caPack' | 'tallyXml' | null>(null)
  const kind = tab === 'items' ? 'sales' : tab
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['register', kind, from, to, granularity],
    queryFn: () => api.analysis.register({ kind, from, to, granularity }),
    enabled: tab !== 'items',
  })
  const rows = data ?? []

  const periodLabel = `${toDisplayDate(from)} → ${toDisplayDate(to)}`
  const exportRows: PdfRow[] = [
    ...rows.map((r) => ({
      cells: [
        r.label,
        String(r.vouchers),
        formatPaise(r.taxable, { zeroDash: true }),
        formatPaise(r.tax, { zeroDash: true }),
        formatPaise(r.total, { zeroDash: true }),
      ],
    })),
    {
      cells: [
        'Total',
        String(rows.reduce((s, r) => s + r.vouchers, 0)),
        formatPaise(
          rows.reduce((s, r) => s + r.taxable, 0),
          { zeroDash: true },
        ),
        formatPaise(
          rows.reduce((s, r) => s + r.tax, 0),
          { zeroDash: true },
        ),
        formatPaise(
          rows.reduce((s, r) => s + r.total, 0),
          { zeroDash: true },
        ),
      ],
      bold: true,
      rule: true,
    },
  ]

  const runExport = async (which: 'caPack' | 'tallyXml'): Promise<void> => {
    setBusy(which)
    try {
      const r =
        which === 'caPack'
          ? await api.exporter.caPack(from, to)
          : await api.exporter.tallyXml(from, to)
      toast.push('success', `Saved to ${r.path}`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const title =
    tab === 'items'
      ? 'Item profitability'
      : tab === 'sales'
        ? 'Sales register'
        : 'Purchase register'

  return (
    <div className="mx-auto max-w-4xl">
      <SectionTitle>{title}</SectionTitle>
      <ReportToolbar className="mb-3">
        <TabBar
          screen="registers"
          tabs={(['sales', 'purchase', 'items'] as const).map((k) => ({
            id: k,
            label: TAB_LABELS[k],
          }))}
          active={tab}
          onSelect={setTab}
        />
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
          {tab !== 'items' && (
            <div
              className="flex items-center gap-2"
              aria-label="Register grouping"
            >
              <span className="text-small font-medium text-muted">
                Group by
              </span>
              <TabBar
                screen="register-granularity"
                tabs={[
                  { id: 'month', label: 'Month' },
                  { id: 'quarter', label: 'Quarter' },
                ]}
                active={granularity}
                onSelect={(id) => setGranularity(id as RegisterGranularity)}
              />
            </div>
          )}
          <SavedReportViews
            views={savedViews.views}
            current={{ tab, granularity, from, to }}
            onSave={savedViews.save}
            onRemove={savedViews.remove}
            onApply={(view) => {
              setTab(view.tab)
              setGranularity(view.granularity)
              setPeriod(view.from, view.to)
            }}
          />
          <details className="relative shrink-0">
            <summary className="flex min-h-8 cursor-pointer list-none items-center rounded-md border border-line bg-panel px-3 py-1.5 text-detail font-medium text-ink panel-shadow hover:border-amber/60">
              Export
            </summary>
            <div
              role="menu"
              className="absolute right-0 z-20 mt-1 min-w-44 overflow-hidden rounded-lg border border-line bg-panel py-1 panel-shadow"
            >
              {tab !== 'items' && (
                <>
                  <button
                    role="menuitem"
                    className="block min-h-8 w-full px-3 py-1.5 text-left text-detail hover:bg-panel2"
                    onClick={(event) => {
                      event.currentTarget
                        .closest('details')
                        ?.removeAttribute('open')
                      void printReport(
                        {
                          title,
                          periodLabel,
                          columns: EXPORT_COLUMNS,
                          rows: exportRows,
                        },
                        toast,
                      )
                    }}
                  >
                    PDF report
                  </button>
                  <button
                    role="menuitem"
                    className="block min-h-8 w-full px-3 py-1.5 text-left text-detail hover:bg-panel2"
                    onClick={(event) => {
                      event.currentTarget
                        .closest('details')
                        ?.removeAttribute('open')
                      void csvReport(
                        EXPORT_COLUMNS.map((c) => c.label),
                        exportRows.map((r) => r.cells),
                        `${kind}-register-${granularity}`,
                        toast,
                      )
                    }}
                  >
                    CSV data
                  </button>
                </>
              )}
              <button
                role="menuitem"
                disabled={busy !== null}
                className="block min-h-8 w-full px-3 py-1.5 text-left text-detail hover:bg-panel2 disabled:opacity-40"
                onClick={(event) => {
                  event.currentTarget
                    .closest('details')
                    ?.removeAttribute('open')
                  void runExport('tallyXml')
                }}
              >
                Tally XML
              </button>
              <button
                role="menuitem"
                data-testid="btn-registers-ca-pack"
                disabled={busy !== null}
                className="block min-h-8 w-full px-3 py-1.5 text-left text-detail font-medium text-amber hover:bg-panel2 disabled:opacity-40"
                onClick={(event) => {
                  event.currentTarget
                    .closest('details')
                    ?.removeAttribute('open')
                  void runExport('caPack')
                }}
              >
                CA pack
              </button>
            </div>
          </details>
        </div>
      </ReportToolbar>
      {tab === 'items' ? (
        <ItemProfitPanel from={from} to={to} periodLabel={periodLabel} />
      ) : (
        <>
          <Panel scroll={{ maxH: '70vh' }}>
            {isLoading ? (
              <SkeletonRows />
            ) : isError ? (
              <QueryErrorState
                className="m-3"
                title={`Could not load the ${kind} register`}
                detail="The report request failed. No vouchers or balances were changed."
                onRetry={() => void refetch()}
              />
            ) : rows.length === 0 ? (
              <EmptyState title={`No ${kind} vouchers in this period`} />
            ) : (
              <table className="ledger-table">
                <thead>
                  <tr>
                    <th>{granularity === 'month' ? 'Month' : 'Quarter'}</th>
                    <th className="r w-24">Vouchers</th>
                    <th className="r w-40">Taxable value</th>
                    <th className="r w-36">GST</th>
                    <th className="r w-40">Invoice total</th>
                  </tr>
                </thead>
                <tbody data-testid="rows-registers">
                  {rows.map((r) => (
                    <PeriodRow key={r.key} period={r} kind={kind} />
                  ))}
                  <tr className="total-row">
                    <td>Total</td>
                    <td className="r num">
                      {rows.reduce((s, r) => s + r.vouchers, 0)}
                    </td>
                    <td className="r">
                      <Money paise={rows.reduce((s, r) => s + r.taxable, 0)} />
                    </td>
                    <td className="r">
                      <Money paise={rows.reduce((s, r) => s + r.tax, 0)} />
                    </td>
                    <td className="r">
                      <Money paise={rows.reduce((s, r) => s + r.total, 0)} />
                    </td>
                  </tr>
                </tbody>
              </table>
            )}
          </Panel>
          <p className="mt-2 text-[11.5px] text-muted">
            Select a {granularity} to open its vouchers in the Day Book.
          </p>
        </>
      )}
    </div>
  )
}

function PeriodRow({
  period,
  kind,
}: {
  period: import('@shared/reports').RegisterPeriodRow
  kind: 'sales' | 'purchase'
}): React.JSX.Element {
  const nav = useNav()
  return (
    <InteractiveReportRow
      data-row-id={period.key}
      className="hover:bg-panel2"
      title="Open this period in the Day Book"
      aria-label={`Open ${period.label} in the Day Book`}
      onActivate={() =>
        nav.go({
          name: 'daybook',
          from: period.from,
          to: period.to,
          periodLabel: period.label,
          kind,
        })
      }
    >
      <td className="text-blue">{period.label}</td>
      <td className="r num">{period.vouchers}</td>
      <td className="r">
        <Money paise={period.taxable} />
      </td>
      <td className="r">
        <Money paise={period.tax} />
      </td>
      <td className="r">
        <Money paise={period.total} />
      </td>
    </InteractiveReportRow>
  )
}

/** Item profitability (v0.3 R3): per-item qty sold, sales value, engine-valued COGS and margin. */
function ItemProfitPanel({
  from,
  to,
  periodLabel,
}: {
  from: string
  to: string
  periodLabel: string
}): React.JSX.Element {
  const toast = useToasts()
  const { data, isLoading } = useQuery({
    queryKey: ['register', 'item-profit', from, to],
    queryFn: ({ signal }) => api.reports.itemProfitability(from, to, signal),
  })
  const rows = data ?? []
  const totals = rows.reduce(
    (acc, r) => ({
      sales: acc.sales + r.salesValue,
      cogs: acc.cogs + r.cogs,
      profit: acc.profit + r.profit,
    }),
    { sales: 0, cogs: 0, profit: 0 },
  )
  const marginOf = (profit: number, sales: number): string =>
    sales !== 0 ? `${((profit / sales) * 100).toFixed(1)}%` : '—'

  const exportRows: PdfRow[] = [
    ...rows.map((r) => ({
      cells: [
        r.name,
        `${fmtQty(r.outQtyMilli, r.decimals)} ${r.unitSymbol}`,
        formatPaise(r.salesValue, { zeroDash: true }),
        formatPaise(r.cogs, { zeroDash: true }),
        formatPaise(r.profit, { zeroDash: true }),
        marginOf(r.profit, r.salesValue),
      ],
    })),
    {
      cells: [
        'Total',
        '',
        formatPaise(totals.sales, { zeroDash: true }),
        formatPaise(totals.cogs, { zeroDash: true }),
        formatPaise(totals.profit, { zeroDash: true }),
        marginOf(totals.profit, totals.sales),
      ],
      bold: true,
      rule: true,
    },
  ]

  return (
    <>
      <div className="mb-2 flex justify-end gap-2">
        <Button
          variant="ghost"
          onClick={() =>
            void printReport(
              {
                title: 'Item profitability',
                periodLabel,
                columns: ITEM_COLUMNS,
                rows: exportRows,
              },
              toast,
            )
          }
        >
          PDF
        </Button>
        <Button
          variant="ghost"
          onClick={() =>
            void csvReport(
              ITEM_COLUMNS.map((c) => c.label),
              exportRows.map((r) => r.cells),
              'item-profitability',
              toast,
            )
          }
        >
          CSV
        </Button>
      </div>
      <Panel scroll={{ maxH: '70vh' }}>
        {isLoading ? (
          <SkeletonRows />
        ) : rows.length === 0 ? (
          <EmptyState title="No item sales in this period" />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th>Item</th>
                <th className="r w-28">Qty sold</th>
                <th className="r w-36">Sales</th>
                <th className="r w-36">COGS</th>
                <th className="r w-36">Profit</th>
                <th className="r w-20">Margin</th>
              </tr>
            </thead>
            <tbody data-testid="rows-registers-items">
              {rows.map((r) => (
                <tr key={r.stockItemId}>
                  <td>{r.name}</td>
                  <td className="r num">
                    {fmtQty(r.outQtyMilli, r.decimals)} {r.unitSymbol}
                  </td>
                  <td className="r">
                    <Money paise={r.salesValue} />
                  </td>
                  <td className="r">
                    <Money paise={r.cogs} />
                  </td>
                  <td className="r">
                    <span className={r.profit < 0 ? 'text-cr' : ''}>
                      <Money paise={r.profit} />
                    </span>
                  </td>
                  <td className="r num text-muted">
                    {marginOf(r.profit, r.salesValue)}
                  </td>
                </tr>
              ))}
              <tr className="total-row">
                <td colSpan={2}>Total</td>
                <td className="r">
                  <Money paise={totals.sales} />
                </td>
                <td className="r">
                  <Money paise={totals.cogs} />
                </td>
                <td className="r">
                  <Money paise={totals.profit} />
                </td>
                <td className="r num">
                  {marginOf(totals.profit, totals.sales)}
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </Panel>
      <p className="mt-2 text-[11.5px] text-muted">
        COGS is valued by each item&apos;s valuation method (FIFO / weighted
        average) over the period&apos;s movements.
      </p>
    </>
  )
}
