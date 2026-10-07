// Test-only helpers for the WP 2.5a trade-cycle dbtests (links, stock, valuation, round trips).
// Not a test file — runs only under `npm run test:db`.
import type { DB } from '../db/connection'
import { seededDb } from '../db/testdb'
import type { LinkType, TradePurpose, VoucherKind } from '@shared/domain'
import type { VoucherInput } from '@shared/schemas'
import { createGodown, createLedger, createStockItem } from './masters'
import { getVoucher, saveVoucher, type SaveVoucherResult } from './vouchers'

export const typeId = (db: DB, kind: VoucherKind): number =>
  (db.prepare('SELECT id FROM voucher_types WHERE kind = ? ORDER BY id LIMIT 1').get(kind) as { id: number }).id

function unitId(db: DB): number {
  return (db.prepare('SELECT id FROM units ORDER BY id LIMIT 1').get() as { id: number }).id
}

export function ledger(db: DB, name: string, group: string): number {
  const g = db.prepare('SELECT id FROM groups WHERE name = ?').get(group) as { id: number }
  return createLedger(db, {
    name, groupId: g.id, openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null,
    tdsSectionId: null, pan: null, creditDays: null, exportType: null
  }).id
}

export function item(
  db: DB,
  name: string,
  opts: { method?: 'weighted_avg' | 'fifo'; serials?: boolean; opening?: [qtyUnits: number, value: number]; gstRate?: number } = {}
): number {
  return createStockItem(db, {
    name, groupId: null, unitId: unitId(db), hsn: '8471', gstRate: opts.gstRate ?? 18, cessRate: null,
    openingQtyMilli: (opts.opening?.[0] ?? 0) * 1000, openingValue: opts.opening?.[1] ?? 0, barcode: null,
    reorderLevelMilli: null, valuationMethod: opts.method ?? 'weighted_avg', trackSerials: opts.serials ?? false
  }).id
}

export interface TradeBooks {
  db: DB
  buyer: number
  buyer2: number
  supplier: number
  sales: number
  purchases: number
  godown: number
  godown2: number
}

export function tradeBooks(): TradeBooks {
  const db = seededDb()
  return {
    db,
    buyer: ledger(db, 'Buyer', 'Sundry Debtors'),
    buyer2: ledger(db, 'Second Buyer', 'Sundry Debtors'),
    supplier: ledger(db, 'Supplier', 'Sundry Creditors'),
    sales: ledger(db, 'Sales', 'Sales Accounts'),
    purchases: ledger(db, 'Purchases', 'Purchase Accounts'),
    godown: createGodown(db, { name: 'Shop', address: null }).id,
    godown2: createGodown(db, { name: 'Store', address: null }).id
  }
}

export interface L {
  item: number
  /** Whole units. */
  qty: number
  amount?: number
  godown?: number | null
  batch?: number | null
  serials?: string[]
  /** Source line uid + link type. */
  from?: string
  link?: LinkType
  uid?: string
}

const header = {
  number: undefined, narration: null, reference: null, instrumentNo: null, instrumentDate: null,
  transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null
}

type InvLine = NonNullable<VoucherInput['inventory']>[number]

export const invLine = (l: L, direction: 'in' | 'out'): InvLine => ({
  stockItemId: l.item, godownId: l.godown ?? null, batchId: l.batch ?? null, qtyMilli: l.qty * 1000,
  ratePaise: l.amount ? Math.round(l.amount / l.qty) : 0, amount: l.amount ?? 0, direction,
  ...(l.serials ? { serials: l.serials } : {}),
  ...(l.uid ? { lineUid: l.uid } : {}),
  ...(l.from ? { source: { lineUid: l.from, linkType: l.link ?? 'fulfil' } } : {})
})

/** A delivery challan (goods out) or GRN (goods in) — no ledger lines. */
export function stockNote(
  b: TradeBooks,
  kind: 'delivery_note' | 'receipt_note',
  date: string,
  lines: L[],
  opts: { id?: number; party?: number; purpose?: TradePurpose; optional?: boolean } = {}
): SaveVoucherResult {
  return saveVoucher(b.db, {
    ...header, voucherTypeId: typeId(b.db, kind), date,
    partyLedgerId: opts.party ?? (kind === 'delivery_note' ? b.buyer : b.supplier),
    ...(opts.purpose ? { trade: { purpose: opts.purpose } } : {}),
    ...(opts.optional !== undefined ? { isOptional: opts.optional } : {}),
    lines: [], inventory: lines.map((l) => invLine(l, kind === 'delivery_note' ? 'out' : 'in')), billRefs: [], tds: null
  }, opts.id)
}

export const dc = (b: TradeBooks, date: string, lines: L[], opts: Parameters<typeof stockNote>[4] = {}): SaveVoucherResult =>
  stockNote(b, 'delivery_note', date, lines, opts)
export const grn = (b: TradeBooks, date: string, lines: L[], opts: Parameters<typeof stockNote>[4] = {}): SaveVoucherResult =>
  stockNote(b, 'receipt_note', date, lines, opts)

/** A trading voucher with balanced party / account lines (no GST, for clean figures). */
export function trade(
  b: TradeBooks,
  kind: 'sales' | 'purchase' | 'credit_note' | 'debit_note',
  date: string,
  lines: L[],
  opts: { id?: number; party?: number; optional?: boolean; postDated?: boolean } = {}
): SaveVoucherResult {
  const total = lines.reduce((s, l) => s + (l.amount ?? 0), 0) || 100
  const salesSide = kind === 'sales' || kind === 'credit_note'
  const party = opts.party ?? (salesSide ? b.buyer : b.supplier)
  const account = salesSide ? b.sales : b.purchases
  const partyDr = kind === 'sales' || kind === 'debit_note'
  const goodsIn = kind === 'purchase' || kind === 'credit_note'
  return saveVoucher(b.db, {
    ...header, voucherTypeId: typeId(b.db, kind), date, partyLedgerId: party,
    ...(opts.optional !== undefined ? { isOptional: opts.optional } : {}),
    ...(opts.postDated !== undefined ? { postDated: opts.postDated } : {}),
    lines: [
      { ledgerId: party, drCr: partyDr ? 'dr' : 'cr', amount: total, costAllocations: [] },
      { ledgerId: account, drCr: partyDr ? 'cr' : 'dr', amount: total, costAllocations: [] }
    ],
    inventory: lines.map((l) => invLine(l, goodsIn ? 'in' : 'out')), billRefs: [], tds: null
  }, opts.id)
}

/** The stable uid of a voucher's line `i`. */
export function uid(db: DB, voucherId: number, i = 0): string {
  return getVoucher(db, voucherId)!.inventory[i]!.lineUid!
}

/** Re-save a voucher exactly as stored (an "alteration" that changes nothing). */
export function resave(db: DB, voucherId: number, patch: (p: VoucherInput) => VoucherInput = (p) => p): SaveVoucherResult {
  const v = getVoucher(db, voucherId)!
  const p: VoucherInput = {
    voucherTypeId: v.voucherTypeId, date: v.date, number: v.number, partyLedgerId: v.partyLedgerId, narration: v.narration,
    reference: v.reference, instrumentNo: v.instrumentNo, instrumentDate: v.instrumentDate, transporterId: v.transporterId,
    vehicleNo: v.vehicleNo, transportDistanceKm: v.transportDistanceKm, posOverride: v.posOverride, currencyCode: v.currencyCode,
    exchangeRate: v.exchangeRate, isOptional: v.isOptional,
    lines: v.lines.map((l) => ({ ledgerId: l.ledgerId, drCr: l.drCr, amount: l.amount, costAllocations: l.costAllocations })),
    inventory: v.inventory.map((l) => ({
      stockItemId: l.stockItemId, godownId: l.godownId, batchId: l.batchId, qtyMilli: l.qtyMilli, ratePaise: l.ratePaise,
      discountPaise: l.discountPaise, amount: l.amount, direction: l.direction, isAbsolute: l.isAbsolute,
      ...(l.serials?.length ? { serials: l.serials } : {}), ...(l.lineUid ? { lineUid: l.lineUid } : {}),
      ...(l.source ? { source: l.source } : {})
    })),
    billRefs: v.billRefs, tds: null, ...(v.trade ? { trade: v.trade } : {})
  }
  return saveVoucher(db, patch(p), voucherId)
}
