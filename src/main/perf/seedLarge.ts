// WP 7.1 — the large-company generator for the performance budgets ("Perf Traders").
//
// Deterministic (a seeded PRNG, no clock, no Math.random) and written ONLY through the services a
// user's entries go through — seedCompany, createLedger / createStockItem, replaceOpeningBills,
// saveVoucher, deleteVoucher — so every save rule, the audit chain and the stock / bill-wise
// engines see exactly what a real company of this size would hold. Saves are batched inside
// outer transactions (saveVoucher's own transactions become savepoints) so a big run is bound by
// the services, not by fsync. Voucher numbers are passed in (the type's own format, restarting
// each FY) so the generator does not pay a numbering scan per save.
//
// Shape (N vouchers dated in order over 2024-04-01 … 2026-09-30 — three FYs):
//   2,000 parties (1,600 customers — 60 % with a GSTIN, 30 % out of state — and 400 suppliers),
//   500 stock items (four GST slabs, every 25th on FIFO) with opening stock, 10 % of customers
//   with 1–3 opening bills; ~32 % sales (1–5 item lines, a bill each; a fifth paid at once by a
//   receipt against the bill), ~14 % purchases (1–5 lines, the supplier's bill no.), receipts
//   against 1–3 of the customer's oldest bills (a tenth on account), payments to suppliers
//   against their bills, expense payments, contras, journals, stock journals, credit / debit
//   notes returning one unit of a recent invoice line (`return` links, against the bill while
//   it is open), and ~0.3 % of the expense payments moved to the bin.
//
// Memory: only the open bills per party and a ring of recent invoice lines are held — vouchers
// are never kept, so a 500k run stays small.
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import type { VoucherInput } from '@shared/schemas'
import { stockItemInputSchema } from '@shared/schemas'
import { gstinCheckChar } from '@shared/gst/validate'
import { fyOf } from '@shared/dates'
import { seedCompany } from '../db/seed'
import { createLedger, createStockItem } from '../services/masters'
import { replaceOpeningBills } from '../services/openingBills'
import { deleteVoucher, saveVoucher } from '../services/vouchers'

function withCheck(first14: string): string {
  return first14 + gstinCheckChar(first14)
}

export const PERF_COMPANY: CompanyInfo = {
  name: 'Perf Traders',
  stateCode: '27',
  gstin: withCheck('27AAPFP1234K1Z'),
  gstRegistrationType: 'regular',
  address: 'Synthetic performance company, Pune',
  booksFrom: 2024,
  email: null,
  phone: null,
  pan: 'AAPFP1234K',
  tan: null
}

/** The as-on day every budgeted figure is computed for (the last seeded day). */
export const PERF_TODAY = '2026-09-30'
export const PERF_DEFAULT_SEED = 7101

export interface LargeSeedOptions {
  vouchers: number
  seed?: number
  parties?: number
  items?: number
  /** Saves per outer transaction (default 2,000). */
  batch?: number
  onProgress?: (done: number, total: number) => void
}

export interface LargeSeedSummary {
  vouchers: number
  parties: number
  items: number
  byKind: Record<string, number>
  binned: number
  ms: number
}

/** mulberry32 — small, fast, deterministic. */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const HEADER = {
  narration: null, reference: null, instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null,
  transportDistanceKm: null, currencyCode: null, exchangeRate: null
}

const OTHER_STATES = ['29', '24', '07', '33', '09', '06']
const SLABS = [5, 12, 18, 28]
const DAY_MS = 86_400_000
const FIRST_DAY = Date.UTC(2024, 3, 1)
const DAYS = Math.round((Date.UTC(2026, 8, 30) - FIRST_DAY) / DAY_MS) + 1

interface OpenBill { name: string; left: number }
interface Item { id: number; gst: number; cost: number; price: number; qty: number }
interface InvoiceLine { uid: string; party: number; itemIdx: number; qtyLeft: number; rate: number; bill: string; inter: boolean }
type Lines = VoucherInput['lines']
type Refs = VoucherInput['billRefs']

/** Seed Perf Traders into a migrated, EMPTY database. Same options → the same books. */
export function seedLarge(db: DB, opts: LargeSeedOptions): LargeSeedSummary {
  const steps = seedLargeSteps(db, opts)
  for (;;) {
    const r = steps.next()
    if (r.done) return r.value
  }
}

/** The same, yielding to the event loop between batches (inside a test runner, whose worker
 *  must keep answering its parent while a 100k company is written). */
export async function seedLargeAsync(db: DB, opts: LargeSeedOptions): Promise<LargeSeedSummary> {
  const steps = seedLargeSteps(db, opts)
  for (;;) {
    const r = steps.next()
    if (r.done) return r.value
    await new Promise((resolve) => setImmediate(resolve))
  }
}

/** The generator behind both: one step per batch of saves. */
export function* seedLargeSteps(db: DB, opts: LargeSeedOptions): Generator<number, LargeSeedSummary> {
  const t0 = performance.now()
  const rnd = prng(opts.seed ?? PERF_DEFAULT_SEED)
  const int = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1))
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!
  const nParties = opts.parties ?? 2000
  const nItems = opts.items ?? 500
  const nCustomers = Math.round(nParties * 0.8)
  const batch = opts.batch ?? 2000

  seedCompany(db, PERF_COMPANY)
  const groupId = (name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
  const ledger = (name: string, group: string, extra: Record<string, unknown> = {}): number =>
    createLedger(db, { name, groupId: groupId(group), ...extra } as Parameters<typeof createLedger>[1]).id

  const bankOpening = 700_000_000
  const L = {
    cash: (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id,
    hdfc: ledger('HDFC Bank', 'Bank Accounts', { openingBalance: 500_000_000 }),
    icici: ledger('ICICI Bank', 'Bank Accounts', { openingBalance: 200_000_000 }),
    sales: ledger('Sales A/c', 'Sales Accounts'),
    purchase: ledger('Purchase A/c', 'Purchase Accounts'),
    outCgst: ledger('Output CGST', 'Duties & Taxes', { taxType: 'cgst' }),
    outSgst: ledger('Output SGST', 'Duties & Taxes', { taxType: 'sgst' }),
    outIgst: ledger('Output IGST', 'Duties & Taxes', { taxType: 'igst' }),
    inCgst: ledger('Input CGST', 'Duties & Taxes', { taxType: 'cgst' }),
    inSgst: ledger('Input SGST', 'Duties & Taxes', { taxType: 'sgst' }),
    inIgst: ledger('Input IGST', 'Duties & Taxes', { taxType: 'igst' }),
    rent: ledger('Shop Rent', 'Indirect Expenses'),
    power: ledger('Electricity Charges', 'Indirect Expenses'),
    salaries: ledger('Salaries', 'Indirect Expenses'),
    freight: ledger('Freight Inward', 'Direct Expenses'),
    misc: ledger('Office Expenses', 'Indirect Expenses'),
    drawings: ledger('Drawings', 'Capital Account')
  }
  const expenses = [L.rent, L.power, L.salaries, L.freight, L.misc]

  // ---- parties (opening bills through the opening-bills writer) ----
  const customers: number[] = []
  const suppliers: number[] = []
  const inter = new Map<number, boolean>()
  const open = new Map<number, OpenBill[]>()
  let openingDr = 0
  for (let i = 0; i < nParties; i++) {
    const isCustomer = i < nCustomers
    const state = rnd() < 0.7 ? '27' : pick(OTHER_STATES)
    const n = String(i + 1).padStart(4, '0')
    const pan = `AAB${isCustomer ? 'C' : 'F'}${String.fromCharCode(65 + (i % 26))}${n}${String.fromCharCode(65 + ((i * 7) % 26))}`
    const gstin = rnd() < (isCustomer ? 0.6 : 0.9) ? withCheck(`${state}${pan}1Z`) : null
    const bills = isCustomer && rnd() < 0.1
      ? Array.from({ length: int(1, 3) }, (_, k) => ({
          name: `OB/${n}/${k + 1}`, date: `2024-0${int(1, 3)}-${String(int(1, 28)).padStart(2, '0')}`, dueDate: null, amount: int(500, 50_000) * 100
        }))
      : []
    const opening = bills.reduce((s, b) => s + b.amount, 0)
    const id = ledger(isCustomer ? `Customer ${n}` : `Supplier ${n}`, isCustomer ? 'Sundry Debtors' : 'Sundry Creditors', {
      stateCode: state, gstin, pan: gstin ? pan : null, creditDays: pick([0, 15, 30, 45, 60]), openingBalance: opening
    })
    ;(isCustomer ? customers : suppliers).push(id)
    inter.set(id, state !== '27')
    open.set(id, bills.map((b) => ({ name: b.name, left: b.amount })))
    if (bills.length) {
      replaceOpeningBills(db, id, bills)
      openingDr += opening
    }
  }

  // ---- items, each with an opening stock ----
  const unit = (db.prepare("SELECT id FROM units WHERE symbol = 'Nos'").get() as { id: number }).id
  const items: Item[] = []
  let openingStock = 0
  for (let i = 0; i < nItems; i++) {
    const cost = int(20, 2_000) * 100
    const qty = int(50, 500)
    const it = createStockItem(db, stockItemInputSchema.parse({
      name: `Item ${String(i + 1).padStart(3, '0')}`, unitId: unit, gstRate: SLABS[i % 4], hsn: String(8471 + (i % 40)),
      openingQtyMilli: qty * 1000, openingValue: qty * cost, ...(i % 25 === 0 ? { valuationMethod: 'fifo' } : {})
    }))
    items.push({ id: it.id, gst: SLABS[i % 4]!, cost, price: Math.round((cost * (120 + (i % 40))) / 10_000) * 100, qty })
    openingStock += qty * cost
  }
  // Capital = the other openings' balancing figure (stock counted as the balance sheet does).
  ledger('Capital Account', 'Capital Account', { openingBalance: -(bankOpening + openingDr + openingStock) })

  // ---- vouchers ----
  const types = new Map<string, { id: number; prefix: string; suffix: string; pad: number; restart: number }>()
  for (const k of ['sales', 'purchase', 'receipt', 'payment', 'contra', 'journal', 'stock_journal', 'credit_note', 'debit_note']) {
    types.set(k, db.prepare('SELECT id, prefix, suffix, pad_width AS pad, restart_fy AS restart FROM voucher_types WHERE kind = ? ORDER BY id').get(k) as never)
  }
  const seq = new Map<string, number>()
  const numberFor = (kind: string, date: string): string => {
    const t = types.get(kind)!
    const key = `${kind}:${t.restart ? fyOf(date).from : ''}`
    const n = (seq.get(key) ?? 0) + 1
    seq.set(key, n)
    return `${t.prefix}${t.pad > 0 ? String(n).padStart(t.pad, '0') : String(n)}${t.suffix}`
  }
  const fyTag = (date: string): string => {
    const y = Number(fyOf(date).from.slice(2, 4))
    return `${y}-${y + 1}`
  }
  const customersWithBills = new Set<number>(customers.filter((c) => open.get(c)!.length))
  const suppliersWithBills = new Set<number>()
  // One of the first 64 members of a set (insertion order — deterministic, oldest debts first).
  const memberOf = (set: Set<number>): number | undefined => {
    const k = Math.floor(rnd() * Math.min(set.size, 64))
    let j = 0
    for (const v of set) if (j++ === k) return v
    return undefined
  }
  const recentSales: InvoiceLine[] = []
  const recentPurchases: InvoiceLine[] = []
  const remember = (ring: InvoiceLine[], line: InvoiceLine): void => {
    ring.push(line)
    if (ring.length > 3000) ring.splice(0, ring.length - 2000)
  }
  const byKind: Record<string, number> = {}
  const binnable: number[] = []
  const N = opts.vouchers
  let saved = 0

  const save = (kind: string, input: Omit<VoucherInput, 'voucherTypeId' | 'number' | keyof typeof HEADER> & { number?: string; narration?: string | null; reference?: string | null }): ReturnType<typeof saveVoucher> => {
    const v = saveVoucher(db, { ...HEADER, ...input, voucherTypeId: types.get(kind)!.id, number: input.number ?? numberFor(kind, input.date) } as VoucherInput)
    byKind[kind] = (byKind[kind] ?? 0) + 1
    saved++
    return v
  }
  const taxLines = (side: 'dr' | 'cr', isInter: boolean, tax: number, purchase: boolean): Lines => {
    if (tax <= 0) return []
    if (isInter) return [{ ledgerId: purchase ? L.inIgst : L.outIgst, drCr: side, amount: tax }]
    const c = Math.floor(tax / 2)
    return [
      ...(c > 0 ? [{ ledgerId: purchase ? L.inCgst : L.outCgst, drCr: side, amount: c }] : []),
      { ledgerId: purchase ? L.inSgst : L.outSgst, drCr: side, amount: tax - c }
    ]
  }
  /** Settle the party's oldest bills, up to `nBills` of them and `max` paise. */
  const settle = (party: number, max: number, nBills: number): { refs: Refs; amount: number } => {
    const bills = open.get(party)!
    const refs: Refs = []
    let amount = 0
    while (refs.length < nBills && bills.length && amount < max) {
      const b = bills[0]!
      const part = Math.min(b.left, max - amount)
      refs.push({ kind: 'against', name: b.name, amount: part, dueDate: null })
      amount += part
      b.left -= part
      if (b.left === 0) bills.shift()
    }
    return { refs, amount }
  }
  const invoiceLines = (n: number, sale: boolean): { itemIdx: number; qty: number; rate: number; amount: number }[] => {
    const out: { itemIdx: number; qty: number; rate: number; amount: number }[] = []
    for (let k = 0; k < n; k++) {
      const itemIdx = int(0, nItems - 1)
      const it = items[itemIdx]!
      const qty = sale ? Math.max(1, Math.min(int(1, 12), it.qty)) : int(10, 60)
      it.qty += sale ? -qty : qty
      const rate = sale ? it.price : it.cost
      out.push({ itemIdx, qty, rate, amount: qty * rate })
    }
    return out
  }

  const one = (i: number, date: string): void => {
    const r = rnd()
    if (r < 0.46) {
      // Sales (r < 0.32) or purchase invoice, 1–5 item lines.
      const sale = r < 0.32
      const party = pick(sale ? customers : suppliers)
      const isInter = inter.get(party)!
      const lines = invoiceLines(rnd() < 0.15 ? 5 : int(1, 4), sale)
      const taxable = lines.reduce((s, l) => s + l.amount, 0)
      const tax = lines.reduce((s, l) => s + Math.round((l.amount * items[l.itemIdx]!.gst) / 100), 0)
      const total = taxable + tax
      const number = numberFor(sale ? 'sales' : 'purchase', date)
      const bill = sale ? `S/${fyTag(date)}/${number}` : `P${party}/${fyTag(date)}/${i}`
      const v = save(sale ? 'sales' : 'purchase', {
        date, number, partyLedgerId: party, reference: sale ? null : bill,
        lines: sale
          ? [{ ledgerId: party, drCr: 'dr', amount: total }, { ledgerId: L.sales, drCr: 'cr', amount: taxable }, ...taxLines('cr', isInter, tax, false)]
          : [{ ledgerId: party, drCr: 'cr', amount: total }, { ledgerId: L.purchase, drCr: 'dr', amount: taxable }, ...taxLines('dr', isInter, tax, true)],
        inventory: lines.map((l) => ({
          stockItemId: items[l.itemIdx]!.id, godownId: null, qtyMilli: l.qty * 1000, ratePaise: l.rate, discountPaise: 0, amount: l.amount,
          direction: sale ? ('out' as const) : ('in' as const)
        })),
        billRefs: [{ kind: 'new', name: bill, amount: total, dueDate: null }]
      })
      v.inventory.forEach((l, k) =>
        remember(sale ? recentSales : recentPurchases, { uid: l.lineUid!, party, itemIdx: lines[k]!.itemIdx, qtyLeft: lines[k]!.qty, rate: lines[k]!.rate, bill, inter: isInter })
      )
      if (sale && rnd() < 0.2 && saved < N) {
        save('receipt', {
          date, partyLedgerId: party,
          lines: [{ ledgerId: pick([L.cash, L.hdfc]), drCr: 'dr', amount: total }, { ledgerId: party, drCr: 'cr', amount: total }],
          inventory: [], billRefs: [{ kind: 'against', name: bill, amount: total, dueDate: null }]
        })
      } else {
        open.get(party)!.push({ name: bill, left: total })
        ;(sale ? customersWithBills : suppliersWithBills).add(party)
      }
    } else if (r < 0.79) {
      // Receipt from a customer (r < 0.66) or payment to a supplier: against 1–3 oldest bills.
      const receipt = r < 0.66
      const party = memberOf(receipt ? customersWithBills : suppliersWithBills) ?? pick(receipt ? customers : suppliers)
      const max = (receipt ? int(1_000, 200_000) : int(5_000, 500_000)) * 100
      const { refs, amount } = !receipt || rnd() < 0.9 ? settle(party, max, int(1, 3)) : { refs: [], amount: 0 }
      if (!open.get(party)!.length) (receipt ? customersWithBills : suppliersWithBills).delete(party)
      const amt = amount || max
      const bank = receipt ? pick([L.cash, L.hdfc, L.icici]) : pick([L.hdfc, L.icici])
      save(receipt ? 'receipt' : 'payment', {
        date, partyLedgerId: party,
        lines: receipt
          ? [{ ledgerId: bank, drCr: 'dr', amount: amt }, { ledgerId: party, drCr: 'cr', amount: amt }]
          : [{ ledgerId: party, drCr: 'dr', amount: amt }, { ledgerId: bank, drCr: 'cr', amount: amt }],
        inventory: [], billRefs: amount ? refs : []
      })
    } else if (r < 0.87) {
      const amt = int(100, 50_000) * 100
      const v = save('payment', {
        date, partyLedgerId: null, narration: `Expense ${i}`,
        lines: [{ ledgerId: pick(expenses), drCr: 'dr', amount: amt }, { ledgerId: pick([L.cash, L.hdfc]), drCr: 'cr', amount: amt }],
        inventory: [], billRefs: []
      })
      if (rnd() < 0.04) binnable.push(v.id)
    } else if (r < 0.9) {
      const amt = int(1_000, 100_000) * 100
      const [a, b] = rnd() < 0.5 ? [L.cash, L.hdfc] : [L.hdfc, L.icici]
      save('contra', { date, partyLedgerId: null, lines: [{ ledgerId: a, drCr: 'dr', amount: amt }, { ledgerId: b, drCr: 'cr', amount: amt }], inventory: [], billRefs: [] })
    } else if (r < 0.93) {
      const amt = int(500, 20_000) * 100
      save('journal', {
        date, partyLedgerId: null, narration: `Adjustment ${i}`,
        lines: [{ ledgerId: pick(expenses), drCr: 'dr', amount: amt }, { ledgerId: rnd() < 0.5 ? L.drawings : L.misc, drCr: 'cr', amount: amt }],
        inventory: [], billRefs: []
      })
    } else if (r < 0.95) {
      // Stock journal: one item consumed into another at cost.
      const a = items[int(0, nItems - 1)]!
      const b = items[int(0, nItems - 1)]!
      if (a === b || a.qty < 5) return one(i, date)
      const qty = int(1, 5)
      a.qty -= qty
      const value = qty * a.cost
      const bq = Math.max(1, Math.floor(value / b.cost))
      b.qty += bq
      save('stock_journal', {
        date, partyLedgerId: null, lines: [],
        inventory: [
          { stockItemId: a.id, godownId: null, qtyMilli: qty * 1000, ratePaise: a.cost, discountPaise: 0, amount: value, direction: 'out' },
          { stockItemId: b.id, godownId: null, qtyMilli: bq * 1000, ratePaise: Math.round(value / bq), discountPaise: 0, amount: value, direction: 'in' }
        ],
        billRefs: []
      })
    } else {
      // Return of one unit of a recent invoice line: credit note (two in three) or debit note.
      const sale = rnd() < 0.67
      const ring = sale ? recentSales : recentPurchases
      const line = ring.length ? ring[int(Math.max(0, ring.length - 500), ring.length - 1)]! : null
      if (!line || line.qtyLeft < 1) return one(i, date)
      line.qtyLeft -= 1
      const it = items[line.itemIdx]!
      it.qty += sale ? 1 : -1
      const taxable = line.rate
      const tax = Math.round((taxable * it.gst) / 100)
      const total = taxable + tax
      const bills = open.get(line.party)!
      const target = bills.find((b) => b.name === line.bill)
      const refs: Refs = []
      if (target && target.left >= total) {
        target.left -= total
        if (target.left === 0) bills.splice(bills.indexOf(target), 1)
        refs.push({ kind: 'against', name: line.bill, amount: total, dueDate: null })
      }
      save(sale ? 'credit_note' : 'debit_note', {
        date, partyLedgerId: line.party, narration: 'Goods returned',
        lines: sale
          ? [{ ledgerId: line.party, drCr: 'cr', amount: total }, { ledgerId: L.sales, drCr: 'dr', amount: taxable }, ...taxLines('dr', line.inter, tax, false)]
          : [{ ledgerId: line.party, drCr: 'dr', amount: total }, { ledgerId: L.purchase, drCr: 'cr', amount: taxable }, ...taxLines('cr', line.inter, tax, true)],
        inventory: [{
          stockItemId: it.id, godownId: null, qtyMilli: 1000, ratePaise: line.rate, discountPaise: 0, amount: taxable,
          direction: sale ? 'in' : 'out', source: { lineUid: line.uid, linkType: 'return' }
        }],
        billRefs: refs
      })
    }
  }

  // Exactly N vouchers (a paid-at-once sale's receipt counts); the day advances with the count.
  while (saved < N) {
    const end = Math.min(N, saved + batch)
    db.transaction(() => {
      while (saved < end) one(saved, new Date(FIRST_DAY + Math.floor((saved * DAYS) / N) * DAY_MS).toISOString().slice(0, 10))
    })()
    opts.onProgress?.(saved, N)
    yield saved
  }
  db.transaction(() => {
    for (const id of binnable) deleteVoucher(db, id)
  })()
  db.exec('ANALYZE')
  return { vouchers: saved, parties: nParties, items: nItems, byKind, binned: binnable.length, ms: Math.round(performance.now() - t0) }
}

/** Counts and totals that identify a seeded company's books — the determinism check. Leaves out
 *  anything clock-dependent (audit timestamps, deleted_at, line uids). */
export function booksFingerprint(db: DB): Record<string, number | string> {
  const one = (sql: string): number | string => {
    const row = db.prepare(sql).get() as Record<string, number | string | null>
    return Object.values(row)[0] ?? 0
  }
  return {
    vouchers: one('SELECT COUNT(*) FROM vouchers'),
    binned: one('SELECT COUNT(*) FROM vouchers WHERE deleted_at IS NOT NULL'),
    voucherLines: one('SELECT COUNT(*) FROM voucher_lines'),
    lineDr: one("SELECT COALESCE(SUM(amount), 0) FROM voucher_lines WHERE dr_cr = 'dr'"),
    lineWeighted: one('SELECT COALESCE(SUM((amount % 1000003) * (ledger_id % 97) + voucher_id), 0) FROM voucher_lines'),
    inventoryLines: one('SELECT COUNT(*) FROM inventory_lines'),
    inventoryQty: one('SELECT COALESCE(SUM(qty_milli * (stock_item_id % 101)), 0) FROM inventory_lines'),
    billRefs: one('SELECT COUNT(*) FROM bill_refs'),
    billRefAmount: one('SELECT COALESCE(SUM(amount), 0) FROM bill_refs'),
    lineLinks: one('SELECT COUNT(*) FROM line_links'),
    openingBills: one('SELECT COUNT(*) FROM opening_bills'),
    ledgers: one('SELECT COUNT(*) FROM ledgers'),
    stockItems: one('SELECT COUNT(*) FROM stock_items'),
    lastNumbers: one("SELECT group_concat(number, ',') FROM (SELECT number FROM vouchers ORDER BY id DESC LIMIT 20)")
  }
}
