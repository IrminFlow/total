// WP 5.3 — the drafting dbtests' shared company fixture and helpers (not a test file).
import { seededDb, TEST_INFO } from '../db/testdb'
import type { DB } from '../db/connection'
import type { CompanyInfo, Voucher } from '@shared/domain'
import type { AiVoucherDraftPayload } from '@shared/ai'
import { stockItemInputSchema, type VoucherInputParsed } from '@shared/schemas'
import { buildInvoicePayload, planVoucherEdit, taxLedgerIdsFrom, taxSideOf, type InvoiceFormState } from '@shared/voucherEdit'
import { createLedger, createStockItem, listLedgers, listStockItems } from '../services/masters'
import { getVoucher, nextVoucherNumber } from '../services/vouchers'
import { getManufactureDetails } from '../services/manufacture'
import { saveBomVersion } from '../services/bom'
import { createToolRegistry } from './tools'
import type { ToolContext } from './tools/registry'
import * as store from './store'

export const INFO: CompanyInfo = { ...TEST_INFO, name: 'Draft Test Co', gstin: '27AAPFU0939F1ZV', stateCode: '27' }
export const TODAY = '2025-08-14' // a Thursday

export let db: DB = null as unknown as DB
export type Key = 'cash' | 'sales' | 'purchase' | 'cgst' | 'sgst' | 'igst' | 'bank' | 'rent' | 'power' | 'umbrella' | 'krishnaEnt' | 'krishnaEl' | 'bharat' | 'laptop' | 'mouse' | 'rod' | 'chair'
export const ids = {} as Record<Key, number>

export const groupId = (name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
export const typeId = (kind: string): number => (db.prepare('SELECT id FROM voucher_types WHERE kind = ? ORDER BY id').get(kind) as { id: number }).id
export const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n

export function ledger(name: string, group: string, extra: Record<string, unknown> = {}): number {
  return createLedger(db, {
    name, groupId: groupId(group), openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null,
    tdsSectionId: null, pan: null, creditDays: null, exportType: null, ...extra
  }).id
}
export function item(name: string, gstRate: number | null, opening: [number, number] = [0, 0], extra: Record<string, unknown> = {}): number {
  const unit = db.prepare("SELECT id FROM units WHERE symbol = 'Nos'").get() as { id: number }
  return createStockItem(db, stockItemInputSchema.parse({ name, unitId: unit.id, gstRate, hsn: '8471', openingQtyMilli: opening[0], openingValue: opening[1], ...extra })).id
}

export function fixture(): void {
  db = seededDb()
  ids.cash = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
  ids.sales = ledger('Sales A/c', 'Sales Accounts')
  ids.purchase = ledger('Purchase A/c', 'Purchase Accounts')
  ids.cgst = ledger('CGST', 'Duties & Taxes', { taxType: 'cgst' })
  ids.sgst = ledger('SGST', 'Duties & Taxes', { taxType: 'sgst' })
  ids.igst = ledger('IGST', 'Duties & Taxes', { taxType: 'igst' })
  ids.bank = ledger('HDFC Bank', 'Bank Accounts')
  ledger('Round Off', 'Indirect Expenses')
  ids.rent = ledger('Shop Rent', 'Indirect Expenses')
  ids.power = ledger('Electricity Charges', 'Indirect Expenses')
  ids.umbrella = ledger('Umbrella Retail', 'Sundry Debtors', { gstin: '27AABCD1234E1Z8', stateCode: '27', creditDays: 30 })
  ids.krishnaEnt = ledger('Krishna Enterprises', 'Sundry Debtors', { gstin: '29AABCF9012G1ZQ', stateCode: '29' })
  ids.krishnaEl = ledger('Krishna Electricals', 'Sundry Debtors', { stateCode: '27' })
  ids.bharat = ledger('Bharat Steel Suppliers', 'Sundry Creditors', { gstin: '27AABCG3456H1ZN', stateCode: '27' })
  ids.laptop = item('Laptop 14"', 18, [10_000, 40_000_000], { barcode: 'LAP14' })
  ids.mouse = item('Wireless Mouse', 18, [50_000, 3_000_000])
  ids.rod = item('Steel Rod', 18, [100_000, 1_500_000])
  ids.chair = item('Chair', 18)
  saveBomVersion(db, { itemId: ids.chair, name: 'v1', isDefault: true, lines: [{ componentId: ids.rod, qtyMilliPerUnit: 2000 }] })
}

export function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    db, company: INFO, role: 'accountant', userName: 'Arun', threadId: null, messageId: null, today: TODAY,
    period: { from: '2025-04-01', to: '2026-03-31' }, userRequest: 'record this entry', ...over
  }
}

export const registry = createToolRegistry()
export async function draft(tool: string, args: Record<string, unknown>, over: Partial<ToolContext> = {}): Promise<{ ok: boolean; data: any; error?: string; draftId: number | null }> {
  const r = await registry.run(tool, JSON.stringify(args), ctx(over))
  return r.ok ? { ok: true, data: r.data, draftId: r.draftId } : { ok: false, data: null, error: r.error, draftId: null }
}
export const payloadOf = (draftId: number): AiVoucherDraftPayload => store.getDraft(db, draftId)!.payload

/** The books' own rows of a voucher, ids and timestamps stripped — "identical rows". */
export function rowsOf(voucherId: number): unknown {
  const v = getVoucher(db, voucherId)!
  return {
    lines: v.lines.map((l) => ({ ledgerId: l.ledgerId, drCr: l.drCr, amount: l.amount })),
    inventory: v.inventory.map((l) => ({ item: l.stockItemId, qty: l.qtyMilli, rate: l.ratePaise, disc: l.discountPaise, amount: l.amount, dir: l.direction, src: l.source ?? null })),
    billRefs: v.billRefs.map((b) => ({ kind: b.kind, name: b.name, amount: b.amount, due: b.dueDate })),
    party: v.partyLedgerId,
    narration: v.narration,
    pos: v.posOverride,
    date: v.date
  }
}

export function planOf(v: Voucher, kind: Parameters<typeof planVoucherEdit>[1]) {
  const ledgers = listLedgers(db)
  const items = listStockItems(db)
  return planVoucherEdit(v, kind, {
    invoice: {
      companyStateCode: INFO.stateCode,
      items: new Map(items.map((i) => [i.id, { gstRate: i.gstRate, cessRate: i.cessRate }])),
      ledgers: new Map(ledgers.map((l) => [l.id, { stateCode: l.stateCode, gstRate: l.gstRate, tdsPayableSectionId: l.tdsPayableSectionId }]))
    },
    taxLedgers: taxLedgerIdsFrom(ledgers),
    taxLedgerList: ledgers,
    manufacture: v.id ? getManufactureDetails(db, v.id) : null,
    itemName: (id) => items.find((i) => i.id === id)?.name ?? ''
  })
}

/** What InvoiceEntry posts for a draft's state: bill name = the auto number, tax ledgers as found. */
export function invoiceEditorPayload(state: InvoiceFormState, kind: 'sales' | 'purchase' | 'credit_note' | 'debit_note', vtId: number): VoucherInputParsed {
  const ledgers = listLedgers(db)
  const items = listStockItems(db)
  const number = nextVoucherNumber(db, vtId, state.date)
  const r = buildInvoicePayload(
    { ...state, billName: state.billName || number },
    {
      kind, companyStateCode: INFO.stateCode,
      items: new Map(items.map((i) => [i.id, { gstRate: i.gstRate, cessRate: i.cessRate }])),
      ledgers: new Map(ledgers.map((l) => [l.id, { stateCode: l.stateCode, gstRate: l.gstRate, tdsPayableSectionId: l.tdsPayableSectionId }]))
    },
    vtId,
    taxLedgerIdsFrom(ledgers, taxSideOf(kind))
  )
  if (!r.ok) throw new Error(r.error)
  return r.payload
}

export const BLANK = {
  partyLedgerId: null, narration: null, reference: null, instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null,
  transportDistanceKm: null, posOverride: null, currencyCode: null, exchangeRate: null
}
