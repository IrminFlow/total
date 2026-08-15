import type { Nature, VoucherKind } from './domain'

export interface SeedGroup {
  name: string
  parent: string | null
  nature: Nature
  affectsGrossProfit: boolean
}

/** Tally Prime's 28 default account groups, verbatim names for muscle memory. */
export const DEFAULT_GROUPS: SeedGroup[] = [
  // Primary — Balance Sheet
  { name: 'Capital Account', parent: null, nature: 'liability', affectsGrossProfit: false },
  { name: 'Reserves & Surplus', parent: 'Capital Account', nature: 'liability', affectsGrossProfit: false },
  { name: 'Loans (Liability)', parent: null, nature: 'liability', affectsGrossProfit: false },
  { name: 'Bank OD A/c', parent: 'Loans (Liability)', nature: 'liability', affectsGrossProfit: false },
  { name: 'Secured Loans', parent: 'Loans (Liability)', nature: 'liability', affectsGrossProfit: false },
  { name: 'Unsecured Loans', parent: 'Loans (Liability)', nature: 'liability', affectsGrossProfit: false },
  { name: 'Current Liabilities', parent: null, nature: 'liability', affectsGrossProfit: false },
  { name: 'Duties & Taxes', parent: 'Current Liabilities', nature: 'liability', affectsGrossProfit: false },
  { name: 'Provisions', parent: 'Current Liabilities', nature: 'liability', affectsGrossProfit: false },
  { name: 'Sundry Creditors', parent: 'Current Liabilities', nature: 'liability', affectsGrossProfit: false },
  { name: 'Fixed Assets', parent: null, nature: 'asset', affectsGrossProfit: false },
  { name: 'Investments', parent: null, nature: 'asset', affectsGrossProfit: false },
  { name: 'Current Assets', parent: null, nature: 'asset', affectsGrossProfit: false },
  { name: 'Bank Accounts', parent: 'Current Assets', nature: 'asset', affectsGrossProfit: false },
  { name: 'Cash-in-Hand', parent: 'Current Assets', nature: 'asset', affectsGrossProfit: false },
  { name: 'Deposits (Asset)', parent: 'Current Assets', nature: 'asset', affectsGrossProfit: false },
  { name: 'Loans & Advances (Asset)', parent: 'Current Assets', nature: 'asset', affectsGrossProfit: false },
  { name: 'Stock-in-Hand', parent: 'Current Assets', nature: 'asset', affectsGrossProfit: false },
  { name: 'Sundry Debtors', parent: 'Current Assets', nature: 'asset', affectsGrossProfit: false },
  { name: 'Branch / Divisions', parent: null, nature: 'liability', affectsGrossProfit: false },
  { name: 'Misc. Expenses (ASSET)', parent: null, nature: 'asset', affectsGrossProfit: false },
  { name: 'Suspense A/c', parent: null, nature: 'liability', affectsGrossProfit: false },
  // Primary — Profit & Loss
  { name: 'Sales Accounts', parent: null, nature: 'income', affectsGrossProfit: true },
  { name: 'Purchase Accounts', parent: null, nature: 'expense', affectsGrossProfit: true },
  { name: 'Direct Incomes', parent: null, nature: 'income', affectsGrossProfit: true },
  { name: 'Direct Expenses', parent: null, nature: 'expense', affectsGrossProfit: true },
  { name: 'Indirect Incomes', parent: null, nature: 'income', affectsGrossProfit: false },
  { name: 'Indirect Expenses', parent: null, nature: 'expense', affectsGrossProfit: false }
]

/** Groups whose ledgers count as cash/bank for contra/payment/receipt rules. */
export const CASH_BANK_GROUPS = ['Cash-in-Hand', 'Bank Accounts', 'Bank OD A/c']

export interface SeedVoucherType {
  name: string
  kind: VoucherKind
}

export const DEFAULT_VOUCHER_TYPES: SeedVoucherType[] = [
  { name: 'Contra', kind: 'contra' },
  { name: 'Payment', kind: 'payment' },
  { name: 'Receipt', kind: 'receipt' },
  { name: 'Journal', kind: 'journal' },
  { name: 'Sales', kind: 'sales' },
  { name: 'Purchase', kind: 'purchase' },
  { name: 'Credit Note', kind: 'credit_note' },
  { name: 'Debit Note', kind: 'debit_note' },
  { name: 'Stock Journal', kind: 'stock_journal' },
  { name: 'Physical Stock', kind: 'physical_stock' }
]

/** Common GST rate presets offered in pickers; any rate is accepted. */
export const GST_RATE_PRESETS = [0, 0.25, 3, 5, 12, 18, 28, 40]

/** Default units seeded into new companies (GST UQC codes). */
export const DEFAULT_UNITS = [
  { name: 'Numbers', symbol: 'Nos', decimals: 0, uqc: 'NOS' },
  { name: 'Pieces', symbol: 'Pcs', decimals: 0, uqc: 'PCS' },
  { name: 'Kilograms', symbol: 'Kg', decimals: 3, uqc: 'KGS' },
  { name: 'Litres', symbol: 'L', decimals: 3, uqc: 'LTR' },
  { name: 'Metres', symbol: 'm', decimals: 2, uqc: 'MTR' },
  { name: 'Boxes', symbol: 'Box', decimals: 0, uqc: 'BOX' }
]
