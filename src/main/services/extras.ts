import type { DB } from '../db/connection'
import type { Currency } from '@shared/domain'

// ---------- currencies ----------

export function listCurrencies(db: DB): Currency[] {
  return db.prepare('SELECT * FROM currencies ORDER BY code').all() as Currency[]
}

// ---------- bill of materials ----------
// WP 2.4: BOMs are versioned — services/bom.ts owns them; the pre-2.4 API is re-exported here so
// existing callers (bom:get / bom:set / bom:items) keep working unchanged.
export { getBom, setBom, itemsWithBom } from './bom'
