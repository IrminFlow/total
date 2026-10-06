// Chart of accounts — the Masters → Groups tree with ledgers as leaves, plus the pure
// filtering helpers both Masters tabs use. No DB, no DOM: balances are handed in by the
// caller (main computes them with the trial balance's closing-balance query).
import type { Nature } from './domain'

export interface ChartLedgerNode {
  kind: 'ledger'
  id: number
  name: string
  groupId: number
  gstin: string | null
  pan: string | null
  /** Signed paise, dr-positive, opening included. */
  balance: number
}

export interface ChartGroupNode {
  kind: 'group'
  id: number
  name: string
  parentId: number | null
  nature: Nature
  isSystem: boolean
  /** Sum of every ledger in this group and its descendants (signed paise, dr-positive). */
  balance: number
  /** Ledgers in this group and its descendants. */
  ledgerCount: number
  /** Sub-groups, name-ordered. */
  children: ChartGroupNode[]
  /** Ledgers directly under this group, name-ordered. */
  ledgers: ChartLedgerNode[]
}

export interface ChartGroupInput {
  id: number
  name: string
  parentId: number | null
  nature: Nature
  isSystem: boolean
}

export interface ChartLedgerInput {
  id: number
  name: string
  groupId: number
  gstin: string | null
  pan: string | null
}

const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name)

/** Build the full tree. Groups whose parent is missing become roots (same as groupTree);
 *  ledgers whose group is missing are dropped (FK makes that impossible in practice). */
export function buildChartOfAccounts(
  groups: ChartGroupInput[],
  ledgers: ChartLedgerInput[],
  balanceOf: (ledgerId: number) => number
): ChartGroupNode[] {
  const nodes = new Map<number, ChartGroupNode>()
  for (const g of groups) {
    nodes.set(g.id, {
      kind: 'group', id: g.id, name: g.name, parentId: g.parentId, nature: g.nature, isSystem: g.isSystem,
      balance: 0, ledgerCount: 0, children: [], ledgers: []
    })
  }
  const roots: ChartGroupNode[] = []
  for (const n of nodes.values()) {
    if (n.parentId != null && nodes.has(n.parentId) && n.parentId !== n.id) nodes.get(n.parentId)!.children.push(n)
    else roots.push(n)
  }
  for (const l of ledgers) {
    const g = nodes.get(l.groupId)
    if (!g) continue
    g.ledgers.push({ kind: 'ledger', id: l.id, name: l.name, groupId: l.groupId, gstin: l.gstin, pan: l.pan, balance: balanceOf(l.id) })
  }
  const visited = new Set<number>()
  const finish = (n: ChartGroupNode): void => {
    if (visited.has(n.id)) return // defensive against a parent cycle
    visited.add(n.id)
    n.children.sort(byName)
    n.ledgers.sort(byName)
    let balance = n.ledgers.reduce((s, l) => s + l.balance, 0)
    let count = n.ledgers.length
    for (const c of n.children) {
      finish(c)
      balance += c.balance
      count += c.ledgerCount
    }
    n.balance = balance
    n.ledgerCount = count
  }
  roots.sort(byName)
  roots.forEach(finish)
  return roots
}

const norm = (s: string): string => s.trim().toLowerCase()

/** Prune the tree to what matches `query` (case-insensitive substring on group and ledger names).
 *  - A ledger is kept when its name matches.
 *  - A group whose own name matches is kept whole (all sub-groups and ledgers) and expanded.
 *  - A group is otherwise kept when anything beneath it matches, showing only the matching path.
 *  `expand` holds every ancestor group of a match so the matches are visible. Node balances and
 *  counts keep their true (unfiltered) totals. An empty query returns the tree unchanged. */
export function filterChartTree(roots: ChartGroupNode[], query: string): { roots: ChartGroupNode[]; expand: Set<number> } {
  const q = norm(query)
  const expand = new Set<number>()
  if (!q) return { roots, expand }

  const visit = (n: ChartGroupNode, ancestors: number[]): ChartGroupNode | null => {
    const path = [...ancestors, n.id]
    if (n.name.toLowerCase().includes(q)) {
      for (const id of path) expand.add(id) // the matched group opens one level too
      return n
    }
    const ledgers = n.ledgers.filter((l) => l.name.toLowerCase().includes(q))
    const children = n.children.map((c) => visit(c, path)).filter((c): c is ChartGroupNode => c !== null)
    if (!ledgers.length && !children.length) return null
    if (ledgers.length) for (const id of path) expand.add(id)
    return { ...n, children, ledgers }
  }

  return { roots: roots.map((r) => visit(r, [])).filter((r): r is ChartGroupNode => r !== null), expand }
}

/** Every group id in the tree. */
export function allGroupIds(roots: ChartGroupNode[]): Set<number> {
  const out = new Set<number>()
  const walk = (n: ChartGroupNode): void => {
    out.add(n.id)
    n.children.forEach(walk)
  }
  roots.forEach(walk)
  return out
}

// ---------- flat-list helpers (Ledgers tab) ----------

export interface GroupLink {
  id: number
  name: string
  parentId: number | null
}

/** groupId → names of the group and all its ancestors (nearest first). */
export function groupChains(groups: GroupLink[]): Map<number, string[]> {
  const byId = new Map(groups.map((g) => [g.id, g]))
  const out = new Map<number, string[]>()
  for (const g of groups) {
    const chain: string[] = []
    const seen = new Set<number>()
    let cur: GroupLink | undefined = g
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id)
      chain.push(cur.name)
      cur = cur.parentId != null ? byId.get(cur.parentId) : undefined
    }
    out.set(g.id, chain)
  }
  return out
}

/** The group and every group beneath it (inclusive). */
export function descendantGroupIds(groups: GroupLink[], rootId: number): Set<number> {
  const children = new Map<number, number[]>()
  for (const g of groups) {
    if (g.parentId == null) continue
    const list = children.get(g.parentId) ?? []
    list.push(g.id)
    children.set(g.parentId, list)
  }
  const out = new Set<number>()
  const stack = [rootId]
  while (stack.length) {
    const id = stack.pop()!
    if (out.has(id)) continue
    out.add(id)
    for (const c of children.get(id) ?? []) stack.push(c)
  }
  return out
}

export interface FilterableLedger {
  name: string
  groupId: number
  gstin: string | null
  pan: string | null
}

/** Case-insensitive substring match on the ledger name, its group, any ancestor group, GSTIN or PAN. */
export function ledgerMatches(ledger: FilterableLedger, query: string, chains: Map<number, string[]>): boolean {
  const q = norm(query)
  if (!q) return true
  const hay = [ledger.name, ledger.gstin ?? '', ledger.pan ?? '', ...(chains.get(ledger.groupId) ?? [])]
  return hay.some((s) => s.toLowerCase().includes(q))
}

/** Apply the Ledgers-tab text filter and (optional) group dropdown, which includes descendant groups. */
export function filterLedgers<L extends FilterableLedger>(
  ledgers: L[],
  groups: GroupLink[],
  query: string,
  groupId: number | null
): L[] {
  const chains = groupChains(groups)
  const inGroup = groupId != null ? descendantGroupIds(groups, groupId) : null
  return ledgers.filter((l) => (!inGroup || inGroup.has(l.groupId)) && ledgerMatches(l, query, chains))
}
