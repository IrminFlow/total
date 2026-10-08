import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { BalanceSheet, ProfitAndLoss, StatementNode } from '@shared/reports'
import { variance } from '@shared/reportBuilder/shape'
import { toDisplayDate } from '@shared/dates'
import { reportsApi, type BudgetAmounts, type ComparativeColumn } from '../lib/reportsClient'
import { Money, Panel, SkeletonRows } from './ui'
import { STATEMENT_COLUMN_W, StatementTree, type StatementColumn } from './StatementTree'

// ---------------------------------------------------------------- pure helpers (tested)

export const nodeKey = (n: Pick<StatementNode, 'kind' | 'id' | 'name'>): string => `${n.kind}:${n.id}:${n.kind === 'computed' ? n.name : ''}`

/** Union of several statements' trees (same shape rules): every node any column has, amounts
 *  from the FIRST list (0 when only another column has it), children merged recursively. */
export function unionTrees(lists: StatementNode[][]): StatementNode[] {
  const order: string[] = []
  const byKey = new Map<string, { first: StatementNode | null; any: StatementNode; childLists: StatementNode[][] }>()
  lists.forEach((nodes, li) => {
    for (const n of nodes) {
      const k = nodeKey(n)
      let e = byKey.get(k)
      if (!e) {
        e = { first: null, any: n, childLists: lists.map(() => []) }
        byKey.set(k, e)
        order.push(k)
      }
      if (li === 0) e.first = n
      e.childLists[li] = n.children
    }
  })
  return order.map((k) => {
    const e = byKey.get(k)!
    return { ...e.any, amount: e.first?.amount ?? 0, children: unionTrees(e.childLists) }
  })
}

/** Every node's amount by key. */
export function amountIndex(nodes: StatementNode[], out = new Map<string, number>()): Map<string, number> {
  for (const n of nodes) {
    out.set(nodeKey(n), n.amount)
    amountIndex(n.children, out)
  }
  return out
}

/** A node's budget: a ledger's own lines; a group's own lines plus everything under it. */
export function budgetOf(node: StatementNode, b: BudgetAmounts): number {
  if (node.kind === 'ledger') return b.ledgers[node.id] ?? 0
  if (node.kind !== 'group') return 0
  return (b.groups[node.id] ?? 0) + node.children.reduce((s, c) => s + budgetOf(c, b), 0)
}

// ---------------------------------------------------------------- view

interface FlatLine {
  label: string
  values: (number | null)[]
  strong?: boolean
}

function HeaderRow({ labels }: { labels: string[] }): React.JSX.Element {
  return (
    <div className="flex items-end justify-between border-b border-line px-2 pb-1.5 text-caption font-semibold tracking-[0.06em] text-muted uppercase">
      <span>Particulars</span>
      <span className="flex">
        {labels.map((l) => <span key={l} className={`${STATEMENT_COLUMN_W} text-right`}>{l}</span>)}
      </span>
    </div>
  )
}

function Line({ line }: { line: FlatLine }): React.JSX.Element {
  return (
    <div className={`flex items-center justify-between px-2 py-1 ${line.strong ? 'font-medium' : ''}`}>
      <span className="text-detail">{line.label}</span>
      <span className="flex">
        {line.values.map((v, i) => (
          <span key={i} className={`${STATEMENT_COLUMN_W} text-right ${i > 0 ? 'text-muted' : ''}`}>
            {v === null ? '' : <Money paise={v} className="text-detail" />}
          </span>
        ))}
      </span>
    </div>
  )
}

function Section({ title, trees, columns, budget, tree, labels }: {
  title: string
  trees: StatementNode[][]
  columns: ComparativeColumn[]
  budget: BudgetAmounts | null
  tree: { expandAll: boolean; hideZero: boolean }
  labels: string[]
}): React.JSX.Element | null {
  const merged = useMemo(() => unionTrees(trees), [trees])
  const extra = useMemo<StatementColumn[]>(() => {
    const idx = trees.slice(1).map((t) => amountIndex(t))
    const cols: StatementColumn[] = idx.map((m, i) => ({ key: columns[i + 1]!.key, amountOf: (n) => m.get(nodeKey(n)) ?? 0 }))
    if (budget) cols.push({ key: 'budget', amountOf: (n) => budgetOf(n, budget) })
    const ly = idx[1]
    cols.push({ key: 'change', percent: true, amountOf: (n) => variance(n.amount, ly?.get(nodeKey(n)) ?? 0).pct })
    return cols
  }, [trees, columns, budget])
  if (merged.length === 0) return null
  return (
    <div className="mb-3">
      <p className="mt-2 mb-1 px-2 text-caption font-semibold tracking-[0.08em] text-muted uppercase">{title}</p>
      <StatementTree nodes={merged} columns={extra} {...tree} key={`${tree.expandAll}-${tree.hideZero}-${labels.length}`} />
    </div>
  )
}

/** Comparative P&L / balance sheet (WP 6.2): this period, the previous period and the same period
 *  last year side by side (and a budget for the P&L when chosen), with the change against last
 *  year. Reuses StatementTree with extra columns. */
export function ComparativeStatement({
  kind,
  from,
  to,
  budgetId,
  tree
}: {
  kind: 'pnl' | 'bs'
  from: string
  to: string
  budgetId: number | null
  tree: { expandAll: boolean; hideZero: boolean }
}): React.JSX.Element {
  const pnl = useQuery({ queryKey: ['pnlComparative', from, to], queryFn: () => reportsApi.comparativePnl(from, to), enabled: kind === 'pnl' })
  const bs = useQuery({ queryKey: ['bsComparative', from, to], queryFn: () => reportsApi.comparativeBs(from, to), enabled: kind === 'bs' })
  const budgetQ = useQuery({ queryKey: ['budgetAmounts', budgetId, from, to], queryFn: () => reportsApi.budgetAmounts(budgetId!, from, to), enabled: kind === 'pnl' && budgetId !== null })
  const data = kind === 'pnl' ? pnl.data : bs.data
  if (!data) return <Panel><SkeletonRows /></Panel>
  const budget = kind === 'pnl' && budgetId !== null ? (budgetQ.data ?? null) : null
  const labels = [
    ...data.columns.map((c) => (kind === 'bs' ? `${c.label === 'This period' ? 'As on' : c.label} ${toDisplayDate(c.to)}` : `${c.label}`)),
    ...(budget ? [`Budget`] : []),
    'vs last year'
  ]
  const shortLabels = kind === 'bs' ? labels.map((l) => l.replace('Previous period', 'Prev.').replace('Same period last year', 'Last yr')) : labels
  const flat = (label: string, get: (s: ProfitAndLoss) => number, strong = false, b: number | null = null): FlatLine => {
    const vals = (data.statements as ProfitAndLoss[]).map(get)
    return { label, strong, values: [...vals, ...(budget ? [b] : []), null] }
  }

  return (
    <Panel className="p-4" testId={`comparative-${kind}`}>
      <p className="mb-2 text-small text-muted">
        {data.columns.map((c) => `${c.label}: ${toDisplayDate(c.from)} → ${toDisplayDate(c.to)}`).join(' · ')}
        {budget && ` · Budget: ${budget.name}`}
      </p>
      <HeaderRow labels={shortLabels} />
      {kind === 'pnl' ? (
        <>
          {(data.statements as ProfitAndLoss[]).some((s) => s.openingStock) && <Line line={flat('Opening stock', (s) => s.openingStock)} />}
          <Section title="Trading incomes" trees={(data.statements as ProfitAndLoss[]).map((s) => s.tradingIncomes)} columns={data.columns} budget={budget} tree={tree} labels={labels} />
          <Section title="Trading expenses" trees={(data.statements as ProfitAndLoss[]).map((s) => s.tradingExpenses)} columns={data.columns} budget={budget} tree={tree} labels={labels} />
          {(data.statements as ProfitAndLoss[]).some((s) => s.closingStock) && <Line line={flat('Closing stock', (s) => s.closingStock)} />}
          <Line line={flat('Gross profit', (s) => s.grossProfit, true)} />
          <Section title="Indirect incomes" trees={(data.statements as ProfitAndLoss[]).map((s) => s.indirectIncomes)} columns={data.columns} budget={budget} tree={tree} labels={labels} />
          <Section title="Indirect expenses" trees={(data.statements as ProfitAndLoss[]).map((s) => s.indirectExpenses)} columns={data.columns} budget={budget} tree={tree} labels={labels} />
          <div className="mt-2 border-t border-line pt-1">
            <Line line={flat('Net profit', (s) => s.netProfit, true)} />
          </div>
        </>
      ) : (
        <>
          <Section title="Liabilities" trees={(data.statements as BalanceSheet[]).map((s) => s.liabilities)} columns={data.columns} budget={null} tree={tree} labels={labels} />
          <Line line={{ label: 'Total liabilities', strong: true, values: [...(data.statements as BalanceSheet[]).map((s) => s.totalLiabilities), null] }} />
          <Section title="Assets" trees={(data.statements as BalanceSheet[]).map((s) => s.assets)} columns={data.columns} budget={null} tree={tree} labels={labels} />
          <Line line={{ label: 'Total assets', strong: true, values: [...(data.statements as BalanceSheet[]).map((s) => s.totalAssets), null] }} />
        </>
      )}
    </Panel>
  )
}
