import type { DB } from '../db/connection'
import {
  resolvePrice, type DiscountScheme, type LevelRateRow, type PartyRateRow, type PriceContext, type PriceLevelInfo, type PriceResult
} from '@shared/pricing'
import {
  discountSchemeInputSchema, partyRateInputSchema, pricingConfigSchema,
  type DiscountSchemeInput, type PartyRateInput, type PricingConfig
} from '@shared/pricingSchemas'
import type { SupplyType } from '@shared/gst/calc'
import type { DiscountSchemeRow, PartyRate, ResolvedLine } from '@shared/pricingTypes'
import { writeAudit } from './audit'

export type { DiscountSchemeRow, PartyRate, ResolvedLine }
import { IN_BOOKS } from './vouchers'
import { defaultPriceLevel } from './priceLevels'

/**
 * WP 2.6 pricing services: party-wise rates (negotiated + remembered last price), discount
 * schemes, the pricing options, and the resolver's context loader. The rules themselves are the
 * pure resolvePrice in src/shared/pricing.ts — this file only gathers the facts it needs.
 *
 * Audit rows use the existing 'priceRate' / 'priceLevel' entities (party rates are rates, schemes
 * are price-list masters) with the payload naming what changed.
 */

// ---------------------------------------------------------------- config (meta 'pricing.config')

const CONFIG_KEY = 'pricing.config'

export function getPricingConfig(db: DB): PricingConfig {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(CONFIG_KEY) as { value: string } | undefined
  let raw: unknown = {}
  try {
    raw = row ? JSON.parse(row.value) : {}
  } catch {
    raw = {}
  }
  const r = pricingConfigSchema.safeParse(raw)
  return r.success ? r.data : pricingConfigSchema.parse({})
}

export function setPricingConfig(db: DB, input: unknown): PricingConfig {
  const before = getPricingConfig(db)
  const parsed = pricingConfigSchema.parse(input)
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(CONFIG_KEY, JSON.stringify(parsed))
  writeAudit(db, 'company', 0, 'update', { pricing: before }, { pricing: parsed })
  return parsed
}

// ---------------------------------------------------------------- party-wise rates


const PARTY_RATE_SELECT = `SELECT p.id, p.ledger_id AS ledgerId, l.name AS ledgerName, p.stock_item_id AS stockItemId,
    si.name AS itemName, u.symbol AS unitSymbol, p.rate_paise AS ratePaise, p.discount_bp AS discountBp,
    p.effective_from AS effectiveFrom, p.effective_to AS effectiveTo, p.source, p.last_sold_at AS lastSoldAt,
    p.last_voucher_id AS lastVoucherId
  FROM party_item_rates p
  JOIN ledgers l ON l.id = p.ledger_id
  JOIN stock_items si ON si.id = p.stock_item_id
  JOIN units u ON u.id = si.unit_id`

export function listPartyRates(db: DB, ledgerId?: number): PartyRate[] {
  return (
    ledgerId != null
      ? db.prepare(`${PARTY_RATE_SELECT} WHERE p.ledger_id = ? ORDER BY si.name, p.source, p.effective_from DESC`).all(ledgerId)
      : db.prepare(`${PARTY_RATE_SELECT} ORDER BY l.name, si.name, p.source, p.effective_from DESC`).all()
  ) as PartyRate[]
}

function getPartyRate(db: DB, id: number): PartyRate | undefined {
  return db.prepare(`${PARTY_RATE_SELECT} WHERE p.id = ?`).get(id) as PartyRate | undefined
}

/** Create / edit a negotiated party-wise rate. Remembered last prices are written by
 *  rememberSalePrices only; editing one turns it into a negotiated (manual) rate. */
export function savePartyRate(db: DB, raw: PartyRateInput, id?: number): PartyRate {
  const input = partyRateInputSchema.parse(raw)
  if (!db.prepare('SELECT 1 FROM ledgers WHERE id = ?').get(input.ledgerId)) throw new Error('Ledger not found')
  if (!db.prepare('SELECT 1 FROM stock_items WHERE id = ?').get(input.stockItemId)) throw new Error('Stock item not found')
  return db.transaction(() => {
    const before = id ? getPartyRate(db, id) : undefined
    if (id && !before) throw new Error('Party rate not found')
    let rowId = id
    if (id) {
      db.prepare(
        `UPDATE party_item_rates SET ledger_id = ?, stock_item_id = ?, rate_paise = ?, discount_bp = ?, effective_from = ?, effective_to = ?,
           source = 'manual' WHERE id = ?`
      ).run(input.ledgerId, input.stockItemId, input.ratePaise, input.discountBp, input.effectiveFrom, input.effectiveTo, id)
    } else {
      rowId = Number(
        db.prepare(
          `INSERT INTO party_item_rates (ledger_id, stock_item_id, rate_paise, discount_bp, effective_from, effective_to, source)
           VALUES (?, ?, ?, ?, ?, ?, 'manual')`
        ).run(input.ledgerId, input.stockItemId, input.ratePaise, input.discountBp, input.effectiveFrom, input.effectiveTo).lastInsertRowid
      )
    }
    const saved = getPartyRate(db, rowId!)!
    writeAudit(db, 'partyRate', saved.id, before ? 'update' : 'create', before ?? null, saved)
    return saved
  })()
}

export function deletePartyRate(db: DB, id: number): void {
  const before = getPartyRate(db, id)
  if (!before) throw new Error('Party rate not found')
  db.prepare('DELETE FROM party_item_rates WHERE id = ?').run(id)
  writeAudit(db, 'partyRate', id, 'delete', before, null)
}

/**
 * "Remember last price": after a sales invoice is saved, each item line's rate (₹, per unit)
 * and its discount (as bp of the line's gross) become the party + item's remembered price —
 * unless a later sale is already remembered (a back-dated invoice never regresses it). Lines in a
 * foreign currency are stored in ₹ (inventory lines are). `skipLedgerId` is the counter's
 * walk-in party, whose "last price" would be everyone's. Returns the rows written.
 */
export function rememberSalePrices(db: DB, voucherId: number, opts: { force?: boolean; skipLedgerId?: number | null } = {}): number {
  if (!opts.force && !getPricingConfig(db).rememberLastPrice) return 0
  const v = db
    .prepare(
      `SELECT v.id, v.date, v.party_ledger_id AS partyId, vt.kind FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id
       WHERE v.id = ? AND ${IN_BOOKS}`
    )
    .get(voucherId) as { id: number; date: string; partyId: number | null; kind: string } | undefined
  if (!v || v.kind !== 'sales' || v.partyId == null || v.partyId === (opts.skipLedgerId ?? walkInLedgerId(db))) return 0
  const lines = db
    .prepare('SELECT stock_item_id AS itemId, qty_milli AS qty, rate_paise AS rate, discount_paise AS disc FROM inventory_lines WHERE voucher_id = ? AND is_absolute = 0 ORDER BY line_order, id')
    .all(voucherId) as { itemId: number; qty: number; rate: number; disc: number }[]
  const existing = db.prepare("SELECT id, last_sold_at FROM party_item_rates WHERE ledger_id = ? AND stock_item_id = ? AND source = 'last_sale'")
  let n = 0
  const seen = new Set<number>()
  for (const l of lines) {
    if (seen.has(l.itemId)) continue // the first line of an item is its price
    seen.add(l.itemId)
    const gross = Math.round((l.qty * l.rate) / 1000)
    const bp = gross > 0 && l.disc > 0 ? Math.min(10000, Math.round((l.disc * 10000) / gross)) : 0
    const row = existing.get(v.partyId, l.itemId) as { id: number; last_sold_at: string | null } | undefined
    if (row && row.last_sold_at != null && row.last_sold_at > v.date) continue
    if (row) {
      db.prepare('UPDATE party_item_rates SET rate_paise = ?, discount_bp = ?, last_sold_at = ?, last_voucher_id = ? WHERE id = ?').run(l.rate, bp, v.date, v.id, row.id)
    } else {
      db.prepare(
        `INSERT INTO party_item_rates (ledger_id, stock_item_id, rate_paise, discount_bp, source, last_sold_at, last_voucher_id)
         VALUES (?, ?, ?, ?, 'last_sale', ?, ?)`
      ).run(v.partyId, l.itemId, l.rate, bp, v.date, v.id)
    }
    n++
  }
  return n
}

/** The counter's walk-in party (counter.config, else the "Cash sale" ledger) — its "last price"
 *  would be everyone's, so it is never remembered. */
function walkInLedgerId(db: DB): number | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'counter.config'").get() as { value: string } | undefined
  try {
    const id = row ? (JSON.parse(row.value) as { walkInLedgerId?: unknown }).walkInLedgerId : null
    if (typeof id === 'number') return id
  } catch {
    /* fall through */
  }
  return (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash sale'").get() as { id: number } | undefined)?.id ?? null
}

// ---------------------------------------------------------------- discount schemes


export function listSchemes(db: DB): DiscountSchemeRow[] {
  const rows = db
    .prepare(
      `SELECT s.id, s.name, s.kind, s.applies_to AS appliesTo, s.target_id AS targetId, s.from_date AS fromDate, s.to_date AS toDate,
              s.priority, s.active,
              CASE s.applies_to WHEN 'item' THEN (SELECT name FROM stock_items WHERE id = s.target_id)
                                WHEN 'group' THEN (SELECT name FROM stock_groups WHERE id = s.target_id) END AS targetName
       FROM discount_schemes s ORDER BY s.active DESC, s.priority DESC, s.name`
    )
    .all() as (Omit<DiscountSchemeRow, 'slabs' | 'active'> & { active: number })[]
  const slabStmt = db.prepare(
    `SELECT min_qty_milli AS minQtyMilli, min_value_paise AS minValuePaise, discount_bp AS discountBp, free_qty_milli AS freeQtyMilli
     FROM discount_scheme_slabs WHERE scheme_id = ? ORDER BY COALESCE(min_qty_milli, min_value_paise), id`
  )
  return rows.map((r) => ({ ...r, active: !!r.active, slabs: slabStmt.all(r.id) as DiscountScheme['slabs'] }))
}

function getScheme(db: DB, id: number): DiscountSchemeRow | undefined {
  return listSchemes(db).find((s) => s.id === id)
}

export function saveScheme(db: DB, raw: DiscountSchemeInput, id?: number): DiscountSchemeRow {
  const input = discountSchemeInputSchema.parse(raw)
  if (input.appliesTo === 'item' && !db.prepare('SELECT 1 FROM stock_items WHERE id = ?').get(input.targetId)) throw new Error('Stock item not found')
  if (input.appliesTo === 'group' && !db.prepare('SELECT 1 FROM stock_groups WHERE id = ?').get(input.targetId)) throw new Error('Stock group not found')
  return db.transaction(() => {
    const before = id ? getScheme(db, id) : undefined
    if (id && !before) throw new Error('Scheme not found')
    let schemeId = id
    const args = [input.name, input.kind, input.appliesTo, input.targetId, input.fromDate, input.toDate, input.priority, input.active ? 1 : 0] as const
    if (id) {
      db.prepare('UPDATE discount_schemes SET name = ?, kind = ?, applies_to = ?, target_id = ?, from_date = ?, to_date = ?, priority = ?, active = ? WHERE id = ?').run(...args, id)
      db.prepare('DELETE FROM discount_scheme_slabs WHERE scheme_id = ?').run(id)
    } else {
      schemeId = Number(
        db.prepare('INSERT INTO discount_schemes (name, kind, applies_to, target_id, from_date, to_date, priority, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(...args).lastInsertRowid
      )
    }
    const ins = db.prepare('INSERT INTO discount_scheme_slabs (scheme_id, min_qty_milli, min_value_paise, discount_bp, free_qty_milli) VALUES (?, ?, ?, ?, ?)')
    for (const sl of input.slabs) {
      // A flat scheme's single slab applies from quantity 0.
      const minQty = input.kind === 'flat' ? (sl.minQtyMilli ?? 0) : sl.minQtyMilli
      ins.run(schemeId, minQty, sl.minValuePaise, sl.discountBp, sl.freeQtyMilli)
    }
    const saved = getScheme(db, schemeId!)!
    writeAudit(db, 'discountScheme', saved.id, before ? 'update' : 'create', before ?? null, saved)
    return saved
  })()
}

export function deleteScheme(db: DB, id: number): void {
  const before = getScheme(db, id)
  if (!before) throw new Error('Scheme not found')
  db.prepare('DELETE FROM discount_schemes WHERE id = ?').run(id)
  writeAudit(db, 'discountScheme', id, 'delete', before, null)
}

// ---------------------------------------------------------------- the resolver

export interface ResolveRequest {
  date: string
  partyLedgerId: number | null
  currency: string
  supply: SupplyType
  lines: { key: number; itemId: number; qtyMilli: number }[]
}


/** Prepared statements + per-call caches for building PriceContexts (counter billing reuses one
 *  loader across a checkout). */
export function pricingLoader(db: DB): (req: Omit<ResolveRequest, 'lines'>, itemId: number, qtyMilli: number) => PriceResult {
  const levelStmt = db.prepare('SELECT id, name, inclusive_of_tax FROM price_levels WHERE id = ?')
  const partyStmt = db.prepare('SELECT price_level_id FROM ledgers WHERE id = ?')
  const itemStmt = db.prepare('SELECT id, group_id, gst_rate, cess_rate, mrp_paise FROM stock_items WHERE id = ?')
  const groupStmt = db.prepare('SELECT parent_id FROM stock_groups WHERE id = ?')
  const ratesStmt = db.prepare(
    `SELECT id, price_level_id AS priceLevelId, rate AS ratePaise, effective_from AS effectiveFrom, effective_to AS effectiveTo,
            min_qty_milli AS minQtyMilli, discount_bp AS discountBp, currency
     FROM price_list_rates WHERE stock_item_id = ?`
  )
  const partyRatesStmt = db.prepare(
    `SELECT id, rate_paise AS ratePaise, discount_bp AS discountBp, effective_from AS effectiveFrom, effective_to AS effectiveTo, source,
            last_sold_at AS lastSoldAt
     FROM party_item_rates WHERE ledger_id = ? AND stock_item_id = ?`
  )
  const lastPurchaseStmt = db.prepare(
    `SELECT il.rate_paise AS rate FROM inventory_lines il
     JOIN vouchers v ON v.id = il.voucher_id JOIN voucher_types vt ON vt.id = v.voucher_type_id
     WHERE il.stock_item_id = ? AND vt.kind = 'purchase' AND il.direction = 'in' AND il.is_absolute = 0 AND il.rate_paise > 0
       AND v.date <= ? AND ${IN_BOOKS}
     ORDER BY v.date DESC, v.id DESC LIMIT 1`
  )
  const level = (id: number | null): PriceLevelInfo | null => {
    if (id == null) return null
    const r = levelStmt.get(id) as { id: number; name: string; inclusive_of_tax: number } | undefined
    return r ? { id: r.id, name: r.name, inclusiveOfTax: !!r.inclusive_of_tax } : null
  }
  const def = defaultPriceLevel(db)
  const defaultLevel: PriceLevelInfo | null = def ? { id: def.id, name: def.name, inclusiveOfTax: !!def.inclusiveOfTax } : null
  const schemes: DiscountScheme[] = listSchemes(db).filter((s) => s.active)
  const partyLevels = new Map<number, PriceLevelInfo | null>()
  return (req, itemId, qtyMilli) => {
    const it = itemStmt.get(itemId) as { id: number; group_id: number | null; gst_rate: number | null; cess_rate: number | null; mrp_paise: number | null } | undefined
    if (!it) throw new Error('Stock item not found')
    const groupIds: number[] = []
    for (let g = it.group_id, guard = 0; g != null && guard < 50; guard++) {
      groupIds.push(g)
      g = (groupStmt.get(g) as { parent_id: number | null } | undefined)?.parent_id ?? null
    }
    let partyLevel: PriceLevelInfo | null = null
    if (req.partyLedgerId != null) {
      if (!partyLevels.has(req.partyLedgerId)) {
        const p = partyStmt.get(req.partyLedgerId) as { price_level_id: number | null } | undefined
        partyLevels.set(req.partyLedgerId, level(p?.price_level_id ?? null))
      }
      partyLevel = partyLevels.get(req.partyLedgerId) ?? null
    }
    const ctx: PriceContext = {
      date: req.date,
      qtyMilli,
      currency: req.currency,
      supply: req.supply,
      item: {
        id: it.id, groupIds, gstRate: it.gst_rate, cessRate: it.cess_rate, mrpPaise: it.mrp_paise,
        lastPurchaseRatePaise: (lastPurchaseStmt.get(itemId, req.date) as { rate: number } | undefined)?.rate ?? null
      },
      partyRates: req.partyLedgerId != null ? (partyRatesStmt.all(req.partyLedgerId, itemId) as PartyRateRow[]) : [],
      partyLevel,
      defaultLevel,
      levelRates: ratesStmt.all(itemId) as LevelRateRow[],
      schemes
    }
    return resolvePrice(ctx)
  }
}

/** pricing:resolve — price every requested line. */
export function resolveLines(db: DB, req: ResolveRequest): ResolvedLine[] {
  const price = pricingLoader(db)
  return req.lines.map((l) => ({ key: l.key, itemId: l.itemId, qtyMilli: l.qtyMilli, result: price(req, l.itemId, l.qtyMilli) }))
}
