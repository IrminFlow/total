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
  useEffect(() => {
    setFrom(sessionFrom)
    setTo(sessionTo)
  }, [sessionFrom, sessionTo])
  // keepPreviousData: editing the on-screen dates changes the query key — keep the previous
  // figures rendered (with a subtle hint) instead of unmounting the screen into "Loading…",
  // which would drop focus from the very DateInput being edited.
  const { data, isPlaceholderData } = useQuery({
    queryKey: ['pnl', from, to],
    queryFn: () => api.reports.profitLoss(from, to),
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
          <div className="flex items-center gap-2">
            {isPlaceholderData && (
              <span data-testid="pnl-refreshing" className="text-caption text-muted" aria-live="polite">
                Updating…
              </span>
            )}
            <DateInput value={from} context={from} onChange={setFrom} className="w-28" testId="input-pnl-from" />
            <span className="text-small text-muted">→</span>
            <DateInput value={to} context={to} onChange={setTo} className="w-28" testId="input-pnl-to" />
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
          </div>
        }
      >
        Profit &amp; Loss
      </SectionTitle>

      <div className={`grid grid-cols-2 gap-3 transition-opacity ${isPlaceholderData ? 'opacity-60' : ''}`}>
        <Panel className="p-4">
          <p className="mb-2 text-caption font-semibold tracking-[0.08em] text-muted uppercase">Expenses</p>
          {data.openingStock !== 0 && <FlatRow name="Opening stock" paise={data.openingStock} />}
          <StatementTree nodes={data.tradingExpenses} />
          {data.grossProfit > 0 && <FlatRow name="Gross profit c/o" paise={data.grossProfit} strong />}
          <div className="my-2 border-t border-line" />
          <StatementTree nodes={data.indirectExpenses} />
          {data.netProfit > 0 && <FlatRow name="Net profit" paise={data.netProfit} strong tone="dr" />}
        </Panel>

        <Panel className="p-4">
          <p className="mb-2 text-caption font-semibold tracking-[0.08em] text-muted uppercase">Incomes</p>
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
        <span className="text-body font-medium">{data.netProfit >= 0 ? 'Net profit for the period' : 'Net loss for the period'}</span>
        <Money paise={Math.abs(data.netProfit)} className={`text-title font-semibold ${data.netProfit >= 0 ? 'text-dr' : 'text-cr'}`} />
      </Panel>
    </div>
  )
}

function FlatRow({ name, paise, strong, tone }: { name: string; paise: number; strong?: boolean; tone?: 'dr' | 'cr' }): React.JSX.Element {
  return (
    <div className={`flex items-center justify-between px-2 py-1 ${strong ? 'font-medium' : ''}`}>
      <span className={`text-detail ${tone === 'dr' ? 'text-dr' : tone === 'cr' ? 'text-cr' : ''}`}>{name}</span>
      <Money paise={paise} className="text-detail" />
    </div>
  )
}
