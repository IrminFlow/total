import type { DB } from '../db/connection'
import type { Voucher } from '@shared/domain'
import { manufactureInputSchema, type ManufactureCostPreviewInput } from '@shared/schemas'
import {
  buildManufactureVoucher, needsLossConfirmation, validateManufacture, manufactureTotals,
  LABOUR_CREDIT_GROUP, LABOUR_CREDIT_LEDGER, LABOUR_EXPENSE_GROUP, LABOUR_EXPENSE_LEDGER,
  type ManufactureDetails, type ManufactureInput
} from '@shared/manufacture'
import { fyOf } from '@shared/dates'
import { costAsOf } from './stockAnalysis'
import { findOrCreateLedger } from './masters'
import { getVoucher, saveVoucher, IN_BOOKS, NOT_DELETED, type SaveVoucherResult } from './vouchers'
import { writeAudit } from './audit'

/**
 * Manufacture voucher service (WP 2.2). A manufacture is a stock_journal built here from the
 * Manufacture screen's input and saved through vouchers.saveVoucher (numbering, lock date,
 * year-end immutability, negative-stock warn/block, audit, duplicate-number flag all come from
 * that pipeline) with its `manufacture_details` row written inside the same transaction.
 * Costing: stockAnalysis' default derived-costing source reads manufacture_details, so these
 * vouchers are valued 'derived' — finished goods = engine cost of the consumed raw materials +
 * labour, re-derived at every valuation (a backdated purchase re-prices them).
 */

interface DetailsRow {
  voucher_id: number
  finished_item_id: number
  qty_milli: number
  sale_rate_paise: number
  sale_amount: number
  labour_paise: number
  labour_posted: number
  labour_expense_ledger_id: number | null
  labour_credit_ledger_id: number | null
  profit_paise: number
}

const mapDetails = (r: DetailsRow): ManufactureDetails => ({
  voucherId: r.voucher_id,
  finishedItemId: r.finished_item_id,
  qtyMilli: r.qty_milli,
  saleRatePaise: r.sale_rate_paise,
  saleAmount: r.sale_amount,
  labourPaise: r.labour_paise,
  labourPosted: !!r.labour_posted,
  labourExpenseLedgerId: r.labour_expense_ledger_id,
  labourCreditLedgerId: r.labour_credit_ledger_id,
  profitPaise: r.profit_paise
})

export function getManufactureDetails(db: DB, voucherId: number): ManufactureDetails | null {
  const row = db.prepare('SELECT * FROM manufacture_details WHERE voucher_id = ?').get(voucherId) as DetailsRow | undefined
  return row ? mapDetails(row) : null
}

export interface ManufactureRecord {
  voucher: Voucher
  /** null = a legacy stock journal (created before 0.6.0, costed at its saved amounts). */
  details: ManufactureDetails | null
}

export function getManufacture(db: DB, voucherId: number): ManufactureRecord | null {
  const voucher = getVoucher(db, voucherId)
  if (!voucher) return null
  return { voucher, details: getManufactureDetails(db, voucherId) }
}

// ---------- pricing ----------

export interface SaleRateSuggestion {
  /** Paise per whole unit; null = nothing to suggest. */
  ratePaise: number | null
  source: 'sales' | 'priceList' | null
}

/**
 * The finished item's average SELLING rate for the Sale Item row: Σ amount ÷ Σ qty over its
 * in-books sales lines in the financial year of `date`; else the latest price-list rate in force
 * on `date` (any price level, lowest level first); else null.
 */
export function suggestedSaleRate(db: DB, itemId: number, date: string): SaleRateSuggestion {
  const fy = fyOf(date)
  const sales = db
    .prepare(
      `SELECT COALESCE(SUM(il.amount), 0) AS amount, COALESCE(SUM(il.qty_milli), 0) AS qty
       FROM inventory_lines il
       JOIN vouchers v ON v.id = il.voucher_id
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       WHERE il.stock_item_id = ? AND vt.kind = 'sales' AND il.direction = 'out' AND il.is_absolute = 0
         AND v.date BETWEEN ? AND ? AND ${IN_BOOKS}`
    )
    .get(itemId, fy.from, fy.to) as { amount: number; qty: number }
  if (sales.qty > 0) return { ratePaise: Math.round((sales.amount * 1000) / sales.qty), source: 'sales' }
  const listed = db
    .prepare(
      `SELECT rate FROM price_list_rates WHERE stock_item_id = ? AND effective_from <= ?
       ORDER BY price_level_id, effective_from DESC LIMIT 1`
    )
    .get(itemId, date) as { rate: number } | undefined
  if (listed) return { ratePaise: listed.rate, source: 'priceList' }
  return { ratePaise: null, source: null }
}

export interface CostPreviewLine {
  itemId: number
  qtyMilli: number
  /** Engine cost of taking this quantity as of the voucher date (paise). */
  costPaise: number
  /** Average cost per whole unit shown in the row: costPaise ÷ qty when there is a quantity,
   *  else what one unit would cost now. */
  unitCostPaise: number
  /** On hand before this voucher, thousandths (negative = overdrawn). */
  onHandQtyMilli: number
}

export interface CostPreview {
  lines: CostPreviewLine[]
  totalPaise: number
  saleRate: SaleRateSuggestion
}

/** Price the screen's raw rows as of the voucher date (WP 2.1 costConsumption — exactly what
 *  the derived costing will charge), plus the finished item's suggested sale rate. */
export function costPreview(db: DB, q: ManufactureCostPreviewInput): CostPreview {
  const lines = q.lines.map((l) => ({ itemId: l.itemId, qtyMilli: l.qtyMilli }))
  const r = costAsOf(db, { date: q.date, voucherId: q.voucherId, lines, itemIds: [...new Set(lines.map((l) => l.itemId))] })
  const pos = new Map(r.positions.map((p) => [p.itemId, p]))
  const priced = r.consumption?.lines ?? []
  return {
    lines: priced.map((l) => {
      const p = pos.get(l.itemId)
      return {
        itemId: l.itemId,
        qtyMilli: l.qtyMilli,
        costPaise: l.costPaise,
        unitCostPaise: l.qtyMilli > 0 ? Math.round((l.costPaise * 1000) / l.qtyMilli) : (p?.unitCostPaise ?? 0),
        onHandQtyMilli: p?.qtyMilli ?? 0
      }
    }),
    totalPaise: r.consumption?.totalPaise ?? 0,
    saleRate: q.finishedItemId ? suggestedSaleRate(db, q.finishedItemId, q.date) : { ratePaise: null, source: null }
  }
}

// ---------- save ----------

export const LOSS_NEEDS_CONFIRMATION = 'This manufacture makes a loss — confirm to save it anyway'

export type SaveManufactureResult = SaveVoucherResult & { manufacture: ManufactureDetails }

function stockJournalTypeId(db: DB, wanted?: number): number {
  if (wanted) {
    const row = db.prepare('SELECT kind FROM voucher_types WHERE id = ?').get(wanted) as { kind: string } | undefined
    if (!row) throw new Error('Voucher type not found')
    if (row.kind !== 'stock_journal') throw new Error('A manufacture must use a stock journal voucher type')
    return wanted
  }
  const row = db.prepare("SELECT id FROM voucher_types WHERE kind = 'stock_journal' ORDER BY id LIMIT 1").get() as
    | { id: number }
    | undefined
  if (!row) throw new Error('No stock journal voucher type — add one in Masters → Voucher types')
  return row.id
}

/**
 * Create (no `existingId`) or alter a manufacture, in ONE transaction: labour ledgers
 * (find-or-create), the stock_journal via saveVoucher, and the manufacture_details row. Throws
 * with a user-facing message when a rule fails; negative stock is a warning on the result unless
 * the company blocks it (Settings → Features), exactly as for any other voucher.
 */
export function saveManufacture(db: DB, raw: ManufactureInput, existingId?: number): SaveManufactureResult {
  const input = manufactureInputSchema.parse(raw) as ManufactureInput
  const before = existingId ? getManufacture(db, existingId) : null
  if (existingId) {
    if (!before) throw new Error('Voucher not found')
    if (!before.details) {
      throw new Error('This stock journal was created before 0.6.0 — alter it from voucher entry (it keeps its saved amounts)')
    }
  }
  const voucherTypeId = stockJournalTypeId(db, input.voucherTypeId ?? before?.voucher.voucherTypeId)
  const itemRows = db.prepare('SELECT id, name FROM stock_items').all() as { id: number; name: string }[]
  const names = new Map(itemRows.map((i) => [i.id, i.name]))
  const itemName = (id: number): string => names.get(id) ?? `Item #${id}`
  const unknown = [input.finishedItemId, ...input.raw.map((r) => r.stockItemId)].find((id) => id > 0 && !names.has(id))
  if (unknown !== undefined) throw new Error('Stock item not found')

  const structural = validateManufacture(input, undefined, itemName)
  if (structural.length) throw new Error(structural.map((i) => i.message).join('; '))

  const run = db.transaction((): SaveManufactureResult => {
    // Price consumption at the voucher's own position (an alteration leaves its old lines out).
    const priced = costAsOf(db, {
      date: input.date,
      voucherId: existingId,
      lines: input.raw.map((r) => ({ itemId: r.stockItemId, qtyMilli: r.qtyMilli }))
    }).consumption!
    const issues = validateManufacture(input, priced.totalPaise, itemName)
    if (issues.length) throw new Error(issues.map((i) => i.message).join('; '))
    if (needsLossConfirmation(input.profitPaise) && !input.confirmLoss) throw new Error(LOSS_NEEDS_CONFIRMATION)

    let expenseId: number | null = null
    let creditId: number | null = null
    if (input.labourPosted) {
      if (input.labourCreditLedgerId != null) {
        const exists = db.prepare('SELECT 1 FROM ledgers WHERE id = ?').get(input.labourCreditLedgerId)
        if (!exists) throw new Error('Labour credit account not found')
        creditId = input.labourCreditLedgerId
      }
      if (input.labourPaise > 0) {
        expenseId = findOrCreateLedger(db, LABOUR_EXPENSE_LEDGER, LABOUR_EXPENSE_GROUP)
        creditId ??= findOrCreateLedger(db, LABOUR_CREDIT_LEDGER, LABOUR_CREDIT_GROUP)
        if (creditId === expenseId) throw new Error('Labour cannot be credited to the Labour Charges ledger itself')
      }
    }

    const payload = buildManufactureVoucher(input, {
      voucherTypeId,
      rawCosts: priced.lines.map((l) => l.costPaise),
      finishedName: itemName(input.finishedItemId),
      labourExpenseLedgerId: expenseId,
      labourCreditLedgerId: creditId
    })
    const totals = manufactureTotals({
      qtyMilli: input.qtyMilli,
      saleRatePaise: input.saleRatePaise,
      materialPaise: priced.totalPaise,
      labourPaise: input.labourPaise
    })
    const saved = saveVoucher(db, payload, existingId, {
      manufacture: true,
      withinTransaction: (voucherId) => {
        db.prepare(
          `INSERT INTO manufacture_details (voucher_id, finished_item_id, qty_milli, sale_rate_paise, sale_amount,
             labour_paise, labour_posted, labour_expense_ledger_id, labour_credit_ledger_id, profit_paise)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(voucher_id) DO UPDATE SET finished_item_id = excluded.finished_item_id,
             qty_milli = excluded.qty_milli, sale_rate_paise = excluded.sale_rate_paise,
             sale_amount = excluded.sale_amount, labour_paise = excluded.labour_paise,
             labour_posted = excluded.labour_posted, labour_expense_ledger_id = excluded.labour_expense_ledger_id,
             labour_credit_ledger_id = excluded.labour_credit_ledger_id, profit_paise = excluded.profit_paise`
        ).run(voucherId, input.finishedItemId, input.qtyMilli, input.saleRatePaise, totals.saleAmount, input.labourPaise,
          input.labourPosted ? 1 : 0, expenseId, input.labourPosted ? creditId : null, totals.profit)
      }
    })
    const details = getManufactureDetails(db, saved.id)!
    writeAudit(db, 'manufacture', saved.id, existingId ? 'update' : 'create', before?.details ?? null, details)
    return { ...saved, manufacture: details }
  })
  return run()
}

// ---------- register (margin report) ----------

export interface ManufactureRegisterRow {
  voucherId: number
  date: string
  number: string
  finishedItemId: number
  itemName: string
  unitSymbol: string
  decimals: number
  qtyMilli: number
  /** Production cost as saved: materials (engine cost at save time) + labour. */
  productionCost: number
  labourPaise: number
  saleAmount: number
  profitPaise: number
}

/** Live (not binned) manufactures dated within [from, to], oldest first. */
export function manufactureRegister(db: DB, from: string, to: string): ManufactureRegisterRow[] {
  return db
    .prepare(
      `SELECT v.id AS voucherId, v.date, v.number, md.finished_item_id AS finishedItemId, si.name AS itemName,
              u.symbol AS unitSymbol, u.decimals, md.qty_milli AS qtyMilli,
              md.sale_amount - md.profit_paise AS productionCost, md.labour_paise AS labourPaise,
              md.sale_amount AS saleAmount, md.profit_paise AS profitPaise
       FROM manufacture_details md
       JOIN vouchers v ON v.id = md.voucher_id
       JOIN stock_items si ON si.id = md.finished_item_id
       JOIN units u ON u.id = si.unit_id
       WHERE v.date BETWEEN ? AND ? AND ${NOT_DELETED}
       ORDER BY v.date, v.id`
    )
    .all(from, to) as ManufactureRegisterRow[]
}
