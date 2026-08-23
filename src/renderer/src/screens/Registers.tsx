import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useNav, useSession, useToasts } from '../state/stores'
import { Button, EmptyState, Money, Panel, SectionTitle, SkeletonRows, useTableNav } from '../components/ui'
import { TabBar } from '../components/TabBar'
import { csvReport, printReport } from '../lib/reportExport'
import type { ReportColumn as PdfColumn, ReportRow as PdfRow } from '../lib/client'
import type { RegisterPeriodRow } from '@shared/reports'
import { toDisplayDate } from '@shared/dates'
import { formatPaise } from '@shared/money'
import { periodBounds, type Period } from '@shared/period'


const EXPORT_COLUMNS: PdfColumn[] = [
  { label: 'Month', align: 'l' },
  { label: 'Vouchers', align: 'r' },
  { label: 'Taxable value', align: 'r' },
  { label: 'GST', align: 'r' },
  { label: 'Invoice total', align: 'r' }
]

const ITEM_COLUMNS: PdfColumn[] = [
  { label: 'Item', align: 'l' },
  { label: 'Qty sold', align: 'r' },
  { label: 'Sales', align: 'r' },
  { label: 'COGS', align: 'r' },
  { label: 'Profit', align: 'r' },
  { label: 'Margin', align: 'r' }
]

/**
 * Register granularity. Quarters are Indian FY quarters (Q1 = Apr-Jun) via `@shared/period`,
 * which is what a QRMP filer means by "the quarter" — so this register lines up with the GST
 * return it feeds. Row labels come from the service; nothing is re-derived here.
 */
const GRANULARITIES: { period: Period; label: string; heading: string }[] = [
  { period: 'month', label: 'Monthly', heading: 'Month' },
  { period: 'quarter', label: 'Quarterly', heading: 'Quarter' },
  { period: 'half', label: 'Half-year', heading: 'Half-year' },
  { period: 'year', label: 'Yearly', heading: 'Year' }
]

function fmtQty(qtyMilli: number, decimals: number): string {
  return (qtyMilli / 1000).toFixed(decimals)
}

type Tab = 'sales' | 'purchase' | 'items'

const TAB_LABELS: Record<Tab, string> = { sales: 'Sales', purchase: 'Purchase', items: 'Item profit' }

export function RegistersScreen(): React.JSX.Element {
  const { from, to } = useSession()
  const toast = useToasts()
  const [tab, setTab] = useState<Tab>('sales')
  const [granularity, setGranularity] = useState<Period>('month')
  const [busy, setBusy] = useState<'caPack' | 'tallyXml' | null>(null)
  const kind = tab === 'items' ? 'sales' : tab
  const { data, isLoading } = useQuery({
    queryKey: ['register', kind, from, to, granularity],
    queryFn: () => api.analysis.register(kind, from, to, granularity),
    enabled: tab !== 'items'
  })
  const rows = data ?? []
  const heading = GRANULARITIES.find((g) => g.period === granularity)?.heading ?? 'Period'
  // Enter drills the selected period into the Day Book, same as clicking it.
  const nav = useNav()
  const table = useTableNav(rows, {
    rowId: (r) => r.period,
    enabled: tab !== 'items',
    onEnter: (r) =>
      nav.go({ name: 'daybook', span: { ...periodBounds(r.period, granularity), label: r.label }, kind })
  })

  const periodLabel = `${toDisplayDate(from)} → ${toDisplayDate(to)}`
  const exportRows: PdfRow[] = [
    ...rows.map((r) => ({
      cells: [
        r.label,
        String(r.vouchers),
        formatPaise(r.taxable, { zeroDash: true }),
        formatPaise(r.tax, { zeroDash: true }),
        formatPaise(r.total, { zeroDash: true })
      ]
    })),
    {
      cells: [
        'Total',
        String(rows.reduce((s, r) => s + r.vouchers, 0)),
        formatPaise(rows.reduce((s, r) => s + r.taxable, 0), { zeroDash: true }),
        formatPaise(rows.reduce((s, r) => s + r.tax, 0), { zeroDash: true }),
        formatPaise(rows.reduce((s, r) => s + r.total, 0), { zeroDash: true })
      ],
      bold: true,
      rule: true
    }
  ]

  const runExport = async (which: 'caPack' | 'tallyXml'): Promise<void> => {
    setBusy(which)
    try {
      const r = which === 'caPack' ? await api.exporter.caPack(from, to) : await api.exporter.tallyXml(from, to)
      toast.push('success', `Saved to ${r.path}`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const title = tab === 'items' ? 'Item profitability' : tab === 'sales' ? 'Sales register' : 'Purchase register'

  return (
    <div className="mx-auto max-w-4xl">
      <SectionTitle
        right={
          <div className="flex items-center gap-2">
            <TabBar
              screen="registers"
              tabs={(['sales', 'purchase', 'items'] as const).map((k) => ({ id: k, label: TAB_LABELS[k] }))}
              active={tab}
              onSelect={setTab}
            />
            {tab !== 'items' && (
              <div className="flex gap-1" role="group" aria-label="Register period">
                {GRANULARITIES.map((g) => (
                  <button
                    key={g.period}
                    type="button"
                    data-testid={`tab-registers-period-${g.period}`}
                    aria-pressed={granularity === g.period}
                    onClick={() => setGranularity(g.period)}
                    className={`rounded-md px-2.5 py-1 text-small ${granularity === g.period ? 'bg-amberbar/25 font-medium text-ink' : 'text-muted hover:bg-panel2'}`}
                  >
                    {g.label}
                  </button>
                ))}
              </div>
            )}
            {tab !== 'items' && (
              <>
                <Button
                  variant="ghost"
                  onClick={() =>
                    void printReport({ title, periodLabel, columns: EXPORT_COLUMNS, rows: exportRows }, toast)
                  }
                >
                  PDF
                </Button>
                <Button
                  variant="ghost"
                  onClick={() =>
                    void csvReport(EXPORT_COLUMNS.map((c) => c.label), exportRows.map((r) => r.cells), `${kind}-register-${granularity}`, toast)
                  }
                >
                  CSV
                </Button>
              </>
            )}
            <Button disabled={busy !== null} onClick={() => void runExport('tallyXml')}>
              Tally XML
            </Button>
            <Button variant="primary" data-testid="btn-registers-ca-pack" disabled={busy !== null} onClick={() => void runExport('caPack')}>
              CA pack…
            </Button>
          </div>
        }
      >
        {title}
      </SectionTitle>
      {tab === 'items' ? (
        <ItemProfitPanel from={from} to={to} periodLabel={periodLabel} />
      ) : (
        <>
          <Panel scroll={{ maxH: '70vh' }}>
            {isLoading ? (
              <SkeletonRows />
            ) : rows.length === 0 ? (
              <EmptyState title={`No ${kind} vouchers in this period`} />
            ) : (
              <table className="ledger-table">
                <thead>
                  <tr>
                    <th>{heading}</th>
                    <th className="r w-24">Vouchers</th>
                    <th className="r w-40">Taxable value</th>
                    <th className="r w-36">GST</th>
                    <th className="r w-40">Invoice total</th>
                  </tr>
                </thead>
                <tbody data-testid="rows-registers">
                  {rows.map((r, i) => (
                    <PeriodRow key={r.period} row={r} rowProps={table.rowProps(i, r)} />
                  ))}
                  <tr className="total-row">
                    <td>Total</td>
                    <td className="r num">{rows.reduce((s, r) => s + r.vouchers, 0)}</td>
                    <td className="r"><Money paise={rows.reduce((s, r) => s + r.taxable, 0)} /></td>
                    <td className="r"><Money paise={rows.reduce((s, r) => s + r.tax, 0)} /></td>
                    <td className="r"><Money paise={rows.reduce((s, r) => s + r.total, 0)} /></td>
                  </tr>
                </tbody>
              </table>
            )}
          </Panel>
          <p className="mt-2 text-hint text-muted">Click a month to open its vouchers in the Day Book.</p>
        </>
      )}
    </div>
  )
}

/** One period row. Selection/keyboard markup comes from the parent's useTableNav. */
function PeriodRow({
  row,
  rowProps
}: {
  row: RegisterPeriodRow
  rowProps: React.ComponentProps<'tr'>
}): React.JSX.Element {
  return (
    <tr {...rowProps} title={`Open ${row.label} in the Day Book`}>
      <td className="text-blue">{row.label}</td>
      <td className="r num">{row.vouchers}</td>
      <td className="r"><Money paise={row.taxable} /></td>
      <td className="r"><Money paise={row.tax} /></td>
      <td className="r"><Money paise={row.total} /></td>
    </tr>
  )
}

/** Item profitability (v0.3 R3): per-item qty sold, sales value, engine-valued COGS and margin. */
function ItemProfitPanel({ from, to, periodLabel }: { from: string; to: string; periodLabel: string }): React.JSX.Element {
  const toast = useToasts()
  const { data, isLoading } = useQuery({
    queryKey: ['register', 'item-profit', from, to],
    queryFn: () => api.reports.itemProfitability(from, to)
  })
  const rows = data ?? []
  const totals = rows.reduce(
    (acc, r) => ({ sales: acc.sales + r.salesValue, cogs: acc.cogs + r.cogs, profit: acc.profit + r.profit }),
    { sales: 0, cogs: 0, profit: 0 }
  )
  const marginOf = (profit: number, sales: number): string => (sales !== 0 ? `${((profit / sales) * 100).toFixed(1)}%` : '—')

  const exportRows: PdfRow[] = [
    ...rows.map((r) => ({
      cells: [
        r.name,
        `${fmtQty(r.outQtyMilli, r.decimals)} ${r.unitSymbol}`,
        formatPaise(r.salesValue, { zeroDash: true }),
        formatPaise(r.cogs, { zeroDash: true }),
        formatPaise(r.profit, { zeroDash: true }),
        marginOf(r.profit, r.salesValue)
      ]
    })),
    {
      cells: [
        'Total',
        '',
        formatPaise(totals.sales, { zeroDash: true }),
        formatPaise(totals.cogs, { zeroDash: true }),
        formatPaise(totals.profit, { zeroDash: true }),
        marginOf(totals.profit, totals.sales)
      ],
      bold: true,
      rule: true
    }
  ]

  return (
    <>
      <div className="mb-2 flex justify-end gap-2">
        <Button
          variant="ghost"
          onClick={() => void printReport({ title: 'Item profitability', periodLabel, columns: ITEM_COLUMNS, rows: exportRows }, toast)}
        >
          PDF
        </Button>
        <Button
          variant="ghost"
          onClick={() => void csvReport(ITEM_COLUMNS.map((c) => c.label), exportRows.map((r) => r.cells), 'item-profitability', toast)}
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
                  <td className="r"><Money paise={r.salesValue} /></td>
                  <td className="r"><Money paise={r.cogs} /></td>
                  <td className="r">
                    <span className={r.profit < 0 ? 'text-cr' : ''}>
                      <Money paise={r.profit} />
                    </span>
                  </td>
                  <td className="r num text-muted">{marginOf(r.profit, r.salesValue)}</td>
                </tr>
              ))}
              <tr className="total-row">
                <td colSpan={2}>Total</td>
                <td className="r"><Money paise={totals.sales} /></td>
                <td className="r"><Money paise={totals.cogs} /></td>
                <td className="r"><Money paise={totals.profit} /></td>
                <td className="r num">{marginOf(totals.profit, totals.sales)}</td>
              </tr>
            </tbody>
          </table>
        )}
      </Panel>
      <p className="mt-2 text-hint text-muted">
        COGS is valued by each item&apos;s valuation method (FIFO / weighted average) over the period&apos;s movements.
      </p>
    </>
  )
}
