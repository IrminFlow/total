import type { Group } from '@shared/domain'

export const PARTY_GROUPS = ['Sundry Debtors', 'Sundry Creditors']
export const TAX_GROUPS = ['Duties & Taxes']
export const TRADING_GROUPS = [
  'Sales Accounts',
  'Purchase Accounts',
  'Direct Incomes',
  'Direct Expenses',
  'Indirect Incomes',
  'Indirect Expenses'
]

/** This group's own name plus every ancestor's name, walking parent_id up to the root. */
export function groupAncestryNames(groupId: number, groups: Group[]): string[] {
  const map = new Map(groups.map((g) => [g.id, g]))
  const names: string[] = []
  let g = map.get(groupId)
  while (g) {
    names.push(g.name)
    g = g.parentId ? map.get(g.parentId) : undefined
  }
  return names
}
