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

interface BalanceSheetView { asOn: string; comparePrior: boolean }

const EXPORT_COLUMNS: PdfColumn[] = [
  { label: 'Particulars', align: 'l' },
  { label: 'Amount', align: 'r' }
]

export function BalanceSheetScreen(): React.JSX.Element {
  const { to: sessionTo } = useSession()
  const toast = useToasts()
  // Local, on-screen as-on date (user ask): seeded from the header period, editable here
  // without touching the global session period other screens read.
  const [asOn, setAsOn] = useState(sessionTo)
  const [comparePrior, setComparePrior] = useState(false)
  const savedViews = useSavedReportViews<BalanceSheetView>('balance-sheet')
  useEffect(() => setAsOn(sessionTo), [sessionTo])
  // keepPreviousData: editing the on-screen as-on date changes the query key — keep the previous
  // figures rendered (with a subtle hint) instead of unmounting the screen into "Loading…",
  // which would drop focus from the very DateInput being edited.
  const { data, isPlaceholderData } = useQuery({
    queryKey: ['balanceSheet', asOn, comparePrior],
    queryFn: ({ signal }) => api.reports.balanceSheet(asOn, comparePrior, signal),
    placeholderData: keepPreviousData
  })
  if (!data) return <p className="text-muted">Loading…</p>

  const balanced = data.totalAssets === data.totalLiabilities
  const periodLabel = `as on ${toDisplayDate(data.asOn)}`
  const exportRows: PdfRow[] = [
    { cells: ['Liabilities', ''], bold: true },
    ...flattenNodes(data.liabilities, 1),
    { cells: ['Total liabilities', formatPaise(data.totalLiabilities, { zeroDash: true })], bold: true, rule: true },
    { cells: ['Assets', ''], bold: true },
    ...flattenNodes(data.assets, 1),
    { cells: ['Total assets', formatPaise(data.totalAssets, { zeroDash: true })], bold: true, rule: true }
  ]

  return (
    <div className="mx-auto max-w-5xl">
      <SectionTitle
        right={
          <ReportToolbar compact>
            {isPlaceholderData && (
              <span data-testid="bs-refreshing" className="text-[11px] text-muted" aria-live="polite">
                Updating…
              </span>
            )}
            <span className="text-[12px] text-muted">as on</span>
            <DateInput value={asOn} context={asOn} onChange={setAsOn} className="w-28" testId="input-bs-ason" />
            <Button variant={comparePrior ? 'primary' : 'default'} data-testid="btn-bs-compare" onClick={() => setComparePrior((v) => !v)}>
              Prior year
            </Button>
            <SavedReportViews views={savedViews.views} current={{ asOn, comparePrior }} onSave={savedViews.save} onRemove={savedViews.remove} onApply={(view) => { setAsOn(view.asOn); setComparePrior(view.comparePrior) }} />
            <Button
              variant="ghost"
              onClick={() => void printReport({ title: 'Balance sheet', periodLabel, columns: EXPORT_COLUMNS, rows: exportRows }, toast)}
            >
              PDF
            </Button>
            <Button
              variant="ghost"
              onClick={() =>
                void csvReport(EXPORT_COLUMNS.map((c) => c.label), exportRows.map((r) => r.cells), 'balance-sheet', toast)
              }
            >
              CSV
            </Button>
          </ReportToolbar>
        }
      >
        Balance sheet
      </SectionTitle>
      {comparePrior && data.prior && <div className="mb-3 grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-line bg-line">
        {[
          { label: 'Total assets', current: data.totalAssets, prior: data.prior.totalAssets },
          { label: 'Total liabilities', current: data.totalLiabilities, prior: data.prior.totalLiabilities },
          { label: 'Current-period profit', current: data.profitCurrentPeriod, prior: data.prior.profitCurrentPeriod }
        ].map((item) => {
          const change = item.prior === 0 ? null : ((item.current - item.prior) / Math.abs(item.prior)) * 100
          return <div key={item.label} className="bg-panel px-4 py-3"><p className="text-[10px] font-semibold tracking-[0.08em] text-muted uppercase">{item.label}</p><div className="mt-1 flex items-baseline justify-between"><Money paise={item.current} className="text-[13px] font-medium" /><span className={`num text-[10.5px] ${change !== null && change < 0 ? 'text-cr' : 'text-dr'}`}>{change === null ? 'new' : `${change >= 0 ? '+' : ''}${change.toFixed(1)}%`}</span></div><p className="mt-0.5 text-[10px] text-muted">Prior <Money paise={item.prior} /></p></div>
        })}
      </div>}
      <div className={`grid grid-cols-2 gap-3 transition-opacity ${isPlaceholderData ? 'opacity-60' : ''}`}>
        <Panel className="p-4">
          <p className="mb-2 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">Liabilities</p>
          <StatementTree nodes={data.liabilities} />
          <div className="total-row mt-2 flex justify-between px-2 pt-1.5 pb-0.5">
            <span>Total</span>
            <Money paise={data.totalLiabilities} />
          </div>
        </Panel>
        <Panel className="p-4">
          <p className="mb-2 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">Assets</p>
          <StatementTree nodes={data.assets} />
          <div className="total-row mt-2 flex justify-between px-2 pt-1.5 pb-0.5">
            <span>Total</span>
            <Money paise={data.totalAssets} />
          </div>
        </Panel>
      </div>
      {!balanced && (
        <p className="mt-3 text-[12.5px] text-amber">
          The two sides differ by {<Money paise={Math.abs(data.totalAssets - data.totalLiabilities)} />} — usually an opening balance entered on one side only.
        </p>
      )}
    </div>
  )
}
