/**
 * CMA data — Credit Monitoring Arrangement (roadmap #371).
 *
 * A bank will not sanction or renew a cash-credit limit without this pack. It is six forms and a
 * ratio sheet, laid out across five columns: two audited years, the current year's estimate, and
 * two projected years. A CA charges thousands to rebuild it by hand from a trial balance.
 *
 * The whole design turns on one boundary, and it is a boundary of honesty rather than of
 * convenience:
 *
 *   - The AUDITED columns come from the books. This app can compute them and must.
 *   - The ESTIMATE and PROJECTION columns are the borrower's own claim about their future. An
 *     accounting app has no business inventing them. They are typed, every one of them.
 *
 * So every cell carries where it came from — `books`, `typed`, or `derived` (a subtotal, computed
 * from the cells above it whatever their source). The UI renders the three differently on
 * purpose: a banker reading a projection needs to know it is a projection, and the borrower
 * signing the pack needs to know which numbers they are personally asserting.
 *
 * The third state that matters is a column with nothing behind it. A business two years old has
 * no second audited year, and a CMA pack that quietly prints zeros for a year that did not exist
 * is a pack that gets the loan refused. Such a column is marked `empty` and every cell in it is
 * null — blank, not zero — until the user types the figures off their printed accounts.
 *
 * Everything in this file is pure arithmetic over supplied figures. Where the figures come from
 * is `src/main/services/cma.ts`, which reuses the working-capital classification of #372/#373
 * rather than inventing a second one that disagrees with the stock statement.
 */

import type { RatioPanel } from './reportMath'

// ---------- columns ----------

export const CMA_COLUMN_KEYS = ['a2', 'a1', 'e', 'p1', 'p2'] as const
export type CmaColumnKey = (typeof CMA_COLUMN_KEYS)[number]

/** What kind of claim the column makes. Audited is a fact; the other two are assertions. */
export type CmaColumnSource = 'audited' | 'estimate' | 'projection'

export const CMA_COLUMN_SOURCE: Record<CmaColumnKey, CmaColumnSource> = {
  a2: 'audited',
  a1: 'audited',
  e: 'estimate',
  p1: 'projection',
  p2: 'projection'
}

/**
 * `books`   — read out of the ledgers; the user cannot edit it without editing the books.
 * `typed`   — the user's own figure.
 * `derived` — a subtotal of cells in the same column.
 */
export type CmaCellSource = 'books' | 'typed' | 'derived'

export interface CmaColumn {
  key: CmaColumnKey
  /** 'FY 2024-25'. */
  label: string
  source: CmaColumnSource
  fyStartYear: number
  from: string
  to: string
  /**
   * `books`  — an audited year the books cover, computed.
   * `typed`  — the user is entering it (every estimate/projection, and any audited year the
   *            books do not reach — a migrated company has those on paper, not in here).
   * `empty`  — typed and nothing typed yet. Cells are null, never zero.
   */
  state: 'books' | 'typed' | 'empty'
  /** Only meaningful for audited columns: whether the books actually cover the year. */
  booksCover: boolean
}

export interface CmaColumnSpec {
  key: CmaColumnKey
  fyStartYear: number
  from: string
  to: string
  booksCover: boolean
}

// ---------- the figures the books can supply ----------

/**
 * One audited column's worth of book figures, in integer paise.
 *
 * Every field is a bucket that some set of ledgers falls into, and the buckets are exhaustive on
 * purpose: an expense ledger nobody thought about lands in `otherIndirectExpenses` rather than
 * being dropped, so Form II's profit still ties to the books' profit. A CMA pack whose bottom
 * line disagrees with the audited accounts attached to the same application is worse than no pack.
 */
export interface CmaBookFigures {
  // --- Form II, period flows ---
  /** Net of returns: credit notes debit the sales ledger, so this is what the books call sales. */
  netSales: number
  /** Memo split — sales-kind vouchers to parties flagged SEZ/export on the ledger master. */
  exportSales: number
  otherOperatingIncome: number
  openingStock: number
  closingStock: number
  rawMaterials: number
  directWages: number
  powerAndFuel: number
  otherManufacturingExpenses: number
  depreciation: number
  sellingExpenses: number
  administrativeExpenses: number
  otherIndirectExpenses: number
  interest: number
  otherIncome: number
  taxProvision: number
  /** Debits to the capital account during the year: drawings, or dividend paid. */
  drawings: number

  // --- Form III, position at the column's `to` date ---
  bankBorrowingShortTerm: number
  sundryCreditors: number
  statutoryDues: number
  provisions: number
  currentInstalmentsOfTermLoans: number
  otherCurrentLiabilities: number
  termLiabilities: number
  otherNonCurrentLiabilities: number
  capital: number
  reserves: number
  cashAndBank: number
  receivablesWithinSixMonths: number
  receivablesOverSixMonths: number
  inventory: number
  advancesAndDeposits: number
  otherCurrentAssets: number
  netFixedAssets: number
  investments: number
  otherNonCurrentAssets: number
  intangibleAssets: number

  // --- debt service, from the loan register ---
  termLoanInterest: number
  termLoanInstalments: number
}

export function zeroBookFigures(): CmaBookFigures {
  return {
    netSales: 0, exportSales: 0, otherOperatingIncome: 0, openingStock: 0, closingStock: 0,
    rawMaterials: 0, directWages: 0, powerAndFuel: 0, otherManufacturingExpenses: 0,
    depreciation: 0, sellingExpenses: 0, administrativeExpenses: 0, otherIndirectExpenses: 0,
    interest: 0, otherIncome: 0, taxProvision: 0, drawings: 0,
    bankBorrowingShortTerm: 0, sundryCreditors: 0, statutoryDues: 0, provisions: 0,
    currentInstalmentsOfTermLoans: 0, otherCurrentLiabilities: 0, termLiabilities: 0,
    otherNonCurrentLiabilities: 0, capital: 0, reserves: 0,
    cashAndBank: 0, receivablesWithinSixMonths: 0, receivablesOverSixMonths: 0, inventory: 0,
    advancesAndDeposits: 0, otherCurrentAssets: 0, netFixedAssets: 0, investments: 0,
    otherNonCurrentAssets: 0, intangibleAssets: 0,
    termLoanInterest: 0, termLoanInstalments: 0
  }
}

// ---------- the line catalogue ----------

export type CmaFormId = 'I' | 'II' | 'III' | 'IV' | 'V' | 'VI' | 'DS'

interface LineDef {
  key: string
  label: string
  form: CmaFormId
  indent?: 0 | 1 | 2
  /** Section heading rendered above this line. */
  heading?: string
  emphasis?: boolean
  /** A leaf reads from the books in an audited column, and is typed everywhere else. */
  fromBooks?: (f: CmaBookFigures) => number
  /** A total is always derived, from other lines in the same column. */
  formula?: (get: (key: string) => number) => number
}

const sum = (get: (k: string) => number, ...keys: string[]): number =>
  keys.reduce((s, k) => s + get(k), 0)

/**
 * Form II — the operating statement.
 *
 * There is no "less: excise duty" line, which the pre-GST form had between gross and net sales.
 * GST is not revenue and never reaches a sales ledger, so under GST gross sales and net sales are
 * the same figure and a deduction line would always read nil. Printing a permanently-nil line
 * invites someone to fill it in with the GST, which would understate turnover to the bank.
 */
const FORM_II: LineDef[] = [
  { key: 'ii_sales_export', label: 'Gross sales — exports and SEZ supplies', form: 'II', indent: 1, heading: 'Sales', fromBooks: (f) => f.exportSales },
  { key: 'ii_sales_domestic', label: 'Gross sales — domestic', form: 'II', indent: 1, formula: (g) => g('ii_net_sales_total') - g('ii_sales_export') },
  { key: 'ii_net_sales_total', label: 'Net sales', form: 'II', emphasis: true, fromBooks: (f) => f.netSales },
  { key: 'ii_other_operating_income', label: 'Other operating income', form: 'II', indent: 1, fromBooks: (f) => f.otherOperatingIncome },
  { key: 'ii_total_income', label: 'Total operating income', form: 'II', emphasis: true, formula: (g) => sum(g, 'ii_net_sales_total', 'ii_other_operating_income') },

  { key: 'ii_raw_materials', label: 'Raw materials / goods purchased', form: 'II', indent: 1, heading: 'Cost of sales', fromBooks: (f) => f.rawMaterials },
  { key: 'ii_direct_wages', label: 'Direct wages and labour', form: 'II', indent: 1, fromBooks: (f) => f.directWages },
  { key: 'ii_power_fuel', label: 'Power and fuel', form: 'II', indent: 1, fromBooks: (f) => f.powerAndFuel },
  { key: 'ii_other_mfg', label: 'Other manufacturing / direct expenses', form: 'II', indent: 1, fromBooks: (f) => f.otherManufacturingExpenses },
  { key: 'ii_depreciation', label: 'Depreciation', form: 'II', indent: 1, fromBooks: (f) => f.depreciation },
  { key: 'ii_opening_stock', label: 'Add: opening stock', form: 'II', indent: 1, fromBooks: (f) => f.openingStock },
  { key: 'ii_closing_stock', label: 'Less: closing stock', form: 'II', indent: 1, fromBooks: (f) => f.closingStock },
  {
    key: 'ii_cost_of_sales', label: 'Cost of sales', form: 'II', emphasis: true,
    formula: (g) => sum(g, 'ii_raw_materials', 'ii_direct_wages', 'ii_power_fuel', 'ii_other_mfg', 'ii_depreciation', 'ii_opening_stock') - g('ii_closing_stock')
  },
  { key: 'ii_gross_profit', label: 'Gross profit', form: 'II', emphasis: true, formula: (g) => g('ii_total_income') - g('ii_cost_of_sales') },

  { key: 'ii_selling', label: 'Selling and distribution expenses', form: 'II', indent: 1, heading: 'Operating expenses', fromBooks: (f) => f.sellingExpenses },
  { key: 'ii_admin', label: 'Administrative expenses', form: 'II', indent: 1, fromBooks: (f) => f.administrativeExpenses },
  { key: 'ii_other_indirect', label: 'Other indirect expenses', form: 'II', indent: 1, fromBooks: (f) => f.otherIndirectExpenses },
  { key: 'ii_op_profit_before_interest', label: 'Operating profit before interest', form: 'II', emphasis: true, formula: (g) => g('ii_gross_profit') - sum(g, 'ii_selling', 'ii_admin', 'ii_other_indirect') },
  { key: 'ii_interest', label: 'Interest', form: 'II', indent: 1, fromBooks: (f) => f.interest },
  { key: 'ii_op_profit', label: 'Operating profit after interest', form: 'II', emphasis: true, formula: (g) => g('ii_op_profit_before_interest') - g('ii_interest') },
  { key: 'ii_other_income', label: 'Add: other (non-operating) income', form: 'II', indent: 1, fromBooks: (f) => f.otherIncome },
  { key: 'ii_pbt', label: 'Profit before tax', form: 'II', emphasis: true, formula: (g) => g('ii_op_profit') + g('ii_other_income') },
  { key: 'ii_tax', label: 'Less: provision for taxes', form: 'II', indent: 1, fromBooks: (f) => f.taxProvision },
  { key: 'ii_pat', label: 'Net profit after tax', form: 'II', emphasis: true, formula: (g) => g('ii_pbt') - g('ii_tax') },
  { key: 'ii_drawings', label: 'Less: dividend / withdrawals', form: 'II', indent: 1, fromBooks: (f) => f.drawings },
  { key: 'ii_retained', label: 'Retained profit', form: 'II', emphasis: true, formula: (g) => g('ii_pat') - g('ii_drawings') }
]

/** Form III — analysis of the balance sheet, the same five columns. */
const FORM_III: LineDef[] = [
  { key: 'iii_bank_borrowing', label: 'Short-term bank borrowing (CC / OD / packing credit)', form: 'III', indent: 1, heading: 'Current liabilities', fromBooks: (f) => f.bankBorrowingShortTerm },
  { key: 'iii_creditors', label: 'Sundry creditors (trade)', form: 'III', indent: 1, fromBooks: (f) => f.sundryCreditors },
  { key: 'iii_statutory', label: 'Statutory dues (GST, TDS, PF, ESI)', form: 'III', indent: 1, fromBooks: (f) => f.statutoryDues },
  { key: 'iii_provisions', label: 'Provisions', form: 'III', indent: 1, fromBooks: (f) => f.provisions },
  { key: 'iii_term_current', label: 'Instalments of term loans due within one year', form: 'III', indent: 1, fromBooks: (f) => f.currentInstalmentsOfTermLoans },
  { key: 'iii_other_cl', label: 'Other current liabilities', form: 'III', indent: 1, fromBooks: (f) => f.otherCurrentLiabilities },
  { key: 'iii_tcl', label: 'Total current liabilities', form: 'III', emphasis: true, formula: (g) => sum(g, 'iii_bank_borrowing', 'iii_creditors', 'iii_statutory', 'iii_provisions', 'iii_term_current', 'iii_other_cl') },

  { key: 'iii_term_liabilities', label: 'Term loans and debentures', form: 'III', indent: 1, heading: 'Term liabilities', fromBooks: (f) => f.termLiabilities },
  { key: 'iii_other_ncl', label: 'Other term liabilities', form: 'III', indent: 1, fromBooks: (f) => f.otherNonCurrentLiabilities },
  { key: 'iii_ttl', label: 'Total term liabilities', form: 'III', emphasis: true, formula: (g) => sum(g, 'iii_term_liabilities', 'iii_other_ncl') },

  { key: 'iii_capital', label: 'Capital / share capital', form: 'III', indent: 1, heading: 'Net worth', fromBooks: (f) => f.capital },
  { key: 'iii_reserves', label: 'Reserves and surplus', form: 'III', indent: 1, fromBooks: (f) => f.reserves },
  { key: 'iii_net_worth', label: 'Net worth', form: 'III', emphasis: true, formula: (g) => sum(g, 'iii_capital', 'iii_reserves') },
  { key: 'iii_total_liabilities', label: 'Total liabilities', form: 'III', emphasis: true, formula: (g) => sum(g, 'iii_tcl', 'iii_ttl', 'iii_net_worth') },

  { key: 'iii_cash', label: 'Cash and bank balances', form: 'III', indent: 1, heading: 'Current assets', fromBooks: (f) => f.cashAndBank },
  { key: 'iii_receivables_6m', label: 'Receivables — within six months', form: 'III', indent: 1, fromBooks: (f) => f.receivablesWithinSixMonths },
  { key: 'iii_receivables_over_6m', label: 'Receivables — exceeding six months', form: 'III', indent: 1, fromBooks: (f) => f.receivablesOverSixMonths },
  { key: 'iii_inventory', label: 'Inventory', form: 'III', indent: 1, fromBooks: (f) => f.inventory },
  { key: 'iii_advances', label: 'Advances to suppliers and deposits', form: 'III', indent: 1, fromBooks: (f) => f.advancesAndDeposits },
  { key: 'iii_other_ca', label: 'Other current assets', form: 'III', indent: 1, fromBooks: (f) => f.otherCurrentAssets },
  { key: 'iii_tca', label: 'Total current assets', form: 'III', emphasis: true, formula: (g) => sum(g, 'iii_cash', 'iii_receivables_6m', 'iii_receivables_over_6m', 'iii_inventory', 'iii_advances', 'iii_other_ca') },

  { key: 'iii_net_fixed_assets', label: 'Fixed assets (net block)', form: 'III', indent: 1, heading: 'Non-current assets', fromBooks: (f) => f.netFixedAssets },
  { key: 'iii_investments', label: 'Investments', form: 'III', indent: 1, fromBooks: (f) => f.investments },
  { key: 'iii_other_nca', label: 'Other non-current assets', form: 'III', indent: 1, fromBooks: (f) => f.otherNonCurrentAssets },
  { key: 'iii_intangibles', label: 'Intangible and deferred revenue expenditure', form: 'III', indent: 1, fromBooks: (f) => f.intangibleAssets },
  { key: 'iii_total_assets', label: 'Total assets', form: 'III', emphasis: true, formula: (g) => sum(g, 'iii_tca', 'iii_net_fixed_assets', 'iii_investments', 'iii_other_nca', 'iii_intangibles') },
  { key: 'iii_nwc', label: 'Net working capital', form: 'III', emphasis: true, formula: (g) => g('iii_tca') - g('iii_tcl') }
]

/**
 * Form V — MPBF under the Tandon Committee's two lending methods.
 *
 * Both start from the working-capital gap (current assets less the current liabilities other than
 * bank borrowing) and both then require the borrower to fund a slice of it themselves. They
 * differ only in what the slice is a quarter OF:
 *
 *   Method I  — 25% of the working-capital gap.
 *   Method II — 25% of total current assets, which is stricter, and is the one banks apply to
 *               anything but the smallest limits.
 *
 * MPBF is the LOWER of (gap less the stipulated minimum) and (gap less the net working capital
 * the borrower actually has). Taking the higher — a common hand-computation error — hands the
 * borrower a limit their own balance sheet does not support.
 */
const FORM_V: LineDef[] = [
  { key: 'v_tca', label: 'Total current assets', form: 'V', formula: (g) => g('iii_tca') },
  { key: 'v_ocl', label: 'Current liabilities other than bank borrowing', form: 'V', formula: (g) => g('iii_tcl') - g('iii_bank_borrowing') },
  { key: 'v_wcg', label: 'Working capital gap', form: 'V', emphasis: true, formula: (g) => g('v_tca') - g('v_ocl') },
  { key: 'v_actual_nwc', label: 'Net working capital actually available', form: 'V', formula: (g) => g('iii_tca') - g('iii_tcl') },

  { key: 'v_min_nwc_1', label: 'Minimum stipulated net working capital — 25% of the gap', form: 'V', indent: 1, heading: 'Method I', formula: (g) => quarter(g('v_wcg')) },
  { key: 'v_gap_less_min_1', label: 'Gap less minimum stipulated NWC', form: 'V', indent: 1, formula: (g) => g('v_wcg') - g('v_min_nwc_1') },
  { key: 'v_gap_less_actual_1', label: 'Gap less actual NWC', form: 'V', indent: 1, formula: (g) => g('v_wcg') - g('v_actual_nwc') },
  { key: 'v_mpbf_1', label: 'MPBF — Method I', form: 'V', emphasis: true, formula: (g) => Math.max(0, Math.min(g('v_gap_less_min_1'), g('v_gap_less_actual_1'))) },
  { key: 'v_shortfall_1', label: 'Excess borrowing / shortfall in NWC — Method I', form: 'V', indent: 1, formula: (g) => Math.max(0, g('v_min_nwc_1') - g('v_actual_nwc')) },

  { key: 'v_min_nwc_2', label: 'Minimum stipulated net working capital — 25% of current assets', form: 'V', indent: 1, heading: 'Method II', formula: (g) => quarter(g('v_tca')) },
  { key: 'v_gap_less_min_2', label: 'Gap less minimum stipulated NWC', form: 'V', indent: 1, formula: (g) => g('v_wcg') - g('v_min_nwc_2') },
  { key: 'v_gap_less_actual_2', label: 'Gap less actual NWC', form: 'V', indent: 1, formula: (g) => g('v_wcg') - g('v_actual_nwc') },
  { key: 'v_mpbf_2', label: 'MPBF — Method II', form: 'V', emphasis: true, formula: (g) => Math.max(0, Math.min(g('v_gap_less_min_2'), g('v_gap_less_actual_2'))) },
  { key: 'v_shortfall_2', label: 'Excess borrowing / shortfall in NWC — Method II', form: 'V', indent: 1, formula: (g) => Math.max(0, g('v_min_nwc_2') - g('v_actual_nwc')) }
]

/** 25%, rounded to whole paise so the form never carries a fraction of a paisa. */
const quarter = (paise: number): number => Math.sign(paise) * Math.round(Math.abs(paise) / 4)

/** Debt service inputs, which live in the loan register rather than in any of the six forms. */
const FORM_DS: LineDef[] = [
  { key: 'ds_term_interest', label: 'Interest on term loans', form: 'DS', fromBooks: (f) => f.termLoanInterest },
  { key: 'ds_term_instalments', label: 'Term loan instalments falling due', form: 'DS', fromBooks: (f) => f.termLoanInstalments }
]

export const CMA_LINES: readonly LineDef[] = [...FORM_II, ...FORM_III, ...FORM_V, ...FORM_DS]

const LINE_BY_KEY = new Map(CMA_LINES.map((l) => [l.key, l]))

/** Every line the user may type into: the leaves. Totals are never editable. */
export const CMA_TYPEABLE_KEYS: readonly string[] = CMA_LINES.filter((l) => !l.formula).map((l) => l.key)

export function isCmaLineKey(key: string): boolean {
  return LINE_BY_KEY.has(key)
}

// ---------- resolved output ----------

export interface CmaCell {
  /** Integer paise, or null when the column has nothing behind it at all. */
  value: number | null
  source: CmaCellSource
}

export interface CmaLine {
  key: string
  label: string
  indent: 0 | 1 | 2
  heading?: string
  emphasis: boolean
  /** Whether the user may type into this line (in a typed column). */
  editable: boolean
  /** One per column, in column order. */
  cells: CmaCell[]
}

export interface CmaForm {
  id: CmaFormId
  title: string
  lines: CmaLine[]
}

export const CMA_FORM_TITLES: Record<CmaFormId, string> = {
  I: 'Form I — Particulars of existing and proposed limits',
  II: 'Form II — Operating statement',
  III: 'Form III — Analysis of the balance sheet',
  IV: 'Form IV — Comparative statement of current assets and current liabilities',
  V: 'Form V — Computation of maximum permissible bank finance',
  VI: 'Form VI — Fund flow statement',
  DS: 'Debt service'
}

export type CmaTypedValues = Partial<Record<CmaColumnKey, Record<string, number>>>

// ---------- the resolver ----------

/**
 * Decide each column's state before a single figure is placed.
 *
 * An audited column the books do not reach falls back to typed entry rather than to zero: a
 * business that migrated into this app last year still has two audited years, they are just on
 * paper. Saying "no books for that year, type it" is useful; printing zeros is not.
 */
export function resolveColumns(specs: CmaColumnSpec[], typed: CmaTypedValues): CmaColumn[] {
  return specs.map((s) => {
    const source = CMA_COLUMN_SOURCE[s.key]
    const fy = `FY ${s.fyStartYear}-${String((s.fyStartYear + 1) % 100).padStart(2, '0')}`
    const fromBooks = source === 'audited' && s.booksCover
    const hasTyped = Object.keys(typed[s.key] ?? {}).length > 0
    return {
      key: s.key,
      label: fy,
      source,
      fyStartYear: s.fyStartYear,
      from: s.from,
      to: s.to,
      booksCover: s.booksCover,
      state: fromBooks ? 'books' : hasTyped ? 'typed' : 'empty'
    }
  })
}

interface ResolvedColumn {
  column: CmaColumn
  values: Map<string, number>
}

function resolveColumnValues(
  column: CmaColumn,
  books: CmaBookFigures | null,
  typed: Record<string, number>
): Map<string, number> {
  const values = new Map<string, number>()
  const get = (key: string): number => {
    const cached = values.get(key)
    if (cached !== undefined) return cached
    const def = LINE_BY_KEY.get(key)
    if (!def) return 0
    // Guard against a cycle in the catalogue turning into a stack overflow at runtime: seed the
    // key with 0 before evaluating its formula, so a self-reference resolves to 0 rather than
    // recursing. The unit tests assert the catalogue is acyclic; this is the belt.
    values.set(key, 0)
    const v =
      def.formula !== undefined
        ? def.formula(get)
        : column.state === 'books' && books && def.fromBooks
          ? def.fromBooks(books)
          : (typed[key] ?? 0)
    values.set(key, v)
    return v
  }
  for (const def of CMA_LINES) get(def.key)
  return values
}

export interface CmaPackInput {
  specs: CmaColumnSpec[]
  /** Book figures for the audited columns the books cover. */
  books: Partial<Record<CmaColumnKey, CmaBookFigures>>
  typed: CmaTypedValues
}

export interface CmaPack {
  columns: CmaColumn[]
  forms: CmaForm[]
  formIV: CmaFormIV
  fundFlow: CmaFundFlow
  ratios: CmaRatioRow[]
}

export function buildCmaPack(input: CmaPackInput): CmaPack {
  const columns = resolveColumns(input.specs, input.typed)
  const resolved: ResolvedColumn[] = columns.map((column) => ({
    column,
    values: resolveColumnValues(column, input.books[column.key] ?? null, input.typed[column.key] ?? {})
  }))

  const cellFor = (r: ResolvedColumn, def: LineDef): CmaCell => {
    if (r.column.state === 'empty') return { value: null, source: def.formula ? 'derived' : 'typed' }
    const source: CmaCellSource = def.formula ? 'derived' : r.column.state === 'books' && def.fromBooks ? 'books' : 'typed'
    return { value: r.values.get(def.key) ?? 0, source }
  }

  const lineFor = (def: LineDef): CmaLine => ({
    key: def.key,
    label: def.label,
    indent: def.indent ?? 0,
    ...(def.heading ? { heading: def.heading } : {}),
    emphasis: def.emphasis ?? false,
    editable: def.formula === undefined,
    cells: resolved.map((r) => cellFor(r, def))
  })

  const formOf = (id: CmaFormId, defs: LineDef[]): CmaForm => ({
    id,
    title: CMA_FORM_TITLES[id],
    lines: defs.map(lineFor)
  })

  return {
    columns,
    forms: [formOf('II', FORM_II), formOf('III', FORM_III), formOf('V', FORM_V), formOf('DS', FORM_DS)],
    formIV: buildFormIV(resolved),
    fundFlow: buildFundFlow(resolved),
    ratios: buildRatios(resolved)
  }
}

// ---------- Form IV ----------

export interface CmaFormIVRow {
  key: string
  label: string
  emphasis: boolean
  cells: CmaCell[]
  /**
   * Holding level in days — inventory against cost of sales, receivables against sales, creditors
   * against purchases. Null where the flow it is measured against is nil: a business with no
   * sales does not hold its debtors for infinity days, the question simply has no answer.
   */
  holdingDays: (number | null)[]
}

export interface CmaFormIV {
  assets: CmaFormIVRow[]
  liabilities: CmaFormIVRow[]
}

const CA_KEYS = ['iii_cash', 'iii_receivables_6m', 'iii_receivables_over_6m', 'iii_inventory', 'iii_advances', 'iii_other_ca', 'iii_tca']
const CL_KEYS = ['iii_bank_borrowing', 'iii_creditors', 'iii_statutory', 'iii_provisions', 'iii_term_current', 'iii_other_cl', 'iii_tcl']

/** Which flow each current item's holding period is measured against. */
const HOLDING_BASE: Record<string, string> = {
  iii_inventory: 'ii_cost_of_sales',
  iii_receivables_6m: 'ii_net_sales_total',
  iii_receivables_over_6m: 'ii_net_sales_total',
  iii_creditors: 'ii_raw_materials'
}

const round2 = (n: number): number => Math.round(n * 100) / 100

function formIVRows(resolved: ResolvedColumn[], keys: string[]): CmaFormIVRow[] {
  return keys.map((key) => {
    const def = LINE_BY_KEY.get(key)!
    return {
      key,
      label: def.label,
      emphasis: def.emphasis ?? false,
      cells: resolved.map((r) =>
        r.column.state === 'empty'
          ? { value: null, source: def.formula ? ('derived' as const) : ('typed' as const) }
          : {
              value: r.values.get(key) ?? 0,
              source: def.formula ? ('derived' as const) : r.column.state === 'books' && def.fromBooks ? ('books' as const) : ('typed' as const)
            }
      ),
      holdingDays: resolved.map((r) => {
        const baseKey = HOLDING_BASE[key]
        if (!baseKey || r.column.state === 'empty') return null
        const base = r.values.get(baseKey) ?? 0
        if (base <= 0) return null
        return round2(((r.values.get(key) ?? 0) / base) * 365)
      })
    }
  })
}

function buildFormIV(resolved: ResolvedColumn[]): CmaFormIV {
  return { assets: formIVRows(resolved, CA_KEYS), liabilities: formIVRows(resolved, CL_KEYS) }
}

// ---------- Form VI, fund flow ----------

export interface CmaFundFlowColumn {
  /** 'FY 2024-25 → FY 2025-26'. */
  label: string
  fromKey: CmaColumnKey
  toKey: CmaColumnKey
  /** Both endpoint columns have figures. A period with a blank endpoint has no movement to show. */
  available: boolean
}

export interface CmaFundFlowLine {
  key: string
  label: string
  emphasis: boolean
  /** Null where the delta column is unavailable. */
  values: (number | null)[]
}

export interface CmaFundFlow {
  columns: CmaFundFlowColumn[]
  sources: CmaFundFlowLine[]
  uses: CmaFundFlowLine[]
  summary: CmaFundFlowLine[]
}

/**
 * The fund flow is a statement of movement, so its columns are the GAPS between the pack's
 * columns, not the columns themselves. Four of them across five years.
 *
 * The identity it must satisfy — and the one the tests pin — is that the long-term surplus less
 * the increase in the working-capital gap equals the decrease in bank borrowing. It falls out of
 * the balance sheet balancing; when it does not, something in the pack does not add up and the
 * credit officer will find it before the borrower does.
 *
 * Fresh capital is computed as the movement in net worth LESS the year's retained profit, rather
 * than read off the capital line directly. Retained profit is already a source in its own right,
 * so counting the whole movement in net worth would count the year's earnings twice.
 */
function buildFundFlow(resolved: ResolvedColumn[]): CmaFundFlow {
  const pairs: { prev: ResolvedColumn; curr: ResolvedColumn }[] = []
  for (let i = 1; i < resolved.length; i++) pairs.push({ prev: resolved[i - 1]!, curr: resolved[i]! })

  const columns: CmaFundFlowColumn[] = pairs.map(({ prev, curr }) => ({
    label: `${prev.column.label} → ${curr.column.label}`,
    fromKey: prev.column.key,
    toKey: curr.column.key,
    available: prev.column.state !== 'empty' && curr.column.state !== 'empty'
  }))

  const line = (key: string, label: string, calc: (prev: Map<string, number>, curr: Map<string, number>) => number, emphasis = false): CmaFundFlowLine => ({
    key,
    label,
    emphasis,
    values: pairs.map(({ prev, curr }, i) => (columns[i]!.available ? calc(prev.values, curr.values) : null))
  })

  const d = (m: Map<string, number>, k: string): number => m.get(k) ?? 0
  const delta = (prev: Map<string, number>, curr: Map<string, number>, k: string): number => d(curr, k) - d(prev, k)
  const freshCapital = (prev: Map<string, number>, curr: Map<string, number>): number =>
    delta(prev, curr, 'iii_net_worth') - d(curr, 'ii_retained')
  const nonCurrentAssets = (m: Map<string, number>): number =>
    d(m, 'iii_net_fixed_assets') + d(m, 'iii_investments') + d(m, 'iii_other_nca') + d(m, 'iii_intangibles')
  /**
   * Capital expenditure, which is what the form's "increase in fixed assets" line means — not the
   * movement in the net block.
   *
   * Form III carries fixed assets NET of depreciation, so the movement in it is already the year's
   * additions less the year's depreciation. Depreciation is separately a source above, being a
   * charge that consumed no funds. Showing the net movement as the use would therefore report the
   * depreciation twice, once as a source and once as a smaller use, and the statement would fail
   * to balance by exactly the depreciation. Adding it back here restores the gross figure, which
   * is what was actually spent.
   */
  const capitalExpenditure = (prev: Map<string, number>, curr: Map<string, number>): number =>
    nonCurrentAssets(curr) - nonCurrentAssets(prev) + d(curr, 'ii_depreciation')
  const pos = (n: number): number => Math.max(0, n)

  const sourcesTotal = (p: Map<string, number>, c: Map<string, number>): number =>
    pos(d(c, 'ii_pat')) + d(c, 'ii_depreciation') + pos(freshCapital(p, c)) + pos(delta(p, c, 'iii_ttl')) + pos(-capitalExpenditure(p, c))
  const usesTotal = (p: Map<string, number>, c: Map<string, number>): number =>
    pos(-d(c, 'ii_pat')) + d(c, 'ii_drawings') + pos(-freshCapital(p, c)) + pos(-delta(p, c, 'iii_ttl')) + pos(capitalExpenditure(p, c))
  const sources: CmaFundFlowLine[] = [
    line('vi_s_pat', 'Net profit after tax', (_p, c) => pos(d(c, 'ii_pat'))),
    line('vi_s_depreciation', 'Depreciation', (_p, c) => d(c, 'ii_depreciation')),
    line('vi_s_capital', 'Capital introduced', (p, c) => pos(freshCapital(p, c))),
    line('vi_s_term', 'Increase in term liabilities', (p, c) => pos(delta(p, c, 'iii_ttl'))),
    line('vi_s_nca', 'Sale of fixed assets and investments', (p, c) => pos(-capitalExpenditure(p, c))),
    line('vi_s_total', 'Total sources', (p, c) => sourcesTotal(p, c), true)
  ]

  const uses: CmaFundFlowLine[] = [
    line('vi_u_loss', 'Net loss', (_p, c) => pos(-d(c, 'ii_pat'))),
    line('vi_u_drawings', 'Dividend / withdrawals', (_p, c) => d(c, 'ii_drawings')),
    line('vi_u_capital', 'Capital withdrawn', (p, c) => pos(-freshCapital(p, c))),
    line('vi_u_term', 'Decrease in term liabilities', (p, c) => pos(-delta(p, c, 'iii_ttl'))),
    line('vi_u_nca', 'Capital expenditure on fixed assets and investments', (p, c) => pos(capitalExpenditure(p, c))),
    line('vi_u_total', 'Total uses', (p, c) => usesTotal(p, c), true)
  ]

  const wcg = (m: Map<string, number>): number => d(m, 'iii_tca') - (d(m, 'iii_tcl') - d(m, 'iii_bank_borrowing'))

  const summary: CmaFundFlowLine[] = [
    line('vi_long_term_surplus', 'Long-term surplus / (deficit)', (p, c) => sourcesTotal(p, c) - usesTotal(p, c), true),
    line('vi_increase_tca', 'Increase / (decrease) in current assets', (p, c) => delta(p, c, 'iii_tca')),
    line('vi_increase_ocl', 'Increase / (decrease) in current liabilities other than bank borrowing', (p, c) => (d(c, 'iii_tcl') - d(c, 'iii_bank_borrowing')) - (d(p, 'iii_tcl') - d(p, 'iii_bank_borrowing'))),
    line('vi_increase_wcg', 'Increase / (decrease) in working capital gap', (p, c) => wcg(c) - wcg(p), true),
    line('vi_net_surplus', 'Net surplus / (deficit)', (p, c) => sourcesTotal(p, c) - usesTotal(p, c) - (wcg(c) - wcg(p)), true),
    line('vi_bank_borrowing', 'Increase / (decrease) in bank borrowing', (p, c) => delta(p, c, 'iii_bank_borrowing'), true)
  ]

  return { columns, sources, uses, summary }
}

// ---------- ratios ----------

export interface CmaRatioRow {
  key: string
  label: string
  /** How to read it — a banker's convention, not a value judgement about this borrower. */
  note: string
  /** One per column; null where the denominator is nil. */
  values: (number | null)[]
  /** 'x' for a plain multiple, 'days' for a holding period, '%' for a percentage. */
  unit: 'x' | 'days' | '%'
}

function buildRatios(resolved: ResolvedColumn[]): CmaRatioRow[] {
  const per = (calc: (v: Map<string, number>) => number | null): (number | null)[] =>
    resolved.map((r) => (r.column.state === 'empty' ? null : calc(r.values)))
  const g = (v: Map<string, number>, k: string): number => v.get(k) ?? 0
  const ratio = (num: number, den: number): number | null => (den === 0 ? null : round2(num / den))

  return [
    {
      key: 'current_ratio',
      label: 'Current ratio',
      note: 'Current assets ÷ current liabilities. Banks look for 1.33 under the second method of lending.',
      unit: 'x',
      values: per((v) => ratio(g(v, 'iii_tca'), g(v, 'iii_tcl')))
    },
    {
      key: 'tol_tnw',
      label: 'TOL / TNW',
      note: 'Total outside liabilities ÷ tangible net worth. Intangibles are struck out of net worth before dividing, which is what makes it tangible.',
      unit: 'x',
      values: per((v) => ratio(g(v, 'iii_tcl') + g(v, 'iii_ttl'), g(v, 'iii_net_worth') - g(v, 'iii_intangibles')))
    },
    {
      key: 'dscr',
      label: 'Debt service coverage',
      note: 'Profit after tax + depreciation + interest on term loans, over interest plus instalments falling due. Below 1 the year does not pay its own term debt.',
      unit: 'x',
      values: per((v) =>
        ratio(
          g(v, 'ii_pat') + g(v, 'ii_depreciation') + g(v, 'ds_term_interest'),
          g(v, 'ds_term_interest') + g(v, 'ds_term_instalments')
        )
      )
    },
    {
      key: 'inventory_turnover',
      label: 'Inventory turnover',
      note: 'Cost of sales ÷ closing inventory, in times a year.',
      unit: 'x',
      values: per((v) => ratio(g(v, 'ii_cost_of_sales'), g(v, 'iii_inventory')))
    },
    {
      key: 'inventory_days',
      label: 'Inventory holding',
      note: 'The same figure said in days.',
      unit: 'days',
      values: per((v) => {
        const cos = g(v, 'ii_cost_of_sales')
        return cos <= 0 ? null : round2((g(v, 'iii_inventory') / cos) * 365)
      })
    },
    {
      key: 'receivable_turnover',
      label: 'Receivable turnover',
      note: 'Net sales ÷ receivables, in times a year.',
      unit: 'x',
      values: per((v) => ratio(g(v, 'ii_net_sales_total'), g(v, 'iii_receivables_6m') + g(v, 'iii_receivables_over_6m')))
    },
    {
      key: 'receivable_days',
      label: 'Receivable collection',
      note: 'The same figure said in days.',
      unit: 'days',
      values: per((v) => {
        const sales = g(v, 'ii_net_sales_total')
        return sales <= 0 ? null : round2(((g(v, 'iii_receivables_6m') + g(v, 'iii_receivables_over_6m')) / sales) * 365)
      })
    },
    {
      key: 'net_margin',
      label: 'Net profit margin',
      note: 'Profit after tax as a percentage of net sales.',
      unit: '%',
      values: per((v) => {
        const sales = g(v, 'ii_net_sales_total')
        return sales === 0 ? null : round2((g(v, 'ii_pat') / sales) * 100)
      })
    }
  ]
}

/** Re-exported so a caller can put the CMA ratios beside the app's own ratio panel. */
export type { RatioPanel }

// ---------- Form I ----------

/**
 * Form I is the only form that is not arithmetic at all: it is a list of the facilities the bank
 * already gives and the ones being asked for. The outstanding against a facility can come from
 * the books when the user points it at a ledger — everything else is theirs to state.
 */
export interface CmaFacility {
  id: number
  seq: number
  facility: string
  existingLimitPaise: number
  /** Null when no ledger is linked; otherwise read from the books, not typed. */
  outstandingPaise: number | null
  outstandingFromBooks: boolean
  proposedLimitPaise: number
  security: string | null
  ledgerId: number | null
  ledgerName: string | null
  notes: string | null
}

export function facilityTotals(rows: CmaFacility[]): {
  existingLimitPaise: number
  outstandingPaise: number
  proposedLimitPaise: number
} {
  return {
    existingLimitPaise: rows.reduce((s, r) => s + r.existingLimitPaise, 0),
    outstandingPaise: rows.reduce((s, r) => s + (r.outstandingPaise ?? 0), 0),
    proposedLimitPaise: rows.reduce((s, r) => s + r.proposedLimitPaise, 0)
  }
}

// ---------- classifying a chart of accounts into CMA buckets ----------

/**
 * Which Form II line an expense ledger belongs on.
 *
 * The buckets are EXHAUSTIVE, which is the whole design: a ledger nobody anticipated falls into
 * `otherIndirectExpenses` rather than being dropped. That is what makes Form II's profit before
 * tax tie, to the paisa, to the profit in the audited accounts attached to the same loan
 * application — and a CMA pack whose bottom line disagrees with the accounts beside it is the one
 * thing guaranteed to get the file sent back.
 *
 * The name patterns are a convenience, not a contract. They exist because a chart of accounts in
 * this market puts "Depreciation" and "Interest on Term Loan" under Indirect Expenses along with
 * everything else, and a credit officer reading Form II expects to see them on their own lines.
 * When a pattern misses, the amount is still counted; it is just counted one line lower down.
 */
export type CmaExpenseBucket =
  | 'rawMaterials'
  | 'directWages'
  | 'powerAndFuel'
  | 'otherManufacturingExpenses'
  | 'depreciation'
  | 'sellingExpenses'
  | 'administrativeExpenses'
  | 'otherIndirectExpenses'
  | 'interest'
  | 'taxProvision'

const DEPRECIATION = /depreciat|amortis|amortiz/i
const INTEREST = /interest|bank charge|processing fee|loan charge/i
const TAX_PROVISION = /income[\s-]?tax|provision for tax|corporate tax/i
const WAGES = /wage|labour|labor|contract staff|piece ?rate|bonus|gratuity|pf |esic?\b/i
const POWER = /power|fuel|electric|diesel|furnace oil|\bgas\b|water charge/i
const SELLING = /sell|market|advert|publicity|commission|brokerage|freight out|outward|carriage out|distribut|discount allowed|sales promo/i
const ADMIN = /salar|rent\b|office|admin|legal|professional|audit|telephone|internet|insurance|stationery|printing|travel|conveyance|repair|postage|subscription|security charge|housekeep/i

/**
 * @param topGroupName the ROOT group the ledger hangs under — 'Indirect Expenses', not the
 *        sub-group the user created beneath it.
 */
export function classifyExpenseLedger(topGroupName: string, ledgerName: string): CmaExpenseBucket {
  // These three are read off the name before the group, because a chart of accounts almost always
  // files them under Indirect Expenses and Form II wants them called out.
  if (DEPRECIATION.test(ledgerName)) return 'depreciation'
  if (TAX_PROVISION.test(ledgerName)) return 'taxProvision'
  if (INTEREST.test(ledgerName)) return 'interest'

  if (topGroupName === 'Purchase Accounts') return 'rawMaterials'
  if (topGroupName === 'Direct Expenses') {
    if (WAGES.test(ledgerName)) return 'directWages'
    if (POWER.test(ledgerName)) return 'powerAndFuel'
    return 'otherManufacturingExpenses'
  }
  if (SELLING.test(ledgerName)) return 'sellingExpenses'
  if (ADMIN.test(ledgerName)) return 'administrativeExpenses'
  return 'otherIndirectExpenses'
}

export type CmaIncomeBucket = 'netSales' | 'otherOperatingIncome' | 'otherIncome'

export function classifyIncomeLedger(topGroupName: string): CmaIncomeBucket {
  if (topGroupName === 'Sales Accounts') return 'netSales'
  if (topGroupName === 'Direct Incomes') return 'otherOperatingIncome'
  return 'otherIncome'
}
