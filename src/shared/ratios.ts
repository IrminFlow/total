/**
 * Ratio analysis (WP 6.2) — pure. Extends the dashboard's ratio panel (`computeRatios` in
 * reportMath.ts, reused here unchanged for the seven ratios it already computes) to the full set
 * the Ratios screen shows, grouped as liquidity, profitability, leverage, efficiency and
 * working-capital days.
 *
 * Formulas follow the standard published forms. Sources (cited per ratio in RATIO_DEFS):
 *   [S3]  Schedule III to the Companies Act, 2013, Division I — "Additional Regulatory
 *         Information" item on ratios, inserted by MCA notification G.S.R. 207(E) dated
 *         24 March 2021 (current ratio, debt-equity, return on equity, inventory turnover, trade
 *         receivables / payables turnover, net capital turnover, net profit ratio, ROCE …).
 *   [GN]  ICAI, Guidance Note on Division I – Non Ind AS Schedule III to the Companies Act, 2013
 *         — explains the numerator / denominator of each Schedule III ratio.
 *   [FM]  ICAI study material, Financial Management — "Ratio Analysis" chapter (quick ratio,
 *         cash ratio, debtor / creditor / inventory days, cash conversion cycle).
 * Unverified (we have not checked the exact paragraph numbering of [S3]/[GN] against the
 * official text): the citation labels; the formulas themselves are the textbook forms. Where a
 * Schedule III ratio needs data the books don't identify (interest, debt service, EBIT,
 * investments) it is left out rather than approximated: debt service coverage, ROCE, return on
 * investment.
 *
 * Money in, plain numbers out (ratios are not paise). A ratio is null when its denominator is
 * zero. Turnover / return figures are for the period given, not annualised; day counts use the
 * period's length.
 */
import { computeRatios } from './reportMath'

export interface RatioSetInput {
  /** Positions at the end of the period (paise; liabilities credit-positive). */
  currentAssets: number
  currentLiabilities: number
  stock: number
  cashBank: number
  receivables: number
  payables: number
  totalAssets: number
  /** Owners' funds: total assets less outside liabilities (capital + reserves + profit). */
  equity: number
  /** Loans (Liability) subtree, credit-positive. */
  debt: number
  /** The same positions at the start of the period, for the averages. */
  openingReceivables: number
  openingPayables: number
  openingTotalAssets: number
  openingEquity: number
  /** Flows for the period. */
  sales: number
  purchases: number
  openingStock: number
  closingStock: number
  grossProfit: number
  netProfit: number
  periodDays: number
}

export const RATIO_KEYS = [
  'currentRatio', 'quickRatio', 'cashRatio',
  'grossMarginPct', 'netMarginPct', 'returnOnEquityPct', 'returnOnAssetsPct',
  'debtEquity', 'equityRatio',
  'inventoryTurnover', 'receivablesTurnover', 'payablesTurnover', 'netCapitalTurnover', 'assetTurnover',
  'debtorDays', 'creditorDays', 'inventoryDays', 'cashConversionDays'
] as const
export type RatioKey = (typeof RATIO_KEYS)[number]

export type RatioSet = Record<RatioKey, number | null>

export type RatioCategory = 'liquidity' | 'profitability' | 'leverage' | 'efficiency' | 'workingCapital'

export const RATIO_CATEGORIES: { id: RatioCategory; label: string }[] = [
  { id: 'liquidity', label: 'Liquidity' },
  { id: 'profitability', label: 'Profitability' },
  { id: 'leverage', label: 'Leverage' },
  { id: 'efficiency', label: 'Efficiency' },
  { id: 'workingCapital', label: 'Working-capital days' }
]

export interface RatioDef {
  key: RatioKey
  label: string
  category: RatioCategory
  /** 'x' = times, '%' = percent, 'days'. */
  unit: 'x' | '%' | 'days'
  formula: string
  explain: string
  source: '[S3]' | '[GN]' | '[FM]' | '[S3] [GN]'
  /** Higher is better (for the trend colouring); null = neither. */
  higherIsBetter: boolean | null
}

export const RATIO_DEFS: RatioDef[] = [
  { key: 'currentRatio', label: 'Current ratio', category: 'liquidity', unit: 'x', formula: 'Current assets ÷ Current liabilities', explain: 'How many times short-term assets cover short-term dues. Around 1.5–2 is comfortable for a trading business; below 1 means dues exceed liquid assets.', source: '[S3] [GN]', higherIsBetter: true },
  { key: 'quickRatio', label: 'Quick ratio', category: 'liquidity', unit: 'x', formula: '(Current assets − Inventories) ÷ Current liabilities', explain: 'The current ratio without stock, which may take time to sell. Shows whether dues can be met from cash, bank and receivables alone.', source: '[FM]', higherIsBetter: true },
  { key: 'cashRatio', label: 'Cash ratio', category: 'liquidity', unit: 'x', formula: 'Cash and bank ÷ Current liabilities', explain: 'The strictest liquidity test: cash and bank balances against everything due within a year.', source: '[FM]', higherIsBetter: true },
  { key: 'grossMarginPct', label: 'Gross margin', category: 'profitability', unit: '%', formula: 'Gross profit ÷ Net sales × 100', explain: 'What is left of each rupee of sales after the cost of goods sold and direct expenses.', source: '[FM]', higherIsBetter: true },
  { key: 'netMarginPct', label: 'Net profit ratio', category: 'profitability', unit: '%', formula: 'Net profit ÷ Net sales × 100', explain: 'Profit after every expense, per rupee of sales.', source: '[S3] [GN]', higherIsBetter: true },
  { key: 'returnOnEquityPct', label: 'Return on equity', category: 'profitability', unit: '%', formula: 'Net profit ÷ Average owners’ funds × 100', explain: 'Profit earned on the owners’ money in the business over the period (not annualised).', source: '[S3] [GN]', higherIsBetter: true },
  { key: 'returnOnAssetsPct', label: 'Return on assets', category: 'profitability', unit: '%', formula: 'Net profit ÷ Average total assets × 100', explain: 'Profit earned on everything the business holds, however financed (not annualised).', source: '[FM]', higherIsBetter: true },
  { key: 'debtEquity', label: 'Debt-equity ratio', category: 'leverage', unit: 'x', formula: 'Total borrowings ÷ Owners’ funds', explain: 'Borrowed money (the Loans (Liability) group) per rupee of owners’ funds. Higher means more reliance on lenders.', source: '[S3] [GN]', higherIsBetter: false },
  { key: 'equityRatio', label: 'Proprietary ratio', category: 'leverage', unit: 'x', formula: 'Owners’ funds ÷ Total assets', explain: 'Share of the assets financed by the owners rather than by creditors and lenders.', source: '[FM]', higherIsBetter: true },
  { key: 'inventoryTurnover', label: 'Inventory turnover', category: 'efficiency', unit: 'x', formula: 'Cost of goods sold ÷ Average inventory', explain: 'How many times the average stock was sold and replaced in the period. COGS = opening stock + purchases − closing stock.', source: '[S3] [GN]', higherIsBetter: true },
  { key: 'receivablesTurnover', label: 'Trade receivables turnover', category: 'efficiency', unit: 'x', formula: 'Net sales ÷ Average trade receivables', explain: 'How many times customers’ dues were collected in the period. All sales are treated as credit sales.', source: '[S3] [GN]', higherIsBetter: true },
  { key: 'payablesTurnover', label: 'Trade payables turnover', category: 'efficiency', unit: 'x', formula: 'Net purchases ÷ Average trade payables', explain: 'How many times suppliers were paid off in the period. All purchases are treated as credit purchases.', source: '[S3] [GN]', higherIsBetter: null },
  { key: 'netCapitalTurnover', label: 'Net capital turnover', category: 'efficiency', unit: 'x', formula: 'Net sales ÷ Working capital (Current assets − Current liabilities)', explain: 'Sales generated per rupee of working capital.', source: '[S3] [GN]', higherIsBetter: true },
  { key: 'assetTurnover', label: 'Asset turnover', category: 'efficiency', unit: 'x', formula: 'Net sales ÷ Average total assets', explain: 'Sales generated per rupee of total assets.', source: '[FM]', higherIsBetter: true },
  { key: 'debtorDays', label: 'Debtor days', category: 'workingCapital', unit: 'days', formula: 'Closing trade receivables ÷ Net sales × Days in period', explain: 'Average days customers take to pay.', source: '[FM]', higherIsBetter: false },
  { key: 'creditorDays', label: 'Creditor days', category: 'workingCapital', unit: 'days', formula: 'Closing trade payables ÷ Net purchases × Days in period', explain: 'Average days taken to pay suppliers.', source: '[FM]', higherIsBetter: null },
  { key: 'inventoryDays', label: 'Inventory days', category: 'workingCapital', unit: 'days', formula: 'Average inventory ÷ Cost of goods sold × Days in period', explain: 'Average days stock is held before it is sold.', source: '[FM]', higherIsBetter: false },
  { key: 'cashConversionDays', label: 'Cash conversion cycle', category: 'workingCapital', unit: 'days', formula: 'Debtor days + Inventory days − Creditor days', explain: 'Days between paying for stock and collecting from customers; the shorter, the less working capital is tied up.', source: '[FM]', higherIsBetter: false }
]

const round2 = (n: number): number => Math.round(n * 100) / 100
const div = (num: number, den: number): number | null => (den === 0 ? null : round2(num / den))
const pct = (num: number, den: number): number | null => (den === 0 ? null : round2((num / den) * 100))

export function computeRatioSet(i: RatioSetInput): RatioSet {
  // The seven the dashboard already shows — one definition, reused.
  const base = computeRatios({
    currentAssets: i.currentAssets,
    currentLiabilities: i.currentLiabilities,
    stock: i.stock,
    receivables: i.receivables,
    payables: i.payables,
    sales: i.sales,
    purchases: i.purchases,
    openingStock: i.openingStock,
    closingStock: i.closingStock,
    grossProfit: i.grossProfit,
    netProfit: i.netProfit,
    periodDays: i.periodDays
  })
  const cogs = i.openingStock + i.purchases - i.closingStock
  const avgStock = (i.openingStock + i.closingStock) / 2
  const avgReceivables = (i.openingReceivables + i.receivables) / 2
  const avgPayables = (i.openingPayables + i.payables) / 2
  const avgAssets = (i.openingTotalAssets + i.totalAssets) / 2
  const avgEquity = (i.openingEquity + i.equity) / 2
  const inventoryDays = cogs === 0 ? null : round2((avgStock / cogs) * i.periodDays)
  const cashConversionDays =
    base.debtorDays === null || inventoryDays === null || base.creditorDays === null
      ? null
      : round2(base.debtorDays + inventoryDays - base.creditorDays)
  return {
    currentRatio: base.currentRatio,
    quickRatio: base.quickRatio,
    cashRatio: div(i.cashBank, i.currentLiabilities),
    grossMarginPct: base.grossMarginPct,
    netMarginPct: base.netMarginPct,
    returnOnEquityPct: avgEquity <= 0 ? null : pct(i.netProfit, avgEquity),
    returnOnAssetsPct: pct(i.netProfit, avgAssets),
    debtEquity: i.equity <= 0 ? null : div(i.debt, i.equity),
    equityRatio: div(i.equity, i.totalAssets),
    inventoryTurnover: base.inventoryTurnover,
    receivablesTurnover: div(i.sales, avgReceivables),
    payablesTurnover: div(i.purchases, avgPayables),
    netCapitalTurnover: div(i.sales, i.currentAssets - i.currentLiabilities),
    assetTurnover: div(i.sales, avgAssets),
    debtorDays: base.debtorDays,
    creditorDays: base.creditorDays,
    inventoryDays,
    cashConversionDays
  }
}

export function formatRatio(value: number | null, unit: RatioDef['unit']): string {
  if (value === null) return '—'
  if (unit === '%') return `${value.toFixed(1)}%`
  if (unit === 'days') return `${Math.round(value)} days`
  return `${value.toFixed(2)}×`
}

/** One point of the Ratios screen: the period (or a month) and its ratio set. */
export interface RatioPoint {
  key: string
  label: string
  from: string
  to: string
  ratios: RatioSet
}

export interface RatioReport {
  period: RatioPoint
  months: RatioPoint[]
  /** Inputs of the whole-period point, for "how was this worked out". */
  inputs: RatioSetInput
}
