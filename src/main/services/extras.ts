import type { DB } from '../db/connection'
import type { Currency } from '@shared/domain'
import type { CurrencyInput } from '@shared/schemas'
import { writeAudit } from './audit'

// ---------- currencies ----------

export function listCurrencies(db: DB): Currency[] {
  return db.prepare('SELECT * FROM currencies ORDER BY code').all() as Currency[]
}

export function createCurrency(db: DB, input: CurrencyInput): Currency {
  const res = db
    .prepare('INSERT INTO currencies (code, symbol, name, decimals) VALUES (?, ?, ?, ?)')
    .run(input.code, input.symbol, input.name, input.decimals)
  const created = db.prepare('SELECT * FROM currencies WHERE id = ?').get(res.lastInsertRowid) as Currency
  writeAudit(db, 'currency', created.id, 'create', null, created)
  return created
}

export function deleteCurrency(db: DB, id: number): void {
  const existing = db.prepare('SELECT * FROM currencies WHERE id = ?').get(id) as Currency | undefined
  if (!existing) throw new Error('Currency not found')
  const used = db.prepare('SELECT COUNT(*) AS n FROM vouchers WHERE currency_code = ?').get(existing.code) as { n: number }
  if (used.n > 0) throw new Error('Currency is used on vouchers')
  db.prepare('DELETE FROM currencies WHERE id = ?').run(id)
  writeAudit(db, 'currency', id, 'delete', existing, null)
}

// ---------- bill of materials ----------
// WP 2.4: BOMs are versioned — services/bom.ts owns them; the pre-2.4 API is re-exported here so
// existing callers (bom:get / bom:set / bom:items) keep working unchanged.
export { getBom, setBom, itemsWithBom } from './bom'
