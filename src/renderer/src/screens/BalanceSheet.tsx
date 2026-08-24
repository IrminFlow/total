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
import { addDays, daysBetween, fyOf, toDisplayDate } from '@shared/dates'
import { formatPaise } from '@shared/money'
import { RatioPanel } from '../components/RatioPanel'
import { SavedViews } from '../components/SavedViews'
import { xlsReport } from '../lib/reportExport'

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
  const [showRatios, setShowRatios] = useStickyFlag('bs-show-ratios', false)
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

  // Typed cells, not the formatted PDF rows: money reaches the sheet as a number that sums.
  const exportXls = (): Promise<void> =>
    xlsReport(
      'balance-sheet',
      [
        {
          name: 'Balance sheet',
          columns: [
            { label: 'Particulars', kind: 'text' },
            { label: 'Amount', kind: 'money' }
          ],
          rows: [
            { cells: ['Liabilities', null], bold: true },
            ...xlsNodes(data.liabilities, 1),
            { cells: ['Total liabilities', data.totalLiabilities], bold: true },
            { cells: ['Assets', null], bold: true },
            ...xlsNodes(data.assets, 1),
            { cells: ['Total assets', data.totalAssets], bold: true }
          ]
        }
      ],
      toast
    )

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
            <DateScrubber asOn={asOn} onChange={setAsOn} />
            <SavedViews<{ asOn: string; comparePrior: boolean; showRatios: boolean }>
              screen="balance-sheet"
              state={{ asOn, comparePrior, showRatios }}
              onRestore={(v) => {
                setAsOn(v.asOn)
                setComparePrior(v.comparePrior)
                setShowRatios(v.showRatios)
              }}
            />
            <Button variant="ghost" data-testid="btn-bs-ratios" onClick={() => setShowRatios(!showRatios)}>
              {showRatios ? 'Hide ratios' : 'Ratios'}
            </Button>
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
            <Button variant="ghost" data-testid="btn-bs-xls" onClick={() => void exportXls()}>
              XLS
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
      {showRatios && (
        <div className="mt-3">
          <RatioPanel fyFrom={fyOf(data.asOn).from} asOn={data.asOn} />
        </div>
      )}
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

/** StatementNode tree → typed spreadsheet rows (money stays paise). Mirrors flattenNodes. */
function xlsNodes(
  nodes: StatementNode[],
  depth = 0
): { cells: (string | number | null)[]; bold?: boolean }[] {
  const out: { cells: (string | number | null)[]; bold?: boolean }[] = []
  for (const n of nodes) {
    out.push({ cells: [`${'   '.repeat(depth)}${n.name}`, n.amount], bold: n.kind !== 'ledger' })
    if (n.children.length) out.push(...xlsNodes(n.children, depth + 1))
  }
  return out
}

/**
 * The date scrubber: drag a day and the whole sheet recomputes as on that date.
 *
 * Typing a date already works (the field beside it), and typing is what you do when you know the
 * date you want. The scrubber is for the other question — "when did this go wrong" — which is
 * answered by watching the figures move, not by guessing a date and pressing enter eleven times.
 *
 * It runs over the financial year the current as-on date falls in, so the two ends of the track
 * are always meaningful dates rather than an arbitrary window. The query keeps the previous data
 * on screen while the new one loads (keepPreviousData above), so dragging does not strobe.
 */
function DateScrubber({ asOn, onChange }: { asOn: string; onChange: (d: string) => void }): React.JSX.Element {
  const fy = fyOf(asOn)
  const total = daysBetween(fy.from, fy.to)
  const value = Math.max(0, Math.min(total, daysBetween(fy.from, asOn)))
  return (
    <input
      type="range"
      min={0}
      max={total}
      value={value}
      aria-label={`As on date within ${fy.label}`}
      title={`${toDisplayDate(fy.from)} → ${toDisplayDate(fy.to)}`}
      data-testid="input-bs-scrubber"
      className="h-1 w-32 cursor-pointer accent-amber"
      onChange={(e) => onChange(addDays(fy.from, Number(e.currentTarget.value)))}
    />
  )
}
