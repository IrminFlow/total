import { useState } from 'react'
import type { StatementNode } from '@shared/reports'
import { useNav } from '../state/stores'
import { Money } from './ui'

/** Drill-down tree used by P&L and Balance Sheet: groups expand, ledgers open their statement. */
export function StatementTree({ nodes, depth = 0 }: { nodes: StatementNode[]; depth?: number }): React.JSX.Element {
  return (
    <div>
      {nodes.map((n) => (
        <StatementRow key={`${n.kind}-${n.id}-${n.name}`} node={n} depth={depth} />
      ))}
    </div>
  )
}

function StatementRow({ node, depth }: { node: StatementNode; depth: number }): React.JSX.Element {
  const [open, setOpen] = useState(depth === 0)
  const nav = useNav()
  const isLeafLedger = node.kind === 'ledger'
  return (
    <>
      <button
        className="flex w-full items-center justify-between rounded px-2 py-1 text-left hover:bg-panel2"
        style={{ paddingLeft: `${8 + depth * 18}px` }}
        onClick={() => {
          if (isLeafLedger) nav.go({ name: 'ledger-statement', ledgerId: node.id })
          else if (node.children.length) setOpen((v) => !v)
        }}
      >
        <span className={`text-[13px] ${depth === 0 ? 'font-medium' : isLeafLedger ? 'text-muted' : ''}`}>
          {node.children.length > 0 && <span className="mr-1.5 inline-block w-3 text-[10px] text-muted">{open ? '▾' : '▸'}</span>}
          {node.name}
        </span>
        <Money paise={node.amount} className="text-[13px]" />
      </button>
      {open && node.children.length > 0 && <StatementTree nodes={node.children} depth={depth + 1} />}
    </>
  )
}
