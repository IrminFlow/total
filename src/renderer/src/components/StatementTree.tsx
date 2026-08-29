import { useState } from 'react'
import type { StatementNode } from '@shared/reports'
import type { ComparedNode } from '@shared/statementCompare'
import { useNav } from '../state/stores'
import { Money } from './ui'

/**
 * Drill-down tree used by P&L and Balance Sheet: groups expand, ledgers open their statement.
 *
 * Each row is a real `<button>`, which is what makes A17 ("Space folds a tree row") true here
 * without a line of key handling: the browser already activates a focused button on Space and
 * on Enter, and already swallows the page-scroll that Space would otherwise cause. Binding it
 * again in the list layer would fold the row twice — see `SPACE_ACTIVATES` in components/ui.tsx,
 * which is the guard that stops the two paths overlapping.
 */
export function StatementTree({
  nodes,
  depth = 0,
  percentOf
}: {
  nodes: StatementNode[]
  depth?: number
  /**
   * Base for a percentage column, in paise. Omitted, or zero, means no column.
   *
   * The base is passed down rather than computed per level on purpose: every line on a P&L should
   * be a percentage of the same thing (turnover), which is the only reading that lets two lines
   * be compared. A percentage of the parent subtotal would make "8%" mean something different on
   * every row.
   */
  percentOf?: number
}): React.JSX.Element {
  return (
    <div>
      {nodes.map((n) => (
        <StatementRow key={`${n.kind}-${n.id}-${n.name}`} node={n} depth={depth} percentOf={percentOf} />
      ))}
    </div>
  )
}

/** One decimal, and a dash rather than "0.0%" for a line that rounds away to nothing. */
function pctText(amount: number, base: number): string {
  if (!base) return ''
  const pct = (Math.abs(amount) * 1000) / Math.abs(base) // tenths of a percent, integer maths
  const rounded = Math.round(pct) / 10
  return rounded === 0 ? '–' : `${rounded.toFixed(1)}%`
}

function StatementRow({
  node,
  depth,
  percentOf
}: {
  node: StatementNode
  depth: number
  percentOf?: number
}): React.JSX.Element {
  const [open, setOpen] = useState(depth === 0)
  const nav = useNav()
  const isLeafLedger = node.kind === 'ledger'
  return (
    <>
      <button
        className="flex w-full items-center justify-between rounded-md px-2 py-1 text-left hover:bg-panel2"
        style={{ paddingLeft: `${8 + depth * 18}px` }}
        data-tree-row={node.name}
        aria-expanded={node.children.length > 0 ? open : undefined}
        onClick={() => {
          if (isLeafLedger) nav.go({ name: 'ledger-statement', ledgerId: node.id })
          else if (node.children.length) setOpen((v) => !v)
        }}
      >
        <span className={`text-detail ${depth === 0 ? 'font-medium' : isLeafLedger ? 'text-muted' : ''}`}>
          {node.children.length > 0 && <span className="mr-1.5 inline-block w-3 text-label text-muted">{open ? '▾' : '▸'}</span>}
          {node.name}
        </span>
        <span className="flex items-baseline gap-3">
          <Money paise={node.amount} className="text-detail" />
          {percentOf ? (
            <span className="num w-14 text-right text-hint text-muted" data-testid="statement-pct">
              {pctText(node.amount, percentOf)}
            </span>
          ) : null}
        </span>
      </button>
      {open && node.children.length > 0 && (
        <StatementTree nodes={node.children} depth={depth + 1} percentOf={percentOf} />
      )}
    </>
  )
}

/**
 * The same tree, with a prior-period column and the change beside it.
 *
 * A separate component rather than more props on StatementTree: the row is genuinely a different
 * shape (three numeric columns, not one), and threading an optional prior through every row would
 * make the common case harder to read for the sake of the rarer one.
 */
export function ComparedStatementTree({
  nodes,
  depth = 0
}: {
  nodes: ComparedNode[]
  depth?: number
}): React.JSX.Element {
  return (
    <div>
      {nodes.map((n) => (
        <ComparedRow key={`${n.kind}-${n.id}-${n.name}`} node={n} depth={depth} />
      ))}
    </div>
  )
}

function ComparedRow({ node, depth }: { node: ComparedNode; depth: number }): React.JSX.Element {
  const [open, setOpen] = useState(depth === 0)
  const nav = useNav()
  const isLeafLedger = node.kind === 'ledger'
  return (
    <>
      <button
        className="flex w-full items-center justify-between rounded-md px-2 py-1 text-left hover:bg-panel2"
        style={{ paddingLeft: `${8 + depth * 18}px` }}
        data-tree-row={node.name}
        aria-expanded={node.children.length > 0 ? open : undefined}
        onClick={() => {
          if (isLeafLedger) nav.go({ name: 'ledger-statement', ledgerId: node.id })
          else if (node.children.length) setOpen((v) => !v)
        }}
      >
        <span className={`text-detail ${depth === 0 ? 'font-medium' : isLeafLedger ? 'text-muted' : ''}`}>
          {node.children.length > 0 && (
            <span className="mr-1.5 inline-block w-3 text-label text-muted">{open ? '▾' : '▸'}</span>
          )}
          {node.name}
          {/* A line that exists in only one period is the interesting kind, so it says so rather
              than leaving the reader to notice a zero. */}
          {node.onlyIn === 'current' && <span className="ml-2 text-hint text-dr">new</span>}
          {node.onlyIn === 'prior' && <span className="ml-2 text-hint text-muted">ended</span>}
        </span>
        <span className="flex items-baseline gap-4">
          <Money paise={node.amount} className="w-32 text-right text-detail" />
          <Money paise={node.priorAmount} className="w-32 text-right text-detail text-muted" />
          <span
            className={`num w-24 text-right text-detail ${node.change > 0 ? 'text-dr' : node.change < 0 ? 'text-cr' : 'text-muted'}`}
            data-testid="statement-change"
          >
            {node.changeRatio == null
              ? '—'
              : `${node.changeRatio > 0 ? '+' : ''}${(node.changeRatio * 100).toFixed(0)}%`}
          </span>
        </span>
      </button>
      {open && node.children.length > 0 && <ComparedStatementTree nodes={node.children} depth={depth + 1} />}
    </>
  )
}
