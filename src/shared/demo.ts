/**
 * Deterministic "sample data" for the demo company: a fixed set of masters plus a generator that
 * builds ~40 balanced vouchers spanning the trailing 3 months (clamped to the FY start). Pure —
 * no DB, no Electron. src/main/services/demo.ts turns this neutral shape into real ledgers/items/
 * vouchers via the same masters/vouchers services every other screen uses.
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
