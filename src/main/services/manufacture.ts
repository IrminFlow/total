import type { DB } from '../db/connection'
import type { Voucher } from '@shared/domain'
import { manufactureInputSchema, type ManufactureCostPreviewInput } from '@shared/schemas'
import {
  buildManufactureVoucher, byProductTotal, needsLossConfirmation, validateManufacture, manufactureTotals,
  JOB_CHARGES_GROUP, JOB_CHARGES_LEDGER, LABOUR_CREDIT_GROUP, LABOUR_CREDIT_LEDGER, LABOUR_EXPENSE_GROUP, LABOUR_EXPENSE_LEDGER,
  type ManufactureDetails, type ManufactureInput, type ManufactureJobWork, type ManufactureOutput
} from '@shared/manufacture'
import { fyOf } from '@shared/dates'
import { costAsOf, voucherLineCosts } from './stockAnalysis'
import { findOrCreateLedger } from './masters'
import { getVoucher, saveVoucher, IN_BOOKS, NOT_DELETED, type SaveVoucherResult } from './vouchers'
import { writeAudit } from './audit'

/**
 * Manufacture voucher service (WP 2.2; WP 2.4 adds BOM versions, by-products / scrap and the
 * receive-from-job-worker mode). A manufacture is a stock_journal built here from the Manufacture
 * screen's input and saved through vouchers.saveVoucher (numbering, lock date, year-end
 * immutability, negative-stock warn/block, audit, duplicate-number flag all come from that
 * pipeline) with its `manufacture_details` row (+ `manufacture_outputs`, `job_work_challans`,
 * `job_work_losses`) written inside the same transaction.
 *
 * Costing: stockAnalysis' default derived-costing source reads manufacture_details, so these
 * vouchers are valued 'derived' — Σ engine cost of the consumed raw materials + labour (or job
 * charges) is conserved into the inward lines: by-products / scrap at their assigned value, the
 * remainder to the finished item — re-derived at every valuation (a backdated purchase
 * re-prices them; the register shows "cost now" next to "cost at save").
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
  bom_version_id: number | null
  bom_exploded: number
}

function outputsOf(db: DB, voucherId: number): ManufactureOutput[] {
  return db
    .prepare(
      `SELECT line_order AS lineOrder, stock_item_id AS stockItemId, qty_milli AS qtyMilli, value_paise AS valuePaise, kind
       FROM manufacture_outputs WHERE voucher_id = ? ORDER BY line_order`
    )
    .all(voucherId) as ManufactureOutput[]
}

function jobWorkOf(db: DB, voucherId: number): ManufactureJobWork | null {
  const row = db
    .prepare(
      `SELECT godown_id AS godownId, party_ledger_id AS partyLedgerId, challan_no AS challanNo, challan_date AS challanDate,
              nature_of_processing AS natureOfProcessing, original_challan_voucher_id AS originalChallanVoucherId
       FROM job_work_challans WHERE voucher_id = ? AND kind = 'receive'`
    )
    .get(voucherId) as Omit<ManufactureJobWork, 'losses'> | undefined
  if (!row) return null
  const losses = db
    .prepare('SELECT line_order AS lineOrder, loss_qty_milli AS lossQtyMilli FROM job_work_losses WHERE voucher_id = ? ORDER BY line_order')
    .all(voucherId) as ManufactureJobWork['losses']
  return { ...row, losses }
}

const mapDetails = (db: DB, r: DetailsRow): ManufactureDetails => ({
  voucherId: r.voucher_id,
  finishedItemId: r.finished_item_id,
  qtyMilli: r.qty_milli,
  saleRatePaise: r.sale_rate_paise,
  saleAmount: r.sale_amount,
  labourPaise: r.labour_paise,
  labourPosted: !!r.labour_posted,
  labourExpenseLedgerId: r.labour_expense_ledger_id,
  labourCreditLedgerId: r.labour_credit_ledger_id,
  profitPaise: r.profit_paise,
  bomVersionId: r.bom_version_id,
  bomExploded: !!r.bom_exploded,
  byProducts: outputsOf(db, r.voucher_id),
  jobWork: jobWorkOf(db, r.voucher_id)
})

export function getManufactureDetails(db: DB, voucherId: number): ManufactureDetails | null {
  const row = db.prepare('SELECT * FROM manufacture_details WHERE voucher_id = ?').get(voucherId) as DetailsRow | undefined
  return row ? mapDetails(db, row) : null
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

/** The job worker godown of a receipt: must exist, be kind 'job_worker' and carry a party. */
function jobWorkerGodown(db: DB, godownId: number): { id: number; partyLedgerId: number } {
  const g = db.prepare('SELECT id, kind, party_ledger_id AS partyLedgerId FROM godowns WHERE id = ?').get(godownId) as
    | { id: number; kind: string; partyLedgerId: number | null }
    | undefined
  if (!g) throw new Error('Job worker godown not found')
  if (g.kind !== 'job_worker' || g.partyLedgerId == null) throw new Error('That godown is not a job worker godown (Masters → Godowns)')
  return { id: g.id, partyLedgerId: g.partyLedgerId }
}

/**
 * Create (no `existingId`) or alter a manufacture, in ONE transaction: labour ledgers
 * (find-or-create), the stock_journal via saveVoucher, and the manufacture_details row (+ its
 * by-products and job-work facts). Throws with a user-facing message when a rule fails; negative
 * stock is a warning on the result unless the company blocks it (Settings → Features), exactly
 * as for any other voucher.
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
  const unknown = [input.finishedItemId, ...input.raw.map((r) => r.stockItemId), ...(input.byProducts ?? []).map((b) => b.stockItemId)].find(
    (id) => id > 0 && !names.has(id)
  )
  if (unknown !== undefined) throw new Error('Stock item not found')

  const structural = validateManufacture(input, undefined, itemName)
  if (structural.length) throw new Error(structural.map((i) => i.message).join('; '))
  const jobWorker = input.jobWork ? jobWorkerGodown(db, input.jobWork.godownId) : null
  if (input.bomVersionId != null) {
    const v = db.prepare('SELECT item_id FROM bom_versions WHERE id = ?').get(input.bomVersionId) as { item_id: number } | undefined
    if (!v || v.item_id !== input.finishedItemId) throw new Error('BOM version not found for this item')
  }
  if (input.jobWork?.originalChallanVoucherId != null) {
    const c = db.prepare("SELECT godown_id FROM job_work_challans WHERE voucher_id = ? AND kind = 'send'").get(input.jobWork.originalChallanVoucherId) as
      | { godown_id: number }
      | undefined
    if (!c || c.godown_id !== input.jobWork.godownId) throw new Error('The original challan is not a send challan to this job worker')
  }

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
      if (jobWorker) {
        // Job charges: always credited to the job worker.
        creditId = jobWorker.partyLedgerId
        if (input.labourPaise > 0) expenseId = findOrCreateLedger(db, JOB_CHARGES_LEDGER, JOB_CHARGES_GROUP)
      } else {
        if (input.labourCreditLedgerId != null) {
          const exists = db.prepare('SELECT 1 FROM ledgers WHERE id = ?').get(input.labourCreditLedgerId)
          if (!exists) throw new Error('Labour credit account not found')
          creditId = input.labourCreditLedgerId
        }
        if (input.labourPaise > 0) {
          expenseId = findOrCreateLedger(db, LABOUR_EXPENSE_LEDGER, LABOUR_EXPENSE_GROUP)
          creditId ??= findOrCreateLedger(db, LABOUR_CREDIT_LEDGER, LABOUR_CREDIT_GROUP)
        }
      }
      if (expenseId != null && creditId === expenseId) throw new Error('Labour cannot be credited to the expense ledger itself')
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
      labourPaise: input.labourPaise,
      byProductPaise: byProductTotal(input.byProducts)
    })
    const saved = saveVoucher(db, payload, existingId, {
      manufacture: true,
      withinTransaction: (voucherId) => {
        db.prepare(
          `INSERT INTO manufacture_details (voucher_id, finished_item_id, qty_milli, sale_rate_paise, sale_amount,
             labour_paise, labour_posted, labour_expense_ledger_id, labour_credit_ledger_id, profit_paise,
             bom_version_id, bom_exploded)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(voucher_id) DO UPDATE SET finished_item_id = excluded.finished_item_id,
             qty_milli = excluded.qty_milli, sale_rate_paise = excluded.sale_rate_paise,
             sale_amount = excluded.sale_amount, labour_paise = excluded.labour_paise,
             labour_posted = excluded.labour_posted, labour_expense_ledger_id = excluded.labour_expense_ledger_id,
             labour_credit_ledger_id = excluded.labour_credit_ledger_id, profit_paise = excluded.profit_paise,
             bom_version_id = excluded.bom_version_id, bom_exploded = excluded.bom_exploded`
        ).run(voucherId, input.finishedItemId, input.qtyMilli, input.saleRatePaise, totals.saleAmount, input.labourPaise,
          input.labourPosted ? 1 : 0, expenseId, input.labourPosted ? creditId : null, totals.profit,
          input.bomVersionId ?? null, input.bomExploded ? 1 : 0)
        // By-products: inward lines after the finished line (raw rows, finished, by-products).
        db.prepare('DELETE FROM manufacture_outputs WHERE voucher_id = ?').run(voucherId)
        const insOut = db.prepare(
          'INSERT INTO manufacture_outputs (voucher_id, line_order, stock_item_id, qty_milli, value_paise, kind) VALUES (?, ?, ?, ?, ?, ?)'
        )
        ;(input.byProducts ?? []).forEach((b, i) => insOut.run(voucherId, input.raw.length + 1 + i, b.stockItemId, b.qtyMilli, b.valuePaise, b.kind))
        // Job-work receipt facts (ITC-04): the job worker's challan + losses per raw line.
        db.prepare('DELETE FROM job_work_challans WHERE voucher_id = ?').run(voucherId)
        if (input.jobWork && jobWorker) {
          const jw = input.jobWork
          db.prepare(
            `INSERT INTO job_work_challans (voucher_id, kind, godown_id, party_ledger_id, challan_no, challan_date,
               nature_of_processing, goods_type, original_challan_voucher_id) VALUES (?, 'receive', ?, ?, ?, ?, ?, 'inputs', ?)`
          ).run(voucherId, jobWorker.id, jobWorker.partyLedgerId, jw.challanNo?.trim() || null, jw.challanDate ?? null,
            jw.natureOfProcessing?.trim() || null, jw.originalChallanVoucherId ?? null)
          const insLoss = db.prepare('INSERT INTO job_work_losses (voucher_id, line_order, loss_qty_milli) VALUES (?, ?, ?)')
          input.raw.forEach((r, i) => {
            if ((r.lossQtyMilli ?? 0) > 0) insLoss.run(voucherId, i, r.lossQtyMilli)
          })
        }
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
  /** Engine cost of the raw materials NOW (re-derived: a backdated purchase re-prices it). */
  materialPaise: number
  labourPaise: number
  /** By-product / scrap value booked by the engine (= assigned, unless costs fell below it). */
  byProductPaise: number
  /** Production cost NOW: materials + labour − by-products — the finished item's engine value. */
  productionCost: number
  /** Production cost as saved (sale amount − saved profit). */
  costAtSave: number
  saleAmount: number
  /** sale amount − production cost now. */
  profitPaise: number
  /** As saved. */
  profitAtSave: number
  /** true when cost now ≠ cost at save. */
  repriced: boolean
  /** A receive-from-job-worker manufacture. */
  jobWork: boolean
}

interface RegisterBaseRow {
  voucherId: number
  date: string
  number: string
  finishedItemId: number
  itemName: string
  unitSymbol: string
  decimals: number
  qtyMilli: number
  labourPaise: number
  saleAmount: number
  profitAtSave: number
  byProductAtSave: number
  jobWork: number
}

/** Live (not binned) manufactures dated within [from, to], oldest first — with the engine's
 *  CURRENT derived cost next to the save-time figures. */
export function manufactureRegister(db: DB, from: string, to: string, itemId?: number): ManufactureRegisterRow[] {
  const rows = db
    .prepare(
      `SELECT v.id AS voucherId, v.date, v.number, md.finished_item_id AS finishedItemId, si.name AS itemName,
              u.symbol AS unitSymbol, u.decimals, md.qty_milli AS qtyMilli, md.labour_paise AS labourPaise,
              md.sale_amount AS saleAmount, md.profit_paise AS profitAtSave,
              COALESCE((SELECT SUM(value_paise) FROM manufacture_outputs mo WHERE mo.voucher_id = v.id), 0) AS byProductAtSave,
              EXISTS (SELECT 1 FROM job_work_challans j WHERE j.voucher_id = v.id AND j.kind = 'receive') AS jobWork
       FROM manufacture_details md
       JOIN vouchers v ON v.id = md.voucher_id
       JOIN stock_items si ON si.id = md.finished_item_id
       JOIN units u ON u.id = si.unit_id
       WHERE v.date BETWEEN ? AND ? AND ${NOT_DELETED} ${itemId ? 'AND md.finished_item_id = ?' : ''}
       ORDER BY v.date, v.id`
    )
    .all(...(itemId ? [from, to, itemId] : [from, to])) as RegisterBaseRow[]
  if (rows.length === 0) return []
  const { derived } = voucherLineCosts(db, to, new Set(rows.map((r) => r.voucherId)))
  return rows.map((r) => {
    const costAtSave = r.saleAmount - r.profitAtSave
    const d = derived.get(r.voucherId)
    // Not derived right now (an optional / post-dated voucher is outside the books): the
    // save-time figures stand.
    const materialPaise = d ? d.consumedValue : costAtSave - r.labourPaise + r.byProductAtSave
    const byProductPaise = d ? d.fixedValue : r.byProductAtSave
    const productionCost = d ? d.mainValue : costAtSave
    return {
      voucherId: r.voucherId, date: r.date, number: r.number, finishedItemId: r.finishedItemId, itemName: r.itemName,
      unitSymbol: r.unitSymbol, decimals: r.decimals, qtyMilli: r.qtyMilli, materialPaise, labourPaise: r.labourPaise,
      byProductPaise, productionCost, costAtSave, saleAmount: r.saleAmount, profitPaise: r.saleAmount - productionCost,
      profitAtSave: r.profitAtSave, repriced: productionCost !== costAtSave, jobWork: !!r.jobWork
    }
  })
}
