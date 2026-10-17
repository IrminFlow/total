// WP 9.3 — Record a purchase: the form's answers (shared/simple/buy.ts purchaseIntentFrom, with
// the defaults simple:buy:setup gives) → simple:post, against the books:
//   - a purchase with GST equals the purchase an accountant types into the purchase editor in a
//     twin company (bill + payment, row for row), opens in that editor and re-saves unchanged, and
//     GSTR-3B's input tax (4A / net ITC) equals the accountant-entered twin's;
//   - an unregistered business books the bill's GST into the cost (products and an expense), the
//     same as the editor's GST-inclusive rates, with no input-tax line and no ITC;
//   - the same supplier's bill number again in the year is refused on the bill-number question
//     with the bill already recorded, and leaves no trace;
//   - part paid = the bill + a payment against it; the purchase list / view say what Outstandings
//     says; the "Pay from" default follows WP 5.6 memory.
import { beforeEach, describe, expect, it } from 'vitest'
import { seededDb, TEST_INFO } from '../db/testdb'
import { readCompanyInfo, writeCompanyInfo } from '../db/seed'
import type { DB } from '../db/connection'
import type { CompanyInfo, Group, Voucher, VoucherKind } from '@shared/domain'
import { gstRegistrationOf } from '@shared/gst/registration'
import { stockItemInputSchema, type VoucherInputParsed } from '@shared/schemas'
import {
  buildAccountingPayload, buildInvoicePayload, derivePartyId, emptyInvoiceState, planVoucherEdit, taxLedgerIdsFrom, taxSideOf, voucherTaxLedgers,
  type AccountingFormState, type EditPlan, type InvoiceFormState
} from '@shared/voucherEdit'
import { emptyMoneyOutForm, moneyOutIntentFrom } from '@shared/simple/money'
import { buyIntentFrom, emptyBuyForm, purchaseIntentFrom, buyFormErrors, buyTotals, type BuyContext, type BuyForm } from '@shared/simple/buy'
import { createLedger, createStockItem, listGroups, listLedgers, listStockItems } from './masters'
import { getVoucher, nextVoucherNumber, saveVoucher } from './vouchers'
import { partyAllocation } from './analysis'
import { gstr3b } from './gst'
import { undoSave } from './undo'
import { postIntent } from './simplePost'
import { buySetup, purchasesList, purchaseView } from './simpleBuy'
import { createMemory } from '../ai/memory'

const INFO: CompanyInfo = { ...TEST_INFO, name: 'Simple Buy Co', gstin: '27AAPFU0939F1ZV', stateCode: '27', gstRegistrationType: 'regular' }
const UNREG: CompanyInfo = { ...TEST_INFO, name: 'Sharma Kirana', gstin: null, stateCode: '27', gstRegistrationType: 'unregistered' }
const TODAY = '2025-08-14'

let db: DB
let info: CompanyInfo
let seq = 0
const groupId = (d: DB, name: string): number => (d.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
const L = (name: string, d: DB = db): number => (d.prepare('SELECT id FROM ledgers WHERE name = ?').get(name) as { id: number }).id
const I = (name: string, d: DB = db): number => (d.prepare('SELECT id FROM stock_items WHERE name = ?').get(name) as { id: number }).id
const typeId = (d: DB, kind: VoucherKind): number => (d.prepare('SELECT id FROM voucher_types WHERE kind = ? ORDER BY id').get(kind) as { id: number }).id
const count = (sql: string, d: DB = db): number => (d.prepare(sql).get() as { n: number }).n

function ledger(d: DB, name: string, group: string, extra: Record<string, unknown> = {}): number {
  return createLedger(d, {
    name, groupId: groupId(d, group), openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null,
    tdsSectionId: null, pan: null, creditDays: null, exportType: null, ...extra
  }).id
}

function company(ci: CompanyInfo): DB {
  const d = seededDb()
  writeCompanyInfo(d, ci)
  ledger(d, 'Purchases', 'Purchase Accounts', { simpleCategory: 'purchases' })
  ledger(d, 'Input CGST', 'Duties & Taxes', { taxType: 'cgst' })
  ledger(d, 'Input SGST', 'Duties & Taxes', { taxType: 'sgst' })
  ledger(d, 'Input IGST', 'Duties & Taxes', { taxType: 'igst' })
  ledger(d, 'Round Off', 'Indirect Expenses')
  ledger(d, 'HDFC Bank', 'Bank Accounts')
  ledger(d, 'Rent', 'Indirect Expenses', { gstRate: 18, simpleCategory: 'rent' })
  ledger(d, 'Electricity', 'Indirect Expenses', { simpleCategory: 'electricity' })
  ledger(d, 'Bharat Steel', 'Sundry Creditors', { stateCode: '27', gstin: '27AABCG3456H1ZN', creditDays: 30 })
  ledger(d, 'Karnataka Mills', 'Sundry Creditors', { stateCode: '29', gstin: '29AABCF9012G1ZQ' })
  const unit = d.prepare("SELECT id FROM units WHERE symbol = 'Nos'").get() as { id: number }
  createStockItem(d, stockItemInputSchema.parse({ name: 'Widget', unitId: unit.id, gstRate: 18, hsn: '8471' }))
  createStockItem(d, stockItemInputSchema.parse({ name: 'Rice', unitId: unit.id, gstRate: 5, hsn: '1006' }))
  return d
}

function invoiceCtx(d: DB) {
  const ledgers = listLedgers(d)
  const items = listStockItems(d)
  return {
    companyStateCode: '27', ...gstRegistrationOf(readCompanyInfo(d)),
    items: new Map(items.map((i) => [i.id, { gstRate: i.gstRate, cessRate: i.cessRate }])),
    ledgers: new Map(ledgers.map((l) => [l.id, { stateCode: l.stateCode, gstRate: l.gstRate, tdsPayableSectionId: l.tdsPayableSectionId }]))
  }
}

/** The renderer's path: the form's answers → purchaseIntentFrom with simple:buy:setup's defaults → simple:post. */
function buy(f: Partial<BuyForm>, d: DB = db, ci: CompanyInfo = info): ReturnType<typeof postIntent> {
  const setup = buySetup(d)
  const ctx: BuyContext = { invoice: invoiceCtx(d), purchaseAccountId: setup.purchaseAccountId }
  const form: BuyForm = { ...emptyBuyForm('2025-08-10', { mode: 'items', ratesIncludeGst: false }), ...f }
  expect(buyFormErrors(form, ctx)).toEqual({})
  const out = postIntent(d, ci, { clientId: `buy-${++seq}-client`, ...purchaseIntentFrom(form, ctx, setup.defaults) }, TODAY)
  // The live total the form showed is what was saved.
  expect(out.facts.total).toBe(buyTotals(form, ctx).total)
  return out
}
const ln = (key: number, item: string, qtyText: string, rate: number, discount: number | null = null) => ({ key, itemId: I(item), qtyText, rate, discount })

// ---------------------------------------------------------------- editor helpers (as simplePost.dbtest)

function kindOf(d: DB, v: Voucher): VoucherKind {
  return (d.prepare('SELECT kind FROM voucher_types WHERE id = ?').get(v.voucherTypeId) as { kind: VoucherKind }).kind
}
function isPartyOrTds(d: DB): (id: number) => boolean {
  const ledgers = listLedgers(d)
  const groups = new Map(listGroups(d).map((g) => [g.id, g]))
  return (id) => {
    const l = ledgers.find((x) => x.id === id)
    if (!l) return false
    for (let g: Group | undefined = groups.get(l.groupId); g; g = g.parentId ? groups.get(g.parentId) : undefined) {
      if (g.name === 'Sundry Debtors' || g.name === 'Sundry Creditors') return true
    }
    return l.tdsSectionId != null
  }
}
function editorResave(d: DB, id: number): { plan: EditPlan; payload: VoucherInputParsed } {
  const v = getVoucher(d, id)!
  const kind = kindOf(d, v)
  const ledgers = listLedgers(d)
  const items = listStockItems(d)
  const plan = planVoucherEdit(v, kind, {
    invoice: invoiceCtx(d), taxLedgers: taxLedgerIdsFrom(ledgers), taxLedgerList: ledgers, manufacture: null, itemName: (i) => items.find((x) => x.id === i)?.name ?? ''
  })
  const r =
    plan.mode === 'invoice'
      ? buildInvoicePayload(plan.state, { ...invoiceCtx(d), kind }, v.voucherTypeId, voucherTaxLedgers(v, ledgers, taxSideOf(kind)))
      : plan.mode === 'accounting'
        ? buildAccountingPayload(plan.state, { kind, voucherTypeId: v.voucherTypeId, derivedPartyId: derivePartyId(plan.state.rows, isPartyOrTds(d), null) })
        : null
  if (!r || !r.ok) throw new Error(`cannot rebuild ${plan.mode}`)
  return { plan, payload: r.payload }
}
function rows(d: DB, id: number): unknown {
  return {
    voucher: d.prepare('SELECT voucher_type_id, date, number, party_ledger_id, narration, reference, instrument_no, instrument_date, pos_override, post_dated, is_optional FROM vouchers WHERE id = ?').get(id),
    lines: d.prepare('SELECT ledger_id, dr_cr, amount, line_order FROM voucher_lines WHERE voucher_id = ? ORDER BY line_order').all(id),
    inventory: d.prepare('SELECT stock_item_id, godown_id, batch_id, qty_milli, rate_paise, discount_paise, amount, direction, moves_stock, line_order FROM inventory_lines WHERE voucher_id = ? ORDER BY line_order').all(id),
    billRefs: d.prepare('SELECT party_ledger_id, kind, name, amount, due_date FROM bill_refs WHERE voucher_id = ? ORDER BY id').all(id)
  }
}
function roundTrips(id: number, mode: EditPlan['mode']): void {
  const before = rows(db, id)
  const { plan, payload } = editorResave(db, id)
  expect(plan.mode).toBe(mode)
  saveVoucher(db, payload, id)
  expect(rows(db, id)).toEqual(before)
}
type HandEntry = { kind: VoucherKind; form: 'invoice'; state: InvoiceFormState } | { kind: VoucherKind; form: 'accounting'; state: AccountingFormState }
/** The same answers typed into the accountant editors of an identical company, in order. */
function handEntered(ci: CompanyInfo, entries: (HandEntry | ((twin: DB) => HandEntry))[]): { twin: DB; ids: number[] } {
  const twin = company(ci)
  const ids = entries.map((x) => {
    const e = typeof x === 'function' ? x(twin) : x
    const vt = typeId(twin, e.kind)
    const r =
      e.form === 'invoice'
        ? buildInvoicePayload(e.state, { ...invoiceCtx(twin), kind: e.kind }, vt, taxLedgerIdsFrom(listLedgers(twin), taxSideOf(e.kind)))
        : buildAccountingPayload(e.state, { kind: e.kind, voucherTypeId: vt, derivedPartyId: derivePartyId(e.state.rows, isPartyOrTds(twin), null) })
    if (!r.ok) throw new Error(r.error)
    return saveVoucher(twin, r.payload).id
  })
  return { twin, ids }
}
const acc = (date: string, rowsIn: AccountingFormState['rows'], billRefs: AccountingFormState['billRefs'], extra: Partial<AccountingFormState> = {}): AccountingFormState => ({
  date, number: '', rows: rowsIn, narration: '', instrumentNo: '', billRefs, advanceReceipt: false, optional: false, tds: null, tcs: null, original: null, ...extra
})
const r = (drCr: 'dr' | 'cr', ledgerId: number, amount: number) => ({ drCr, ledgerId, amount, costAllocations: [] })
const inv = (d: DB, date: string, party: string, rowsIn: [string, string, number][], billName: string, due: string, reference: string | null): InvoiceFormState => ({
  ...emptyInvoiceState(date), partyId: L(party, d), accountId: L('Purchases', d), billName, billDueDate: due, reference,
  rows: rowsIn.map(([item, qtyText, rate]) => ({ itemId: I(item, d), qtyText, rate, discount: null, godownId: null, batchId: null }))
})
function trace(d: DB = db): unknown {
  return {
    vouchers: count('SELECT COUNT(*) AS n FROM vouchers', d),
    lines: count('SELECT COUNT(*) AS n FROM voucher_lines', d),
    ledgers: count('SELECT COUNT(*) AS n FROM ledgers', d),
    posts: count('SELECT COUNT(*) AS n FROM simple_posts', d),
    audit: d.prepare('SELECT COUNT(*) AS n, MAX(id) AS last FROM audit_log').get(),
    next: nextVoucherNumber(d, typeId(d, 'purchase'), TODAY)
  }
}
const itcOf = (d: DB, ci: CompanyInfo) => {
  const g = gstr3b(d, ci, '2025-08-01', '2025-08-31', '082025')
  return { itc: g.itc, itcParts: g.itcParts }
}

beforeEach(() => {
  info = INFO
  db = company(INFO)
})

describe('WP 9.3 Record a purchase: the form → simple:post = the purchase an accountant enters', () => {
  it('products with GST (intra + inter-state) and an expense with GST: row for row the hand-entered bills; GSTR-3B input tax equals the twin’s', () => {
    // 1. Bharat Steel (MH): 10 Widgets at ₹100 before GST, part paid ₹500 by bank.
    const a = buy({ supplierId: L('Bharat Steel'), billNo: 'BS/101', paid: 'part', partHow: 'bank', partAmount: 50_000, lines: [ln(1, 'Widget', '10', 10_000)] })
    // 2. Karnataka Mills (KA): 20 Rice at ₹52.50 incl. 5 % GST (IGST), not paid yet.
    const b = buy({ supplierId: L('Karnataka Mills'), billNo: 'KM-7', ratesIncludeGst: true, lines: [ln(1, 'Rice', '20', 5_250)] })
    // 3. Bharat Steel: rent ₹1,000 before GST (Rent carries 18 %), paid in full from the bank.
    const c = buy({ supplierId: L('Bharat Steel'), billNo: 'RENT-AUG', mode: 'expense', categoryId: L('Rent'), amount: 100_000, paid: 'bank' })

    const [bill1, pay1] = a.voucherIds as [number, number]
    const [bill2] = b.voucherIds as [number]
    const [bill3, pay3] = c.voucherIds as [number, number]
    roundTrips(bill1, 'invoice')
    roundTrips(pay1, 'accounting')
    roundTrips(bill2, 'invoice')
    roundTrips(bill3, 'accounting')
    roundTrips(pay3, 'accounting')
    expect(getVoucher(db, bill1)!).toMatchObject({ date: '2025-08-10', reference: 'BS/101' })
    expect(a.facts).toMatchObject({ total: 118_000, tax: 18_000, paid: 50_000, due: 68_000, dueDate: '2025-09-09' })
    expect(b.facts).toMatchObject({ total: 105_000, tax: 5_000, paid: 0 })

    // The same bills typed into the purchase / payment editors of a twin company, in the same order.
    const { twin, ids } = handEntered(INFO, [
      (t) => ({ kind: 'purchase', form: 'invoice', state: inv(t, '2025-08-10', 'Bharat Steel', [['Widget', '10', 10_000]], 'BS/101', '2025-09-09', 'BS/101') }),
      (t) => ({ kind: 'payment', form: 'accounting', state: acc('2025-08-10', [r('dr', L('Bharat Steel', t), 50_000), r('cr', L('HDFC Bank', t), 50_000)], [{ kind: 'against', name: 'BS/101', amount: 50_000, dueDate: null }]) }),
      (t) => ({ kind: 'purchase', form: 'invoice', state: inv(t, '2025-08-10', 'Karnataka Mills', [['Rice', '20', 5_000]], 'KM-7', '2025-08-10', 'KM-7') }),
      (t) => ({
        kind: 'purchase', form: 'accounting',
        state: acc('2025-08-10', [r('cr', L('Bharat Steel', t), 118_000), r('dr', L('Rent', t), 100_000), r('dr', L('Input CGST', t), 9_000), r('dr', L('Input SGST', t), 9_000)], [{ kind: 'new', name: 'RENT-AUG', amount: 118_000, dueDate: '2025-09-09' }], { reference: 'RENT-AUG' })
      }),
      (t) => ({ kind: 'payment', form: 'accounting', state: acc('2025-08-10', [r('dr', L('Bharat Steel', t), 118_000), r('cr', L('HDFC Bank', t), 118_000)], [{ kind: 'against', name: 'RENT-AUG', amount: 118_000, dueDate: null }]) })
    ])
    const mine = [bill1, pay1, bill2, bill3, pay3]
    mine.forEach((id, i) => expect(rows(twin, ids[i]!), `entry ${i}`).toEqual(rows(db, id)))

    // GSTR-3B: the claimable input tax is the accountant-entered twin's, to the paisa.
    const simple = itcOf(db, INFO)
    expect(simple).toEqual(itcOf(twin, INFO))
    expect(simple.itc).toMatchObject({ igst: 5_000, cgst: 18_000, sgst: 18_000 })
  })

  it('an unregistered business books the bill’s GST into the cost — the editor’s GST-inclusive rates, no input tax, no ITC', () => {
    info = UNREG
    db = company(UNREG)
    // Products typed before GST: Rice 5 % → ₹105 a unit of cost.
    const a = buy({ supplierId: L('Bharat Steel'), billNo: 'K-1', lines: [ln(1, 'Rice', '10', 10_000)] }, db, UNREG)
    // Products typed with GST (what was paid): the price is the cost.
    const b = buy({ supplierId: L('Bharat Steel'), billNo: 'K-2', ratesIncludeGst: true, lines: [ln(1, 'Widget', '2', 11_800)] }, db, UNREG)
    // An expense by category, before GST at the rate printed (18 %): ₹1,180 of rent.
    const c = buy({ supplierId: L('Bharat Steel'), billNo: 'K-3', mode: 'expense', categoryId: L('Electricity'), amount: 100_000, gstRate: 18, paid: 'cash' }, db, UNREG)
    expect([a.facts.total, b.facts.total, c.facts.total]).toEqual([105_000, 23_600, 118_000])
    for (const out of [a, b, c]) {
      const v = getVoucher(db, out.voucherIds[0]!)!
      expect(v.lines.some((l) => [L('Input CGST'), L('Input SGST'), L('Input IGST')].includes(l.ledgerId))).toBe(false)
    }
    roundTrips(a.voucherIds[0]!, 'invoice')
    roundTrips(b.voucherIds[0]!, 'invoice')
    roundTrips(c.voucherIds[0]!, 'accounting')
    const { twin, ids } = handEntered(UNREG, [
      (t) => ({ kind: 'purchase', form: 'invoice', state: inv(t, '2025-08-10', 'Bharat Steel', [['Rice', '10', 10_500]], 'K-1', '2025-09-09', 'K-1') }),
      (t) => ({ kind: 'purchase', form: 'invoice', state: inv(t, '2025-08-10', 'Bharat Steel', [['Widget', '2', 11_800]], 'K-2', '2025-09-09', 'K-2') }),
      (t) => ({ kind: 'purchase', form: 'accounting', state: acc('2025-08-10', [r('cr', L('Bharat Steel', t), 118_000), r('dr', L('Electricity', t), 118_000)], [{ kind: 'new', name: 'K-3', amount: 118_000, dueDate: '2025-09-09' }], { reference: 'K-3' }) })
    ])
    expect(rows(twin, ids[0]!)).toEqual(rows(db, a.voucherIds[0]!))
    expect(rows(twin, ids[1]!)).toEqual(rows(db, b.voucherIds[0]!))
    expect(rows(twin, ids[2]!)).toEqual(rows(db, c.voucherIds[0]!))
    // The stock is valued at what it cost, GST included.
    expect(getVoucher(db, a.voucherIds[0]!)!.inventory[0]).toMatchObject({ ratePaise: 10_500, amount: 105_000 })
  })

  it('the same supplier bill again in the year: refused on the bill number with the bill already recorded, no trace', () => {
    const first = buy({ supplierId: L('Bharat Steel'), billNo: 'BS/101', lines: [ln(1, 'Widget', '1', 10_000)] })
    const setup = buySetup(db)
    const ctx: BuyContext = { invoice: invoiceCtx(db), purchaseAccountId: setup.purchaseAccountId }
    const again = { ...emptyBuyForm('2025-08-12', { mode: 'expense', ratesIncludeGst: false }), supplierId: L('Bharat Steel'), billNo: 'bs 101', categoryId: L('Rent'), amount: 5_000, paid: 'cash' as const }
    const before = trace()
    expect(() => postIntent(db, INFO, { clientId: 'dup-client-1', ...purchaseIntentFrom(again, ctx, setup.defaults) }, TODAY)).toThrow(
      expect.objectContaining({ code: 'simple_duplicate_bill', field: 'billNo', params: expect.objectContaining({ voucherId: first.voucherIds[0] }) })
    )
    expect(trace()).toEqual(before)
    // Another supplier's bill with that number is fine.
    expect(buy({ supplierId: L('Karnataka Mills'), billNo: 'BS/101', lines: [ln(1, 'Rice', '1', 1_000)] }).voucherIds).toHaveLength(1)
  })

  it('part paid: the purchase list and the bill view say what the Outstandings allocation says; Undo bins both together', () => {
    const out = buy({ supplierId: L('Bharat Steel'), billNo: 'BS/9', paid: 'part', partHow: 'cash', partAmount: 50_000, lines: [ln(1, 'Widget', '2', 50_000)] })
    const [bill, pay] = out.voucherIds as [number, number]
    expect(out.entries.map((e) => [e.role, e.kind])).toEqual([['bill', 'purchase'], ['payment', 'payment']])
    const row = purchasesList(db, '2025-04-01', TODAY, TODAY).find((x) => x.voucherId === bill)!
    expect(row).toMatchObject({ billNo: 'BS/9', partyName: 'Bharat Steel', total: 118_000, tax: 18_000, paid: 50_000, due: 68_000, dueDate: '2025-09-09' })
    expect(partyAllocation(db, L('Bharat Steel'), TODAY).bills.find((b) => b.number === 'BS/9')!.pending).toBe(row.due)
    expect(purchaseView(db, bill, TODAY)).toMatchObject({ total: 118_000, tax: 18_000, paid: 50_000, due: 68_000, items: [{ name: 'Widget', qtyMilli: 2000, ratePaise: 50_000 }] })
    expect(purchaseView(db, pay, TODAY)).toBeNull()
    // An expense bill's view lists the account it was charged to.
    const rent = buy({ supplierId: L('Karnataka Mills'), billNo: 'R-1', mode: 'expense', categoryId: L('Rent'), amount: 10_000 })
    expect(purchaseView(db, rent.voucherIds[0]!, TODAY)).toMatchObject({ amounts: [{ name: 'Rent', amount: 10_000 }], tax: 1_800, total: 11_800, due: 11_800 })
    // Undo bins the bill and its payment as one group: off the list.
    undoSave(db, out.voucherIds)
    expect(purchasesList(db, '2025-04-01', TODAY, TODAY).some((x) => x.voucherId === bill)).toBe(false)
    expect(count(`SELECT COUNT(*) AS n FROM vouchers WHERE id IN (${bill}, ${pay}) AND deleted_at IS NOT NULL`)).toBe(2)
  })

  it('review: nil-rated products on a bill without GST post with no tax; the bill view carries the rupee round-off', () => {
    const unit = db.prepare("SELECT id FROM units WHERE symbol = 'Nos'").get() as { id: number }
    createStockItem(db, stockItemInputSchema.parse({ name: 'Loose salt', unitId: unit.id, gstRate: 0, hsn: '2501' }))
    const salt = buy({ supplierId: L('Bharat Steel'), billNo: 'S-1', gstOnBill: false, lines: [ln(1, 'Loose salt', '3', 1_030)] })
    const v = getVoucher(db, salt.voucherIds[0]!)!
    expect(salt.facts).toMatchObject({ total: 3_100, tax: 0 })
    expect(v.lines.some((l) => [L('Input CGST'), L('Input SGST'), L('Input IGST')].includes(l.ledgerId))).toBe(false)
    roundTrips(v.id, 'invoice')
    // Products that carry GST are still refused without it (main too).
    const setup = buySetup(db)
    const ctx: BuyContext = { invoice: invoiceCtx(db), purchaseAccountId: setup.purchaseAccountId }
    const taxed = { ...emptyBuyForm('2025-08-10', { mode: 'items', ratesIncludeGst: false }), supplierId: L('Bharat Steel'), gstOnBill: false, lines: [ln(1, 'Widget', '1', 10_000)] }
    expect(() => postIntent(db, INFO, { clientId: 'taxed-no-gst-1', ...purchaseIntentFrom(taxed, ctx, setup.defaults) }, TODAY)).toThrow(expect.objectContaining({ code: 'simple_items_no_gst', field: 'gstOnBill' }))
    // ₹31.00 from ₹30.90: rounded up ₹0.10 — the view says so (lines + round-off = total).
    expect(purchaseView(db, v.id, TODAY)).toMatchObject({ total: 3_100, rounding: 10, items: [{ amount: 3_090 }] })
    // A rounded-down bill: Widget at ₹100.30 + 18 % = ₹118.36 → ₹118.00.
    const down = buy({ supplierId: L('Bharat Steel'), billNo: 'W-1', lines: [ln(1, 'Widget', '1', 10_030)] })
    const view = purchaseView(db, down.voucherIds[0]!, TODAY)!
    expect(view.total).toBe(11_800)
    expect(view.items[0]!.amount + view.tax + view.rounding).toBe(view.total)
    expect(view.rounding).toBeLessThan(0)
  })

  it('the "Pay from" default: WP 5.6 memory (a bank), else the counter / first bank; suppliers are the creditors', () => {
    const sbi = ledger(db, 'SBI', 'Bank Accounts')
    expect(buySetup(db)).toMatchObject({ defaults: { upi: L('HDFC Bank'), card: L('HDFC Bank'), bank: L('HDFC Bank') }, memoryId: null, purchaseAccountId: L('Purchases') })
    const m = createMemory(db, { kind: 'preference', text: 'Pay suppliers from SBI', data: { purpose: 'payment', ledgerId: sbi } }, { source: 'user', status: 'active', createdBy: null })
    expect(buySetup(db)).toMatchObject({ defaults: { upi: sbi, card: sbi, bank: sbi }, memoryId: m.id })
    expect(buySetup(db).suppliers.map((s) => s.name)).toEqual(['Bharat Steel', 'Karnataka Mills'])
  })
})

describe('PR #171 review: an amount typed WITH GST is the printed total, in every registration', () => {
  // Hand-worked (18 %, intra-state):
  //   ₹1,180.50 → before GST 118050 / 1.18 = 100042.37 → ₹1,000.42; CGST = SGST = 9 % × 100042 = 9003.78 → ₹90.04;
  //               100042 + 9004 + 9004 = 118050 → no round off.
  //   ₹999.99   → 99999 / 1.18 = 84745.0 → ₹847.45; 9 % × 84745 = 7627.05 → ₹76.27; 84745 + 7627 + 7627 = 99999.
  const CASES = [
    { total: 118_050, taxable: 100_042, half: 9_004 },
    { total: 99_999, taxable: 84_745, half: 7_627 }
  ]
  it('regular: the bill is the typed total (no rupee rounding), the money paid too; GSTR-3B = the accountant-entered twin', () => {
    const outs = CASES.map((c, i) =>
      buy({ supplierId: L('Bharat Steel'), billNo: `T-${i}`, mode: 'expense', categoryId: L('Rent'), amount: c.total, gstRate: 18, ratesIncludeGst: true, paid: 'bank' })
    )
    outs.forEach((o, i) => {
      const c = CASES[i]!
      const v = getVoucher(db, o.voucherIds[0]!)!
      expect(v.lines.map((l) => [l.ledgerId, l.drCr, l.amount])).toEqual([
        [L('Bharat Steel'), 'cr', c.total], [L('Rent'), 'dr', c.taxable], [L('Input CGST'), 'dr', c.half], [L('Input SGST'), 'dr', c.half]
      ])
      expect(getVoucher(db, o.voucherIds[1]!)!.lines.find((l) => l.ledgerId === L('HDFC Bank'))).toMatchObject({ drCr: 'cr', amount: c.total })
      roundTrips(o.voucherIds[0]!, 'accounting')
    })
    const { twin } = handEntered(
      INFO,
      CASES.map((c, i) => (t: DB) => ({
        kind: 'purchase' as const, form: 'accounting' as const,
        state: acc('2025-08-10', [r('cr', L('Bharat Steel', t), c.total), r('dr', L('Rent', t), c.taxable), r('dr', L('Input CGST', t), c.half), r('dr', L('Input SGST', t), c.half)], [{ kind: 'new', name: `T-${i}`, amount: c.total, dueDate: '2025-09-09' }], { reference: `T-${i}` })
      }))
    )
    expect(itcOf(db, INFO)).toEqual(itcOf(twin, INFO))
    expect(itcOf(db, INFO).itc).toMatchObject({ cgst: 9_004 + 7_627, sgst: 9_004 + 7_627 })
  })

  it('unregistered / composition: what was paid is the cost to the paisa — no round-off line, no simple_bill_total refusal', () => {
    for (const ci of [UNREG, { ...UNREG, name: 'Comp Co', gstin: '27AAPFU0939F1ZV', gstRegistrationType: 'composition' as const }]) {
      info = ci
      db = company(ci)
      for (const c of CASES) {
        const o = buy({ supplierId: L('Bharat Steel'), billNo: `U-${c.total}`, mode: 'expense', categoryId: L('Rent'), amount: c.total, gstRate: 18, ratesIncludeGst: true, paid: 'cash' }, db, ci)
        expect(o.facts.total).toBe(c.total)
        const v = getVoucher(db, o.voucherIds[0]!)!
        expect(v.lines.map((l) => [l.ledgerId, l.drCr, l.amount])).toEqual([[L('Bharat Steel'), 'cr', c.total], [L('Rent'), 'dr', c.total]])
        roundTrips(o.voucherIds[0]!, 'accounting')
      }
    }
  })
})

describe('to-do §4: a cash expense with no supplier is Money out’s expense entry', () => {
  const ctxOf = (d: DB): { ctx: BuyContext; defaults: ReturnType<typeof buySetup>['defaults'] } => {
    const setup = buySetup(d)
    return { ctx: { invoice: invoiceCtx(d), purchaseAccountId: setup.purchaseAccountId }, defaults: setup.defaults }
  }
  const noSupplier = (patch: Partial<BuyForm> = {}): BuyForm => ({
    ...emptyBuyForm('2025-08-10', { mode: 'expense', ratesIncludeGst: true }), mode: 'expense', categoryId: L('Electricity'), amount: 85_050, paid: 'cash', gstOnBill: false, note: 'August', ...patch
  })

  it('= the entry Money out posts for the same expense in a twin company; same GSTR-3B; not a bill; Undo bins it', () => {
    const { ctx, defaults } = ctxOf(db)
    const form = noSupplier()
    expect(buyFormErrors(form, ctx)).toEqual({})
    const out = postIntent(db, info, { clientId: 'cash-expense-1', ...buyIntentFrom(form, ctx, defaults) }, TODAY)
    expect(out.entries.map((e) => e.kind)).toEqual(['payment'])
    expect(out.facts).toMatchObject({ kind: 'money_out', total: 85_050, paid: 85_050, toName: 'Electricity' })

    const twin = company(INFO)
    const tw = postIntent(
      twin, INFO,
      { clientId: 'twin-money-out-1', ...moneyOutIntentFrom({ ...emptyMoneyOutForm('2025-08-10'), who: 'expense', amount: 85_050, how: 'cash', payeeId: L('Electricity', twin), note: 'August' }, [], ctxOf(twin).defaults,
        { facts: gstRegistrationOf(INFO), companyStateCode: '27', supplierState: () => null, drawingsId: null }) },
      TODAY
    )
    expect(rows(db, out.voucherIds[0]!)).toEqual(rows(twin, tw.voucherIds[0]!))
    expect(itcOf(db, INFO)).toEqual(itcOf(twin, INFO))

    // It is the payment it is: no purchase bill, so no supplier on the purchase list; it re-opens in
    // the payment editor unchanged.
    expect(purchasesList(db, '2025-04-01', TODAY, TODAY)).toEqual([])
    roundTrips(out.voucherIds[0]!, 'accounting')
    // Undo bins a fresh one (a group of one) — the first was re-saved by the editor round trip.
    const again = postIntent(db, info, { clientId: 'cash-expense-1b', ...buyIntentFrom(form, ctx, defaults) }, TODAY)
    undoSave(db, again.voucherIds)
    expect(count(`SELECT COUNT(*) AS n FROM vouchers WHERE id = ${again.voucherIds[0]} AND deleted_at IS NOT NULL`)).toBe(1)
  })

  it('a company that can’t claim GST: before GST typed = the folded cost; not yet / partly / a GST bill to claim / products still need the supplier', () => {
    const d = company(UNREG)
    const { ctx, defaults } = ctxOf(d)
    const rent = L('Rent', d)
    const out = postIntent(d, UNREG, { clientId: 'cash-expense-2', ...buyIntentFrom(noSupplier({ categoryId: rent, amount: 100_000, ratesIncludeGst: false, gstRate: 18 }), ctx, defaults) }, TODAY)
    expect(out.facts.total).toBe(118_000)
    const lines = d.prepare('SELECT ledger_id, dr_cr, amount FROM voucher_lines WHERE voucher_id = ? ORDER BY line_order').all(out.voucherIds[0]!)
    expect(lines).toEqual([{ ledger_id: rent, dr_cr: 'dr', amount: 118_000 }, { ledger_id: buySetup(d).defaults.cash, dr_cr: 'cr', amount: 118_000 }])

    const regular = ctxOf(db).ctx
    expect(buyFormErrors(noSupplier({ paid: 'credit' }), regular).party).toBe('simple.buy.err.supplierOwe')
    expect(buyFormErrors(noSupplier({ paid: 'part', partAmount: 100 }), regular).party).toBe('simple.buy.err.supplierOwe')
    expect(buyFormErrors(noSupplier({ gstOnBill: true, gstRate: 18 }), regular).party).toBe('simple.buy.err.supplierGst')
    expect(buyFormErrors(noSupplier({ mode: 'items', lines: [ln(1, 'Widget', '1', 100)] }), regular).party).toBe('simple.buy.err.supplier')
  })
})
