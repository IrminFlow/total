import { useState } from 'react'
import type { StatementNode } from '@shared/reports'
import { Money } from './ui'
import { LedgerLink, drillRowProps } from './links'
import { isRealId, openLedgerStatement } from '../lib/drill'
import { ExplainButton } from './kit/ExplainButton'
import { figureText, useAiAffordances } from '../lib/explain'

/** An extra figure column (comparatives, WP 6.2): `amountOf` a node, null = blank. */
export interface StatementColumn {
  key: string
  amountOf: (node: StatementNode) => number | null
  /** Render as a percentage (variance %) rather than money. */
  percent?: boolean
}

/** Width of each extra column, so the header row above the tree can line up with it. */
export const STATEMENT_COLUMN_W = 'w-32'

function ExtraCells({ node, columns }: { node: StatementNode; columns: StatementColumn[] }): React.JSX.Element {
  return (
    <>
      {columns.map((c) => {
        const v = c.amountOf(node)
        return (
          <span key={c.key} className={`${STATEMENT_COLUMN_W} shrink-0 text-right text-detail text-muted`} data-col={c.key}>
            {v === null ? '' : c.percent ? <span className="num">{`${v > 0 ? '+' : ''}${v.toFixed(1)}%`}</span> : <Money paise={v} className="text-detail" />}
          </span>
        )
      })}
    </>
  )
}

/** Drill-down tree used by P&L and Balance Sheet: groups expand; a ledger leaf's NAME opens its
 *  edit window and the rest of its row opens its statement. `columns` adds comparative figures
 *  after the node's own amount. WP 5.2: while the assistant is on, every line's amount has an
 *  "Explain this" action (a ledger by id, a group by name). */
export function StatementTree({
  nodes,
  depth = 0,
  expandAll = false,
  hideZero = false,
  columns
}: {
  nodes: StatementNode[]
  depth?: number
  /** Open every group (default: only the top level). Re-keyed by the caller to re-apply. */
  expandAll?: boolean
  /** Leave out groups and ledgers whose amount is zero. */
  hideZero?: boolean
  columns?: StatementColumn[]
}): React.JSX.Element {
  return (
    <div>
      {nodes
        .filter((n) => !hideZero || n.amount !== 0)
        .map((n) => (
          <StatementRow key={`${n.kind}-${n.id}-${n.name}`} node={n} depth={depth} expandAll={expandAll} hideZero={hideZero} columns={columns} />
      ))}
    </div>
  )
}

const ROW_CLS = 'flex w-full items-center justify-between rounded px-2 py-1 text-left hover:bg-panel2'

function StatementRow({
  node,
  depth,
  expandAll,
  hideZero,
  columns
}: {
  node: StatementNode
  depth: number
  expandAll: boolean
  hideZero: boolean
  columns?: StatementColumn[]
}): React.JSX.Element {
  const amount = columns ? (
    <span className="flex shrink-0 items-center">
      <span className={`${STATEMENT_COLUMN_W} text-right`}><Money paise={node.amount} className="text-detail" /></span>
      <ExtraCells node={node} columns={columns} />
    </span>
  ) : (
    <Money paise={node.amount} className="text-detail" />
  )
  const [open, setOpen] = useState(depth === 0 || expandAll)
  const isLeafLedger = node.kind === 'ledger' && isRealId(node.id)
  const style = { paddingLeft: `${8 + depth * 18}px` }
  const nameCls = `text-detail ${depth === 0 ? 'font-medium' : isLeafLedger ? 'text-muted' : ''}`
  const aiOn = useAiAffordances()
  // The action sits beside the row (a group row is a button), right of the amount.
  const explain =
    aiOn && node.amount !== 0 ? (
      <ExplainButton
        testId="statement-explain"
        className="t-explain-reveal absolute top-1/2 right-1 -translate-y-1/2"
        figure={{
          label: node.name,
          value: figureText(node.amount),
          paise: node.amount,
          ...(isLeafLedger ? { ledgerId: node.id } : { groupName: node.name })
        }}
      />
    ) : null
  const wrap = (row: React.JSX.Element): React.JSX.Element => (explain ? <div className="t-explain-host relative pr-6">{row}{explain}</div> : row)

  if (isLeafLedger) {
    return wrap(
      <div
        className={`${ROW_CLS} cursor-pointer focus-visible:bg-panel2 focus-visible:outline-none`}
        style={style}
        title={`Open ${node.name} statement`}
        data-testid="statement-ledger"
        {...drillRowProps(() => openLedgerStatement(node.id), node.id)}
      >
        <span className={`min-w-0 truncate ${nameCls}`}>
          <LedgerLink ledgerId={node.id} name={node.name} />
        </span>
        {amount}
      </div>
    )
  }

  return (
    <>
      {wrap(<button
        type="button"
        className={ROW_CLS}
        style={style}
        aria-expanded={node.children.length > 0 ? open : undefined}
        onClick={() => {
          if (node.children.length) setOpen((v) => !v)
        }}
      >
        <span className={nameCls}>
          {node.children.length > 0 && (
            <span aria-hidden="true" className="mr-1.5 inline-block w-3 text-micro text-muted">
              {open ? '▾' : '▸'}
            </span>
          )}
          {node.name}
        </span>
        {amount}
      </button>)}
      {open && node.children.length > 0 && <StatementTree nodes={node.children} depth={depth + 1} expandAll={expandAll} hideZero={hideZero} columns={columns} />}
    </>
  )
}
