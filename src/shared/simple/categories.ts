// Simple-mode account categories (WP 8.3, plan 2026-10-13 §4.1). Pure data.
//
// A category is what a simple screen calls an account ("Rent", "Sales", "Owner's money"). Each
// seeded account carries its category key in `ledgers.simple_category` (nullable, migration
// "simple_category"; never read by any report — reports keep working off groups and lines). The
// key gives simple screens a stable handle that survives a rename, and its `cls` must agree with
// the WP 5.6 ledger classifier (`src/main/ai/ledgerClass.ts`) so memory checks and drafting
// treat a seeded account the same way the simple screens do (unit + db tested).
//
// `group` is the standard (Tally) group the account sits under — a CA review of this mapping is
// an owner item before 1.0 (plan §9).

/** What the WP 5.6 classifier must say about an account of this category. */
export type CategoryClass = 'income' | 'expense' | 'tax' | 'other'

/** Where a simple screen offers the category. */
export type CategoryUse = 'sale' | 'purchase' | 'expense' | 'income' | 'owner' | 'tax' | 'system'

export interface CategoryDef {
  /** Ledger name it is seeded with (plain words; the accountant view shows the same name). */
  name: string
  /** Standard group it sits under (one of DEFAULT_GROUPS). */
  group: string
  cls: CategoryClass
  use: CategoryUse
  /** Icon id for the category picker (WP 8.4 renders it). */
  icon: string
  /** GST component for a tax account (Duties & Taxes), else absent. */
  taxType?: 'cgst' | 'sgst' | 'igst'
}

export const CATEGORIES = {
  // ---------- what you sell ----------
  sales: { name: 'Sales', group: 'Sales Accounts', cls: 'income', use: 'sale', icon: 'cart' },
  service_income: { name: 'Service income', group: 'Sales Accounts', cls: 'income', use: 'sale', icon: 'briefcase' },
  // ---------- what you buy to sell or make ----------
  purchases: { name: 'Purchases', group: 'Purchase Accounts', cls: 'expense', use: 'purchase', icon: 'box' },
  raw_material: { name: 'Raw material purchases', group: 'Purchase Accounts', cls: 'expense', use: 'purchase', icon: 'layers' },
  freight_inward: { name: 'Freight inward', group: 'Direct Expenses', cls: 'expense', use: 'expense', icon: 'truck' },
  labour: { name: 'Labour charges', group: 'Direct Expenses', cls: 'expense', use: 'expense', icon: 'hammer' },
  factory_power: { name: 'Factory power', group: 'Direct Expenses', cls: 'expense', use: 'expense', icon: 'bolt' },
  gas: { name: 'Gas & fuel', group: 'Direct Expenses', cls: 'expense', use: 'expense', icon: 'flame' },
  kitchen_supplies: { name: 'Kitchen supplies', group: 'Direct Expenses', cls: 'expense', use: 'expense', icon: 'utensils' },
  // ---------- day-to-day costs ----------
  rent: { name: 'Rent', group: 'Indirect Expenses', cls: 'expense', use: 'expense', icon: 'home' },
  electricity: { name: 'Electricity', group: 'Indirect Expenses', cls: 'expense', use: 'expense', icon: 'bolt' },
  salary: { name: 'Salary & wages', group: 'Indirect Expenses', cls: 'expense', use: 'expense', icon: 'users' },
  transport: { name: 'Transport', group: 'Indirect Expenses', cls: 'expense', use: 'expense', icon: 'truck' },
  phone_internet: { name: 'Phone & internet', group: 'Indirect Expenses', cls: 'expense', use: 'expense', icon: 'phone' },
  bank_charges: { name: 'Bank charges', group: 'Indirect Expenses', cls: 'expense', use: 'expense', icon: 'bank' },
  repairs: { name: 'Repairs', group: 'Indirect Expenses', cls: 'expense', use: 'expense', icon: 'wrench' },
  office: { name: 'Office expenses', group: 'Indirect Expenses', cls: 'expense', use: 'expense', icon: 'paperclip' },
  packing: { name: 'Packing', group: 'Indirect Expenses', cls: 'expense', use: 'expense', icon: 'package' },
  shop_expenses: { name: 'Shop expenses', group: 'Indirect Expenses', cls: 'expense', use: 'expense', icon: 'shop' },
  commission_paid: { name: 'Commission paid', group: 'Indirect Expenses', cls: 'expense', use: 'expense', icon: 'percent' },
  software: { name: 'Software & subscriptions', group: 'Indirect Expenses', cls: 'expense', use: 'expense', icon: 'laptop' },
  travel: { name: 'Travel', group: 'Indirect Expenses', cls: 'expense', use: 'expense', icon: 'plane' },
  professional_fees: { name: 'Professional fees', group: 'Indirect Expenses', cls: 'expense', use: 'expense', icon: 'scale' },
  delivery_commission: { name: 'Delivery app commission', group: 'Indirect Expenses', cls: 'expense', use: 'expense', icon: 'bike' },
  discount_given: { name: 'Discount given', group: 'Indirect Expenses', cls: 'expense', use: 'expense', icon: 'tag' },
  // ---------- other income ----------
  discount_received: { name: 'Discount received', group: 'Indirect Incomes', cls: 'income', use: 'income', icon: 'tag' },
  // WP 9.6: the simple Bank screen's "Interest from the bank" (never seeded by a preset).
  interest_received: { name: 'Interest received', group: 'Indirect Incomes', cls: 'income', use: 'income', icon: 'percent' },
  // ---------- the owner ----------
  owner_capital: { name: "Owner's money", group: 'Capital Account', cls: 'other', use: 'owner', icon: 'wallet' },
  owner_drawings: { name: "Owner's drawings", group: 'Capital Account', cls: 'other', use: 'owner', icon: 'wallet' },
  // ---------- what you owe ----------
  wages_payable: { name: 'Wages payable', group: 'Current Liabilities', cls: 'other', use: 'system', icon: 'clock' },
  // ---------- bills: rounding (the invoice editor finds "Round Off" by name) ----------
  round_off: { name: 'Round Off', group: 'Indirect Expenses', cls: 'other', use: 'system', icon: 'dot' },
  // ---------- GST (regular registration only — §4.2) ----------
  gst_output_cgst: { name: 'Output CGST', group: 'Duties & Taxes', cls: 'tax', use: 'tax', icon: 'receipt', taxType: 'cgst' },
  gst_output_sgst: { name: 'Output SGST', group: 'Duties & Taxes', cls: 'tax', use: 'tax', icon: 'receipt', taxType: 'sgst' },
  gst_output_igst: { name: 'Output IGST', group: 'Duties & Taxes', cls: 'tax', use: 'tax', icon: 'receipt', taxType: 'igst' },
  gst_input_cgst: { name: 'Input CGST', group: 'Duties & Taxes', cls: 'tax', use: 'tax', icon: 'receipt', taxType: 'cgst' },
  gst_input_sgst: { name: 'Input SGST', group: 'Duties & Taxes', cls: 'tax', use: 'tax', icon: 'receipt', taxType: 'sgst' },
  gst_input_igst: { name: 'Input IGST', group: 'Duties & Taxes', cls: 'tax', use: 'tax', icon: 'receipt', taxType: 'igst' }
} as const satisfies Record<string, CategoryDef>

export type CategoryKey = keyof typeof CATEGORIES
export const CATEGORY_KEYS = Object.keys(CATEGORIES) as CategoryKey[]

export function isCategoryKey(k: unknown): k is CategoryKey {
  return typeof k === 'string' && Object.prototype.hasOwnProperty.call(CATEGORIES, k)
}

/** The one question a NEW category asks (plan §4.1) → its group. */
export const NEW_CATEGORY_KINDS = ['day_to_day', 'stock_you_sell', 'use_for_years'] as const
export type NewCategoryKind = (typeof NEW_CATEGORY_KINDS)[number]

/** "Day-to-day cost" → Indirect Expenses; "Stock you sell" → Purchase Accounts (a manufacturer's
 *  making cost → Direct Expenses); "Something you'll use for years" → Fixed Assets. */
export function groupForNewCategory(kind: NewCategoryKind, opts: { makingCost?: boolean } = {}): string {
  if (kind === 'day_to_day') return 'Indirect Expenses'
  if (kind === 'stock_you_sell') return opts.makingCost ? 'Direct Expenses' : 'Purchase Accounts'
  return 'Fixed Assets'
}

/** The class a ledger under `nature` / with these tags gets from the WP 5.6 classifier — the pure
 *  half of ledgerClass.ts's rule order (cash / bank / party groups are never category groups). */
export function expectedClass(nature: 'asset' | 'liability' | 'income' | 'expense', name: string, taxType: string | null | undefined): CategoryClass {
  if (taxType) return 'tax'
  if (/^round\s*-?\s*off\b/i.test(name.trim())) return 'other'
  if (nature === 'income') return 'income'
  if (nature === 'expense') return 'expense'
  return 'other'
}
