/**
 * Group-wise subtotals for the trial balance.
 *
 * A trial balance is a list of ledgers, and on a real chart of accounts that list is long enough
 * that the question "how much is under Sundry Debtors" cannot be answered by reading it. This
 * folds the flat rows into sections with their own totals — the section total is computed from
 * exactly the rows shown under it, never from a separate query, so a collapsed section cannot
 * disagree with the rows it hides.
 */

import type { TrialBalanceRow } from './reports'

export interface TbTotals {
  debit: number
  credit: number
  opening: number
  movementDebit: number
  movementCredit: number
}

export interface TbGroupSection {
  /** Stable key for React and for the collapse-state set. */
  key: string
  name: string
  rows: TrialBalanceRow[]
  totals: TbTotals
}

export type TbGroupBy = 'group' | 'topGroup'

const zero = (): TbTotals => ({ debit: 0, credit: 0, opening: 0, movementDebit: 0, movementCredit: 0 })

function add(t: TbTotals, r: TrialBalanceRow): void {
  t.debit += r.debit
  t.credit += r.credit
  t.opening += r.opening
  t.movementDebit += r.movementDebit
  t.movementCredit += r.movementCredit
}

/**
 * Fold rows into sections. `topGroup` uses the primary (root) group — 'Current Assets' rather
 * than 'Sundry Debtors' — which is the level a balance sheet reads at; `group` keeps the ledger's
 * own immediate group.
 *
 * A row whose topGroupName the service did not supply falls back to its own group rather than
 * being dropped: a ledger missing from a subtotalled report is invisible, and an invisible ledger
 * in a trial balance is the one failure mode this report exists to prevent.
 */
export function groupTrialBalance(rows: TrialBalanceRow[], by: TbGroupBy): TbGroupSection[] {
  const sections = new Map<string, TbGroupSection>()
  for (const r of rows) {
    const name = (by === 'topGroup' ? (r.topGroupName ?? r.groupName) : r.groupName) || 'Ungrouped'
    let section = sections.get(name)
    if (!section) {
      section = { key: name, name, rows: [], totals: zero() }
      sections.set(name, section)
    }
    section.rows.push(r)
    add(section.totals, r)
  }
  const out = [...sections.values()]
  for (const s of out) s.rows.sort((a, b) => a.ledgerName.localeCompare(b.ledgerName))
  return out.sort((a, b) => a.name.localeCompare(b.name))
}
