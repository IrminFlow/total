import type { DB } from '../db/connection'
import type { BomDetail, BomLine, BomRequirement, BomRequirementRow, Currency } from '@shared/domain'
import type { BomInputPayload, CurrencyInput } from '@shared/schemas'
import { bomInputSchema } from '@shared/schemas'
import { wouldCreateBomCycle, type BomEdge } from '@shared/valuation'
import { explodeBom, type BomRequirementNode, type BomSpec } from '@shared/bomExplode'
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

export function getBom(db: DB, itemId: number): BomLine[] {
  return db
    .prepare(
      `SELECT b.id, b.component_id AS componentId, si.name AS componentName, u.symbol AS unitSymbol,
              b.qty_milli_per_unit AS qtyMilliPerUnit, b.scrap_bp AS scrapBp,
              EXISTS (SELECT 1 FROM bom_lines c WHERE c.item_id = b.component_id) AS hasBom
       FROM bom_lines b
       JOIN stock_items si ON si.id = b.component_id
       JOIN units u ON u.id = si.unit_id
       WHERE b.item_id = ? ORDER BY si.name`
    )
    .all(itemId)
    .map((r) => {
      const row = r as Omit<BomLine, 'hasBom'> & { hasBom: number }
      return { ...row, hasBom: Boolean(row.hasBom) }
    })
}

/** The BOM plus the finished item's yield, which lives on the item and not on any line. */
export function getBomDetail(db: DB, itemId: number): BomDetail {
  const row = db.prepare('SELECT bom_yield_bp AS bomYieldBp FROM stock_items WHERE id = ?').get(itemId) as
    | { bomYieldBp: number }
    | undefined
  if (!row) throw new Error('Stock item not found')
  return { itemId, bomYieldBp: row.bomYieldBp, lines: getBom(db, itemId) }
}

export function setBom(db: DB, raw: BomInputPayload): BomLine[] {
  // Parsed here as well as at the IPC boundary: scrap and yield are defaulted fields, and a
  // caller that predates them (an older payload, an older test) must still mean 0 and 100%.
  const input = bomInputSchema.parse(raw)
  if (input.lines.some((l) => l.componentId === input.itemId)) {
    throw new Error('An item cannot be its own component')
  }
  // Multi-level cycle detection (task 79): DFS through the existing BOM graph — saving this
  // BOM must not make any component (transitively) contain the item itself.
  const edges = db
    .prepare('SELECT item_id AS itemId, component_id AS componentId FROM bom_lines')
    .all() as BomEdge[]
  if (wouldCreateBomCycle(input.itemId, input.lines.map((l) => l.componentId), edges)) {
    throw new Error('This BOM would create a cycle — a component already contains this item')
  }
  const before = getBomDetail(db, input.itemId)
  const run = db.transaction(() => {
    db.prepare('DELETE FROM bom_lines WHERE item_id = ?').run(input.itemId)
    const insert = db.prepare(
      'INSERT INTO bom_lines (item_id, component_id, qty_milli_per_unit, scrap_bp) VALUES (?, ?, ?, ?)'
    )
    for (const line of input.lines) insert.run(input.itemId, line.componentId, line.qtyMilliPerUnit, line.scrapBp)
    // Yield belongs to the finished item, so it rides along with the BOM that defines it.
    db.prepare('UPDATE stock_items SET bom_yield_bp = ? WHERE id = ?').run(input.bomYieldBp, input.itemId)
  })
  run()
  const after = getBomDetail(db, input.itemId)
  writeAudit(db, 'bom', input.itemId, 'update', before, after)
  return after.lines
}

/**
 * Requirement for `qtyMilli` of `itemId`, exploded through every nested sub-assembly (#126).
 *
 * The whole graph is read in two queries rather than one per level: a BOM tree is small, and a
 * recursive read would issue a query per node while holding the arithmetic hostage to IO.
 */
export function explodeBomRequirement(db: DB, itemId: number, qtyMilli: number): BomRequirement {
  const lines = db
    .prepare(
      `SELECT item_id AS itemId, component_id AS componentId, qty_milli_per_unit AS qtyMilliPerUnit,
              scrap_bp AS scrapBp
       FROM bom_lines ORDER BY item_id, id`
    )
    .all() as { itemId: number; componentId: number; qtyMilliPerUnit: number; scrapBp: number }[]
  const yields = db.prepare('SELECT id, bom_yield_bp AS bomYieldBp FROM stock_items').all() as {
    id: number
    bomYieldBp: number
  }[]
  const yieldOf = new Map(yields.map((y) => [y.id, y.bomYieldBp]))
  const graph = new Map<number, BomSpec>()
  for (const l of lines) {
    const spec = graph.get(l.itemId) ?? { yieldBp: yieldOf.get(l.itemId) ?? 10000, lines: [] }
    spec.lines.push({ componentId: l.componentId, qtyMilliPerUnit: l.qtyMilliPerUnit, scrapBp: l.scrapBp })
    graph.set(l.itemId, spec)
  }

  const exploded = explodeBom(graph, itemId, qtyMilli)
  const names = db
    .prepare('SELECT si.id, si.name, u.symbol AS unitSymbol FROM stock_items si JOIN units u ON u.id = si.unit_id')
    .all() as { id: number; name: string; unitSymbol: string }[]
  const nameOf = new Map(names.map((n) => [n.id, n]))
  const row = (n: {
    componentId: number
    qtyMilli: number
    scrapBp: number
    parentYieldBp: number
    depth: number
    isSubAssembly: boolean
  }): BomRequirementRow => ({
    componentId: n.componentId,
    componentName: nameOf.get(n.componentId)?.name ?? `#${n.componentId}`,
    unitSymbol: nameOf.get(n.componentId)?.unitSymbol ?? '',
    qtyMilli: n.qtyMilli,
    scrapBp: n.scrapBp,
    parentYieldBp: n.parentYieldBp,
    depth: n.depth,
    isSubAssembly: n.isSubAssembly
  })

  // Depth-first so a sub-assembly is immediately followed by what it is made of: that is the
  // order a person reads a parts list in, and it is the only order the indent means anything in.
  const rows: BomRequirementRow[] = []
  const flatten = (nodes: BomRequirementNode[]): void => {
    for (const n of nodes) {
      rows.push(row(n))
      flatten(n.children)
    }
  }
  flatten(exploded.tree)

  // The raw list is summed across the tree, so one row per material even when it appears twice.
  const raw = exploded.raw.map((r) =>
    row({ ...r, scrapBp: 0, parentYieldBp: 10000, depth: 1, isSubAssembly: false })
  )
  return { itemId, qtyMilli, rows, raw }
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
