/**
 * Pure math for the v0.3 analytical reports: indirect cash flow statement, the financial
 * ratio panel, and stock ageing buckets. No Electron, no DB — services feed these plain data.
 */

// ---------- cash flow (indirect method) ----------

export interface CashFlowRow {
  name: string
  /** Signed cash effect in paise: positive = cash generated, negative = cash used. */
  amount: number
}

export interface CashFlowStatement {
  period: { from: string; to: string }
  netProfit: number
  /** Working-capital and stock adjustments (net profit itself is shown separately). */
  operating: CashFlowRow[]
  /** netProfit + operating adjustments. */
  operatingTotal: number
  investing: CashFlowRow[]
  investingTotal: number
  financing: CashFlowRow[]
  financingTotal: number
  /** operatingTotal + investingTotal + financingTotal — equals closingCash − openingCash. */
  netChange: number
  openingCash: number
  closingCash: number
}

export interface GroupDelta {
  /** Top-level balance-sheet group name (e.g. 'Fixed Assets', 'Current Liabilities'). */
  name: string
  /** Balance change over the period, signed dr-positive (asset increase > 0, liability increase < 0). */
  delta: number
}

export interface CashFlowInput {
  period: { from: string; to: string }
  netProfit: number
  /** closingStock − openingStock over the period (computed inventory, no ledger). */
  stockDelta: number
  /** Per top-level BS group, EXCLUDING cash/bank ledgers (they are the statement's subject). */
  groupDeltas: GroupDelta[]
  openingCash: number
  closingCash: number
}

/** Top-level Tally groups whose movements are investing activity. */
const INVESTING_GROUPS = new Set(['fixed assets', 'investments', 'misc. expenses (asset)'])
/** Top-level Tally groups whose movements are financing activity. */
const FINANCING_GROUPS = new Set(['capital account', 'loans (liability)', 'branch / divisions', 'suspense a/c'])

export type CashFlowActivity = 'operating' | 'investing' | 'financing'

export function activityFor(groupName: string): CashFlowActivity {
  const n = groupName.toLowerCase()
  if (INVESTING_GROUPS.has(n)) return 'investing'
  if (FINANCING_GROUPS.has(n)) return 'financing'
  return 'operating'
}

/**
 * Compose the indirect cash flow statement. Because every ledger delta is dr-positive and
 * double entry forces all movements (incl. cash) to sum against net profit, the cash effect of
 * any non-cash group is simply −delta, and the composed statement reconciles exactly:
 * netChange === closingCash − openingCash whenever the inputs come from the same books.
 */
export function buildCashFlow(input: CashFlowInput): CashFlowStatement {
  const operating: CashFlowRow[] = []
  const investing: CashFlowRow[] = []
  const financing: CashFlowRow[] = []

  if (input.stockDelta !== 0) {
    operating.push({
      name: input.stockDelta > 0 ? 'Increase in stock' : 'Decrease in stock',
      amount: -input.stockDelta
    })
  }
  for (const g of input.groupDeltas) {
    if (g.delta === 0) continue
    const row: CashFlowRow = { name: g.name, amount: -g.delta }
    const activity = activityFor(g.name)
    if (activity === 'investing') investing.push(row)
    else if (activity === 'financing') financing.push(row)
    else operating.push(row)
  }
  operating.sort((a, b) => a.name.localeCompare(b.name))
  investing.sort((a, b) => a.name.localeCompare(b.name))
  financing.sort((a, b) => a.name.localeCompare(b.name))

  const sum = (rows: CashFlowRow[]): number => rows.reduce((s, r) => s + r.amount, 0)
  const operatingTotal = input.netProfit + sum(operating)
  const investingTotal = sum(investing)
  const financingTotal = sum(financing)

  return {
    period: input.period,
    netProfit: input.netProfit,
    operating,
    operatingTotal,
    investing,
    investingTotal,
    financing,
    financingTotal,
    netChange: operatingTotal + investingTotal + financingTotal,
    openingCash: input.openingCash,
    closingCash: input.closingCash
  }
}

// ---------- ratio panel ----------

export interface RatioPanel {
  /** Ratios are plain numbers (not paise); null when the denominator is zero/unknown. */
  currentRatio: number | null
  quickRatio: number | null
  /** Borrowings ÷ owners' funds. Null when there is no equity to divide by — a company whose
   *  capital account is nil is not infinitely geared, it is unmeasurable, and printing a huge
   *  number would be a confident answer to a question the books cannot answer. */
  debtEquity: number | null
  debtorDays: number | null
  creditorDays: number | null
  inventoryTurnover: number | null
  grossMarginPct: number | null
  netMarginPct: number | null
}

export interface RatioInput {
  /** Paise figures as of the report date. */
  currentAssets: number
  currentLiabilities: number
  stock: number
  receivables: number
  payables: number
  /** Loans (liability) + bank OD, as a positive figure. */
  borrowings?: number
  /** Capital account + reserves, as a positive figure. Negative (accumulated losses beyond
   *  capital) is left as-is — a negative gearing ratio is meaningful and hiding it is not. */
  equity?: number
  /** Period (FY-to-date) flow figures, paise. */
  sales: number
  purchases: number
  openingStock: number
  closingStock: number
  grossProfit: number
  netProfit: number
  /** Days elapsed in the period (for debtor/creditor days). */
  periodDays: number
}

const round2 = (n: number): number => Math.round(n * 100) / 100

export function computeRatios(i: RatioInput): RatioPanel {
  const ratio = (num: number, den: number): number | null => (den === 0 ? null : round2(num / den))
  const cogs = i.openingStock + i.purchases - i.closingStock
  const avgStock = (i.openingStock + i.closingStock) / 2
  return {
    currentRatio: ratio(i.currentAssets, i.currentLiabilities),
    quickRatio: ratio(i.currentAssets - i.stock, i.currentLiabilities),
    debtEquity: ratio(i.borrowings ?? 0, i.equity ?? 0),
    debtorDays: i.sales === 0 ? null : round2((i.receivables / i.sales) * i.periodDays),
    creditorDays: i.purchases === 0 ? null : round2((i.payables / i.purchases) * i.periodDays),
    inventoryTurnover: avgStock === 0 ? null : round2(cogs / avgStock),
    grossMarginPct: i.sales === 0 ? null : round2((i.grossProfit / i.sales) * 100),
    netMarginPct: i.sales === 0 ? null : round2((i.netProfit / i.sales) * 100)
  }
}

// ---------- stock ageing ----------

export interface InwardLot {
  date: string
  qtyMilli: number
}

/** Ageing buckets in days: 0–30, 31–60, 61–90, 90+. */
export type AgeBuckets = [number, number, number, number]

function daysBetween(fromDate: string, toDate: string): number {
  return Math.round((Date.parse(toDate) - Date.parse(fromDate)) / 86_400_000)
}

/**
 * Attribute an item's closing quantity to age buckets, newest inward first (the stock you still
 * hold is assumed to be the most recently received — standard FIFO consumption). Whatever the
 * dated inwards can't cover is opening stock of unknown date and lands in the 90+ bucket.
 */
export function ageStock(closingQtyMilli: number, inwards: InwardLot[], asOn: string): AgeBuckets {
  const buckets: AgeBuckets = [0, 0, 0, 0]
  if (closingQtyMilli <= 0) return buckets
  let remaining = closingQtyMilli
  const newestFirst = [...inwards].sort((a, b) => b.date.localeCompare(a.date))
  for (const lot of newestFirst) {
    if (remaining <= 0) break
    const take = Math.min(remaining, lot.qtyMilli)
    if (take <= 0) continue
    const age = Math.max(0, daysBetween(lot.date, asOn))
    const b = age <= 30 ? 0 : age <= 60 ? 1 : age <= 90 ? 2 : 3
    buckets[b] += take
    remaining -= take
  }
  if (remaining > 0) buckets[3] += remaining
  return buckets
}
