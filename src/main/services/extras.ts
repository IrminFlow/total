import type { DB } from '../db/connection'
import type { BomLine, Currency } from '@shared/domain'
import type { BomInput, CurrencyInput } from '@shared/schemas'

// ---------- currencies ----------

export function listCurrencies(db: DB): Currency[] {
  return db.prepare('SELECT * FROM currencies ORDER BY code').all() as Currency[]
}

export function createCurrency(db: DB, input: CurrencyInput): Currency {
  const res = db
    .prepare('INSERT INTO currencies (code, symbol, name, decimals) VALUES (?, ?, ?, ?)')
    .run(input.code, input.symbol, input.name, input.decimals)
  return db.prepare('SELECT * FROM currencies WHERE id = ?').get(res.lastInsertRowid) as Currency
}

export function deleteCurrency(db: DB, id: number): void {
  const cur = db.prepare('SELECT code FROM currencies WHERE id = ?').get(id) as { code: string } | undefined
  if (!cur) throw new Error('Currency not found')
  const used = db.prepare('SELECT COUNT(*) AS n FROM vouchers WHERE currency_code = ?').get(cur.code) as { n: number }
  if (used.n > 0) throw new Error('Currency is used on vouchers')
  db.prepare('DELETE FROM currencies WHERE id = ?').run(id)
}

// ---------- bill of materials ----------

export function getBom(db: DB, itemId: number): BomLine[] {
  return db
    .prepare(
      `SELECT b.id, b.component_id AS componentId, si.name AS componentName, u.symbol AS unitSymbol,
              b.qty_milli_per_unit AS qtyMilliPerUnit
       FROM bom_lines b
       JOIN stock_items si ON si.id = b.component_id
       JOIN units u ON u.id = si.unit_id
       WHERE b.item_id = ? ORDER BY si.name`
    )
    .all(itemId) as BomLine[]
}

export function setBom(db: DB, input: BomInput): BomLine[] {
  if (input.lines.some((l) => l.componentId === input.itemId)) {
    throw new Error('An item cannot be its own component')
  }
  const run = db.transaction(() => {
    db.prepare('DELETE FROM bom_lines WHERE item_id = ?').run(input.itemId)
    const insert = db.prepare('INSERT INTO bom_lines (item_id, component_id, qty_milli_per_unit) VALUES (?, ?, ?)')
    for (const line of input.lines) insert.run(input.itemId, line.componentId, line.qtyMilliPerUnit)
  })
  run()
  return getBom(db, input.itemId)
}

/** Items that have a BOM (for the Manufacture picker). */
export function itemsWithBom(db: DB): { itemId: number; name: string; components: number }[] {
  return db
    .prepare(
      `SELECT si.id AS itemId, si.name, COUNT(b.id) AS components
       FROM stock_items si JOIN bom_lines b ON b.item_id = si.id
       GROUP BY si.id ORDER BY si.name`
    )
    .all() as { itemId: number; name: string; components: number }[]
}
