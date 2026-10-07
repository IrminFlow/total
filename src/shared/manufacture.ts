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
 */

/** One raw-material row as saved. `godownId` null/absent = the header godown. */
export interface ManufactureRawInput {
  stockItemId: number
  qtyMilli: number
  godownId?: number | null
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
}

/** The manufacture_details row (migration 019). */
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
  profitPaise: number
}

export const LABOUR_EXPENSE_LEDGER = 'Labour Charges'
export const LABOUR_EXPENSE_GROUP = 'Direct Expenses'
export const LABOUR_CREDIT_LEDGER = 'Wages Payable'
export const LABOUR_CREDIT_GROUP = 'Current Liabilities'

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
  /** materials + labour — the value the finished goods enter stock at. */
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
}): ManufactureTotals {
  const saleAmount = lineAmount(p.qtyMilli, p.saleRatePaise)
  const productionCost = p.materialPaise + p.labourPaise
  const profit = saleAmount - productionCost
  return { saleAmount, materialPaise: p.materialPaise, labourPaise: p.labourPaise, productionCost, profit, rightTotal: productionCost + profit }
}

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

export interface ManufactureIssue {
  code: ManufactureIssueCode
  message: string
  /** Index into `raw` for row-level issues. */
  row?: number
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
  input: Pick<ManufactureInput, 'finishedItemId' | 'qtyMilli' | 'saleRatePaise' | 'raw' | 'labourPaise' | 'profitPaise'>,
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
  if (!isNonNegInt(input.labourPaise)) issues.push({ code: 'bad_labour', message: 'Labour cost cannot be negative' })
  if (!isNonNegInt(input.saleRatePaise)) issues.push({ code: 'bad_sale_rate', message: 'Average price cannot be negative' })
  if (consumptionPaise !== undefined && isNonNegInt(input.labourPaise) && isNonNegInt(input.saleRatePaise) && isPosInt(input.qtyMilli)) {
    const t = manufactureTotals({
      qtyMilli: input.qtyMilli,
      saleRatePaise: input.saleRatePaise,
      materialPaise: consumptionPaise,
      labourPaise: input.labourPaise
    })
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
 * (save time; the engine re-derives at valuation time). The finished line carries
 * Σ rawCosts + labour. Labour ledger lines only when posted and non-zero.
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
  const consumption = p.rawCosts.reduce((s, c) => s + c, 0)
  const finishedValue = consumption + input.labourPaise
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
        godownId: r.godownId ?? header,
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
      }
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
