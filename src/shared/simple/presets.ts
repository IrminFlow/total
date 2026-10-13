// Business presets for the setup wizard (WP 8.3, plan 2026-10-13 §4.1 / §4.3). Pure data.
//
// A preset says which accounts a new simple company starts with (category keys, see
// categories.ts), its units, whether stock is on by default and which modules stay off. The
// setup service (src/main/services/companySetup.ts) applies it through the masters services
// inside the create transaction; nothing here touches the accountant path — `seedCompany` and
// DEFAULT_FEATURES are unchanged, and a company with no `features` meta keeps today's defaults.
import { DEFAULT_FEATURES, type CompanyFeatures } from '../features'
import type { CategoryKey } from './categories'

export const BUSINESS_TYPES = ['retail', 'trader', 'services', 'manufacturer', 'restaurant', 'other'] as const
export type BusinessType = (typeof BUSINESS_TYPES)[number]

export function isBusinessType(v: unknown): v is BusinessType {
  return typeof v === 'string' && (BUSINESS_TYPES as readonly string[]).includes(v)
}

/** Units a preset may use beyond the seeded DEFAULT_UNITS (GST UQC "OTH" = others). */
export const EXTRA_UNITS = [{ name: 'Plates', symbol: 'Plate', decimals: 0, uqc: 'OTH' }] as const

export interface Preset {
  id: BusinessType
  /** The stock answer the wizard pre-selects (the user decides). */
  stockDefault: boolean
  /** Manufacturing (made goods) is visible — needs stock too. */
  manufacturing: boolean
  /** Accounts on top of BASE_ACCOUNTS. */
  extraAccounts: readonly CategoryKey[]
  /** Unit symbols; the first is the default for a new product. */
  units: readonly string[]
  /** The sale account a bill uses by default. */
  salesAccount: CategoryKey
  /** The Home task button that leads (WP 8.6). */
  homeTask: 'quickBill' | 'makeBill'
}

/** Every preset seeds these (plan §4.1): sales, purchases, the everyday costs, the owner,
 *  discounts and rounding. */
export const BASE_ACCOUNTS: readonly CategoryKey[] = [
  'sales', 'purchases', 'rent', 'electricity', 'salary', 'transport', 'phone_internet', 'bank_charges',
  'repairs', 'office', 'owner_capital', 'owner_drawings', 'discount_given', 'discount_received', 'round_off'
]

/** Regular GST registration only (§4.2): the tax accounts the bill calculation posts to. */
export const GST_ACCOUNTS: readonly CategoryKey[] = [
  'gst_output_cgst', 'gst_output_sgst', 'gst_output_igst', 'gst_input_cgst', 'gst_input_sgst', 'gst_input_igst'
]

export const PRESETS: Record<BusinessType, Preset> = {
  retail: {
    id: 'retail', stockDefault: true, manufacturing: false,
    extraAccounts: ['shop_expenses', 'packing'], units: ['Pcs', 'Kg'], salesAccount: 'sales', homeTask: 'quickBill'
  },
  trader: {
    id: 'trader', stockDefault: true, manufacturing: false,
    extraAccounts: ['freight_inward', 'commission_paid'], units: ['Pcs', 'Kg'], salesAccount: 'sales', homeTask: 'makeBill'
  },
  services: {
    id: 'services', stockDefault: false, manufacturing: false,
    extraAccounts: ['service_income', 'software', 'travel', 'professional_fees'], units: ['Nos'], salesAccount: 'service_income', homeTask: 'makeBill'
  },
  manufacturer: {
    id: 'manufacturer', stockDefault: true, manufacturing: true,
    extraAccounts: ['labour', 'wages_payable', 'factory_power', 'raw_material'], units: ['Pcs', 'Kg'], salesAccount: 'sales', homeTask: 'makeBill'
  },
  restaurant: {
    id: 'restaurant', stockDefault: false, manufacturing: false,
    extraAccounts: ['kitchen_supplies', 'gas', 'delivery_commission'], units: ['Plate', 'Nos'], salesAccount: 'sales', homeTask: 'quickBill'
  },
  other: {
    id: 'other', stockDefault: false, manufacturing: false,
    extraAccounts: [], units: ['Nos'], salesAccount: 'sales', homeTask: 'makeBill'
  }
}

/** The accounts a new company of this type starts with, in seeding order (no duplicates). */
export function presetAccounts(type: BusinessType, chargesGst: boolean): CategoryKey[] {
  const p = PRESETS[type]
  const keys = [...BASE_ACCOUNTS, ...p.extraAccounts, ...(chargesGst ? GST_ACCOUNTS : [])]
  return [...new Set(keys)]
}

/** The modules a NEW simple company has (§4.3), written explicitly at setup: TDS, TCS, payroll,
 *  cost centres, multi-currency and orders off; manufacturing only for a manufacturer that keeps
 *  stock; stock as answered; bill-wise on. Everything else stays at DEFAULT_FEATURES. */
export function presetFeatures(type: BusinessType, stock: boolean): CompanyFeatures {
  return {
    ...DEFAULT_FEATURES,
    inventory: stock,
    billWise: true,
    costCentres: false,
    tds: false,
    tcs: false,
    multiCurrency: false,
    payroll: false,
    orders: false,
    manufacturing: stock && PRESETS[type].manufacturing
  }
}

/** The modules setup switches off, for the Settings → Features "Turn on" cards. */
export const MODULES_OFF_AT_SETUP = ['tds', 'tcs', 'payroll', 'costCentres', 'multiCurrency', 'orders', 'manufacturing'] as const
