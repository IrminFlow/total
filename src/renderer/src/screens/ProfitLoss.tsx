import { useEffect, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useSession, useToasts } from '../state/stores'
import { Button, DateInput, Money, Panel, SectionTitle } from '../components/ui'
import { StatementTree } from '../components/StatementTree'
import { csvReport, flattenNodes, printReport } from '../lib/reportExport'
import type { ReportColumn as PdfColumn, ReportRow as PdfRow } from '../lib/client'
import { toDisplayDate } from '@shared/dates'
import { formatPaise } from '@shared/money'
import { SavedReportViews } from '../components/SavedReportViews'
import { ReportToolbar } from '../components/ReportToolbar'
import { useSavedReportViews } from '../lib/reportConfig'

interface ProfitLossView { from: string; to: string; comparePrior: boolean }

const EXPORT_COLUMNS: PdfColumn[] = [
  { label: 'Particulars', align: 'l' },
  { label: 'Amount', align: 'r' }
]

export function ProfitLossScreen(): React.JSX.Element {
  const { from: sessionFrom, to: sessionTo } = useSession()
  const toast = useToasts()
  // Local, on-screen range (user ask): seeded from the header period, editable here without
  // touching the global session period other screens read.
  const [from, setFrom] = useState(sessionFrom)
  const [to, setTo] = useState(sessionTo)
  const [comparePrior, setComparePrior] = useState(false)
  const savedViews = useSavedReportViews<ProfitLossView>('profit-loss')
  useEffect(() => {
    setFrom(sessionFrom)
    setTo(sessionTo)
  }, [sessionFrom, sessionTo])
  // keepPreviousData: editing the on-screen dates changes the query key — keep the previous
  // figures rendered (with a subtle hint) instead of unmounting the screen into "Loading…",
  // which would drop focus from the very DateInput being edited.
  const { data, isPlaceholderData } = useQuery({
    queryKey: ['pnl', from, to, comparePrior],
    queryFn: ({ signal }) => api.reports.profitLoss(from, to, comparePrior, signal),
    placeholderData: keepPreviousData
  })
  if (!data) return <p className="text-muted">Loading…</p>

  const periodLabel = `${toDisplayDate(from)} → ${toDisplayDate(to)}`
  const flat = (label: string, paise: number): PdfRow => ({ cells: [label, formatPaise(paise, { zeroDash: true })], bold: true })
  const exportRows: PdfRow[] = [
    { cells: ['Expenses', ''], bold: true },
    ...(data.openingStock !== 0 ? [flat('Opening stock', data.openingStock)] : []),
    ...flattenNodes(data.tradingExpenses, 1),
    ...(data.grossProfit > 0 ? [flat('Gross profit c/o', data.grossProfit)] : []),
    ...flattenNodes(data.indirectExpenses, 1),
    ...(data.netProfit > 0 ? [flat('Net profit', data.netProfit)] : []),
    { cells: ['Incomes', ''], bold: true },
    ...flattenNodes(data.tradingIncomes, 1),
    ...(data.closingStock !== 0 ? [flat('Closing stock', data.closingStock)] : []),
    ...(data.grossProfit < 0 ? [flat('Gross loss c/o', -data.grossProfit)] : []),
    ...flattenNodes(data.indirectIncomes, 1),
    ...(data.grossProfit > 0 ? [flat('Gross profit b/f', data.grossProfit)] : []),
    ...(data.netProfit < 0 ? [flat('Net loss', -data.netProfit)] : []),
    {
      cells: [
        data.netProfit >= 0 ? 'Net profit for the period' : 'Net loss for the period',
        formatPaise(Math.abs(data.netProfit), { zeroDash: true })
      ],
      bold: true,
      rule: true
    }
  ]

  return (
    <div className="mx-auto max-w-5xl">
      <SectionTitle
        right={
          <ReportToolbar
            compact
            ariaLabel="Profit and loss controls"
            period={<>
              {isPlaceholderData && (
                <span data-testid="pnl-refreshing" className="text-[11px] text-muted" aria-live="polite">
                  Updating…
                </span>
              )}
              <DateInput value={from} context={from} onChange={setFrom} className="w-28" testId="input-pnl-from" />
              <span className="text-[12px] text-muted">→</span>
              <DateInput value={to} context={to} onChange={setTo} className="w-28" testId="input-pnl-to" />
            </>}
            comparison={
              <Button variant={comparePrior ? 'primary' : 'default'} data-testid="btn-pnl-compare" onClick={() => setComparePrior((v) => !v)}>
                Prior year
              </Button>
            }
            savedView={<SavedReportViews views={savedViews.views} current={{ from, to, comparePrior }} onSave={savedViews.save} onRemove={savedViews.remove} onApply={(view) => { setFrom(view.from); setTo(view.to); setComparePrior(view.comparePrior) }} />}
            actions={<>
              <Button
                variant="ghost"
                onClick={() => void printReport({ title: 'Profit & Loss', periodLabel, columns: EXPORT_COLUMNS, rows: exportRows }, toast)}
              >
                PDF
              </Button>
              <Button
                variant="ghost"
                onClick={() =>
                  void csvReport(EXPORT_COLUMNS.map((c) => c.label), exportRows.map((r) => r.cells), 'profit-loss', toast)
                }
              >
                CSV
              </Button>
            </>}
          />
        }
      >
        Profit &amp; Loss
      </SectionTitle>

      {comparePrior && data.prior && <ComparisonStrip items={[
        { label: 'Gross profit', current: data.grossProfit, prior: data.prior.grossProfit },
        { label: 'Net profit', current: data.netProfit, prior: data.prior.netProfit },
        { label: 'Closing stock', current: data.closingStock, prior: data.prior.closingStock }
      ]} />}

      <div className={`grid grid-cols-2 gap-3 transition-opacity ${isPlaceholderData ? 'opacity-60' : ''}`}>
        <Panel className="p-4">
          <p className="mb-2 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">Expenses</p>
          {data.openingStock !== 0 && <FlatRow name="Opening stock" paise={data.openingStock} />}
          <StatementTree nodes={data.tradingExpenses} />
          {data.grossProfit > 0 && <FlatRow name="Gross profit c/o" paise={data.grossProfit} strong />}
          <div className="my-2 border-t border-line" />
          <StatementTree nodes={data.indirectExpenses} />
          {data.netProfit > 0 && <FlatRow name="Net profit" paise={data.netProfit} strong tone="dr" />}
        </Panel>

        <Panel className="p-4">
          <p className="mb-2 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">Incomes</p>
          <StatementTree nodes={data.tradingIncomes} />
          {data.closingStock !== 0 && <FlatRow name="Closing stock" paise={data.closingStock} />}
          {data.grossProfit < 0 && <FlatRow name="Gross loss c/o" paise={-data.grossProfit} strong />}
          <div className="my-2 border-t border-line" />
          <StatementTree nodes={data.indirectIncomes} />
          {data.grossProfit > 0 && <FlatRow name="Gross profit b/f" paise={data.grossProfit} />}
          {data.netProfit < 0 && <FlatRow name="Net loss" paise={-data.netProfit} strong tone="cr" />}
        </Panel>
      </div>

      <Panel className="mt-3 flex items-center justify-between px-5 py-3">
        <span className="text-[13.5px] font-medium">{data.netProfit >= 0 ? 'Net profit for the period' : 'Net loss for the period'}</span>
        <Money paise={Math.abs(data.netProfit)} className={`text-[16px] font-semibold ${data.netProfit >= 0 ? 'text-dr' : 'text-cr'}`} />
      </Panel>
    </div>
  )
}

function ComparisonStrip({ items }: { items: { label: string; current: number; prior: number }[] }): React.JSX.Element {
  return <div className="mb-3 grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-line bg-line">
    {items.map((item) => {
      const change = item.prior === 0 ? null : ((item.current - item.prior) / Math.abs(item.prior)) * 100
      return <div key={item.label} className="bg-panel px-4 py-3"><p className="text-[10px] font-semibold tracking-[0.08em] text-muted uppercase">{item.label}</p><div className="mt-1 flex items-baseline justify-between gap-2"><Money paise={item.current} className="text-[13px] font-medium" /><span className={`num text-[10.5px] ${change !== null && change < 0 ? 'text-cr' : 'text-dr'}`}>{change === null ? 'new' : `${change >= 0 ? '+' : ''}${change.toFixed(1)}%`}</span></div><p className="mt-0.5 text-[10px] text-muted">Prior <Money paise={item.prior} /></p></div>
    })}
  </div>
}

function FlatRow({ name, paise, strong, tone }: { name: string; paise: number; strong?: boolean; tone?: 'dr' | 'cr' }): React.JSX.Element {
  return (
    <div className={`flex items-center justify-between px-2 py-1 ${strong ? 'font-medium' : ''}`}>
      <span className={`text-[13px] ${tone === 'dr' ? 'text-dr' : tone === 'cr' ? 'text-cr' : ''}`}>{name}</span>
      <Money paise={paise} className="text-[13px]" />
    </div>
  )
}
