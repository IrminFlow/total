import type { DB } from '../db/connection'
import type { BomLine } from '@shared/domain'
import type { BomInput, BomVersionInput, BomExplodeInput } from '@shared/schemas'
import {
  explodeBom, validateBomVersion, versionWouldCycle, type BomVersion, type ExplosionResult
} from '@shared/bom'
import { writeAudit } from './audit'

/**
 * Bills of materials with versions (WP 2.4, migration 023). Every BOM lives in a named,
 * effective-dated version (bom_versions + bom_version_lines); one version per item is the
 * default — the one `bom:get` / `bom:set` (the pre-2.4 single-BOM API, kept working) read and
 * write, and the fallback when no version is in force on a date. The legacy `bom_lines` name is
 * a read-only VIEW over the default versions' lines.
 *
 * Cycles are refused across every version of every item (any of them can be picked on some
 * date), reusing wouldCreateBomCycle.
 */

interface VersionRow {
  id: number
  item_id: number
  name: string
  effective_from: string | null
  effective_to: string | null
  is_default: number
}
interface LineRow {
  version_id: number
  component_id: number
  qty_milli_per_unit: number
  scrap_pct_bp: number | null
}

/** Every version (with lines, in line order) — of one item, or all items. */
export function listBomVersions(db: DB, itemId?: number): BomVersion[] {
  const versions = (
    itemId
      ? db.prepare('SELECT * FROM bom_versions WHERE item_id = ? ORDER BY item_id, id').all(itemId)
      : db.prepare('SELECT * FROM bom_versions ORDER BY item_id, id').all()
  ) as VersionRow[]
  if (versions.length === 0) return []
  const lines = (
    itemId
      ? db
          .prepare(
            `SELECT l.* FROM bom_version_lines l JOIN bom_versions v ON v.id = l.version_id
             WHERE v.item_id = ? ORDER BY l.version_id, l.line_order, l.id`
          )
          .all(itemId)
      : db.prepare('SELECT * FROM bom_version_lines ORDER BY version_id, line_order, id').all()
  ) as LineRow[]
  const byVersion = new Map<number, BomVersion['lines']>()
  for (const l of lines) {
    const list = byVersion.get(l.version_id) ?? []
    list.push({ componentId: l.component_id, qtyMilliPerUnit: l.qty_milli_per_unit, scrapPctBp: l.scrap_pct_bp })
    byVersion.set(l.version_id, list)
  }
  return versions.map((v) => ({
    id: v.id,
    itemId: v.item_id,
    name: v.name,
    effectiveFrom: v.effective_from,
    effectiveTo: v.effective_to,
    isDefault: !!v.is_default,
    lines: byVersion.get(v.id) ?? []
  }))
}

const itemNames = (db: DB): ((id: number) => string) => {
  const names = new Map((db.prepare('SELECT id, name FROM stock_items').all() as { id: number; name: string }[]).map((r) => [r.id, r.name]))
  return (id) => names.get(id) ?? `Item #${id}`
}

function assertSavable(db: DB, itemId: number, componentIds: number[]): void {
  if (componentIds.includes(itemId)) throw new Error('An item cannot be its own component')
  const all = listBomVersions(db)
  if (versionWouldCycle(itemId, componentIds, all)) {
    throw new Error('This BOM would create a cycle — a component already contains this item')
  }
}

function writeLines(db: DB, versionId: number, lines: { componentId: number; qtyMilliPerUnit: number; scrapPctBp?: number | null }[]): void {
  db.prepare('DELETE FROM bom_version_lines WHERE version_id = ?').run(versionId)
  const ins = db.prepare(
    'INSERT INTO bom_version_lines (version_id, component_id, qty_milli_per_unit, scrap_pct_bp, line_order) VALUES (?, ?, ?, ?, ?)'
  )
  lines.forEach((l, i) => ins.run(versionId, l.componentId, l.qtyMilliPerUnit, l.scrapPctBp ?? null, i))
}

/** Create (no id) or replace a version. Making it the default demotes the item's other default;
 *  an item's first version is always its default. */
export function saveBomVersion(db: DB, input: BomVersionInput): BomVersion {
  const name = itemNames(db)
  const problems = validateBomVersion(
    {
      itemId: input.itemId,
      name: input.name,
      effectiveFrom: input.effectiveFrom ?? null,
      effectiveTo: input.effectiveTo ?? null,
      lines: input.lines.map((l) => ({ componentId: l.componentId, qtyMilliPerUnit: l.qtyMilliPerUnit, scrapPctBp: l.scrapPctBp ?? null }))
    },
    name
  )
  if (problems.length) throw new Error(problems.join('; '))
  const item = db.prepare('SELECT id FROM stock_items WHERE id = ?').get(input.itemId)
  if (!item) throw new Error('Stock item not found')
  for (const l of input.lines) {
    if (!db.prepare('SELECT 1 FROM stock_items WHERE id = ?').get(l.componentId)) throw new Error('Component not found')
  }
  assertSavable(db, input.itemId, input.lines.map((l) => l.componentId))
  const before = input.id ? (listBomVersions(db, input.itemId).find((v) => v.id === input.id) ?? null) : null
  if (input.id && !before) throw new Error('BOM version not found')
  const clash = db
    .prepare('SELECT id FROM bom_versions WHERE item_id = ? AND name = ? AND id IS NOT ?')
    .get(input.itemId, input.name.trim(), input.id ?? null) as { id: number } | undefined
  if (clash) throw new Error(`This item already has a BOM version named “${input.name.trim()}”`)

  const run = db.transaction((): number => {
    const hasOther = db
      .prepare('SELECT COUNT(*) AS n FROM bom_versions WHERE item_id = ? AND is_default = 1 AND id IS NOT ?')
      .get(input.itemId, input.id ?? null) as { n: number }
    const makeDefault = input.isDefault || hasOther.n === 0
    if (makeDefault) db.prepare('UPDATE bom_versions SET is_default = 0 WHERE item_id = ? AND id IS NOT ?').run(input.itemId, input.id ?? null)
    let id: number
    if (input.id) {
      // A version that stops being the default leaves the item without one only if it was the
      // only default — then it stays the default.
      db.prepare('UPDATE bom_versions SET name = ?, effective_from = ?, effective_to = ?, is_default = ? WHERE id = ?').run(
        input.name.trim(), input.effectiveFrom ?? null, input.effectiveTo ?? null, makeDefault ? 1 : 0, input.id
      )
      id = input.id
    } else {
      id = Number(
        db
          .prepare('INSERT INTO bom_versions (item_id, name, effective_from, effective_to, is_default) VALUES (?, ?, ?, ?, ?)')
          .run(input.itemId, input.name.trim(), input.effectiveFrom ?? null, input.effectiveTo ?? null, makeDefault ? 1 : 0).lastInsertRowid
      )
    }
    writeLines(db, id, input.lines)
    return id
  })
  const id = run()
  const after = listBomVersions(db, input.itemId).find((v) => v.id === id)!
  writeAudit(db, 'bom', input.itemId, input.id ? 'update' : 'create', before, after)
  return after
}

/** Delete a version. Manufactures that recorded it keep their figures (their bom_version_id is
 *  set NULL). Deleting the default promotes the item's oldest remaining version. */
export function deleteBomVersion(db: DB, id: number): void {
  const row = db.prepare('SELECT * FROM bom_versions WHERE id = ?').get(id) as VersionRow | undefined
  if (!row) throw new Error('BOM version not found')
  const before = listBomVersions(db, row.item_id).find((v) => v.id === id)
  db.transaction(() => {
    db.prepare('DELETE FROM bom_versions WHERE id = ?').run(id)
    if (row.is_default) {
      const next = db.prepare('SELECT id FROM bom_versions WHERE item_id = ? ORDER BY id LIMIT 1').get(row.item_id) as { id: number } | undefined
      if (next) db.prepare('UPDATE bom_versions SET is_default = 1 WHERE id = ?').run(next.id)
    }
  })()
  writeAudit(db, 'bom', row.item_id, 'delete', before, null)
}

// ---------- the pre-2.4 single-BOM API (bom:get / bom:set / bom:items) ----------

/** The item's default version's lines (empty when it has no BOM). */
export function getBom(db: DB, itemId: number): BomLine[] {
  return db
    .prepare(
      `SELECT l.id, l.component_id AS componentId, si.name AS componentName, u.symbol AS unitSymbol,
              l.qty_milli_per_unit AS qtyMilliPerUnit
       FROM bom_version_lines l
       JOIN bom_versions v ON v.id = l.version_id AND v.is_default = 1
       JOIN stock_items si ON si.id = l.component_id
       JOIN units u ON u.id = si.unit_id
       WHERE v.item_id = ? ORDER BY si.name`
    )
    .all(itemId) as BomLine[]
}

/** Replace the default version's lines (creating "v1" as the default when the item has no
 *  version yet). Scrap allowances on components that stay are kept. */
export function setBom(db: DB, input: BomInput): BomLine[] {
  assertSavable(db, input.itemId, input.lines.map((l) => l.componentId))
  const before = getBom(db, input.itemId)
  db.transaction(() => {
    let v = db.prepare('SELECT id FROM bom_versions WHERE item_id = ? AND is_default = 1').get(input.itemId) as { id: number } | undefined
    if (!v) {
      if (input.lines.length === 0) return
      const taken = (db.prepare('SELECT name FROM bom_versions WHERE item_id = ?').all(input.itemId) as { name: string }[]).map((r) => r.name.toLowerCase())
      let n = 1
      while (taken.includes(`v${n}`)) n++
      v = { id: Number(db.prepare('INSERT INTO bom_versions (item_id, name, is_default) VALUES (?, ?, 1)').run(input.itemId, `v${n}`).lastInsertRowid) }
    }
    const scrap = new Map(
      (db.prepare('SELECT component_id, scrap_pct_bp FROM bom_version_lines WHERE version_id = ?').all(v.id) as { component_id: number; scrap_pct_bp: number | null }[]).map(
        (r) => [r.component_id, r.scrap_pct_bp]
      )
    )
    writeLines(db, v.id, input.lines.map((l) => ({ ...l, scrapPctBp: scrap.get(l.componentId) ?? null })))
  })()
  const after = getBom(db, input.itemId)
  writeAudit(db, 'bom', input.itemId, 'update', before, after)
  return after
}

/** Items that have a BOM (any version with lines) — for the Manufacture picker. `components`
 *  counts the default version's lines. */
export function itemsWithBom(db: DB): { itemId: number; name: string; components: number }[] {
  return db
    .prepare(
      `SELECT si.id AS itemId, si.name,
              (SELECT COUNT(*) FROM bom_version_lines l JOIN bom_versions d ON d.id = l.version_id
                WHERE d.item_id = si.id AND d.is_default = 1) AS components
       FROM stock_items si
       WHERE EXISTS (SELECT 1 FROM bom_versions v JOIN bom_version_lines l ON l.version_id = v.id WHERE v.item_id = si.id)
       ORDER BY si.name`
    )
    .all() as { itemId: number; name: string; components: number }[]
}

/** Explode `qtyMilli` of an item through its BOM as of `date` (shared/bom.ts explodeBom). */
export function explode(db: DB, q: BomExplodeInput): ExplosionResult {
  return explodeBom(q.itemId, q.qtyMilli, listBomVersions(db), q.date, { levels: q.levels, versionId: q.versionId ?? null })
}
