/**
 * Manufacture voucher (WP 2.2) — the pure rules behind the Manufacture screen and
 * src/main/services/manufacture.ts. No Electron, no DB.
 *
 * A manufacture is a stock_journal: one outward line per raw material, one inward line for the
 * finished item, optionally a labour journal (Dr Labour Charges / Cr Wages Payable or a chosen
 * account) on the same voucher, plus a `manufacture_details` row (migration 019) with the entry
 * facts. Finished goods enter stock at PRODUCTION COST — engine-costed consumption + labour —
 * never at the sale price; the valuation engine re-derives that figure at valuation time
 * ('derived' costing, src/shared/valuation.ts). The sale rate and profit are recorded for
 * margin reporting only and never post.
 *
 * The screen's "both sides match" rule: left = sale amount; right = production cost + profit.
 * Profit is the balancing figure, so the sides match by construction — what the server checks
 * is the substance: `profit === sale amount − (consumption + labour)` to the paisa, against the
 * consumption it prices itself.
 *
 * Duplicate raw materials are REJECTED (not merged): one row per item keeps "the row you typed
 * is the line that posts" true, makes the per-row average cost unambiguous, and keeps
 * open-and-save lossless.
 *
 * WP 2.4 — by-products / scrap: extra inward rows (item, qty, assigned value) posted after the
 * finished line. Value conservation becomes
 *     Σ consumption + labour = finished value + Σ by-product values
 * so the finished item's PRODUCTION COST is net of by-products (materials + labour − by-products)
 * and profit = sale amount − that net cost. A by-product total above materials + labour (a
 * negative remainder) is rejected. Stored in `manufacture_outputs` (migration 023).
 *
 * WP 2.4 — job work receipt: the same voucher, with raw rows consumed out of a job worker's
 * godown and the labour row being the job charges (Dr Job Work Charges / Cr the job worker's
 * party ledger), capitalised into the finished goods by the derived rule; the ITC-04 facts
 * (job worker's challan no/date, nature of processing, losses) ride in `job_work_challans` /
 * `job_work_losses` (migration 023).
 */

/** One raw-material row as saved. `godownId` null/absent = the header godown. */
export interface ManufactureRawInput {
  stockItemId: number
  qtyMilli: number
  godownId?: number | null
  /** Job-work receipt only (ITC-04 "losses and wastes"): of qtyMilli, how much was lost at the
   *  job worker. Informational — the whole qtyMilli is consumed. */
  lossQtyMilli?: number
}

export type ManufactureOutputKind = 'by_product' | 'scrap'

/** One by-product / scrap row (WP 2.4). `godownId` null/absent = the header godown. */
export interface ManufactureByProductInput {
  stockItemId: number
  qtyMilli: number
  /** Assigned value, paise — what the row enters stock at; it reduces the finished item's cost. */
  valuePaise: number
  kind: ManufactureOutputKind
  godownId?: number | null
}

/** Receive-from-job-worker facts (WP 2.4, ITC-04). */
export interface ManufactureJobWorkInput {
  /** The job worker's godown (godowns.kind = 'job_worker'): raw rows are consumed from it. */
  godownId: number
  /** The job worker's own challan number / date for the goods sent back. */
  challanNo?: string | null
  challanDate?: string | null
  natureOfProcessing?: string | null
  /** The send challan these goods come back against (optional). */
  originalChallanVoucherId?: number | null
}

/** What the Manufacture screen posts (manufacture:save). Amounts in paise, quantities in
 *  thousandths. */
export interface ManufactureInput {
  /** Stock-journal voucher type; omitted = the company's first stock_journal type. */
  voucherTypeId?: number
  date: string
  /** Omitted/empty = auto number. */
  number?: string
  /** Empty/null = "Manufactured N × Item". */
  narration?: string | null
  /** Header godown: the finished item's godown and the default for raw rows. */
  godownId?: number | null
  finishedItemId: number
  qtyMilli: number
  /** Sale ("average price") rate per whole unit — margin reporting only. */
  saleRatePaise: number
  raw: ManufactureRawInput[]
  labourPaise: number
  /** true = journal the labour on this voucher (Dr Labour Charges / Cr labourCreditLedgerId);
   *  false = "already booked" elsewhere — capitalised into the stock value with no ledger lines. */
  labourPosted: boolean
  /** Credit side of the labour journal; null/absent = Wages Payable (find-or-create). */
  labourCreditLedgerId?: number | null
  /** sale amount − production cost, as the screen showed it. */
  profitPaise: number
  /** The user confirmed saving at a loss (profit < 0). */
  confirmLoss?: boolean
  /** WP 2.4: by-products / scrap rows (absent = none). */
  byProducts?: ManufactureByProductInput[]
  /** WP 2.4: the BOM version the rows came from (null/absent = none / typed by hand). */
  bomVersionId?: number | null
  /** WP 2.4: the rows are the exploded leaves of a multi-level BOM. */
  bomExploded?: boolean
  /** WP 2.4: receive-from-job-worker mode (null/absent = an own manufacture). */
  jobWork?: ManufactureJobWorkInput | null
}

/** A saved by-product / scrap row (manufacture_outputs, migration 023). */
export interface ManufactureOutput {
  /** inventory_lines.line_order of its inward line. */
  lineOrder: number
  stockItemId: number
  qtyMilli: number
  valuePaise: number
  kind: ManufactureOutputKind
}

/** The job-work receipt row (job_work_challans kind 'receive') + per-raw-row losses. */
export interface ManufactureJobWork {
  godownId: number
  partyLedgerId: number
  challanNo: string | null
  challanDate: string | null
  natureOfProcessing: string | null
  originalChallanVoucherId: number | null
  /** raw line_order → loss quantity (thousandths); only non-zero losses are stored. */
  losses: { lineOrder: number; lossQtyMilli: number }[]
}

/** The manufacture_details row (migration 019; WP 2.4 adds the version, by-products, job work). */
export interface ManufactureDetails {
  voucherId: number
  finishedItemId: number
  qtyMilli: number
  saleRatePaise: number
  saleAmount: number
  labourPaise: number
  labourPosted: boolean
  labourExpenseLedgerId: number | null
  labourCreditLedgerId: number | null
  /** sale amount − production cost (net of by-products), at save. */
  profitPaise: number
  bomVersionId: number | null
  bomExploded: boolean
  byProducts: ManufactureOutput[]
  jobWork: ManufactureJobWork | null
}

export const LABOUR_EXPENSE_LEDGER = 'Labour Charges'
export const LABOUR_EXPENSE_GROUP = 'Direct Expenses'
export const LABOUR_CREDIT_LEDGER = 'Wages Payable'
export const LABOUR_CREDIT_GROUP = 'Current Liabilities'
/** Job charges on a receive-from-job-worker manufacture (Dr this / Cr the job worker). */
export const JOB_CHARGES_LEDGER = 'Job Work Charges'
export const JOB_CHARGES_GROUP = 'Direct Expenses'

/** Number of raw-material rows the screen shows from the start. */
export const RAW_ROWS_VISIBLE = 10

/** qty (thousandths) × rate (paise per whole unit), rounded to the paisa. */
export function lineAmount(qtyMilli: number, ratePaise: number): number {
  return Math.round((qtyMilli * ratePaise) / 1000)
}

/** Paise per whole unit for an amount over a quantity (0 when there is no quantity). */
export function unitRate(amountPaise: number, qtyMilli: number): number {
  return qtyMilli > 0 ? Math.round((amountPaise * 1000) / qtyMilli) : 0
}

export interface ManufactureTotals {
  /** Left total: qty × average price. */
  saleAmount: number
  /** Σ engine-costed raw materials. */
  materialPaise: number
  labourPaise: number
  /** Σ by-product / scrap assigned values. */
  byProductPaise: number
  /** materials + labour (before by-products). */
  grossCost: number
  /** materials + labour − by-products — the value the finished goods enter stock at. */
  productionCost: number
  /** saleAmount − productionCost (negative = a loss). */
  profit: number
  /** productionCost + profit — equals saleAmount by construction. */
  rightTotal: number
}

export function manufactureTotals(p: {
  qtyMilli: number
  saleRatePaise: number
  materialPaise: number
  labourPaise: number
  byProductPaise?: number
}): ManufactureTotals {
  const saleAmount = lineAmount(p.qtyMilli, p.saleRatePaise)
  const byProductPaise = p.byProductPaise ?? 0
  const grossCost = p.materialPaise + p.labourPaise
  const productionCost = grossCost - byProductPaise
  const profit = saleAmount - productionCost
  return {
    saleAmount, materialPaise: p.materialPaise, labourPaise: p.labourPaise, byProductPaise, grossCost, productionCost, profit,
    rightTotal: productionCost + profit
  }
}

export const byProductTotal = (rows: readonly { valuePaise: number }[] | undefined): number =>
  (rows ?? []).reduce((s, r) => s + r.valuePaise, 0)

export const autoManufactureNarration = (qtyMilli: number, itemName: string): string =>
  `Manufactured ${qtyMilli / 1000} × ${itemName}`.trim()

export type ManufactureIssueCode =
  | 'no_item'
  | 'bad_qty'
  | 'no_raw'
  | 'incomplete_row'
  | 'raw_is_finished'
  | 'duplicate_raw'
  | 'bad_labour'
  | 'bad_sale_rate'
  | 'profit_mismatch'
  | 'incomplete_byproduct'
  | 'byproduct_is_finished'
  | 'duplicate_byproduct'
  | 'bad_byproduct_value'
  | 'byproducts_exceed_cost'
  | 'bad_loss'
  | 'no_job_worker'

export interface ManufactureIssue {
  code: ManufactureIssueCode
  message: string
  /** Index into `raw` for row-level issues. */
  row?: number
  /** Index into `byProducts` for by-product row issues. */
  byProductRow?: number
}

const isPosInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0
const isNonNegInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0

/**
 * Every rule a manufacture must pass. The renderer runs it on every keystroke (Save stays
 * disabled while it reports anything); the server re-runs it with the consumption it priced
 * itself. `consumptionPaise` omitted = skip the profit check (structure only). Returns [] when
 * the voucher may be saved (a loss still needs confirmation — see needsLossConfirmation).
 */
export function validateManufacture(
  input: Pick<ManufactureInput, 'finishedItemId' | 'qtyMilli' | 'saleRatePaise' | 'raw' | 'labourPaise' | 'profitPaise' | 'byProducts' | 'jobWork'>,
  consumptionPaise?: number,
  itemName: (id: number) => string = () => 'This item',
  /** Row number shown to the user for raw[i] (default i + 1). */
  rowLabel: (i: number) => number = (i) => i + 1
): ManufactureIssue[] {
  const issues: ManufactureIssue[] = []
  if (!isPosInt(input.finishedItemId)) issues.push({ code: 'no_item', message: 'Pick the item being manufactured' })
  if (!isPosInt(input.qtyMilli)) issues.push({ code: 'bad_qty', message: 'Enter the quantity manufactured (more than zero)' })
  if (input.raw.length === 0) issues.push({ code: 'no_raw', message: 'Add at least one raw material' })
  const seen = new Map<number, number>()
  input.raw.forEach((r, i) => {
    if (!isPosInt(r.stockItemId) || !isPosInt(r.qtyMilli)) {
      issues.push({
        code: 'incomplete_row',
        row: i,
        message: !isPosInt(r.stockItemId) ? `Raw material row ${rowLabel(i)}: pick an item` : `Raw material row ${rowLabel(i)}: enter a quantity`
      })
      return
    }
    if (r.stockItemId === input.finishedItemId) {
      issues.push({ code: 'raw_is_finished', row: i, message: `${itemName(r.stockItemId)} can't be a raw material of itself` })
    }
    const first = seen.get(r.stockItemId)
    if (first !== undefined) {
      issues.push({
        code: 'duplicate_raw',
        row: i,
        message: `${itemName(r.stockItemId)} appears in rows ${rowLabel(first)} and ${rowLabel(i)} — combine them into one row`
      })
    } else {
      seen.set(r.stockItemId, i)
    }
  })
  if (input.jobWork) {
    if (!isPosInt(input.jobWork.godownId)) issues.push({ code: 'no_job_worker', message: 'Pick the job worker the goods come back from' })
    input.raw.forEach((r, i) => {
      const loss = r.lossQtyMilli ?? 0
      if (!isNonNegInt(loss) || (isPosInt(r.qtyMilli) && loss > r.qtyMilli)) {
        issues.push({ code: 'bad_loss', row: i, message: `Raw material row ${rowLabel(i)}: the loss must be between 0 and the quantity consumed` })
      }
    })
  }
  const bps = input.byProducts ?? []
  const seenBp = new Set<number>()
  bps.forEach((b, i) => {
    if (!isPosInt(b.stockItemId) || !isPosInt(b.qtyMilli)) {
      issues.push({
        code: 'incomplete_byproduct',
        byProductRow: i,
        message: !isPosInt(b.stockItemId) ? `By-product row ${i + 1}: pick an item` : `By-product row ${i + 1}: enter a quantity`
      })
      return
    }
    if (!isNonNegInt(b.valuePaise)) issues.push({ code: 'bad_byproduct_value', byProductRow: i, message: `By-product row ${i + 1}: the value cannot be negative` })
    if (b.stockItemId === input.finishedItemId) {
      issues.push({ code: 'byproduct_is_finished', byProductRow: i, message: `${itemName(b.stockItemId)} is the item being manufactured — it can't also be a by-product` })
    }
    if (seenBp.has(b.stockItemId)) {
      issues.push({ code: 'duplicate_byproduct', byProductRow: i, message: `${itemName(b.stockItemId)} appears twice in by-products — combine the rows` })
    }
    seenBp.add(b.stockItemId)
  })
  if (!isNonNegInt(input.labourPaise)) issues.push({ code: 'bad_labour', message: 'Labour cost cannot be negative' })
  if (!isNonNegInt(input.saleRatePaise)) issues.push({ code: 'bad_sale_rate', message: 'Average price cannot be negative' })
  if (consumptionPaise !== undefined && isNonNegInt(input.labourPaise) && isNonNegInt(input.saleRatePaise) && isPosInt(input.qtyMilli)) {
    const t = manufactureTotals({
      qtyMilli: input.qtyMilli,
      saleRatePaise: input.saleRatePaise,
      materialPaise: consumptionPaise,
      labourPaise: input.labourPaise,
      byProductPaise: byProductTotal(bps)
    })
    if (t.productionCost < 0) {
      issues.push({
        code: 'byproducts_exceed_cost',
        message: `By-products are worth more than materials + labour — the finished item can't enter stock below zero`
      })
    }
    if (input.profitPaise !== t.profit) {
      issues.push({
        code: 'profit_mismatch',
        message: `Profit must equal sale amount − production cost (${t.profit} paise, not ${input.profitPaise}) — costs may have changed; refresh and try again`
      })
    }
  }
  return issues
}

/** A loss (profit < 0) is allowed but must be confirmed. */
export const needsLossConfirmation = (profitPaise: number): boolean => profitPaise < 0

// ---------- voucher payload (shared by the server and the edit round-trip check) ----------

/** The VoucherInput shape a manufacture posts as (structurally VoucherInputParsed). */
export interface ManufactureVoucherPayload {
  voucherTypeId: number
  date: string
  number?: string
  partyLedgerId: null
  narration: string
  reference: null
  instrumentNo: null
  instrumentDate: null
  transporterId: null
  vehicleNo: null
  transportDistanceKm: null
  posOverride: null
  currencyCode: null
  exchangeRate: null
  lines: { ledgerId: number; drCr: 'dr' | 'cr'; amount: number; costAllocations: [] }[]
  inventory: {
    stockItemId: number
    godownId: number | null
    batchId: null
    qtyMilli: number
    ratePaise: number
    discountPaise: number
    amount: number
    direction: 'in' | 'out'
    isAbsolute: false
  }[]
  billRefs: []
  tds: null
}

/**
 * Build the stock_journal a manufacture posts as. `rawCosts[i]` is the engine cost of raw row i
 * (save time; the engine re-derives at valuation time). Line order: raw rows (out), the finished
 * line (in) carrying Σ rawCosts + labour − Σ by-products, then one inward line per by-product /
 * scrap row at its assigned value. Labour ledger lines only when posted and non-zero. In job-work
 * mode raw rows default to the job worker's godown instead of the header godown.
 */
export function buildManufactureVoucher(
  input: ManufactureInput,
  p: {
    voucherTypeId: number
    rawCosts: readonly number[]
    finishedName: string
    /** Required when labour is posted and non-zero. */
    labourExpenseLedgerId: number | null
    labourCreditLedgerId: number | null
  }
): ManufactureVoucherPayload {
  const header = input.godownId ?? null
  const rawDefault = input.jobWork ? input.jobWork.godownId : header
  const consumption = p.rawCosts.reduce((s, c) => s + c, 0)
  const byProducts = input.byProducts ?? []
  const finishedValue = consumption + input.labourPaise - byProductTotal(byProducts)
  const postLabour = input.labourPosted && input.labourPaise > 0
  if (postLabour && (p.labourExpenseLedgerId == null || p.labourCreditLedgerId == null)) {
    throw new Error('Labour ledgers are required to post labour')
  }
  const number = input.number?.trim()
  return {
    voucherTypeId: p.voucherTypeId,
    date: input.date,
    ...(number ? { number } : {}),
    partyLedgerId: null,
    narration: input.narration?.trim() || autoManufactureNarration(input.qtyMilli, p.finishedName),
    reference: null,
    instrumentNo: null,
    instrumentDate: null,
    transporterId: null,
    vehicleNo: null,
    transportDistanceKm: null,
    posOverride: null,
    currencyCode: null,
    exchangeRate: null,
    lines: postLabour
      ? [
          { ledgerId: p.labourExpenseLedgerId!, drCr: 'dr', amount: input.labourPaise, costAllocations: [] },
          { ledgerId: p.labourCreditLedgerId!, drCr: 'cr', amount: input.labourPaise, costAllocations: [] }
        ]
      : [],
    inventory: [
      ...input.raw.map((r, i) => ({
        stockItemId: r.stockItemId,
        godownId: r.godownId ?? rawDefault,
        batchId: null,
        qtyMilli: r.qtyMilli,
        ratePaise: unitRate(p.rawCosts[i] ?? 0, r.qtyMilli),
        discountPaise: 0,
        amount: p.rawCosts[i] ?? 0,
        direction: 'out' as const,
        isAbsolute: false as const
      })),
      {
        stockItemId: input.finishedItemId,
        godownId: header,
        batchId: null,
        qtyMilli: input.qtyMilli,
        ratePaise: unitRate(finishedValue, input.qtyMilli),
        discountPaise: 0,
        amount: finishedValue,
        direction: 'in' as const,
        isAbsolute: false as const
      },
      ...byProducts.map((b) => ({
        stockItemId: b.stockItemId,
        godownId: b.godownId ?? header,
        batchId: null,
        qtyMilli: b.qtyMilli,
        ratePaise: unitRate(b.valuePaise, b.qtyMilli),
        discountPaise: 0,
        amount: b.valuePaise,
        direction: 'in' as const,
        isAbsolute: false as const
      }))
    ],
    billRefs: [],
    tds: null
  }
}

// ---------- BOM helpers ----------

export interface BomComponentLike {
  componentId: number
  qtyMilliPerUnit: number
}

/** Raw rows for `qtyMilli` of the finished item from its BOM (per-unit quantities scaled). */
export function rowsFromBom(bom: readonly BomComponentLike[], qtyMilli: number): { stockItemId: number; qtyMilli: number }[] {
  return bom.map((b) => ({ stockItemId: b.componentId, qtyMilli: Math.round((b.qtyMilliPerUnit * qtyMilli) / 1000) }))
}

/** The inverse: per-unit BOM lines from rows produced for `qtyMilli` (null when a row would
 *  round to zero per unit, or there is no quantity). */
export function bomFromRows(
  rows: readonly { stockItemId: number; qtyMilli: number }[],
  qtyMilli: number
): { componentId: number; qtyMilliPerUnit: number }[] | null {
  if (qtyMilli <= 0 || rows.length === 0) return null
  const lines = rows.map((r) => ({ componentId: r.stockItemId, qtyMilliPerUnit: Math.round((r.qtyMilli * 1000) / qtyMilli) }))
  return lines.some((l) => l.qtyMilliPerUnit <= 0) ? null : lines
}
