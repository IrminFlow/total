import type { DB } from '../db/connection'
import { allocateLandedCosts, type LandedCost, type LandedCostBasis } from '@shared/landedCost'
import { IN_BOOKS, NOT_DELETED } from './vouchers'

/**
 * Landed cost allocation across a purchase (roadmap #117).
 *
 * The charge itself is already on the purchase voucher as an ordinary debit — Dr Freight Inward,
 * Cr the transporter or the party. What is stored here is only the instruction to carry that
 * money into the value of the goods, and on which basis. Nothing in this file posts anything, so
 * a landed cost can be added, changed or removed without ever unbalancing a voucher.
 *
 * The guard that keeps it honest is that a landed cost has to point at a debit line that is
 * actually on that voucher, and the amounts allocated from a ledger cannot exceed what was posted
 * to it. Otherwise the feature is a text box for inflating closing stock.
 */

export interface LandedCostRow extends LandedCost {
  id: number
  ledgerId: number
  ledgerName: string
}

export interface LandedCostInputRow {
  ledgerId: number
  label: string
  amount: number
  basis: LandedCostBasis
}

export function listLandedCosts(db: DB, voucherId: number): LandedCostRow[] {
  return db
    .prepare(
      `SELECT lc.id, lc.ledger_id AS ledgerId, l.name AS ledgerName, lc.label, lc.amount, lc.basis
       FROM landed_costs lc
       JOIN ledgers l ON l.id = lc.ledger_id
       WHERE lc.voucher_id = ?
       ORDER BY lc.line_order, lc.id`
    )
    .all(voucherId) as LandedCostRow[]
}

/** The voucher's own debit lines, which is the menu a landed cost may be picked from. */
export interface CapitalisableLine {
  ledgerId: number
  ledgerName: string
  /** Total debited to this ledger on this voucher, paise. */
  amount: number
  /** Already allocated to the goods, paise. */
  allocated: number
}

export function capitalisableLines(db: DB, voucherId: number): CapitalisableLine[] {
  return db
    .prepare(
      `SELECT vl.ledger_id AS ledgerId, l.name AS ledgerName, SUM(vl.amount) AS amount,
              COALESCE((SELECT SUM(lc.amount) FROM landed_costs lc
                        WHERE lc.voucher_id = vl.voucher_id AND lc.ledger_id = vl.ledger_id), 0) AS allocated
       FROM voucher_lines vl JOIN ledgers l ON l.id = vl.ledger_id
       WHERE vl.voucher_id = ? AND vl.dr_cr = 'dr'
       GROUP BY vl.ledger_id, l.name
       ORDER BY l.name`
    )
    .all(voucherId) as CapitalisableLine[]
}

export interface LandedCostView {
  voucherId: number
  date: string
  number: string
  partyName: string | null
  costs: LandedCostRow[]
  candidates: CapitalisableLine[]
  /** Item lines with their share of the costs and the rate the goods really cost. */
  lines: {
    inventoryLineId: number
    stockItemId: number
    name: string
    unitSymbol: string
    decimals: number
    qtyMilli: number
    /** What the supplier billed for this line, paise. */
    amount: number
    ratePaise: number
    extra: number
    effectiveAmount: number
    effectiveRatePaise: number
  }[]
  total: number
  unallocated: number
}

function purchaseHeader(db: DB, voucherId: number): { date: string; number: string; partyName: string | null } {
  const row = db
    .prepare(
      `SELECT v.date, v.number, l.name AS partyName
       FROM vouchers v
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       LEFT JOIN ledgers l ON l.id = v.party_ledger_id
       WHERE v.id = ? AND vt.kind = 'purchase' AND ${NOT_DELETED}`
    )
    .get(voucherId) as { date: string; number: string; partyName: string | null } | undefined
  if (!row) throw new Error('Landed costs can only be added to a purchase')
  return row
}

interface PurchaseItemLine {
  id: number
  stockItemId: number
  name: string
  unitSymbol: string
  decimals: number
  qtyMilli: number
  amount: number
  ratePaise: number
}

function itemLines(db: DB, voucherId: number): PurchaseItemLine[] {
  return db
    .prepare(
      `SELECT il.id, il.stock_item_id AS stockItemId, si.name, u.symbol AS unitSymbol, u.decimals,
              il.qty_milli AS qtyMilli, il.amount, il.rate_paise AS ratePaise
       FROM inventory_lines il
       JOIN stock_items si ON si.id = il.stock_item_id
       JOIN units u ON u.id = si.unit_id
       WHERE il.voucher_id = ? AND il.direction = 'in' AND il.is_absolute = 0
       ORDER BY il.line_order, il.id`
    )
    .all(voucherId) as PurchaseItemLine[]
}

/** The purchase, its landed costs, and what each item line really cost once they are loaded on. */
export function landedCostView(db: DB, voucherId: number): LandedCostView {
  const header = purchaseHeader(db, voucherId)
  const costs = listLandedCosts(db, voucherId)
  const lines = itemLines(db, voucherId)
  const allocation = allocateLandedCosts(lines.map((l) => ({ id: l.id, qtyMilli: l.qtyMilli, amount: l.amount })), costs)
  const extraById = new Map(allocation.lines.map((l) => [l.id, l]))

  return {
    voucherId,
    ...header,
    costs,
    candidates: capitalisableLines(db, voucherId),
    lines: lines.map((l) => {
      const a = extraById.get(l.id)
      return {
        inventoryLineId: l.id,
        stockItemId: l.stockItemId,
        name: l.name,
        unitSymbol: l.unitSymbol,
        decimals: l.decimals,
        qtyMilli: l.qtyMilli,
        amount: l.amount,
        ratePaise: l.ratePaise,
        extra: a?.extra ?? 0,
        effectiveAmount: a?.effectiveAmount ?? l.amount,
        effectiveRatePaise: a?.effectiveRatePaise ?? l.ratePaise
      }
    }),
    total: allocation.total,
    unallocated: allocation.unallocated
  }
}

/**
 * Replace the voucher's landed costs with `costs`.
 *
 * Replace rather than append, because that is what the editing screen means when it saves a list,
 * and appending would double every charge the second time somebody presses save.
 */
export function saveLandedCosts(db: DB, voucherId: number, costs: LandedCostInputRow[]): LandedCostView {
  purchaseHeader(db, voucherId)
  if (itemLines(db, voucherId).length === 0) {
    throw new Error('This purchase has no item lines to carry the cost')
  }

  const candidates = new Map(capitalisableLines(db, voucherId).map((c) => [c.ledgerId, c]))
  const perLedger = new Map<number, number>()
  for (const c of costs) {
    if (c.amount <= 0) throw new Error(`${c.label || 'Landed cost'}: amount must be more than zero`)
    const candidate = candidates.get(c.ledgerId)
    if (!candidate) {
      throw new Error(`${c.label || 'Landed cost'}: that ledger is not debited on this purchase`)
    }
    const running = (perLedger.get(c.ledgerId) ?? 0) + c.amount
    if (running > candidate.amount) {
      // Capitalising more than was spent would inflate closing stock out of thin air.
      throw new Error(`${candidate.ledgerName}: only what the voucher debits to it can be carried into the goods`)
    }
    perLedger.set(c.ledgerId, running)
  }

  db.transaction(() => {
    db.prepare('DELETE FROM landed_costs WHERE voucher_id = ?').run(voucherId)
    const insert = db.prepare(
      'INSERT INTO landed_costs (voucher_id, ledger_id, label, amount, basis, line_order) VALUES (?, ?, ?, ?, ?, ?)'
    )
    costs.forEach((c, i) => insert.run(voucherId, c.ledgerId, c.label.trim() || 'Landed cost', c.amount, c.basis, i))
  })()

  return landedCostView(db, voucherId)
}

export interface CostedPurchaseRow {
  voucherId: number
  date: string
  number: string
  partyName: string | null
  /** Total value of the item lines, paise. */
  goodsValue: number
  /** Landed cost already allocated, paise. */
  landed: number
  items: number
}

/** Recent purchases carrying stock, so the screen can offer something to allocate against
 *  without asking the user to remember a voucher number. */
export function costablePurchases(db: DB, from: string, to: string, limit = 25): CostedPurchaseRow[] {
  return db
    .prepare(
      `SELECT v.id AS voucherId, v.date, v.number, l.name AS partyName,
              SUM(il.amount) AS goodsValue, COUNT(il.id) AS items,
              COALESCE((SELECT SUM(lc.amount) FROM landed_costs lc WHERE lc.voucher_id = v.id), 0) AS landed
       FROM vouchers v
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       JOIN inventory_lines il ON il.voucher_id = v.id AND il.direction = 'in' AND il.is_absolute = 0
       LEFT JOIN ledgers l ON l.id = v.party_ledger_id
       WHERE vt.kind = 'purchase' AND v.date BETWEEN ? AND ? AND ${IN_BOOKS}
       GROUP BY v.id
       ORDER BY v.date DESC, v.id DESC
       LIMIT ?`
    )
    .all(from, to, limit) as CostedPurchaseRow[]
}
