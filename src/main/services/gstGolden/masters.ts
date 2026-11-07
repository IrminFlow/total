// GST golden fixtures (Phase 2a) — the masters every fixture company is built from.
// Plain data: gstGolden.dbtest.ts creates them through the masters services (createLedger /
// createStockItem) on a freshly seeded company, one company per fixture.
//
// GSTINs carry a valid check character (computed with the GSTN mod-36 algorithm, the same one
// shared/gst/validate.ts checks) and their first two digits equal the party's state code.

import type { CompanyInfo } from '@shared/domain'

export type CompanyKey = 'regular' | 'composition' | 'unregistered'

const BASE: CompanyInfo = {
  name: 'Golden Traders',
  stateCode: '27', // Maharashtra
  gstin: '27AAPFU0939F1ZV',
  gstRegistrationType: 'regular',
  address: '12 MG Road, Pune 411001',
  booksFrom: 2024, // FY 2024-25 — the B2CL limit fixtures sit either side of 1 Aug 2024
  email: null,
  phone: null,
  pan: null,
  tan: null
}

export const COMPANIES: Record<CompanyKey, CompanyInfo> = {
  regular: BASE,
  composition: { ...BASE, name: 'Golden Composition', gstRegistrationType: 'composition' },
  unregistered: { ...BASE, name: 'Golden Small Shop', gstRegistrationType: 'unregistered', gstin: null }
}

export type GroupName =
  | 'Sundry Debtors' | 'Sundry Creditors' | 'Sales Accounts' | 'Purchase Accounts' | 'Duties & Taxes'
  | 'Direct Expenses' | 'Indirect Expenses' | 'Bank Accounts'

export interface LedgerSpec {
  name: string
  group: GroupName
  gstin?: string
  stateCode?: string
  address?: string
  taxType?: 'cgst' | 'sgst' | 'igst' | 'cess'
  gstRate?: number
  cessRate?: number
  hsn?: string
  exportType?: 'sez_wp' | 'sez_wop' | 'exp_wp' | 'exp_wop'
  rcm?: boolean
  itcEligibility?: 'eligible' | 'blocked'
}

export const PARTIES = {
  // Customers
  regMH: { name: 'Umbrella Retail', group: 'Sundry Debtors', gstin: '27AABCD1234E1Z8', stateCode: '27', address: 'Shop 4, Linking Road, Mumbai 400050' },
  regKA: { name: 'Krishna Enterprises', group: 'Sundry Debtors', gstin: '29AABCF9012G1ZQ', stateCode: '29', address: '5 Brigade Road, Bengaluru 560001' },
  urMH: { name: 'Ramesh Kumar', group: 'Sundry Debtors', stateCode: '27', address: 'Kothrud, Pune 411038' },
  urKA: { name: 'Suresh Rao', group: 'Sundry Debtors', stateCode: '29', address: 'Jayanagar, Bengaluru 560041' },
  urTN: { name: 'Chennai Walk-in', group: 'Sundry Debtors', stateCode: '33', address: 'T Nagar, Chennai 600017' },
  sezMH: { name: 'Pune SEZ Unit', group: 'Sundry Debtors', gstin: '27AABCS7777K1ZO', stateCode: '27', exportType: 'sez_wp', address: 'Plot 1, Hinjewadi SEZ, Pune 411057' },
  sezKA: { name: 'Bengaluru SEZ Unit', group: 'Sundry Debtors', gstin: '29AABCS8888L1ZC', stateCode: '29', exportType: 'sez_wp', address: 'Electronic City SEZ, Bengaluru 560100' },
  sezDL: { name: 'Delhi SEZ Unit', group: 'Sundry Debtors', gstin: '07AABCK4444Q1Z4', stateCode: '07', exportType: 'sez_wop', address: 'Noida Road SEZ, New Delhi 110020' },
  expWP: { name: 'Acme Imports Inc', group: 'Sundry Debtors', stateCode: '96', exportType: 'exp_wp', address: '500 Fifth Avenue, New York' },
  expWOP: { name: 'Global Handel GmbH', group: 'Sundry Debtors', stateCode: '96', exportType: 'exp_wop', address: 'Hafenstrasse 9, Hamburg' },
  // A customer whose ledger carries a GST rate — what GSTR-1 Table 11A / 11B needs to classify an advance.
  advMH: { name: 'Prepaid Clinic', group: 'Sundry Debtors', gstin: '27AABCR2222N1ZD', stateCode: '27', gstRate: 18, address: 'Baner, Pune 411045' },
  // Suppliers
  vendorMH: { name: 'Bharat Steel', group: 'Sundry Creditors', gstin: '27AABCG3456H1ZN', stateCode: '27', address: 'Bhosari MIDC, Pune 411026' },
  vendorGJ: { name: 'Gujarat Polymers', group: 'Sundry Creditors', gstin: '24AABCT1111M1ZP', stateCode: '24', address: 'GIDC Vapi 396195' },
  importer: { name: 'Shenzhen Parts Co', group: 'Sundry Creditors', stateCode: '96', address: 'Shenzhen' },
  caterer: { name: 'Annapurna Caterers', group: 'Sundry Creditors', gstin: '33AABCV3333P1Z6', stateCode: '33', itcEligibility: 'blocked', address: 'Anna Salai, Chennai 600002' },
  gta: { name: 'Sharma Transport', group: 'Sundry Creditors', stateCode: '27', rcm: true, address: 'Hadapsar, Pune 411028' },
  gtaGJ: { name: 'Vapi Roadlines', group: 'Sundry Creditors', stateCode: '24', rcm: true, address: 'Vapi 396191' },
  lawyer: { name: 'Advocate Mehta', group: 'Sundry Creditors', stateCode: '27', rcm: true, address: 'Shivajinagar, Pune 411005' }
} satisfies Record<string, LedgerSpec>

export type PartyKey = keyof typeof PARTIES

export const LEDGERS = {
  sales: { name: 'Sales', group: 'Sales Accounts' }, // no rate: the posted-tax rate rule applies
  serviceIncome: { name: 'Service Income', group: 'Sales Accounts', hsn: '998313' }, // no rate, a SAC
  consulting: { name: 'Consulting Fees', group: 'Sales Accounts', gstRate: 18, hsn: '998311' },
  purchases: { name: 'Purchases', group: 'Purchase Accounts' },
  freight: { name: 'Freight Inward', group: 'Direct Expenses', gstRate: 5, hsn: '996511' },
  legal: { name: 'Legal Fees', group: 'Indirect Expenses', gstRate: 18, hsn: '998211' },
  cgstOut: { name: 'CGST Output', group: 'Duties & Taxes', taxType: 'cgst' },
  sgstOut: { name: 'SGST Output', group: 'Duties & Taxes', taxType: 'sgst' },
  igstOut: { name: 'IGST Output', group: 'Duties & Taxes', taxType: 'igst' },
  cessOut: { name: 'Cess Output', group: 'Duties & Taxes', taxType: 'cess' },
  cgstIn: { name: 'CGST Input', group: 'Duties & Taxes', taxType: 'cgst' },
  sgstIn: { name: 'SGST Input', group: 'Duties & Taxes', taxType: 'sgst' },
  igstIn: { name: 'IGST Input', group: 'Duties & Taxes', taxType: 'igst' },
  cessIn: { name: 'Cess Input', group: 'Duties & Taxes', taxType: 'cess' },
  roundOff: { name: 'Round Off', group: 'Indirect Expenses' },
  bank: { name: 'HDFC Bank', group: 'Bank Accounts' }
} satisfies Record<string, LedgerSpec>

export type LedgerKey = keyof typeof LEDGERS

export interface ItemSpec {
  name: string
  unit: 'Nos' | 'Pcs' | 'Kg' | 'L'
  /** The unit's UQC as seeded (shared/seed.ts DEFAULT_UNITS). */
  uqc: 'NOS' | 'PCS' | 'KGS' | 'LTR'
  hsn: string
  gstRate: number
  cessRate?: number
}

// Rates as they stood before the 22 Sep 2025 rate change (Notification 9/2025-CT(Rate)): every
// fixture that uses the 12 % / 28 % + cess items is dated before it.
export const ITEMS = {
  widget: { name: 'Steel Widget', unit: 'Nos', uqc: 'NOS', hsn: '7326', gstRate: 18 },
  rice: { name: 'Basmati Rice', unit: 'Kg', uqc: 'KGS', hsn: '1006', gstRate: 5 },
  cola: { name: 'Cola 300ml', unit: 'Nos', uqc: 'NOS', hsn: '2202', gstRate: 28, cessRate: 12 },
  milk: { name: 'Fresh Milk', unit: 'L', uqc: 'LTR', hsn: '0401', gstRate: 0 },
  gold: { name: 'Gold Chain', unit: 'Nos', uqc: 'NOS', hsn: '7113', gstRate: 3 },
  shirt: { name: 'Cotton Shirt', unit: 'Pcs', uqc: 'PCS', hsn: '6205', gstRate: 12 },
  cement: { name: 'Cement Bag', unit: 'Nos', uqc: 'NOS', hsn: '2523', gstRate: 28 }
} satisfies Record<string, ItemSpec>

export type ItemKey = keyof typeof ITEMS
