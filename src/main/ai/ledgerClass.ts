// WP 5.6 — what kind of ledger a memory may point at. One classifier for writing memories (a
// preferred ledger must fit its purpose; a party's usual ledger must be an income ledger for a
// debtor, an expense ledger for a creditor), for drafting defaults taken from memory, and for the
// books statistics behind derived suggestions. Reads the masters only (no vouchers).
import type { DB } from '../db/connection'
import { CASH_BANK_GROUPS } from '@shared/seed'
import type { AiMemoryPurpose } from '@shared/ai'
import { descendantIdsByName } from '../services/masters'

export type LedgerClass = 'cash' | 'bank' | 'debtor' | 'creditor' | 'income' | 'expense' | 'tax' | 'other'

export interface LedgerClassifier {
  cls(id: number): LedgerClass
  name(id: number): string | undefined
}

/** Classes by group (cash / bank / party), then tags (GST tax type, TDS / TCS payable → 'tax'),
 *  then nature. Round Off and every asset / liability ledger (capital, loans, …) are 'other'. */
export function ledgerClassifier(db: DB): LedgerClassifier {
  const cash = descendantIdsByName(db, ['Cash-in-Hand'])
  const bank = descendantIdsByName(db, CASH_BANK_GROUPS.filter((g) => g !== 'Cash-in-Hand'))
  const debtors = descendantIdsByName(db, ['Sundry Debtors'])
  const creditors = descendantIdsByName(db, ['Sundry Creditors'])
  const rows = new Map(
    (db
      .prepare(
        `SELECT l.id, l.name, l.group_id, l.tax_type, l.tds_payable_section_id AS tds, l.tcs_payable_section_id AS tcs, g.nature
           FROM ledgers l JOIN groups g ON g.id = l.group_id`
      )
      .all() as { id: number; name: string; group_id: number; tax_type: string | null; tds: number | null; tcs: number | null; nature: string }[]).map((r) => [r.id, r])
  )
  return {
    name: (id) => rows.get(id)?.name,
    cls(id) {
      const l = rows.get(id)
      if (!l) return 'other'
      if (cash.has(l.group_id)) return 'cash'
      if (bank.has(l.group_id)) return 'bank'
      if (debtors.has(l.group_id)) return 'debtor'
      if (creditors.has(l.group_id)) return 'creditor'
      if (l.tax_type || l.tds != null || l.tcs != null) return 'tax'
      if (/^round\s*-?\s*off\b/i.test(l.name.trim())) return 'other'
      if (l.nature === 'income') return 'income'
      if (l.nature === 'expense') return 'expense'
      return 'other'
    }
  }
}

/** The ledger classes a preference for this purpose may point at. */
export const PURPOSE_CLASSES: Record<AiMemoryPurpose, readonly LedgerClass[]> = {
  payment: ['cash', 'bank'],
  receipt: ['cash', 'bank'],
  cash: ['cash'],
  bank: ['bank'],
  expense: ['expense'],
  purchase: ['expense'],
  sales: ['income'],
  income: ['income']
}

const PURPOSE_WORDS: Record<AiMemoryPurpose, string> = {
  payment: 'a cash or bank ledger',
  receipt: 'a cash or bank ledger',
  cash: 'a cash ledger',
  bank: 'a bank ledger',
  expense: 'an expense ledger',
  purchase: 'a purchase / expense ledger',
  sales: 'a sales / income ledger',
  income: 'an income ledger'
}

export function purposeFits(cls: LedgerClass, purpose: AiMemoryPurpose): boolean {
  return PURPOSE_CLASSES[purpose].includes(cls)
}

/** Why `ledgerId` cannot be the preferred ledger for `purpose`, or null when it can. */
export function purposeProblem(c: LedgerClassifier, ledgerId: number, purpose: AiMemoryPurpose): string | null {
  if (purposeFits(c.cls(ledgerId), purpose)) return null
  return `${c.name(ledgerId) ?? `Ledger #${ledgerId}`} cannot be the ${purpose} ledger — it must be ${PURPOSE_WORDS[purpose]}`
}

/** A party's usual ledger: income for a debtor, expense (purchases) for a creditor. */
export function partyLedgerFits(c: LedgerClassifier, partyLedgerId: number, ledgerId: number): boolean {
  const p = c.cls(partyLedgerId)
  const l = c.cls(ledgerId)
  return (p === 'debtor' && l === 'income') || (p === 'creditor' && l === 'expense')
}
