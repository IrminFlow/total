/**
 * Deterministic "sample data" for the demo company: a fixed set of masters plus a generator that
 * builds ~40 balanced vouchers spanning the trailing 3 months (clamped to the FY start). Pure —
 * no DB, no Electron. src/main/services/demo.ts turns this neutral shape into real ledgers/items/
 * vouchers via the same masters/vouchers services every other screen uses.
 *
 * There are three of them (roadmap #293), because "Demo Traders" only ever showed one kind of
 * book. A manufacturer opening the sample saw no bill of materials and no work in progress and
 * concluded the app could not do either; a services firm saw six stock items it would never have
 * and concluded the opposite — that it would have to switch inventory off and fight the app.
 * Neither of them was true, and both were the sample's fault.
 *
 * The trading profile below is exactly what it always was, deliberately: it is what
 * `createDemoCompany()` still builds by default, and what every existing scenario and screenshot
 * script expects to find.
 */
import type { CompanyInfo, VoucherKind } from './domain'
import { fyOf, todayISO } from './dates'
import { computeGst, supplyTypeFor, type SupplyType } from './gst/calc'

// ---------- company ----------

export const DEMO_COMPANY: CompanyInfo = {
  name: 'Demo Traders',
  stateCode: '27',
  gstin: '27AAPFU0939F1ZV',
  gstRegistrationType: 'regular',
  gstFilingFrequency: 'monthly',
  // Under the e-invoice and QRMP lines, so the demo exercises the ordinary small-business path.
  turnoverBand: '1.5Cr-5Cr',
  address: '12 MG Road, Pune 411001',
  booksFrom: fyOf(todayISO()).startYear,
  email: 'accounts@demotraders.test',
  phone: '9822000000',
  pan: 'AAPFU0939F',
  tan: null
}

// ---------- parties ----------

export interface DemoParty {
  name: string
  kind: 'debtor' | 'creditor'
  gstin: string
  stateCode: string
  address: string
}

/** 3 debtors across 2 states (2 intra-state, 1 inter-state — exercises both CGST+SGST and IGST)
 *  plus 2 creditors (1 intra, 1 inter), so purchases exercise both tax paths too. */
export const DEMO_PARTIES: DemoParty[] = [
  { name: 'Umbrella Retail', kind: 'debtor', gstin: '27AABCD1234E1Z8', stateCode: '27', address: 'Shop 4, FC Road, Pune 411004' },
  { name: 'Silverline Traders', kind: 'debtor', gstin: '27AABCE5678F1ZH', stateCode: '27', address: 'MIDC, Pune 411019' },
  { name: 'Krishna Enterprises', kind: 'debtor', gstin: '29AABCF9012G1ZQ', stateCode: '29', address: 'Indiranagar, Bengaluru 560038' },
  { name: 'Bharat Steel Suppliers', kind: 'creditor', gstin: '27AABCG3456H1ZN', stateCode: '27', address: 'MIDC Bhosari, Pune 411026' },
  { name: 'Gujarat Components Pvt Ltd', kind: 'creditor', gstin: '24AABCH7890I1ZB', stateCode: '24', address: 'GIDC Vatva, Ahmedabad 382445' }
]

export const DEMO_DEBTORS: DemoParty[] = DEMO_PARTIES.filter((p) => p.kind === 'debtor')
export const DEMO_CREDITORS: DemoParty[] = DEMO_PARTIES.filter((p) => p.kind === 'creditor')

// ---------- stock items ----------

export interface DemoItem {
  name: string
  hsn: string
  gstRate: number
  /** Name of one of the default seeded units (src/shared/seed.ts#DEFAULT_UNITS). */
  unitName: string
  saleRatePaise: number
  costRatePaise: number
}

/** 6 items, HSN-coded, spanning the common 5/12/18% GST rate bands. */
export const DEMO_ITEMS: DemoItem[] = [
  { name: 'Laptop 14"', hsn: '8471', gstRate: 18, unitName: 'Numbers', saleRatePaise: 4500000, costRatePaise: 4000000 },
  { name: 'Wireless Mouse', hsn: '8471', gstRate: 18, unitName: 'Numbers', saleRatePaise: 80000, costRatePaise: 60000 },
  { name: 'Office Chair', hsn: '9401', gstRate: 18, unitName: 'Numbers', saleRatePaise: 650000, costRatePaise: 500000 },
  { name: 'A4 Paper Ream', hsn: '4802', gstRate: 12, unitName: 'Boxes', saleRatePaise: 28000, costRatePaise: 22000 },
  { name: 'Steel Filing Cabinet', hsn: '9403', gstRate: 12, unitName: 'Numbers', saleRatePaise: 1200000, costRatePaise: 950000 },
  { name: 'Notebook Pack', hsn: '4820', gstRate: 5, unitName: 'Boxes', saleRatePaise: 45000, costRatePaise: 35000 }
]

// ---------- extra ledgers ----------

export interface DemoLedger {
  name: string
  groupName: string
  taxType?: 'cgst' | 'sgst' | 'igst'
}

export const DEMO_EXTRA_LEDGERS: DemoLedger[] = [
  { name: 'Sales A/c', groupName: 'Sales Accounts' },
  { name: 'Purchase A/c', groupName: 'Purchase Accounts' },
  { name: 'CGST Output', groupName: 'Duties & Taxes', taxType: 'cgst' },
  { name: 'SGST Output', groupName: 'Duties & Taxes', taxType: 'sgst' },
  { name: 'IGST Output', groupName: 'Duties & Taxes', taxType: 'igst' },
  { name: 'CGST Input', groupName: 'Duties & Taxes', taxType: 'cgst' },
  { name: 'SGST Input', groupName: 'Duties & Taxes', taxType: 'sgst' },
  { name: 'IGST Input', groupName: 'Duties & Taxes', taxType: 'igst' },
  { name: 'HDFC Bank', groupName: 'Bank Accounts' }
]

// ---------- vouchers (neutral, name-keyed shape) ----------

export interface DemoVoucherLine {
  ledgerName: string
  drCr: 'dr' | 'cr'
  amount: number
}

export interface DemoInventoryLine {
  itemName: string
  qtyMilli: number
  ratePaise: number
  amount: number
  direction: 'in' | 'out'
}

export interface DemoVoucher {
  kind: VoucherKind
  date: string
  partyName?: string
  narration: string
  lines: DemoVoucherLine[]
  inventory?: DemoInventoryLine[]
}

/** Every generated voucher must actually balance — a bug here would otherwise only surface as a
 *  cryptic 'unbalanced' error deep inside saveVoucher at demo-company-creation time. */
function assertBalanced(v: DemoVoucher): void {
  const dr = v.lines.filter((l) => l.drCr === 'dr').reduce((s, l) => s + l.amount, 0)
  const cr = v.lines.filter((l) => l.drCr === 'cr').reduce((s, l) => s + l.amount, 0)
  if (dr !== cr) {
    throw new Error(`Demo voucher "${v.narration}" on ${v.date} is unbalanced: dr ${dr} !== cr ${cr}`)
  }
}

function addDaysISO(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

function subMonthsISO(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1 - months, d)).toISOString().slice(0, 10)
}

function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number]
  const [ty, tm, td] = to.split('-').map(Number) as [number, number, number]
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000)
}

/** Trailing 3 months up to `today`, clamped so it never runs earlier than the FY start
 *  (a company whose books started last month shouldn't get demo entries "before" it opened). */
export function demoWindow(today: string): { from: string; to: string } {
  const fy = fyOf(today)
  const threeMonthsAgo = subMonthsISO(today, 3)
  return { from: threeMonthsAgo < fy.from ? fy.from : threeMonthsAgo, to: today }
}

/** `count` dates spread evenly (inclusive) across [from, to]. */
function spreadDates(from: string, to: string, count: number): string[] {
  const totalDays = daysBetween(from, to)
  return Array.from({ length: count }, (_, i) => addDaysISO(from, Math.round((i * totalDays) / Math.max(count - 1, 1))))
}

function supplyFor(partyStateCode: string): SupplyType {
  return supplyTypeFor(DEMO_COMPANY.stateCode, partyStateCode)
}

function buildSale(date: string, debtor: DemoParty, item: DemoItem, qty: number): DemoVoucher {
  const amount = qty * item.saleRatePaise
  const g = computeGst(amount, item.gstRate, supplyFor(debtor.stateCode))
  const lines: DemoVoucherLine[] = [
    { ledgerName: debtor.name, drCr: 'dr', amount: g.total },
    { ledgerName: 'Sales A/c', drCr: 'cr', amount }
  ]
  if (g.cgst > 0) lines.push({ ledgerName: 'CGST Output', drCr: 'cr', amount: g.cgst })
  if (g.sgst > 0) lines.push({ ledgerName: 'SGST Output', drCr: 'cr', amount: g.sgst })
  if (g.igst > 0) lines.push({ ledgerName: 'IGST Output', drCr: 'cr', amount: g.igst })
  const v: DemoVoucher = {
    kind: 'sales',
    date,
    partyName: debtor.name,
    narration: `Sale of ${item.name} to ${debtor.name}`,
    lines,
    inventory: [{ itemName: item.name, qtyMilli: qty * 1000, ratePaise: item.saleRatePaise, amount, direction: 'out' }]
  }
  assertBalanced(v)
  return v
}

function buildPurchase(date: string, creditor: DemoParty, item: DemoItem, qty: number): DemoVoucher {
  const amount = qty * item.costRatePaise
  const g = computeGst(amount, item.gstRate, supplyFor(creditor.stateCode))
  const lines: DemoVoucherLine[] = [{ ledgerName: 'Purchase A/c', drCr: 'dr', amount }]
  if (g.cgst > 0) lines.push({ ledgerName: 'CGST Input', drCr: 'dr', amount: g.cgst })
  if (g.sgst > 0) lines.push({ ledgerName: 'SGST Input', drCr: 'dr', amount: g.sgst })
  if (g.igst > 0) lines.push({ ledgerName: 'IGST Input', drCr: 'dr', amount: g.igst })
  lines.push({ ledgerName: creditor.name, drCr: 'cr', amount: g.total })
  const v: DemoVoucher = {
    kind: 'purchase',
    date,
    partyName: creditor.name,
    narration: `Purchase of ${item.name} from ${creditor.name}`,
    lines,
    inventory: [{ itemName: item.name, qtyMilli: qty * 1000, ratePaise: item.costRatePaise, amount, direction: 'in' }]
  }
  assertBalanced(v)
  return v
}

function buildReceipt(date: string, debtor: DemoParty, bankLedger: string, amount: number): DemoVoucher {
  const v: DemoVoucher = {
    kind: 'receipt',
    date,
    partyName: debtor.name,
    narration: `Received from ${debtor.name}`,
    lines: [
      { ledgerName: bankLedger, drCr: 'dr', amount },
      { ledgerName: debtor.name, drCr: 'cr', amount }
    ]
  }
  assertBalanced(v)
  return v
}

function buildPayment(date: string, creditor: DemoParty, bankLedger: string, amount: number): DemoVoucher {
  const v: DemoVoucher = {
    kind: 'payment',
    date,
    partyName: creditor.name,
    narration: `Paid to ${creditor.name}`,
    lines: [
      { ledgerName: creditor.name, drCr: 'dr', amount },
      { ledgerName: bankLedger, drCr: 'cr', amount }
    ]
  }
  assertBalanced(v)
  return v
}

function buildContra(date: string, fromLedger: string, toLedger: string, amount: number, narration: string): DemoVoucher {
  const v: DemoVoucher = {
    kind: 'contra',
    date,
    narration,
    lines: [
      { ledgerName: toLedger, drCr: 'dr', amount },
      { ledgerName: fromLedger, drCr: 'cr', amount }
    ]
  }
  assertBalanced(v)
  return v
}

function buildJournal(date: string, drLedger: string, crLedger: string, amount: number, narration: string): DemoVoucher {
  const v: DemoVoucher = {
    kind: 'journal',
    date,
    narration,
    lines: [
      { ledgerName: drLedger, drCr: 'dr', amount },
      { ledgerName: crLedger, drCr: 'cr', amount }
    ]
  }
  assertBalanced(v)
  return v
}

/**
 * ~40 deterministic, balanced demo vouchers spanning the trailing 3 months (clamped to the FY
 * start): 14 sales item-invoices, 8 purchases, 8 receipts, 6 payments, 2 contra, 2 journal.
 * Deterministic in `today` — same input always produces the same vouchers, which is what makes
 * this testable and reproducible across runs on the same day.
 */
export function demoVouchers(today: string): DemoVoucher[] {
  const { from, to } = demoWindow(today)

  const sales = spreadDates(from, to, 14).map((date, i) =>
    buildSale(date, DEMO_DEBTORS[i % DEMO_DEBTORS.length]!, DEMO_ITEMS[i % DEMO_ITEMS.length]!, 1 + (i % 3))
  )

  const purchases = spreadDates(from, to, 8).map((date, i) =>
    buildPurchase(date, DEMO_CREDITORS[i % DEMO_CREDITORS.length]!, DEMO_ITEMS[(i + 3) % DEMO_ITEMS.length]!, 2 + (i % 4))
  )

  const receiptAmounts = [1800000, 4200000, 950000, 6300000, 2750000, 1500000, 3600000, 2100000]
  const receipts = spreadDates(from, to, 8).map((date, i) =>
    buildReceipt(date, DEMO_DEBTORS[i % DEMO_DEBTORS.length]!, i % 2 === 0 ? 'HDFC Bank' : 'Cash', receiptAmounts[i]!)
  )

  const paymentAmounts = [800000, 1300000, 1750000, 950000, 2100000, 1400000]
  const payments = spreadDates(from, to, 6).map((date, i) =>
    buildPayment(date, DEMO_CREDITORS[i % DEMO_CREDITORS.length]!, i % 2 === 0 ? 'Cash' : 'HDFC Bank', paymentAmounts[i]!)
  )

  const contraDates = spreadDates(from, to, 2)
  const contras = [
    buildContra(contraDates[0]!, 'Cash', 'HDFC Bank', 5000000, 'Cash deposited into bank'),
    buildContra(contraDates[1]!, 'HDFC Bank', 'Cash', 2000000, 'Cash withdrawn for office use')
  ]

  const journalDates = spreadDates(from, to, 2)
  const journals = [
    buildJournal(journalDates[0]!, 'Purchase A/c', DEMO_CREDITORS[1]!.name, 250000, 'Purchase price correction'),
    buildJournal(journalDates[1]!, DEMO_DEBTORS[1]!.name, 'Sales A/c', 180000, 'Sales price correction')
  ]

  return [...sales, ...purchases, ...receipts, ...payments, ...contras, ...journals].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0
  )
}

// ---------- trades (roadmap #293) ----------

export const DEMO_TRADES = ['trading', 'manufacturing', 'services'] as const
export type DemoTrade = (typeof DEMO_TRADES)[number]

/** A finished good and what it is made of, by item name. Empty for trades that make nothing. */
export interface DemoBom {
  itemName: string
  components: { itemName: string; qtyMilliPerUnit: number }[]
}

export interface DemoTradeProfile {
  trade: DemoTrade
  /** What the choice reads as on screen. */
  label: string
  /** One line about what this sample contains that the others do not. */
  blurb: string
  company: CompanyInfo
  parties: DemoParty[]
  items: DemoItem[]
  extraLedgers: DemoLedger[]
  bom: DemoBom[]
  /**
   * Features to switch off for this trade. A services firm with inventory switched on is being
   * shown several screens about stock it does not have — and the complaint about the generic
   * sample was exactly that.
   */
  featureOverrides: { inventory?: boolean }
  vouchers: (today: string) => DemoVoucher[]
}

// --- manufacturing ---

const MFG_COMPANY: CompanyInfo = {
  ...DEMO_COMPANY,
  name: 'Demo Manufacturing',
  gstin: '27AABCM4567N1Z1',
  pan: 'AABCM4567N',
  address: 'Plot 21, MIDC Chakan, Pune 410501',
  email: 'accounts@demomfg.test'
}

const MFG_PARTIES: DemoParty[] = [
  { name: 'Nashik Auto Works', kind: 'debtor', gstin: '27AABCD1234E1Z8', stateCode: '27', address: 'Satpur MIDC, Nashik 422007' },
  { name: 'Deccan Machine Tools', kind: 'debtor', gstin: '27AABCE5678F1ZH', stateCode: '27', address: 'Shivaji Nagar, Pune 411005' },
  { name: 'Hosur Fabricators', kind: 'debtor', gstin: '29AABCF9012G1ZQ', stateCode: '29', address: 'Peenya, Bengaluru 560058' },
  { name: 'Bharat Steel Suppliers', kind: 'creditor', gstin: '27AABCG3456H1ZN', stateCode: '27', address: 'MIDC Bhosari, Pune 411026' },
  { name: 'Gujarat Components Pvt Ltd', kind: 'creditor', gstin: '24AABCH7890I1ZB', stateCode: '24', address: 'GIDC Vatva, Ahmedabad 382445' }
]

/** Three raw materials, one work-in-progress stage, two finished goods. */
const MFG_ITEMS: DemoItem[] = [
  { name: 'MS Sheet 2mm', hsn: '7208', gstRate: 18, unitName: 'Kilograms', saleRatePaise: 9000, costRatePaise: 7500 },
  { name: 'Bearing 6204', hsn: '8482', gstRate: 18, unitName: 'Numbers', saleRatePaise: 22000, costRatePaise: 16000 },
  { name: 'Powder Coat Paint', hsn: '3208', gstRate: 18, unitName: 'Kilograms', saleRatePaise: 55000, costRatePaise: 42000 },
  { name: 'Pulley Housing (WIP)', hsn: '8483', gstRate: 18, unitName: 'Numbers', saleRatePaise: 0, costRatePaise: 0 },
  { name: 'Idler Pulley Assembly', hsn: '8483', gstRate: 18, unitName: 'Numbers', saleRatePaise: 320000, costRatePaise: 0 },
  { name: 'Conveyor Roller 600mm', hsn: '8431', gstRate: 18, unitName: 'Numbers', saleRatePaise: 480000, costRatePaise: 0 }
]

const MFG_BOM: DemoBom[] = [
  {
    itemName: 'Pulley Housing (WIP)',
    components: [
      { itemName: 'MS Sheet 2mm', qtyMilliPerUnit: 2500 },
      { itemName: 'Bearing 6204', qtyMilliPerUnit: 2000 }
    ]
  },
  {
    itemName: 'Idler Pulley Assembly',
    components: [
      { itemName: 'Pulley Housing (WIP)', qtyMilliPerUnit: 1000 },
      { itemName: 'Powder Coat Paint', qtyMilliPerUnit: 200 }
    ]
  },
  {
    itemName: 'Conveyor Roller 600mm',
    components: [
      { itemName: 'MS Sheet 2mm', qtyMilliPerUnit: 4000 },
      { itemName: 'Bearing 6204', qtyMilliPerUnit: 2000 },
      { itemName: 'Powder Coat Paint', qtyMilliPerUnit: 300 }
    ]
  }
]

const MFG_LEDGERS: DemoLedger[] = [
  ...DEMO_EXTRA_LEDGERS,
  { name: 'Factory Wages', groupName: 'Direct Expenses' },
  { name: 'Power & Fuel', groupName: 'Direct Expenses' },
  { name: 'Factory Rent', groupName: 'Direct Expenses' }
]

// --- services ---

const SVC_COMPANY: CompanyInfo = {
  ...DEMO_COMPANY,
  name: 'Demo Consulting',
  gstin: '27AABCS2345P1ZG',
  pan: 'AABCS2345P',
  address: '304 Amar Chambers, Baner, Pune 411045',
  email: 'accounts@democonsulting.test'
}

const SVC_PARTIES: DemoParty[] = [
  { name: 'Kalyani Infrastructure', kind: 'debtor', gstin: '27AABCD1234E1Z8', stateCode: '27', address: 'Kharadi, Pune 411014' },
  { name: 'Meridian Foods Pvt Ltd', kind: 'debtor', gstin: '27AABCE5678F1ZH', stateCode: '27', address: 'Hadapsar, Pune 411028' },
  { name: 'Southern Logistics', kind: 'debtor', gstin: '29AABCF9012G1ZQ', stateCode: '29', address: 'Whitefield, Bengaluru 560066' },
  { name: 'Regus Office Services', kind: 'creditor', gstin: '27AABCG3456H1ZN', stateCode: '27', address: 'Baner, Pune 411045' },
  { name: 'Cloudline Systems', kind: 'creditor', gstin: '24AABCH7890I1ZB', stateCode: '24', address: 'SG Highway, Ahmedabad 380054' }
]

/**
 * A services firm sells time, and time is not stock. Every sale below is a plain ledger invoice
 * with no inventory line at all, which is the whole point of the variant: the sample should not
 * teach a consultancy to invent an item master it will never use.
 */
const SVC_SERVICES: { name: string; incomeLedger: string; gstRate: number; feePaise: number }[] = [
  { name: 'Management consulting retainer', incomeLedger: 'Consulting Fees', gstRate: 18, feePaise: 15000000 },
  { name: 'Process audit', incomeLedger: 'Consulting Fees', gstRate: 18, feePaise: 8500000 },
  { name: 'Implementation support', incomeLedger: 'Implementation Income', gstRate: 18, feePaise: 22000000 },
  { name: 'Training workshop', incomeLedger: 'Training Income', gstRate: 18, feePaise: 6000000 }
]

const SVC_LEDGERS: DemoLedger[] = [
  { name: 'Consulting Fees', groupName: 'Sales Accounts' },
  { name: 'Implementation Income', groupName: 'Sales Accounts' },
  { name: 'Training Income', groupName: 'Sales Accounts' },
  { name: 'CGST Output', groupName: 'Duties & Taxes', taxType: 'cgst' },
  { name: 'SGST Output', groupName: 'Duties & Taxes', taxType: 'sgst' },
  { name: 'IGST Output', groupName: 'Duties & Taxes', taxType: 'igst' },
  { name: 'CGST Input', groupName: 'Duties & Taxes', taxType: 'cgst' },
  { name: 'SGST Input', groupName: 'Duties & Taxes', taxType: 'sgst' },
  { name: 'IGST Input', groupName: 'Duties & Taxes', taxType: 'igst' },
  { name: 'HDFC Bank', groupName: 'Bank Accounts' },
  { name: 'Salaries', groupName: 'Indirect Expenses' },
  { name: 'Office Rent', groupName: 'Indirect Expenses' },
  { name: 'Software Subscriptions', groupName: 'Indirect Expenses' },
  { name: 'Travel & Conveyance', groupName: 'Indirect Expenses' }
]

// --- builders the variants need that the trading sample never did ---

/** A sale of something that is not stock: a fee invoice. */
function buildServiceSale(
  date: string,
  debtor: DemoParty,
  service: { name: string; incomeLedger: string; gstRate: number; feePaise: number },
  multiple: number
): DemoVoucher {
  const amount = service.feePaise * multiple
  const g = computeGst(amount, service.gstRate, supplyFor(debtor.stateCode))
  const lines: DemoVoucherLine[] = [
    { ledgerName: debtor.name, drCr: 'dr', amount: g.total },
    { ledgerName: service.incomeLedger, drCr: 'cr', amount }
  ]
  if (g.cgst > 0) lines.push({ ledgerName: 'CGST Output', drCr: 'cr', amount: g.cgst })
  if (g.sgst > 0) lines.push({ ledgerName: 'SGST Output', drCr: 'cr', amount: g.sgst })
  if (g.igst > 0) lines.push({ ledgerName: 'IGST Output', drCr: 'cr', amount: g.igst })
  const v: DemoVoucher = { kind: 'sales', date, partyName: debtor.name, narration: service.name + ' — ' + debtor.name, lines }
  assertBalanced(v)
  return v
}

/** An expense bill from a supplier: no inventory, input tax credit taken. */
function buildExpensePurchase(
  date: string,
  creditor: DemoParty,
  expenseLedger: string,
  amount: number,
  gstRate: number
): DemoVoucher {
  const g = computeGst(amount, gstRate, supplyFor(creditor.stateCode))
  const lines: DemoVoucherLine[] = [{ ledgerName: expenseLedger, drCr: 'dr', amount }]
  if (g.cgst > 0) lines.push({ ledgerName: 'CGST Input', drCr: 'dr', amount: g.cgst })
  if (g.sgst > 0) lines.push({ ledgerName: 'SGST Input', drCr: 'dr', amount: g.sgst })
  if (g.igst > 0) lines.push({ ledgerName: 'IGST Input', drCr: 'dr', amount: g.igst })
  lines.push({ ledgerName: creditor.name, drCr: 'cr', amount: g.total })
  const v: DemoVoucher = { kind: 'purchase', date, partyName: creditor.name, narration: expenseLedger + ' — ' + creditor.name, lines }
  assertBalanced(v)
  return v
}

/**
 * A manufacturing stock journal: components out, the produced item in, at the value of what was
 * consumed. No ledger lines at all — value moves between stock items and never touches the P&L,
 * which is precisely why manufacture is a stock journal and not a purchase.
 */
function buildManufacture(
  date: string,
  produced: { itemName: string; qty: number },
  consumed: { itemName: string; qtyMilli: number; ratePaise: number }[],
  narration: string
): DemoVoucher {
  const consumedValue = consumed.reduce((s, c) => s + Math.round((c.qtyMilli * c.ratePaise) / 1000), 0)
  const producedQtyMilli = produced.qty * 1000
  return {
    kind: 'stock_journal',
    date,
    narration,
    lines: [],
    inventory: [
      ...consumed.map((c) => ({
        itemName: c.itemName,
        qtyMilli: c.qtyMilli,
        ratePaise: c.ratePaise,
        amount: Math.round((c.qtyMilli * c.ratePaise) / 1000),
        direction: 'out' as const
      })),
      {
        itemName: produced.itemName,
        qtyMilli: producedQtyMilli,
        // Rate per unit, derived from what went in — a produced item has no purchase price.
        ratePaise: Math.round((consumedValue * 1000) / producedQtyMilli),
        amount: consumedValue,
        direction: 'in' as const
      }
    ]
  }
}

function itemNamed(items: DemoItem[], name: string): DemoItem {
  const found = items.find((i) => i.name === name)
  if (!found) throw new Error('Demo item "' + name + '" is not in the item list')
  return found
}

// --- the manufacturing voucher script ---

function manufacturingVouchers(today: string): DemoVoucher[] {
  const { from, to } = demoWindow(today)
  const span = daysBetween(from, to)
  const debtors = MFG_PARTIES.filter((p) => p.kind === 'debtor')
  const creditors = MFG_PARTIES.filter((p) => p.kind === 'creditor')
  const sheet = itemNamed(MFG_ITEMS, 'MS Sheet 2mm')
  const bearing = itemNamed(MFG_ITEMS, 'Bearing 6204')
  const paint = itemNamed(MFG_ITEMS, 'Powder Coat Paint')

  // Raw material has to be bought before it can be consumed, so purchases sit in the first third
  // of the window and the stock journals after them. A manufacture voucher dated before its
  // components arrived produces negative stock, and a sample that opens with a warning is a
  // sample that teaches the wrong thing.
  const early = spreadDates(from, addDaysISO(from, Math.max(1, Math.round(span / 3))), 6)
  const purchases = [
    buildPurchase(early[0]!, creditors[0]!, sheet, 800),
    buildPurchase(early[1]!, creditors[1]!, bearing, 400),
    buildPurchase(early[2]!, creditors[0]!, paint, 60),
    buildPurchase(early[3]!, creditors[1]!, sheet, 500),
    buildPurchase(early[4]!, creditors[0]!, bearing, 250),
    buildPurchase(early[5]!, creditors[1]!, paint, 40)
  ]

  const mid = spreadDates(addDaysISO(from, Math.round(span / 3) + 1), to, 6)
  // Two stages, so work in progress is something you can see on the stock summary rather than an
  // idea: sheet and bearings become housings, housings and paint become assemblies.
  const housings = buildManufacture(
    mid[0]!,
    { itemName: 'Pulley Housing (WIP)', qty: 120 },
    [
      { itemName: sheet.name, qtyMilli: 300000, ratePaise: sheet.costRatePaise },
      { itemName: bearing.name, qtyMilli: 240000, ratePaise: bearing.costRatePaise }
    ],
    'Pressed and machined 120 pulley housings'
  )
  const housingRate = housings.inventory!.at(-1)!.ratePaise
  const assemblies = buildManufacture(
    mid[1]!,
    { itemName: 'Idler Pulley Assembly', qty: 90 },
    [
      { itemName: 'Pulley Housing (WIP)', qtyMilli: 90000, ratePaise: housingRate },
      { itemName: paint.name, qtyMilli: 18000, ratePaise: paint.costRatePaise }
    ],
    'Assembled and coated 90 idler pulleys'
  )
  const rollers = buildManufacture(
    mid[2]!,
    { itemName: 'Conveyor Roller 600mm', qty: 60 },
    [
      { itemName: sheet.name, qtyMilli: 240000, ratePaise: sheet.costRatePaise },
      { itemName: bearing.name, qtyMilli: 120000, ratePaise: bearing.costRatePaise },
      { itemName: paint.name, qtyMilli: 18000, ratePaise: paint.costRatePaise }
    ],
    'Fabricated 60 conveyor rollers'
  )

  const assembly = itemNamed(MFG_ITEMS, 'Idler Pulley Assembly')
  const roller = itemNamed(MFG_ITEMS, 'Conveyor Roller 600mm')
  const sales = spreadDates(mid[3]!, to, 8).map((date, i) =>
    buildSale(date, debtors[i % debtors.length]!, i % 2 === 0 ? assembly : roller, 5 + (i % 4))
  )

  const factory = spreadDates(from, to, 3)
  const overheads = [
    buildJournal(factory[0]!, 'Factory Wages', 'Cash', 9500000, 'Factory wages for the period'),
    buildJournal(factory[1]!, 'Power & Fuel', 'HDFC Bank', 3200000, 'Electricity for the shop floor'),
    buildJournal(factory[2]!, 'Factory Rent', 'HDFC Bank', 4500000, 'Shed rent')
  ]

  const money = spreadDates(from, to, 6)
  const receipts = [
    buildReceipt(money[0]!, debtors[0]!, 'HDFC Bank', 12000000),
    buildReceipt(money[2]!, debtors[1]!, 'HDFC Bank', 8500000),
    buildReceipt(money[4]!, debtors[2]!, 'Cash', 3000000)
  ]
  const payments = [
    buildPayment(money[1]!, creditors[0]!, 'HDFC Bank', 6000000),
    buildPayment(money[3]!, creditors[1]!, 'HDFC Bank', 4500000),
    buildPayment(money[5]!, creditors[0]!, 'Cash', 1500000)
  ]

  return [...purchases, housings, assemblies, rollers, ...sales, ...overheads, ...receipts, ...payments].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0
  )
}

// --- the services voucher script ---

function servicesVouchers(today: string): DemoVoucher[] {
  const { from, to } = demoWindow(today)
  const debtors = SVC_PARTIES.filter((p) => p.kind === 'debtor')
  const creditors = SVC_PARTIES.filter((p) => p.kind === 'creditor')

  const invoices = spreadDates(from, to, 12).map((date, i) =>
    buildServiceSale(date, debtors[i % debtors.length]!, SVC_SERVICES[i % SVC_SERVICES.length]!, 1 + (i % 2))
  )

  const billDates = spreadDates(from, to, 6)
  const bills = [
    buildExpensePurchase(billDates[0]!, creditors[0]!, 'Office Rent', 6500000, 18),
    buildExpensePurchase(billDates[1]!, creditors[1]!, 'Software Subscriptions', 2400000, 18),
    buildExpensePurchase(billDates[2]!, creditors[0]!, 'Office Rent', 6500000, 18),
    buildExpensePurchase(billDates[3]!, creditors[1]!, 'Software Subscriptions', 2400000, 18),
    buildExpensePurchase(billDates[4]!, creditors[0]!, 'Office Rent', 6500000, 18),
    buildExpensePurchase(billDates[5]!, creditors[1]!, 'Travel & Conveyance', 1850000, 18)
  ]

  const payrollJournals = spreadDates(from, to, 3).map((date, i) =>
    buildJournal(date, 'Salaries', 'HDFC Bank', 42000000 + i * 500000, 'Salaries paid')
  )

  const money = spreadDates(from, to, 8)
  const receipts = money
    .filter((_, i) => i % 2 === 0)
    .map((date, i) => buildReceipt(date, debtors[i % debtors.length]!, 'HDFC Bank', 12000000 + i * 2500000))
  const payments = money
    .filter((_, i) => i % 2 === 1)
    .map((date, i) => buildPayment(date, creditors[i % creditors.length]!, 'HDFC Bank', 5000000 + i * 1000000))

  const contra = buildContra(money[3]!, 'HDFC Bank', 'Cash', 500000, 'Cash drawn for petty expenses')

  return [...invoices, ...bills, ...payrollJournals, ...receipts, ...payments, contra].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0
  )
}

// --- the registry ---

const PROFILES: Record<DemoTrade, DemoTradeProfile> = {
  trading: {
    trade: 'trading',
    label: 'A shop or a distributor',
    blurb: 'Goods bought and resold — item invoices, GST both ways, stock that moves.',
    company: DEMO_COMPANY,
    parties: DEMO_PARTIES,
    items: DEMO_ITEMS,
    extraLedgers: DEMO_EXTRA_LEDGERS,
    bom: [],
    featureOverrides: {},
    vouchers: demoVouchers
  },
  manufacturing: {
    trade: 'manufacturing',
    label: 'A workshop or a factory',
    blurb: 'Raw material, a bill of materials, work in progress and finished goods.',
    company: MFG_COMPANY,
    parties: MFG_PARTIES,
    items: MFG_ITEMS,
    extraLedgers: MFG_LEDGERS,
    bom: MFG_BOM,
    featureOverrides: {},
    vouchers: manufacturingVouchers
  },
  services: {
    trade: 'services',
    label: 'A practice or an agency',
    blurb: 'Fees invoiced against time, expenses against bills — and no stock at all.',
    company: SVC_COMPANY,
    parties: SVC_PARTIES,
    items: [],
    extraLedgers: SVC_LEDGERS,
    bom: [],
    // Nothing here is stock, so the stock screens would be noise. Settings turns it back on the
    // moment the user wants it.
    featureOverrides: { inventory: false },
    vouchers: servicesVouchers
  }
}

export function demoProfile(trade: DemoTrade): DemoTradeProfile {
  return PROFILES[trade]
}

export const DEMO_TRADE_PROFILES: DemoTradeProfile[] = DEMO_TRADES.map((t) => PROFILES[t])
