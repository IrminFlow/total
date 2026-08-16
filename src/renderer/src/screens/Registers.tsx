import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useNav, useSession, useToasts } from '../state/stores'
import { Button, EmptyState, Money, Panel, SectionTitle, SkeletonRows } from '../components/ui'
import { TabBar } from '../components/TabBar'
import { csvReport, printReport } from '../lib/reportExport'
import type { ReportColumn as PdfColumn, ReportRow as PdfRow } from '../lib/client'
import { toDisplayDate } from '@shared/dates'
import { formatPaise } from '@shared/money'

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

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

function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number) as [number, number]
  return `${MONTH_NAMES[m - 1]} ${y}`
}

function fmtQty(qtyMilli: number, decimals: number): string {
  return (qtyMilli / 1000).toFixed(decimals)
}

type Tab = 'sales' | 'purchase' | 'items'

const TAB_LABELS: Record<Tab, string> = { sales: 'Sales', purchase: 'Purchase', items: 'Item profit' }

export function RegistersScreen(): React.JSX.Element {
  const { from, to } = useSession()
  const toast = useToasts()
  const [tab, setTab] = useState<Tab>('sales')
  const [busy, setBusy] = useState<'caPack' | 'tallyXml' | null>(null)
  const kind = tab === 'items' ? 'sales' : tab
  const { data, isLoading } = useQuery({
    queryKey: ['register', kind, from, to],
    queryFn: () => api.analysis.register(kind, from, to),
    enabled: tab !== 'items'
  })
  const rows = data ?? []

  const periodLabel = `${toDisplayDate(from)} → ${toDisplayDate(to)}`
  const exportRows: PdfRow[] = [
    ...rows.map((r) => ({
      cells: [
        monthLabel(r.month),
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
                    void csvReport(EXPORT_COLUMNS.map((c) => c.label), exportRows.map((r) => r.cells), `${kind}-register`, toast)
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
                    <th>Month</th>
                    <th className="r w-24">Vouchers</th>
                    <th className="r w-40">Taxable value</th>
                    <th className="r w-36">GST</th>
                    <th className="r w-40">Invoice total</th>
                  </tr>
                </thead>
                <tbody data-testid="rows-registers">
                  {rows.map((r) => (
                    <MonthRow key={r.month} month={r.month} kind={kind} vouchers={r.vouchers} taxable={r.taxable} tax={r.tax} total={r.total} />
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
          <p className="mt-2 text-[11.5px] text-muted">Click a month to open its vouchers in the Day Book.</p>
        </>
      )}
    </div>
  )
}

function MonthRow({
  month,
  kind,
  vouchers,
  taxable,
  tax,
  total
}: {
  month: string
  kind: 'sales' | 'purchase'
  vouchers: number
  taxable: number
  tax: number
  total: number
}): React.JSX.Element {
  const nav = useNav()
  return (
    <tr
      data-row-id={month}
      className="cursor-pointer hover:bg-panel2"
      title="Open this month in the Day Book"
      onClick={() => nav.go({ name: 'daybook', month, kind })}
    >
      <td className="text-blue">{monthLabel(month)}</td>
      <td className="r num">{vouchers}</td>
      <td className="r"><Money paise={taxable} /></td>
      <td className="r"><Money paise={tax} /></td>
      <td className="r"><Money paise={total} /></td>
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
      <p className="mt-2 text-[11.5px] text-muted">
        COGS is valued by each item&apos;s valuation method (FIFO / weighted average) over the period&apos;s movements.
      </p>
    </>
  )
}
