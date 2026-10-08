import { useEffect, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useSession, useToasts } from '../state/stores'
import { Button, DateInput, DrawerSection, Money, Page, PageHeader, Panel, Select, SkeletonRows } from '../components/ui'
import { OptionToggle, OptionsExport, useScreenOptions } from '../components/ScreenOptions'
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
  const opts = useScreenOptions('profit-loss', { expandAll: false, hideZero: false, comparative: false, budgetId: '' })
  const { data: budgets } = useQuery({ queryKey: ['budgets'], queryFn: api.budget.list })
  if (!data) return <ReportSkeleton title="Profit & Loss" />

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

  const exportPdf = (): void => void printReport({ title: 'Profit & Loss', periodLabel, columns: EXPORT_COLUMNS, rows: exportRows }, toast)
  const exportCsv = (): void => void csvReport(EXPORT_COLUMNS.map((c) => c.label), exportRows.map((r) => r.cells), 'profit-loss', toast)
  const treeKey = `${opts.options.expandAll}-${opts.options.hideZero}`
  const tree = { expandAll: opts.options.expandAll, hideZero: opts.options.hideZero }

  return (
    <Page>
      <PageHeader
        title="Profit & Loss"
        controls={
          <div className="flex items-center gap-2">
            {isPlaceholderData && (
              <span data-testid="pnl-refreshing" className="text-caption text-muted" aria-live="polite">
                Updating…
              </span>
            )}
            <DateInput value={from} context={from} onChange={setFrom} className="w-28" testId="input-pnl-from" ariaLabel="From date" />
            <span className="text-small text-muted" aria-hidden="true">
              →
            </span>
            <DateInput value={to} context={to} onChange={setTo} className="w-28" testId="input-pnl-to" ariaLabel="To date" />
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
              <ComparativeOptions
                comparative={opts.options.comparative}
                onComparative={(v) => opts.set('comparative', v)}
                budgetId={opts.options.budgetId}
                onBudget={(v) => opts.set('budgetId', v)}
                budgets={budgets ?? []}
              />
              <OptionsExport>
                <Button size="sm" onClick={exportPdf} data-testid="options-pnl-pdf">
                  Export PDF
                </Button>
                <Button size="sm" onClick={exportCsv} data-testid="options-pnl-csv">
                  Export CSV
                </Button>
              </OptionsExport>
            </>
          )
        }}
      />

      {opts.options.comparative ? (
        <ComparativeStatement kind="pnl" from={from} to={to} budgetId={opts.options.budgetId ? Number(opts.options.budgetId) : null} tree={tree} />
      ) : (
      <>
      <div className={`grid grid-cols-2 gap-3 transition-opacity ${isPlaceholderData ? 'opacity-60' : ''}`}>
        <Panel className="p-4">
          <p className="mb-2 text-caption font-semibold tracking-[0.08em] text-muted uppercase">Expenses</p>
          {data.openingStock !== 0 && <FlatRow name="Opening stock" paise={data.openingStock} />}
          <StatementTree key={`te-${treeKey}`} nodes={data.tradingExpenses} {...tree} />
          {data.grossProfit > 0 && <FlatRow name="Gross profit c/o" paise={data.grossProfit} strong />}
          <div className="my-2 border-t border-line" />
          <StatementTree key={`ie-${treeKey}`} nodes={data.indirectExpenses} {...tree} />
          {data.netProfit > 0 && <FlatRow name="Net profit" paise={data.netProfit} strong tone="dr" />}
        </Panel>

        <Panel className="p-4">
          <p className="mb-2 text-caption font-semibold tracking-[0.08em] text-muted uppercase">Incomes</p>
          <StatementTree key={`ti-${treeKey}`} nodes={data.tradingIncomes} {...tree} />
          {data.closingStock !== 0 && <FlatRow name="Closing stock" paise={data.closingStock} />}
          {data.grossProfit < 0 && <FlatRow name="Gross loss c/o" paise={-data.grossProfit} strong />}
          <div className="my-2 border-t border-line" />
          <StatementTree key={`ii-${treeKey}`} nodes={data.indirectIncomes} {...tree} />
          {data.grossProfit > 0 && <FlatRow name="Gross profit b/f" paise={data.grossProfit} />}
          {data.netProfit < 0 && <FlatRow name="Net loss" paise={-data.netProfit} strong tone="cr" />}
        </Panel>
      </div>

      <Panel className="mt-3 flex items-center justify-between px-5 py-3">
        <span className="text-body font-medium">{data.netProfit >= 0 ? 'Net profit for the period' : 'Net loss for the period'}</span>
        <Money paise={Math.abs(data.netProfit)} className={`text-title font-semibold ${data.netProfit >= 0 ? 'text-dr' : 'text-cr'}`} />
      </Panel>
      </>
      )}
    </Page>
  )
}

/** Display options shared by the P&L and Balance sheet drawers. */
export function StatementOptions({
  expandAll,
  hideZero,
  onExpandAll,
  onHideZero
}: {
  expandAll: boolean
  hideZero: boolean
  onExpandAll: (v: boolean) => void
  onHideZero: (v: boolean) => void
}): React.JSX.Element {
  return (
    <DrawerSection title="Display" testId="options-display">
      <OptionToggle label="Expand every group" hint="Default shows the top-level groups only." checked={expandAll} onChange={onExpandAll} testId="input-statement-expand-all" />
      <OptionToggle label="Hide zero-balance groups and ledgers" checked={hideZero} onChange={onHideZero} testId="input-statement-hide-zero" />
    </DrawerSection>
  )
}

/** "Comparative" drawer section shared by the P&L and Balance sheet (WP 6.2). */
export function ComparativeOptions({
  comparative,
  onComparative,
  budgetId,
  onBudget,
  budgets
}: {
  comparative: boolean
  onComparative: (v: boolean) => void
  budgetId?: string
  onBudget?: (v: string) => void
  budgets?: { id: number; name: string }[]
}): React.JSX.Element {
  return (
    <DrawerSection title="Comparative" testId="options-comparative">
      <OptionToggle
        label="Compare periods"
        hint="This period, the previous period and the same period last year, side by side."
        checked={comparative}
        onChange={onComparative}
        testId="input-statement-comparative"
      />
      {comparative && onBudget && budgets && budgets.length > 0 && (
        <label className="flex flex-col gap-1 text-detail">
          <span>Budget column</span>
          <Select value={budgetId ?? ''} onChange={(e) => onBudget(e.target.value)} data-testid="input-statement-budget">
            <option value="">No budget</option>
            {budgets.map((b) => <option key={b.id} value={String(b.id)}>{b.name}</option>)}
          </Select>
        </label>
      )}
    </DrawerSection>
  )
}

/** Header + panel placeholder while a statement report loads (P&L, Balance sheet, Cash flow). */
export function ReportSkeleton({ title }: { title: string }): React.JSX.Element {
  return (
    <Page>
      <PageHeader title={title} />
      <Panel>
        <SkeletonRows />
      </Panel>
    </Page>
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
