import type { DB } from '../db/connection'

export interface LedgerSuggestion {
  ledgerId: number
  name: string
  groupName: string
  uses: number
}

/**
 * Rank ledgers for the voucher-entry autosuggest: substring match on name,
 * ordered by how often the ledger appears in vouchers of the same kind.
 */
export function suggestLedgers(db: DB, kind: string, query: string, limit = 8): LedgerSuggestion[] {
  return db
    .prepare(
      `SELECT l.id AS ledgerId, l.name, g.name AS groupName,
              COALESCE((
                SELECT COUNT(*)
                FROM voucher_lines vl
                JOIN vouchers v ON v.id = vl.voucher_id
                JOIN voucher_types vt ON vt.id = v.voucher_type_id
                WHERE vl.ledger_id = l.id AND vt.kind = ?
              ), 0) AS uses
       FROM ledgers l JOIN groups g ON g.id = l.group_id
       WHERE l.name LIKE '%' || ? || '%'
       ORDER BY uses DESC, l.name
       LIMIT ?`
    )
    .all(kind, query, limit) as LedgerSuggestion[]
}

export interface AnomalyCheck {
  unusual: boolean
  typicalAmount: number | null
}

/** Flag an amount wildly above the ledger's historical median line amount. */
export function anomalyCheck(db: DB, ledgerId: number, amount: number): AnomalyCheck {
  const amounts = (
    db
      .prepare('SELECT amount FROM voucher_lines WHERE ledger_id = ? ORDER BY amount LIMIT 500')
      .all(ledgerId) as { amount: number }[]
  ).map((r) => r.amount)
  if (amounts.length < 5) return { unusual: false, typicalAmount: null }
  const median = amounts[Math.floor(amounts.length / 2)]!
  return { unusual: amount > median * 10, typicalAmount: median }
}
