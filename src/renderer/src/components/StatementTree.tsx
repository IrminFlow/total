import { useState } from 'react'
import type { StatementNode } from '@shared/reports'
import { Money } from './ui'
import { LedgerLink, drillRowProps } from './links'
import { isRealId, openLedgerStatement } from '../lib/drill'

/** Drill-down tree used by P&L and Balance Sheet: groups expand; a ledger leaf's NAME opens its
 *  edit window and the rest of its row opens its statement. */
export function StatementTree({ nodes, depth = 0 }: { nodes: StatementNode[]; depth?: number }): React.JSX.Element {
  return (
    <div>
      {nodes.map((n) => (
        <StatementRow key={`${n.kind}-${n.id}-${n.name}`} node={n} depth={depth} />
      ))}
    </div>
  )
}

const ROW_CLS = 'flex w-full items-center justify-between rounded px-2 py-1 text-left hover:bg-panel2'

function StatementRow({ node, depth }: { node: StatementNode; depth: number }): React.JSX.Element {
  const [open, setOpen] = useState(depth === 0)
  const isLeafLedger = node.kind === 'ledger' && isRealId(node.id)
  const style = { paddingLeft: `${8 + depth * 18}px` }
  const nameCls = `text-[13px] ${depth === 0 ? 'font-medium' : isLeafLedger ? 'text-muted' : ''}`

  if (isLeafLedger) {
    return (
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
        <Money paise={node.amount} className="text-[13px]" />
      </div>
    )
  }

  return (
    <>
      <button
        className={ROW_CLS}
        style={style}
        onClick={() => {
          if (node.children.length) setOpen((v) => !v)
        }}
      >
        <span className={nameCls}>
          {node.children.length > 0 && <span className="mr-1.5 inline-block w-3 text-[10px] text-muted">{open ? '▾' : '▸'}</span>}
          {node.name}
        </span>
        <Money paise={node.amount} className="text-[13px]" />
      </button>
      {open && node.children.length > 0 && <StatementTree nodes={node.children} depth={depth + 1} />}
    </>
  )
}
