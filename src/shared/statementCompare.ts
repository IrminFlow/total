/**
 * Pairing a statement against the same statement for an earlier period.
 *
 * The P&L and Balance Sheet services already compute a `prior` tree; nothing displayed it,
 * because the two trees are separate structures and a column view needs them line by line.
 *
 * Matching is by (kind, id) rather than by name or by position. Position is wrong the moment a
 * ledger existed in one period and not the other -- which is exactly the case a comparison is
 * for -- and name is wrong the moment a ledger is renamed, which would silently show a real
 * account as "new this year" alongside a phantom that "disappeared".
 *
 * A line present in only one period is kept, with zero on the other side. Dropping it would hide
 * the most interesting rows: the expense that started, and the income that stopped.
 */

import type { StatementNode } from './reports'

export interface ComparedNode {
  id: number
  kind: StatementNode['kind']
  name: string
  amount: number
  priorAmount: number
  /** amount − priorAmount, in paise. */
  change: number
  /**
   * Change as a fraction of the prior amount, or null when there is nothing to divide by.
   *
   * Null rather than Infinity or 100%: a line that went from nothing to something has no
   * meaningful percentage change, and printing one would invite a comparison that is not there.
   */
  changeRatio: number | null
  /** True when the line exists in only one of the two periods. */
  onlyIn: 'current' | 'prior' | null
  children: ComparedNode[]
}

const keyOf = (n: { kind: string; id: number; name: string }): string =>
  // Computed nodes (gross profit, and similar) carry no real id, so they fall back to their name.
  n.kind === 'computed' ? `computed:${n.name}` : `${n.kind}:${n.id}`

function ratio(amount: number, prior: number): number | null {
  if (prior === 0) return null
  return (amount - prior) / Math.abs(prior)
}

/**
 * Merge two statement trees into one comparable tree.
 *
 * Order follows the current period, with lines that exist only in the prior period appended at
 * the end of their level — they have no place in the current ordering, and putting them last is
 * honest about that rather than guessing where they used to sit.
 */
export function compareStatements(
  current: StatementNode[],
  prior: StatementNode[]
): ComparedNode[] {
  const priorByKey = new Map(prior.map((n) => [keyOf(n), n]))
  const seen = new Set<string>()

  const out: ComparedNode[] = current.map((node) => {
    const key = keyOf(node)
    seen.add(key)
    const match = priorByKey.get(key)
    const priorAmount = match?.amount ?? 0
    return {
      id: node.id,
      kind: node.kind,
      name: node.name,
      amount: node.amount,
      priorAmount,
      change: node.amount - priorAmount,
      changeRatio: ratio(node.amount, priorAmount),
      onlyIn: match ? null : 'current',
      children: compareStatements(node.children, match?.children ?? [])
    }
  })

  for (const node of prior) {
    const key = keyOf(node)
    if (seen.has(key)) continue
    out.push({
      id: node.id,
      kind: node.kind,
      name: node.name,
      amount: 0,
      priorAmount: node.amount,
      change: -node.amount,
      changeRatio: ratio(0, node.amount),
      onlyIn: 'prior',
      // Everything under a line that no longer exists is also gone; recursing with an empty
      // current side gives each child the same treatment rather than dropping the subtree.
      children: compareStatements([], node.children)
    })
  }

  return out
}
