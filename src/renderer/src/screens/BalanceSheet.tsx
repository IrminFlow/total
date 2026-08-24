import { useEffect, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useSession, useToasts } from '../state/stores'
import { Button, DateInput, Money, Panel, SectionTitle } from '../components/ui'
import { ComparedStatementTree, StatementTree } from '../components/StatementTree'
import { compareStatements } from '@shared/statementCompare'
import { useStickyFlag } from '../lib/useStickyTab'
import type { StatementNode } from '@shared/reports'
import { csvReport, flattenNodes, printReport } from '../lib/reportExport'
import type { ReportColumn as PdfColumn, ReportRow as PdfRow } from '../lib/client'
import { toDisplayDate } from '@shared/dates'
import { formatPaise } from '@shared/money'

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
  useEffect(() => setAsOn(sessionTo), [sessionTo])
  // keepPreviousData: editing the on-screen as-on date changes the query key — keep the previous
  // figures rendered (with a subtle hint) instead of unmounting the screen into "Loading…",
  // which would drop focus from the very DateInput being edited.
  // Above the early return: every hook has to run on every render, and the first happens before
  // `data` arrives.
  const [comparePrior, setComparePrior] = useStickyFlag('bs-compare-prior', false)
  const { data, isPlaceholderData } = useQuery({
    queryKey: ['balanceSheet', asOn, comparePrior],
    queryFn: () => api.reports.balanceSheet(asOn, comparePrior),
    placeholderData: keepPreviousData
  })
  if (!data) return <p className="text-muted">Loading…</p>

  const balanced = data.totalAssets === data.totalLiabilities
  const periodLabel = `as on ${toDisplayDate(data.asOn)}`
  // Only when the service returned one: asking for a comparison against a date the books do not
  // reach has to read as "no prior period", not as a column of zeroes.
  const prior = comparePrior ? data.prior : undefined
  const priorHeaders = prior
    ? { current: periodLabel, prior: `as on ${toDisplayDate(prior.asOn)}` }
    : undefined
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
          <div className="flex items-center gap-2">
            {isPlaceholderData && (
              <span data-testid="bs-refreshing" className="text-caption text-muted" aria-live="polite">
                Updating…
              </span>
            )}
            <span className="text-small text-muted">as on</span>
            <DateInput value={asOn} context={asOn} onChange={setAsOn} className="w-28" testId="input-bs-ason" />
            <Button variant="ghost" data-testid="btn-bs-compare" onClick={() => setComparePrior(!comparePrior)}>
              {comparePrior ? 'Hide last year' : 'vs last year'}
            </Button>
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
          </div>
        }
      >
        Balance sheet
      </SectionTitle>
      {/* Stacked full width when comparing: the two-column layout has no room for three numeric
          columns a side. */}
      <div
        className={`grid gap-3 transition-opacity ${prior ? 'grid-cols-1' : 'grid-cols-2'} ${
          isPlaceholderData ? 'opacity-60' : ''
        }`}
      >
        {/* The two sides carry different numbers of lines, and a balance sheet whose two totals
            sit on different baselines is unreadable. Each panel is a full-height flex column with
            a growing spacer, so both totals land on the panel foot — and on one shared line. */}
        <Panel className="flex h-full flex-col p-4">
          <p className="mb-2 text-caption font-semibold tracking-[0.08em] text-muted uppercase">Liabilities</p>
          <Section nodes={data.liabilities} prior={prior?.liabilities} headers={priorHeaders} />
          <div className="grow" aria-hidden />
          <div className="total-row mt-2 flex justify-between px-2 pt-1.5 pb-0.5">
            <span>Total</span>
            <Money paise={data.totalLiabilities} />
          </div>
        </Panel>
        <Panel className="flex h-full flex-col p-4">
          <p className="mb-2 text-caption font-semibold tracking-[0.08em] text-muted uppercase">Assets</p>
          <Section nodes={data.assets} prior={prior?.assets} headers={priorHeaders} />
          <div className="grow" aria-hidden />
          <div className="total-row mt-2 flex justify-between px-2 pt-1.5 pb-0.5">
            <span>Total</span>
            <Money paise={data.totalAssets} />
          </div>
        </Panel>
      </div>
      {!balanced && (
        <p className="mt-3 text-body-sm text-amber">
          The two sides differ by {<Money paise={Math.abs(data.totalAssets - data.totalLiabilities)} />} — usually an opening balance entered on one side only.
        </p>
      )}
    </div>
  )
}

/** One side of the sheet, in whichever of the two shapes is in play. Mirrors ProfitLoss's. */
function Section({
  nodes,
  prior,
  headers
}: {
  nodes: StatementNode[]
  prior: StatementNode[] | undefined
  headers?: { current: string; prior: string }
}): React.JSX.Element {
  if (!prior) return <StatementTree nodes={nodes} />
  return (
    <>
      {headers && (
        <div className="mb-1 flex items-baseline justify-end gap-4 px-2 text-caption font-semibold tracking-[0.08em] text-muted uppercase">
          <span className="w-32 text-right">{headers.current}</span>
          <span className="w-32 text-right">{headers.prior}</span>
          <span className="w-24 text-right">Change</span>
        </div>
      )}
      <ComparedStatementTree nodes={compareStatements(nodes, prior)} />
    </>
  )
}
