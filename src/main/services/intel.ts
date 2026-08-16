import type { DB } from '../db/connection'
import { NOT_DELETED } from './vouchers'

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
  // Frequencies come from ONE grouped pass over the kind's voucher lines (CTE), joined to the
  // name-matched ledgers — not a correlated COUNT re-run per candidate ledger row.
  return db
    .prepare(
      `WITH freq AS (
         SELECT vl.ledger_id AS id, COUNT(*) AS uses
         FROM voucher_lines vl
         JOIN vouchers v ON v.id = vl.voucher_id
         JOIN voucher_types vt ON vt.id = v.voucher_type_id
         WHERE vt.kind = ? AND ${NOT_DELETED}
         GROUP BY vl.ledger_id
       )
       SELECT l.id AS ledgerId, l.name, g.name AS groupName, COALESCE(f.uses, 0) AS uses
       FROM ledgers l
       JOIN groups g ON g.id = l.group_id
       LEFT JOIN freq f ON f.id = l.id
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

/** Flag an amount wildly above the ledger's historical median line amount. The median is the
 *  true middle of ALL the ledger's line amounts (ORDER BY amount LIMIT 1 OFFSET count/2) — the
 *  old `LIMIT 500` sample only ever saw the 500 smallest amounts, biasing the median low for
 *  busy ledgers. */
export function anomalyCheck(db: DB, ledgerId: number, amount: number): AnomalyCheck {
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM voucher_lines WHERE ledger_id = ?').get(ledgerId) as { c: number }
  if (c < 5) return { unusual: false, typicalAmount: null }
  const row = db
    .prepare('SELECT amount FROM voucher_lines WHERE ledger_id = ? ORDER BY amount LIMIT 1 OFFSET ?')
    .get(ledgerId, Math.floor(c / 2)) as { amount: number }
  const median = row.amount
  return { unusual: amount > median * 10, typicalAmount: median }
}
