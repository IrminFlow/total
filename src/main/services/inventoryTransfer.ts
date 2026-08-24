import type { DB } from '../db/connection'
import { planTransfer, type TransferItem, type TransferItemFacts, type TransferPlan } from '@shared/stockTransfer'
import { outwardCostOf, stockByGodown } from './stockAnalysis'
import { saveVoucher, IN_BOOKS } from './vouchers'

/**
 * Godown-to-godown stock transfers (roadmap #112).
 *
 * Recorded as a stock journal with no ledger lines at all: nothing is bought, nothing is sold and
 * no money moves, so there is nothing to post to the books. Each item contributes an out line on
 * the source godown and an in line on the destination, of the same quantity and the same value,
 * which is what makes per-godown stock change while company-wide stock stays exactly where it was.
 */

export interface GodownAvailabilityRow {
  stockItemId: number
  name: string
  unitSymbol: string
  decimals: number
  availableQtyMilli: number
  /** Paise per whole unit at the item's own valuation — a display rate, not the transfer value. */
  ratePaise: number
}

/**
 * What a godown actually holds as of `asOn`, so the form offers only what can be moved.
 *
 * Deliberately the same numbers the stock summary shows on screen (`stockByGodown`), rather than a
 * second query with its own opinion — a form that lets you move stock the report says isn't there
 * is a bug report with extra steps.
 */
export function godownAvailability(db: DB, asOn: string, godownId: number): GodownAvailabilityRow[] {
  return stockByGodown(db, asOn)
    .filter((r) => r.godownId === godownId && r.closingQtyMilli > 0)
    .map((r) => ({
      stockItemId: r.stockItemId,
      name: r.name,
      unitSymbol: r.unitSymbol,
      decimals: r.decimals,
      availableQtyMilli: r.closingQtyMilli,
      ratePaise: Math.round((r.closingValue * 1000) / r.closingQtyMilli)
    }))
}

export interface TransferInput {
  date: string
  fromGodownId: number
  toGodownId: number
  items: TransferItem[]
  narration?: string | null
  number?: string
}

/** Gather the facts the pure planner needs: what the source godown holds, and what taking each
 *  requested quantity out actually costs on the books. */
function factsFor(db: DB, input: TransferInput): Map<number, TransferItemFacts> {
  const available = new Map(godownAvailability(db, input.date, input.fromGodownId).map((r) => [r.stockItemId, r]))
  const facts = new Map<number, TransferItemFacts>()
  const nameStmt = db.prepare(
    `SELECT si.name, u.symbol AS unitSymbol, u.decimals
     FROM stock_items si JOIN units u ON u.id = si.unit_id WHERE si.id = ?`
  )
  for (const item of input.items) {
    const row = available.get(item.stockItemId)
    if (row) {
      facts.set(item.stockItemId, {
        name: row.name,
        unitSymbol: row.unitSymbol,
        decimals: row.decimals,
        availableQtyMilli: row.availableQtyMilli,
        costPaise: outwardCostOf(db, input.date, item.stockItemId, item.qtyMilli)
      })
      continue
    }
    // The item exists but this godown holds none of it — the planner must say so by name rather
    // than reporting a bare id, so add the facts with nothing available.
    const named = nameStmt.get(item.stockItemId) as
      | { name: string; unitSymbol: string; decimals: number }
      | undefined
    if (named) facts.set(item.stockItemId, { ...named, availableQtyMilli: 0, costPaise: 0 })
  }
  return facts
}

/** Dry run: the lines that would be written, or every reason they cannot be. Drives the form's
 *  live preview, so a transfer is refused before the user presses save rather than after. */
export function previewTransfer(db: DB, input: TransferInput): TransferPlan {
  return planTransfer(input, factsFor(db, input))
}

export interface TransferResult {
  voucherId: number
  number: string
  totalValue: number
  lineCount: number
}

/** Record the transfer. Throws with every problem at once when the plan is not valid. */
export function saveTransfer(db: DB, input: TransferInput): TransferResult {
  const plan = previewTransfer(db, input)
  if (plan.errors.length > 0) throw new Error(plan.errors.join('; '))

  const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'stock_journal' ORDER BY is_system DESC, id LIMIT 1").get() as
    | { id: number }
    | undefined
  if (!vt) throw new Error('No stock journal voucher type exists')

  const from = godownName(db, input.fromGodownId)
  const to = godownName(db, input.toGodownId)
  const saved = saveVoucher(db, {
    voucherTypeId: vt.id,
    date: input.date,
    number: input.number,
    // Narration carries where it went, because a stock journal's own lines are the only other
    // record of it and nobody reads those from a day book listing.
    narration: input.narration?.trim() || `Stock transfer: ${from} → ${to}`,
    lines: [],
    inventory: plan.lines.map((l) => ({
      stockItemId: l.stockItemId,
      godownId: l.godownId,
      batchId: null,
      qtyMilli: l.qtyMilli,
      ratePaise: l.ratePaise,
      discountPaise: 0,
      amount: l.amount,
      direction: l.direction,
      isAbsolute: false
    }))
  })
  return { voucherId: saved.id, number: saved.number, totalValue: plan.totalValue, lineCount: plan.lines.length / 2 }
}

function godownName(db: DB, id: number): string {
  const row = db.prepare('SELECT name FROM godowns WHERE id = ?').get(id) as { name: string } | undefined
  if (!row) throw new Error('Godown not found')
  return row.name
}

export interface TransferListRow {
  voucherId: number
  date: string
  number: string
  narration: string | null
  fromGodown: string
  toGodown: string
  items: number
  totalValue: number
}

/**
 * Recent transfers, newest first.
 *
 * There is no `is_transfer` flag to read: a transfer is recognised by its shape — a stock journal
 * with no ledger lines whose outs and ins are the same items in the same quantities on two
 * different godowns. Recognising the shape rather than storing a flag keeps a transfer an ordinary
 * voucher, editable and deletable through the same screens as everything else.
 */
export function listTransfers(db: DB, from: string, to: string, limit = 20): TransferListRow[] {
  const vouchers = db
    .prepare(
      `SELECT v.id AS voucherId, v.date, v.number, v.narration
       FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id
       WHERE vt.kind = 'stock_journal' AND v.date BETWEEN ? AND ? AND ${IN_BOOKS}
         AND NOT EXISTS (SELECT 1 FROM voucher_lines WHERE voucher_id = v.id)
       ORDER BY v.date DESC, v.id DESC`
    )
    .all(from, to) as { voucherId: number; date: string; number: string; narration: string | null }[]

  const linesStmt = db.prepare(
    `SELECT il.stock_item_id AS stockItemId, il.qty_milli AS qtyMilli, il.amount, il.direction,
            COALESCE(g.name, '') AS godownName
     FROM inventory_lines il LEFT JOIN godowns g ON g.id = il.godown_id
     WHERE il.voucher_id = ? AND il.is_absolute = 0`
  )

  const rows: TransferListRow[] = []
  for (const v of vouchers) {
    if (rows.length >= limit) break
    const lines = linesStmt.all(v.voucherId) as {
      stockItemId: number; qtyMilli: number; amount: number; direction: 'in' | 'out'; godownName: string
    }[]
    const outs = lines.filter((l) => l.direction === 'out')
    const ins = lines.filter((l) => l.direction === 'in')
    if (outs.length === 0 || outs.length !== ins.length) continue
    const sources = new Set(outs.map((l) => l.godownName))
    const targets = new Set(ins.map((l) => l.godownName))
    if (sources.size !== 1 || targets.size !== 1) continue
    const [source] = sources
    const [target] = targets
    if (!source || !target || source === target) continue
    const sameQuantities = outs.every((o) =>
      ins.some((i) => i.stockItemId === o.stockItemId && i.qtyMilli === o.qtyMilli)
    )
    if (!sameQuantities) continue
    rows.push({
      voucherId: v.voucherId,
      date: v.date,
      number: v.number,
      narration: v.narration,
      fromGodown: source,
      toGodown: target,
      items: outs.length,
      totalValue: outs.reduce((s, l) => s + l.amount, 0)
    })
  }
  return rows
}
