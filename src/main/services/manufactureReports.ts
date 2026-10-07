import type { DB } from '../db/connection'
import {
  averageCostSheet, marginRows, perUnit, productionRegister,
  type CostSheet, type CostSheetLine, type ManufactureFact, type MarginRow, type ProductionRegisterRow, type VarianceReportRow
} from '@shared/manufactureReports'
import { explodeBom, materialVariance } from '@shared/bom'
import { manufactureRegister, type ManufactureRegisterRow } from './manufacture'
import { voucherLineCosts } from './stockAnalysis'
import { listBomVersions } from './bom'
import { itemProfitability } from './reports'

/**
 * Manufacturing reports (WP 2.4): production register, cost sheet per product, expected vs
 * realised margin and material variance against the BOM. Every figure is the engine's CURRENT
 * figure (one valuation pass, via manufactureRegister / voucherLineCosts) — a backdated purchase
 * re-prices them all, consistently with Stock summary.
 */

const toFact = (r: ManufactureRegisterRow): ManufactureFact => ({
  voucherId: r.voucherId, date: r.date, number: r.number, finishedItemId: r.finishedItemId, itemName: r.itemName,
  unitSymbol: r.unitSymbol, decimals: r.decimals, qtyMilli: r.qtyMilli, materialPaise: r.materialPaise, labourPaise: r.labourPaise,
  byProductPaise: r.byProductPaise, productionCost: r.productionCost, saleAmount: r.saleAmount
})

/** Per finished item over [from, to]: quantity, cost, by-products, sale value, margin. */
export function productionRegisterReport(db: DB, from: string, to: string): ProductionRegisterRow[] {
  return productionRegister(manufactureRegister(db, from, to).map(toFact))
}

interface ItemMeta {
  name: string
  unitSymbol: string
  decimals: number
}
const itemMeta = (db: DB): Map<number, ItemMeta> =>
  new Map(
    (
      db.prepare('SELECT si.id, si.name, u.symbol AS unitSymbol, u.decimals FROM stock_items si JOIN units u ON u.id = si.unit_id').all() as
        (ItemMeta & { id: number })[]
    ).map((r) => [r.id, { name: r.name, unitSymbol: r.unitSymbol, decimals: r.decimals }])
  )

interface LineRow {
  id: number
  voucherId: number
  stockItemId: number
  qtyMilli: number
  direction: 'in' | 'out'
  lineOrder: number
}
const voucherLines = (db: DB, voucherIds: number[]): Map<number, LineRow[]> => {
  const out = new Map<number, LineRow[]>()
  if (voucherIds.length === 0) return out
  const rows = db
    .prepare(
      `SELECT id, voucher_id AS voucherId, stock_item_id AS stockItemId, qty_milli AS qtyMilli, direction, line_order AS lineOrder
       FROM inventory_lines WHERE voucher_id IN (${voucherIds.map(() => '?').join(',')}) AND is_absolute = 0
       ORDER BY voucher_id, line_order, id`
    )
    .all(...voucherIds) as LineRow[]
  for (const r of rows) {
    const list = out.get(r.voucherId) ?? []
    list.push(r)
    out.set(r.voucherId, list)
  }
  return out
}

export interface CostSheetReport {
  itemId: number
  itemName: string
  unitSymbol: string
  decimals: number
  manufactures: CostSheet[]
  /** The per-item average over the period (Σ ÷ Σ quantity made). */
  average: CostSheet
}

/** Cost sheet of one finished item: per manufacture in [from, to] — materials by component
 *  (qty / rate / amount at the engine's current cost), labour, by-products (negative), unit cost —
 *  and the period average. */
export function costSheetReport(db: DB, itemId: number, from: string, to: string): CostSheetReport {
  const meta = itemMeta(db)
  const item = meta.get(itemId)
  if (!item) throw new Error('Stock item not found')
  const reg = manufactureRegister(db, from, to, itemId)
  const ids = reg.map((r) => r.voucherId)
  const { lineValue } = voucherLineCosts(db, to, new Set(ids))
  const lines = voucherLines(db, ids)
  const kinds = new Map(
    (
      ids.length
        ? (db.prepare(`SELECT voucher_id AS v, line_order AS o, kind FROM manufacture_outputs WHERE voucher_id IN (${ids.map(() => '?').join(',')})`).all(...ids) as {
            v: number; o: number; kind: 'by_product' | 'scrap'
          }[])
        : []
    ).map((r) => [`${r.v}:${r.o}`, r.kind])
  )
  const line = (kind: CostSheetLine['kind'], itemId2: number | null, qtyMilli: number, amountPaise: number, made: number, name?: string): CostSheetLine => {
    const m = itemId2 != null ? meta.get(itemId2) : undefined
    return {
      kind, itemId: itemId2, name: name ?? m?.name ?? '', unitSymbol: m?.unitSymbol ?? '', decimals: m?.decimals ?? 0, qtyMilli,
      ratePaise: perUnit(Math.abs(amountPaise), qtyMilli), amountPaise,
      qtyPerUnitMilli: made > 0 ? Math.round((qtyMilli * 1000) / made) : 0, amountPerUnitPaise: perUnit(amountPaise, made)
    }
  }
  const sheets: CostSheet[] = reg.map((r) => {
    const ls = lines.get(r.voucherId) ?? []
    const out: CostSheetLine[] = []
    for (const l of ls) {
      if (l.direction === 'out') out.push(line('material', l.stockItemId, l.qtyMilli, lineValue.get(l.id) ?? 0, r.qtyMilli))
    }
    if (r.labourPaise !== 0) out.push(line('labour', null, 0, r.labourPaise, r.qtyMilli, r.jobWork ? 'Job charges' : 'Labour'))
    for (const l of ls) {
      const kind = kinds.get(`${r.voucherId}:${l.lineOrder}`)
      if (l.direction === 'in' && kind) out.push(line(kind, l.stockItemId, l.qtyMilli, -(lineValue.get(l.id) ?? 0), r.qtyMilli))
    }
    const productionCost = out.reduce((s, x) => s + x.amountPaise, 0)
    return {
      voucherId: r.voucherId, date: r.date, number: r.number, qtyMilli: r.qtyMilli, lines: out, productionCost,
      unitCostPaise: perUnit(productionCost, r.qtyMilli), saleAmount: r.saleAmount
    }
  })
  return { itemId, itemName: item.name, unitSymbol: item.unitSymbol, decimals: item.decimals, manufactures: sheets, average: averageCostSheet(sheets) }
}

/** Expected (manufacture sale value − production cost now) vs realised (actual sales of the
 *  item in the period at engine COGS — item profitability) margin, per manufactured item. */
export function marginReport(db: DB, from: string, to: string): MarginRow[] {
  const made = productionRegisterReport(db, from, to)
  const sold = new Map(itemProfitability(db, from, to).map((r) => [r.stockItemId, r]))
  return marginRows(made, sold)
}

/**
 * Material variance against the BOM: for every manufacture in [from, to] whose rows came from a
 * BOM version (or, when none was recorded, whose item has a version in force on the date), the
 * standard = that version exploded (fully, when the manufacture was exploded) for the quantity
 * produced, vs the actual consumption at engine cost. Rows per (manufacture, component).
 */
export function materialVarianceReport(db: DB, from: string, to: string, itemId?: number): VarianceReportRow[] {
  const reg = manufactureRegister(db, from, to, itemId)
  if (reg.length === 0) return []
  const ids = reg.map((r) => r.voucherId)
  const det = new Map(
    (db.prepare(`SELECT voucher_id AS v, bom_version_id AS versionId, bom_exploded AS exploded FROM manufacture_details WHERE voucher_id IN (${ids.map(() => '?').join(',')})`).all(...ids) as {
      v: number; versionId: number | null; exploded: number
    }[]).map((r) => [r.v, r])
  )
  const versions = listBomVersions(db)
  const versionName = new Map(versions.map((v) => [v.id, v.name]))
  const lines = voucherLines(db, ids)
  const planned = reg
    .map((r) => {
      const d = det.get(r.voucherId)
      const e = explodeBom(r.finishedItemId, r.qtyMilli, versions, r.date, {
        levels: d?.exploded ? 'full' : 'single',
        versionId: d?.versionId ?? null
      })
      if (!e.ok || e.versionId == null) return null
      const actualIds = new Set((lines.get(r.voucherId) ?? []).filter((l) => l.direction === 'out').map((l) => l.stockItemId))
      return { r, standard: e.rows, versionId: e.versionId, needsFallback: e.rows.some((s) => !actualIds.has(s.componentId)) }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
  if (planned.length === 0) return []
  const fallbackPoints = planned.filter((p) => p.needsFallback)
  const { lineValue, averageAt } = voucherLineCosts(
    db, to, new Set(planned.map((p) => p.r.voucherId)), fallbackPoints.map((p) => ({ date: p.r.date, voucherId: p.r.voucherId }))
  )
  const averageFor = new Map(fallbackPoints.map((p, i) => [p.r.voucherId, averageAt[i]!]))
  const meta = itemMeta(db)
  const out: VarianceReportRow[] = []
  for (const p of planned) {
    const actual = (lines.get(p.r.voucherId) ?? [])
      .filter((l) => l.direction === 'out')
      .map((l) => ({ componentId: l.stockItemId, qtyMilli: l.qtyMilli, valuePaise: lineValue.get(l.id) ?? 0 }))
    const avg = averageFor.get(p.r.voucherId)
    for (const v of materialVariance(p.standard, actual, (id) => avg?.get(id) ?? 0)) {
      const m = meta.get(v.componentId)
      out.push({
        voucherId: p.r.voucherId, date: p.r.date, number: p.r.number, finishedItemId: p.r.finishedItemId, itemName: p.r.itemName,
        producedQtyMilli: p.r.qtyMilli, bomVersionName: versionName.get(p.versionId) ?? null, componentId: v.componentId,
        componentName: m?.name ?? '', unitSymbol: m?.unitSymbol ?? '', decimals: m?.decimals ?? 0,
        standardQtyMilli: v.standardQtyMilli, actualQtyMilli: v.actualQtyMilli, qtyVarianceMilli: v.qtyVarianceMilli,
        standardValuePaise: v.standardValuePaise, actualValuePaise: v.actualValuePaise, valueVariancePaise: v.valueVariancePaise
      })
    }
  }
  return out
}
