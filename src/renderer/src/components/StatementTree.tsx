import { useState } from 'react'
import type { StatementNode } from '@shared/reports'
import { useNav } from '../state/stores'
import { Money } from './ui'

/** Drill-down tree used by P&L and Balance Sheet: groups expand, ledgers open their statement. */
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
