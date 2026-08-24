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
import { useStickyTab } from '../lib/useStickyTab'


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

type Tab = 'sales' | 'purchase' | 'items' | 'parties'

const TAB_LABELS: Record<Tab, string> = {
  sales: 'Sales',
  purchase: 'Purchase',
  items: 'Item profit',
  parties: 'By party'
}

export function RegistersScreen(): React.JSX.Element {
  const { from, to } = useSession()
  const toast = useToasts()
  const [tab, setTab] = useStickyTab<Tab>('registers', ['sales', 'purchase', 'items', 'parties'], 'sales')
  const [granularity, setGranularity] = useState<Period>('month')
  const [busy, setBusy] = useState<'caPack' | 'tallyXml' | null>(null)
  // The party view ranks sales by default; the register tabs it sits beside decide the rest.
  const kind: 'sales' | 'purchase' = tab === 'items' || tab === 'parties' ? 'sales' : tab
  const { data, isLoading } = useQuery({
    queryKey: ['register', kind, from, to, granularity],
    queryFn: () => api.analysis.register(kind, from, to, granularity),
    enabled: tab === 'sales' || tab === 'purchase'
  })
  const rows = data ?? []
  const heading = GRANULARITIES.find((g) => g.period === granularity)?.heading ?? 'Period'
  // Enter drills the selected period into the Day Book, same as clicking it.
  const nav = useNav()
  const table = useTableNav(rows, {
    rowId: (r) => r.period,
    enabled: tab === 'sales' || tab === 'purchase',
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

  const title =
    tab === 'items'
      ? 'Item profitability'
      : tab === 'parties'
        ? 'Sales by party'
        : tab === 'sales'
          ? 'Sales register'
          : 'Purchase register'

  return (
    <div className="flex h-full min-h-0 w-full flex-col max-w-[1440px]">
      <SectionTitle
        right={
          <div className="flex items-center gap-2">
            <TabBar
              screen="registers"
              tabs={(['sales', 'purchase', 'items', 'parties'] as const).map((k) => ({ id: k, label: TAB_LABELS[k] }))}
              active={tab}
              onSelect={setTab}
            />
            {(tab === 'sales' || tab === 'purchase') && (
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
            {(tab === 'sales' || tab === 'purchase') && (
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
      ) : tab === 'parties' ? (
        <PartySharePanel from={from} to={to} periodLabel={periodLabel} />
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
                    <th scope="col">{heading}</th>
                    <th scope="col" className="r w-24">Vouchers</th>
                    <th scope="col" className="r w-40">Taxable value</th>
                    <th scope="col" className="r w-36">GST</th>
                    <th scope="col" className="r w-40">Invoice total</th>
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
                <th scope="col">Item</th>
                <th scope="col" className="r w-28">Qty sold</th>
                <th scope="col" className="r w-36">Sales</th>
                <th scope="col" className="r w-36">COGS</th>
                <th scope="col" className="r w-36">Profit</th>
                <th scope="col" className="r w-20">Margin</th>
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

const PARTY_COLUMNS: PdfColumn[] = [
  { label: 'Party', align: 'l' },
  { label: 'Documents', align: 'r' },
  { label: 'Value', align: 'r' },
  { label: 'Share', align: 'r' },
  { label: 'Cumulative', align: 'r' }
]

/**
 * Who the period's sales actually came from, and how much of the business rests on how few of
 * them.
 *
 * A business with one customer at 60% of turnover is a materially different business from one
 * with forty at 2.5% each, and the P&L looks identical either way. The cumulative column is the
 * point of the table: it answers "how many names do I have to read before I have half my
 * turnover", which is a question a register cannot answer at all.
 */
function PartySharePanel({
  from,
  to,
  periodLabel
}: {
  from: string
  to: string
  periodLabel: string
}): React.JSX.Element {
  const toast = useToasts()
  const nav = useNav()
  const [side, setSide] = useStickyTab<'sales' | 'purchase'>(
    'registers-party-side',
    ['sales', 'purchase'],
    'sales'
  )
  const { data, isLoading } = useQuery({
    queryKey: ['partyShares', side, from, to],
    queryFn: () => api.analysis.partyShares(side, from, to)
  })
  const rows = data?.rows ?? []
  const table = useTableNav(rows, {
    rowId: (r) => r.ledgerId,
    onEnter: (r) => nav.go({ name: 'ledger-statement', ledgerId: r.ledgerId })
  })

  const pct = (x: number): string => `${(x * 100).toFixed(1)}%`
  const exportRows: PdfRow[] = rows.map((r) => ({
    cells: [r.name, String(r.documents), formatPaise(r.amount), pct(r.share), pct(r.cumulativeShare)]
  }))

  return (
    <>
      <div className="mb-3 flex items-center gap-2">
        <div className="flex gap-1" role="group" aria-label="Party side">
          {(['sales', 'purchase'] as const).map((k) => (
            <button
              key={k}
              type="button"
              data-testid={`tab-parties-${k}`}
              aria-pressed={side === k}
              onClick={() => setSide(k)}
              className={`rounded-md px-2.5 py-1 text-small ${side === k ? 'bg-amberbar/25 font-medium text-ink' : 'text-muted hover:bg-panel2'}`}
            >
              {k === 'sales' ? 'Customers' : 'Suppliers'}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <Button
          variant="ghost"
          disabled={!rows.length}
          onClick={() =>
            void printReport(
              {
                title: side === 'sales' ? 'Sales by party' : 'Purchases by party',
                periodLabel,
                columns: PARTY_COLUMNS,
                rows: exportRows,
                filename: `${side}-by-party`
              },
              toast
            )
          }
        >
          PDF
        </Button>
        <Button
          variant="ghost"
          disabled={!rows.length}
          onClick={() =>
            void csvReport(
              PARTY_COLUMNS.map((c) => c.label),
              exportRows.map((r) => r.cells),
              `${side}-by-party`,
              toast
            )
          }
        >
          CSV
        </Button>
      </div>

      {data?.concentration.warning && (
        <div
          className={`mb-3 rounded-md border px-3.5 py-2.5 text-body-sm ${
            data.concentration.level === 'concentrated'
              ? 'border-cr/40 bg-cr/5 text-cr'
              : 'border-amber/50 bg-amber/10 text-amber'
          }`}
          data-testid="party-concentration"
        >
          {data.concentration.warning}{' '}
          <span className="text-muted">
            {data.concentration.partyCount} part{data.concentration.partyCount === 1 ? 'y' : 'ies'} · top three{' '}
            {pct(data.concentration.top3)}
          </span>
        </div>
      )}

      <Panel scroll={{ maxH: '70vh' }}>
        {isLoading ? (
          <SkeletonRows />
        ) : rows.length === 0 ? (
          <EmptyState title={`No ${side} vouchers with a party in this period`} />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col">Party</th>
                <th scope="col" className="r w-24">Documents</th>
                <th scope="col" className="r w-40">Value</th>
                <th scope="col" className="r w-24">Share</th>
                <th scope="col" className="r w-28">Cumulative</th>
              </tr>
            </thead>
            <tbody data-testid="rows-parties">
              {rows.map((r, i) => (
                <tr key={r.ledgerId} {...table.rowProps(i, r)}>
                  <td>{r.name}</td>
                  <td className="r num">{r.documents}</td>
                  <td className="r"><Money paise={r.amount} /></td>
                  <td className="r num">{pct(r.share)}</td>
                  <td className="r num text-muted">{pct(r.cumulativeShare)}</td>
                </tr>
              ))}
              <tr className="total-row">
                <td>Total</td>
                <td className="r num">{rows.reduce((s, r) => s + r.documents, 0)}</td>
                <td className="r"><Money paise={data?.total ?? 0} /></td>
                <td className="r num">100.0%</td>
                <td />
              </tr>
            </tbody>
          </table>
        )}
      </Panel>
      <p className="mt-2 text-hint text-muted">
        Netted across the period, credit and debit notes included. Click a party to open its ledger.
      </p>
    </>
  )
}
