import { useEffect, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useSession, useToasts } from '../state/stores'
import { Button, DateInput, ExportGroup, Money, Panel, SectionTitle } from '../components/ui'
import { ComparedStatementTree, StatementTree } from '../components/StatementTree'
import { compareStatements } from '@shared/statementCompare'
import type { StatementNode } from '@shared/reports'
import { csvReport, flattenNodes, printReport, xlsReport } from '../lib/reportExport'
import type { ReportColumn as PdfColumn, ReportRow as PdfRow } from '../lib/client'
import { useStickyFlag } from '../lib/useStickyTab'
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
  // Both flags above the query that reads them, and above the early return: every hook this
  // component calls has to run on every render, and the first render happens before `data`.
  const [showPct, setShowPct] = useStickyFlag('pnl-show-pct', false)
  const [comparePrior, setComparePrior] = useStickyFlag('pnl-compare-prior', false)
  const { data, isPlaceholderData } = useQuery({
    queryKey: ['pnl', from, to, comparePrior],
    queryFn: () => api.reports.profitLoss(from, to, comparePrior),
    placeholderData: keepPreviousData
  })
  if (!data) return <p className="text-muted">Loading…</p>

  const periodLabel = `${toDisplayDate(from)} → ${toDisplayDate(to)}`

  // Percentages are of turnover, not of each section's own subtotal: that is the only base that
  // lets two lines on the statement be compared.
  //
  // Turnover is trading income alone. Closing stock sits on the income side of a trading account
  // as a balancing entry, not as a sale, and including it made Sales read as 60% of turnover
  // instead of 100% — which is the tell that the base was wrong.
  const turnover = data.tradingIncomes.reduce((sum, n) => sum + n.amount, 0)
  const pctBase = showPct ? turnover : 0
  // Only when the service actually returned one: asking for a comparison against a year the
  // books do not cover has to render as "no prior period", not as a column of zeroes.
  const prior = comparePrior ? data.prior : undefined
  const priorHeaders = prior
    ? {
        current: periodLabel,
        prior: `${toDisplayDate(prior.period.from)} → ${toDisplayDate(prior.period.to)}`
      }
    : undefined
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
    <div className="flex h-full min-h-0 w-full flex-col max-w-[1440px]">
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
              data-testid="btn-pnl-compare"
              onClick={() => setComparePrior(!comparePrior)}
            >
              {comparePrior ? 'Hide last year' : 'vs last year'}
            </Button>
            <Button
              variant="ghost"
              data-testid="btn-pnl-pct"
              disabled={turnover === 0}
              disabledTitle="No turnover in this period to take a percentage of"
              onClick={() => setShowPct(!showPct)}
            >
              {showPct ? 'Hide %' : '% of turnover'}
            </Button>
            <ExportGroup
              items={[
                {
                  label: 'PDF',
                  onClick: () => void printReport({ title: 'Profit & Loss', periodLabel, columns: EXPORT_COLUMNS, rows: exportRows }, toast)
                },
                {
                  label: 'CSV',
                  onClick: () => void csvReport(EXPORT_COLUMNS.map((c) => c.label), exportRows.map((r) => r.cells), 'profit-loss', toast)
                },
                {
                  label: 'XLS',
                  testId: 'btn-pnl-xls',
                  onClick: () => void xlsReport(
                    'profit-loss',
                    [
                      {
                        name: 'Profit and Loss',
                        columns: [
                          { label: 'Particulars', kind: 'text' },
                          { label: 'Amount', kind: 'money' }
                        ],
                        // Typed cells straight from the statement: the spreadsheet gets paise as a
                        // number, so a column of expenses can be totalled in the sheet itself.
                        rows: [
                          { cells: ['Expenses', null], bold: true },
                          ...xlsStatementRows(data.tradingExpenses, 1),
                          ...xlsStatementRows(data.indirectExpenses, 1),
                          { cells: ['Incomes', null], bold: true },
                          ...xlsStatementRows(data.tradingIncomes, 1),
                          ...xlsStatementRows(data.indirectIncomes, 1),
                          { cells: ['Opening stock', data.openingStock] },
                          { cells: ['Closing stock', data.closingStock] },
                          { cells: ['Gross profit', data.grossProfit], bold: true },
                          { cells: ['Net profit', data.netProfit], bold: true }
                        ]
                      }
                    ],
                    toast
                  )
                }
              ]}
            />
          </div>
        }
      >
        Profit &amp; Loss
      </SectionTitle>

      {/* The T-shaped two-column layout has no room for three numeric columns a side, so the
          comparison view stacks the two halves full width instead of squeezing them. */}
      <div
        className={`grid gap-3 transition-opacity ${prior ? 'grid-cols-1' : 'grid-cols-2'} ${
          isPlaceholderData ? 'opacity-60' : ''
        }`}
      >
        <Panel className="p-4">
          <p className="mb-2 text-caption font-semibold tracking-[0.08em] text-muted uppercase">Expenses</p>
          {data.openingStock !== 0 && <FlatRow name="Opening stock" paise={data.openingStock} />}
          <Section
            nodes={data.tradingExpenses}
            prior={prior?.tradingExpenses}
            percentOf={pctBase}
            headers={priorHeaders}
          />
          {data.grossProfit > 0 && <FlatRow name="Gross profit c/o" paise={data.grossProfit} strong />}
          <div className="my-2 border-t border-line" />
          <Section nodes={data.indirectExpenses} prior={prior?.indirectExpenses} percentOf={pctBase} />
          {data.netProfit > 0 && <FlatRow name="Net profit" paise={data.netProfit} strong tone="dr" />}
        </Panel>

        <Panel className="p-4">
          <p className="mb-2 text-caption font-semibold tracking-[0.08em] text-muted uppercase">Incomes</p>
          <Section
            nodes={data.tradingIncomes}
            prior={prior?.tradingIncomes}
            percentOf={pctBase}
            headers={priorHeaders}
          />
          {data.closingStock !== 0 && <FlatRow name="Closing stock" paise={data.closingStock} />}
          {data.grossProfit < 0 && <FlatRow name="Gross loss c/o" paise={-data.grossProfit} strong />}
          <div className="my-2 border-t border-line" />
          <Section nodes={data.indirectIncomes} prior={prior?.indirectIncomes} percentOf={pctBase} />
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

/**
 * One statement section, in whichever of the two shapes is in play.
 *
 * The choice is made here rather than at each of the four call sites so a future third mode has
 * one place to land, and so the two trees can never disagree about which nodes they are showing.
 */
function Section({
  nodes,
  prior,
  percentOf,
  headers
}: {
  nodes: StatementNode[]
  prior: StatementNode[] | undefined
  percentOf: number
  /** Column captions, shown once per section so they sit directly over their own figures. */
  headers?: { current: string; prior: string }
}): React.JSX.Element {
  if (!prior) return <StatementTree nodes={nodes} percentOf={percentOf} />
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

/** StatementNode tree → typed spreadsheet rows. Money stays integer paise. */
function xlsStatementRows(
  nodes: StatementNode[],
  depth = 0
): { cells: (string | number | null)[]; bold?: boolean }[] {
  const out: { cells: (string | number | null)[]; bold?: boolean }[] = []
  for (const n of nodes) {
    out.push({ cells: [`${'   '.repeat(depth)}${n.name}`, n.amount], bold: n.kind !== 'ledger' })
    if (n.children.length) out.push(...xlsStatementRows(n.children, depth + 1))
  }
  return out
}
