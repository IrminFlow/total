import { describe, expect, it } from 'vitest'
import {
  allGroupIds, buildChartOfAccounts, descendantGroupIds, filterChartTree, filterLedgers, groupChains, ledgerMatches,
  type ChartGroupInput, type ChartGroupNode, type ChartLedgerInput
} from './chartOfAccounts'

const GROUPS: ChartGroupInput[] = [
  { id: 1, name: 'Sales Accounts', parentId: null, nature: 'income', isSystem: true },
  { id: 2, name: 'Purchase Accounts', parentId: null, nature: 'expense', isSystem: true },
  { id: 3, name: 'Current Assets', parentId: null, nature: 'asset', isSystem: true },
  { id: 4, name: 'Sundry Debtors', parentId: 3, nature: 'asset', isSystem: true },
  { id: 5, name: 'Retail Debtors', parentId: 4, nature: 'asset', isSystem: false }
]
const LEDGERS: ChartLedgerInput[] = [
  { id: 10, name: 'Local Sale', groupId: 1, gstin: null, pan: null },
  { id: 11, name: 'Export Sale', groupId: 1, gstin: null, pan: null },
  { id: 20, name: 'Local Purchase', groupId: 2, gstin: null, pan: null },
  { id: 30, name: 'Acme Traders', groupId: 4, gstin: '27AAACA1234A1Z5', pan: 'AAACA1234A' },
  { id: 31, name: 'Walk-in Customer', groupId: 5, gstin: null, pan: 'BBBPB5678B' }
]
const BAL: Record<number, number> = { 10: -500000, 11: -100000, 20: 300000, 30: 250000, 31: 50000 }
const tree = (): ChartGroupNode[] => buildChartOfAccounts(GROUPS, LEDGERS, (id) => BAL[id] ?? 0)
const find = (roots: ChartGroupNode[], name: string): ChartGroupNode | undefined => {
  for (const r of roots) {
    if (r.name === name) return r
    const hit = find(r.children, name)
    if (hit) return hit
  }
  return undefined
}

describe('buildChartOfAccounts', () => {
  it('puts ledgers under their group with rolled-up balances and counts', () => {
    const roots = tree()
    expect(roots.map((r) => r.name)).toEqual(['Current Assets', 'Purchase Accounts', 'Sales Accounts'])
    const sales = find(roots, 'Sales Accounts')!
    expect(sales.ledgers.map((l) => l.name)).toEqual(['Export Sale', 'Local Sale'])
    expect(sales.balance).toBe(-600000)
    expect(sales.ledgerCount).toBe(2)
    const purchase = find(roots, 'Purchase Accounts')!
    expect(purchase.ledgers.map((l) => l.name)).toEqual(['Local Purchase'])
    expect(purchase.balance).toBe(300000)
    const ca = find(roots, 'Current Assets')!
    expect(ca.ledgers).toEqual([])
    expect(ca.ledgerCount).toBe(2)
    expect(ca.balance).toBe(300000)
    expect(find(roots, 'Sundry Debtors')!.ledgerCount).toBe(2)
  })

  it('shows empty groups with zero count and balance', () => {
    const roots = buildChartOfAccounts(GROUPS, [], () => 0)
    expect(find(roots, 'Retail Debtors')).toMatchObject({ ledgerCount: 0, balance: 0, ledgers: [] })
  })
})

describe('filterChartTree', () => {
  it('filter "Sales" returns Local Sale under an expanded Sales Accounts', () => {
    const { roots, expand } = filterChartTree(tree(), 'Sales')
    const sales = find(roots, 'Sales Accounts')!
    expect(sales.ledgers.map((l) => l.name)).toContain('Local Sale')
    expect(roots.map((r) => r.name)).toEqual(['Sales Accounts'])
    expect(expand.has(1)).toBe(true)
  })

  it('a group-name match keeps its whole subtree', () => {
    const { roots, expand } = filterChartTree(tree(), 'sundry')
    expect(find(roots, 'Retail Debtors')!.ledgers.map((l) => l.name)).toEqual(['Walk-in Customer'])
    expect(find(roots, 'Sundry Debtors')!.ledgers.map((l) => l.name)).toEqual(['Acme Traders'])
    expect([...expand].sort()).toEqual([3, 4])
  })

  it('a ledger-name match keeps and expands its ancestors only along the matching path', () => {
    const { roots, expand } = filterChartTree(tree(), 'walk-in')
    expect(roots.map((r) => r.name)).toEqual(['Current Assets'])
    const debtors = find(roots, 'Sundry Debtors')!
    expect(debtors.ledgers).toEqual([]) // Acme is not a match
    expect(find(roots, 'Retail Debtors')!.ledgers.map((l) => l.name)).toEqual(['Walk-in Customer'])
    expect([...expand].sort()).toEqual([3, 4, 5])
    // Totals stay true (unfiltered).
    expect(debtors.balance).toBe(300000)
  })

  it('matches "local" case-insensitively across several groups', () => {
    const { roots, expand } = filterChartTree(tree(), 'local')
    expect(find(roots, 'Sales Accounts')!.ledgers.map((l) => l.name)).toEqual(['Local Sale'])
    expect(find(roots, 'Purchase Accounts')!.ledgers.map((l) => l.name)).toEqual(['Local Purchase'])
    expect(expand.has(1) && expand.has(2)).toBe(true)
  })

  it('empty query returns everything unexpanded; no match returns nothing', () => {
    const t = tree()
    expect(filterChartTree(t, '  ').roots).toBe(t)
    expect(filterChartTree(t, 'zzz').roots).toEqual([])
  })

  it('allGroupIds lists every group', () => {
    expect([...allGroupIds(tree())].sort()).toEqual([1, 2, 3, 4, 5])
  })
})

describe('ledger filter (Ledgers tab)', () => {
  const chains = groupChains(GROUPS)

  it('builds nearest-first ancestor chains', () => {
    expect(chains.get(5)).toEqual(['Retail Debtors', 'Sundry Debtors', 'Current Assets'])
  })

  it('filter "Sales" returns Local Sale (matched through its group)', () => {
    const hits = filterLedgers(LEDGERS, GROUPS, 'Sales', null).map((l) => l.name)
    expect(hits).toContain('Local Sale')
    expect(hits).toContain('Export Sale')
  })

  it('matches ancestor group, GSTIN and PAN case-insensitively', () => {
    expect(filterLedgers(LEDGERS, GROUPS, 'current assets', null).map((l) => l.name)).toEqual(['Acme Traders', 'Walk-in Customer'])
    expect(filterLedgers(LEDGERS, GROUPS, '27aaaca', null).map((l) => l.name)).toEqual(['Acme Traders'])
    expect(filterLedgers(LEDGERS, GROUPS, 'bbbpb5678b', null).map((l) => l.name)).toEqual(['Walk-in Customer'])
    expect(ledgerMatches(LEDGERS[0]!, 'purchase', chains)).toBe(false)
  })

  it('group dropdown includes descendant groups', () => {
    expect([...descendantGroupIds(GROUPS, 3)].sort()).toEqual([3, 4, 5])
    expect(filterLedgers(LEDGERS, GROUPS, '', 4).map((l) => l.name)).toEqual(['Acme Traders', 'Walk-in Customer'])
    expect(filterLedgers(LEDGERS, GROUPS, 'walk', 3).map((l) => l.name)).toEqual(['Walk-in Customer'])
    expect(filterLedgers(LEDGERS, GROUPS, 'local', 1).map((l) => l.name)).toEqual(['Local Sale'])
  })
})
