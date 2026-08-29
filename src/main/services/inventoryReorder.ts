import type { DB } from '../db/connection'
import { buildReorderMessages, type ReorderAlerts, type ReorderSupplier } from '@shared/reorder'
import { purchaseSuggestions } from './reports'

/**
 * Item-wise reorder alerts (roadmap #121).
 *
 * `purchaseSuggestions` already works out what has fallen below its reorder level, how much to buy
 * and who it was last bought from. All that is added here is the contact details of that supplier,
 * so the report can turn into a message somebody actually sends.
 *
 * The supplier is the party on the item's most recent purchase — the one question a buyer would
 * otherwise open the purchase register to answer. An item nobody has ever bought has no supplier
 * and is reported as such rather than being quietly left out of the list.
 */
export function reorderAlerts(db: DB, companyName: string, asOn: string): ReorderAlerts {
  const rows = purchaseSuggestions(db, asOn)
  const ids = [...new Set(rows.map((r) => r.lastSupplierLedgerId).filter((id): id is number => id != null))]
  if (ids.length === 0) return buildReorderMessages({ name: companyName }, rows, new Map(), asOn)

  const suppliers = new Map<number, ReorderSupplier>(
    (
      db
        .prepare(
          `SELECT id AS ledgerId, name, email, phone FROM ledgers WHERE id IN (${ids.map(() => '?').join(',')})`
        )
        .all(...ids) as ReorderSupplier[]
    ).map((s) => [s.ledgerId, s])
  )
  return buildReorderMessages({ name: companyName }, rows, suppliers, asOn)
}
