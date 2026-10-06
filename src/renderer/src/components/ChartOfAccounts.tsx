// Masters → Groups: the chart of accounts. Groups nest with their ledgers as leaves, each node
// showing its ledger count (descendants included) and closing balance. Presentation only — the
// caller fetches the tree (api.groups.chart) and supplies the group actions.
import { useMemo, useState, type ReactNode } from 'react'
import { allGroupIds, filterChartTree, type ChartGroupNode, type ChartLedgerNode } from '@shared/chartOfAccounts'
import { Button, EmptyState, Money, TextInput } from './ui'
import { LedgerLink, drillRowProps } from './links'

const NATURE_TONE = { asset: 'text-dr', liability: 'text-cr', income: 'text-blue', expense: 'text-amber' } as const

/** Default view: top-level groups open one level (their sub-groups and ledgers show). */
const defaultExpanded = (roots: ChartGroupNode[]): Set<number> => new Set(roots.map((r) => r.id))

export function ChartOfAccounts({
  tree,
  onOpenLedger,
  groupActions
}: {
  tree: ChartGroupNode[]
  onOpenLedger: (ledgerId: number) => void
  /** Hover actions rendered on a group row (rename / move / delete). */
  groupActions?: (node: ChartGroupNode) => ReactNode
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  // null = the default expansion, derived from whatever tree is loaded.
  const [expanded, setExpanded] = useState<Set<number> | null>(null)
  const open = expanded ?? defaultExpanded(tree)
  const filtered = useMemo(() => filterChartTree(tree, query), [tree, query])

  const onQuery = (q: string): void => {
    setQuery(q)
    // Matches' ancestors open as you type; clearing the box returns to the default view.
    setExpanded(q.trim() ? new Set([...defaultExpanded(tree), ...filterChartTree(tree, q).expand]) : null)
  }
  const toggle = (id: number): void => {
    const next = new Set(open)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setExpanded(next)
  }

  return (
    <div>
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <div className="w-72 shrink-0">
          <TextInput
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="Filter groups and ledgers…"
            aria-label="Filter groups and ledgers"
            data-testid="coa-filter"
          />
        </div>
        <span className="flex-1" />
        <Button variant="ghost" className="whitespace-nowrap" data-testid="coa-expand-all" onClick={() => setExpanded(allGroupIds(tree))}>
          Expand all
        </Button>
        <Button variant="ghost" className="whitespace-nowrap" data-testid="coa-collapse-all" onClick={() => setExpanded(new Set())}>
          Collapse all
        </Button>
      </div>
      {filtered.roots.length === 0 ? (
        <EmptyState title={query.trim() ? 'No groups or ledgers match' : 'No groups yet'} />
      ) : (
        <div className="p-2" role="tree" aria-label="Chart of accounts" data-testid="coa-tree">
          {filtered.roots.map((n) => (
            <GroupRow key={n.id} node={n} depth={0} open={open} onToggle={toggle} onOpenLedger={onOpenLedger} groupActions={groupActions} />
          ))}
        </div>
      )}
    </div>
  )
}

function GroupRow({
  node,
  depth,
  open,
  onToggle,
  onOpenLedger,
  groupActions
}: {
  node: ChartGroupNode
  depth: number
  open: Set<number>
  onToggle: (id: number) => void
  onOpenLedger: (ledgerId: number) => void
  groupActions?: (node: ChartGroupNode) => ReactNode
}): React.JSX.Element {
  const isOpen = open.has(node.id)
  const hasContent = node.children.length > 0 || node.ledgers.length > 0
  return (
    <div role="treeitem" aria-expanded={hasContent ? isOpen : undefined} aria-selected={false}>
      <div
        data-testid="coa-group"
        data-row-id={node.id}
        className="group flex items-center gap-2 rounded px-2 py-1 hover:bg-panel2"
        style={{ paddingLeft: `${8 + depth * 18}px` }}
      >
        <button
          type="button"
          data-testid="coa-toggle"
          aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${node.name}`}
          disabled={!hasContent}
          onClick={() => onToggle(node.id)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left disabled:cursor-default"
        >
          <span aria-hidden="true" className={`w-3 shrink-0 text-[11px] text-muted ${hasContent ? '' : 'invisible'}`}>
            {isOpen ? '▾' : '▸'}
          </span>
          <span className={`truncate text-[13px] ${depth === 0 ? 'font-semibold text-ink' : 'font-medium text-ink'}`}>{node.name}</span>
          {depth === 0 && <span className={`text-[10.5px] uppercase tracking-wider ${NATURE_TONE[node.nature]}`}>{node.nature}</span>}
        </button>
        {groupActions && <span className="flex gap-2 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">{groupActions(node)}</span>}
        <span className="w-20 shrink-0 text-right text-[11.5px] text-muted" data-testid="coa-count">
          {node.ledgerCount} {node.ledgerCount === 1 ? 'ledger' : 'ledgers'}
        </span>
        <span className="w-40 shrink-0 text-right text-[13px] font-medium" data-testid="coa-balance">
          <Money paise={node.balance} signed />
        </span>
      </div>
      {isOpen && (
        <div role="group">
          {node.children.map((c) => (
            <GroupRow key={c.id} node={c} depth={depth + 1} open={open} onToggle={onToggle} onOpenLedger={onOpenLedger} groupActions={groupActions} />
          ))}
          {node.ledgers.map((l) => (
            <LedgerLeaf key={l.id} ledger={l} depth={depth + 1} onOpen={onOpenLedger} />
          ))}
        </div>
      )}
    </div>
  )
}

/** A ledger leaf: the NAME opens the ledger's edit window (LedgerLink); the rest of the row — or
 *  Enter on it — calls `onOpen` (the statement). Not a <button>: it holds the link button. */
function LedgerLeaf({ ledger, depth, onOpen }: { ledger: ChartLedgerNode; depth: number; onOpen: (id: number) => void }): React.JSX.Element {
  return (
    <div
      {...drillRowProps(() => onOpen(ledger.id), ledger.id)}
      role="treeitem"
      aria-selected={false}
      data-testid="coa-ledger"
      data-ledger-id={ledger.id}
      title={`Open ${ledger.name} statement`}
      className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1 text-left hover:bg-panel2 focus-visible:bg-panel2 focus-visible:outline-none"
      style={{ paddingLeft: `${8 + depth * 18}px` }}
    >
      <span aria-hidden="true" className="w-3 shrink-0 text-center text-[10px] text-muted/60">•</span>
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">
        <LedgerLink ledgerId={ledger.id} name={ledger.name} />
      </span>
      <span className="w-40 shrink-0 text-right text-[12.5px]">
        <Money paise={ledger.balance} signed />
      </span>
    </div>
  )
}
