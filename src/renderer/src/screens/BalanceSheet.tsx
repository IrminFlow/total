import { useEffect, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useSession, useToasts } from '../state/stores'
import { Banner, Button, DateInput, Money, Page, PageHeader, Panel } from '../components/ui'
import { OptionsExport, useScreenOptions } from '../components/ScreenOptions'
import { ComparativeOptions, ReportSkeleton, StatementOptions } from './ProfitLoss'
import { ComparativeStatement } from '../components/ComparativeStatement'
import { StatementTree } from '../components/StatementTree'
import { csvReport, flattenNodes, printReport } from '../lib/reportExport'
import type { ReportColumn as PdfColumn, ReportRow as PdfRow } from '../lib/client'
import { toDisplayDate } from '@shared/dates'
import { formatPaise } from '@shared/money'

const EXPORT_COLUMNS: PdfColumn[] = [
  { label: 'Particulars', align: 'l' },
  { label: 'Amount', align: 'r' }
]

export function BalanceSheetScreen(): React.JSX.Element {
  const { from: sessionFrom, to: sessionTo } = useSession()
  const toast = useToasts()
  // Local, on-screen as-on date (user ask): seeded from the header period, editable here
  // without touching the global session period other screens read.
  const [asOn, setAsOn] = useState(sessionTo)
  useEffect(() => setAsOn(sessionTo), [sessionTo])
  // keepPreviousData: editing the on-screen as-on date changes the query key — keep the previous
  // figures rendered (with a subtle hint) instead of unmounting the screen into "Loading…",
  // which would drop focus from the very DateInput being edited.
  const { data, isPlaceholderData } = useQuery({
    queryKey: ['balanceSheet', asOn],
    queryFn: () => api.reports.balanceSheet(asOn),
    placeholderData: keepPreviousData
  })
  const opts = useScreenOptions('balance-sheet', { expandAll: false, hideZero: false, comparative: false })
  if (!data) return <ReportSkeleton title="Balance sheet" />

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

  const exportPdf = (): void => void printReport({ title: 'Balance sheet', periodLabel, columns: EXPORT_COLUMNS, rows: exportRows }, toast)
  const exportCsv = (): void => void csvReport(EXPORT_COLUMNS.map((c) => c.label), exportRows.map((r) => r.cells), 'balance-sheet', toast)
  const treeKey = `${opts.options.expandAll}-${opts.options.hideZero}`
  const tree = { expandAll: opts.options.expandAll, hideZero: opts.options.hideZero }

  return (
    <Page>
      <PageHeader
        title="Balance sheet"
        controls={
          <div className="flex items-center gap-2">
            {isPlaceholderData && (
              <span data-testid="bs-refreshing" className="text-caption text-muted" aria-live="polite">
                Updating…
              </span>
            )}
            <span className="text-small text-muted">as on</span>
            <DateInput value={asOn} context={asOn} onChange={setAsOn} className="w-28" testId="input-bs-ason" ariaLabel="As on date" />
          </div>
        }
        secondary={
          <>
            <Button variant="ghost" onClick={exportPdf}>
              PDF
            </Button>
            <Button variant="ghost" onClick={exportCsv}>
              CSV
            </Button>
          </>
        }
        options={{
          onReset: opts.reset,
          content: (
            <>
              <StatementOptions
                expandAll={opts.options.expandAll}
                hideZero={opts.options.hideZero}
                onExpandAll={(v) => opts.set('expandAll', v)}
                onHideZero={(v) => opts.set('hideZero', v)}
              />
              <ComparativeOptions comparative={opts.options.comparative} onComparative={(v) => opts.set('comparative', v)} />
              <OptionsExport>
                <Button size="sm" onClick={exportPdf} data-testid="options-bs-pdf">
                  Export PDF
                </Button>
                <Button size="sm" onClick={exportCsv} data-testid="options-bs-csv">
                  Export CSV
                </Button>
              </OptionsExport>
            </>
          )
        }}
      />
      {opts.options.comparative ? (
        <ComparativeStatement kind="bs" from={sessionFrom <= asOn ? sessionFrom : asOn} to={asOn} budgetId={null} tree={tree} />
      ) : (
      <div className={`grid grid-cols-2 gap-3 transition-opacity ${isPlaceholderData ? 'opacity-60' : ''}`}>
        <Panel className="p-4">
          <p className="mb-2 text-caption font-semibold tracking-[0.08em] text-muted uppercase">Liabilities</p>
          <StatementTree key={`l-${treeKey}`} nodes={data.liabilities} {...tree} />
          <div className="total-row mt-2 flex justify-between px-2 pt-1.5 pb-0.5">
            <span>Total</span>
            <Money paise={data.totalLiabilities} />
          </div>
        </Panel>
        <Panel className="p-4">
          <p className="mb-2 text-caption font-semibold tracking-[0.08em] text-muted uppercase">Assets</p>
          <StatementTree key={`a-${treeKey}`} nodes={data.assets} {...tree} />
          <div className="total-row mt-2 flex justify-between px-2 pt-1.5 pb-0.5">
            <span>Total</span>
            <Money paise={data.totalAssets} />
          </div>
        </Panel>
      </div>
      )}
      {!balanced && (
        <Banner tone="warning" className="mt-3" testId="bs-unbalanced">
          The two sides differ by <Money paise={Math.abs(data.totalAssets - data.totalLiabilities)} /> — usually an opening balance entered on one side only.
        </Banner>
      )}
    </Page>
  )
}
