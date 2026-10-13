// WP 9.1 — simple:post invariants. Every intent kind saved through postIntent:
//   - opens in its accountant editor (planVoucherEdit) and re-saves byte-for-byte;
//   - equals the voucher an accountant enters by hand in that editor (a twin company, same masters);
// plus: rehearsal (preview) and refused posts leave no trace; idempotent clientId; one undo group;
// lock / credit hold / closed year / stock refusals come back on the intent's fields; an
// unregistered company's sale has no tax; a part-paid sale is an invoice + a receipt against it;
// money in oldest first equals the Outstandings engine; move money is a contra.
import { beforeEach, describe, expect, it } from 'vitest'
import { seededDb, TEST_INFO } from '../db/testdb'
import { readCompanyInfo, writeCompanyInfo } from '../db/seed'
import { MIGRATIONS } from '../db/migrations'
import type { DB } from '../db/connection'
import type { CompanyInfo, Group, Voucher, VoucherKind } from '@shared/domain'
import { gstRegistrationOf } from '@shared/gst/registration'
import { stockItemInputSchema, type VoucherInputParsed } from '@shared/schemas'
import {
  buildAccountingPayload, buildInvoicePayload, derivePartyId, emptyInvoiceState, planVoucherEdit, taxLedgerIdsFrom, taxSideOf, voucherTaxLedgers,
  type AccountingFormState, type EditPlan, type InvoiceFormState
} from '@shared/voucherEdit'
import { createLedger, createStockItem, listGroups, listLedgers, listStockItems } from './masters'
import { getVoucher, nextVoucherNumber, saveVoucher, setLockDate } from './vouchers'
import { partyAllocation } from './analysis'
import { setCreditHold } from './receivables'
import { postClose } from './yearEnd'
import { getFeatures, setFeatures } from './config'
import { restoreFromBin, undoSave } from './undo'
import { previewIntent, postIntent } from './simplePost'
import { saleView, salesList, sellSetup } from './simpleSell'
import { createMemory } from '../ai/memory'
import { emptySellForm, saleIntentFrom, sellFormErrors, sellTotals, type SellContext, type SellForm } from '@shared/simple/sell'

const INFO: CompanyInfo = { ...TEST_INFO, name: 'Simple Post Co', gstin: '27AAPFU0939F1ZV', stateCode: '27', gstRegistrationType: 'regular' }
const TODAY = '2025-08-14'

let db: DB
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

function company(info: CompanyInfo = INFO): DB {
  const d = seededDb()
  writeCompanyInfo(d, info)
  ledger(d, 'Sales', 'Sales Accounts')
  ledger(d, 'Purchases', 'Purchase Accounts')
  ledger(d, 'CGST', 'Duties & Taxes', { taxType: 'cgst' })
  ledger(d, 'SGST', 'Duties & Taxes', { taxType: 'sgst' })
  ledger(d, 'IGST', 'Duties & Taxes', { taxType: 'igst' })
  ledger(d, 'Round Off', 'Indirect Expenses')
  ledger(d, 'HDFC Bank', 'Bank Accounts')
  ledger(d, 'Rent', 'Indirect Expenses', { gstRate: 18 })
  ledger(d, "Owner's money", 'Capital Account')
  ledger(d, "Owner's drawings", 'Capital Account')
  ledger(d, 'Ramesh', 'Sundry Debtors', { stateCode: '27', creditDays: 15 })
  ledger(d, 'Kumar', 'Sundry Debtors', { stateCode: '29', gstin: '29AABCF9012G1ZQ' })
  ledger(d, 'Bharat Steel', 'Sundry Creditors', { stateCode: '27', gstin: '27AABCG3456H1ZN' })
  const unit = d.prepare("SELECT id FROM units WHERE symbol = 'Nos'").get() as { id: number }
  createStockItem(d, stockItemInputSchema.parse({ name: 'Widget', unitId: unit.id, gstRate: 18, hsn: '8471', openingQtyMilli: 100_000, openingValue: 1_000_000 }))
  createStockItem(d, stockItemInputSchema.parse({ name: 'Rice', unitId: unit.id, gstRate: 5, hsn: '1006', openingQtyMilli: 50_000, openingValue: 150_000 }))
  return d
}

const post = (intent: Record<string, unknown>, d: DB = db, info: CompanyInfo = INFO) => postIntent(d, info, { clientId: `client-${++seq}-x`, ...intent }, TODAY)

// ---------------------------------------------------------------- editor helpers

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

function invoiceCtx(d: DB) {
  const ledgers = listLedgers(d)
  const items = listStockItems(d)
  return {
    companyStateCode: INFO.stateCode, ...gstRegistrationOf(readCompanyInfo(d)),
    items: new Map(items.map((i) => [i.id, { gstRate: i.gstRate, cessRate: i.cessRate }])),
    ledgers: new Map(ledgers.map((l) => [l.id, { stateCode: l.stateCode, gstRate: l.gstRate, tdsPayableSectionId: l.tdsPayableSectionId }]))
  }
}

/** What the accountant editor posts when it opens `id` and the user hits Save. */
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

/** Every stored row of a voucher, ids stripped. */
function rows(d: DB, id: number): unknown {
  return {
    voucher: d.prepare('SELECT voucher_type_id, date, number, party_ledger_id, narration, reference, instrument_no, instrument_date, pos_override, post_dated, is_optional FROM vouchers WHERE id = ?').get(id),
    lines: d.prepare('SELECT ledger_id, dr_cr, amount, line_order FROM voucher_lines WHERE voucher_id = ? ORDER BY line_order').all(id),
    inventory: d.prepare('SELECT stock_item_id, godown_id, batch_id, qty_milli, rate_paise, discount_paise, amount, direction, moves_stock, line_order FROM inventory_lines WHERE voucher_id = ? ORDER BY line_order').all(id),
    billRefs: d.prepare('SELECT party_ledger_id, kind, name, amount, due_date FROM bill_refs WHERE voucher_id = ? ORDER BY id').all(id),
    links: d.prepare("SELECT from_voucher_id, link_type, qty_milli FROM line_links WHERE to_voucher_id = ? ORDER BY id").all(id)
  }
}

/** Opens in its editor (expected mode) and re-saves unchanged. */
function roundTrips(id: number, mode: EditPlan['mode']): void {
  const before = rows(db, id)
  const { plan, payload } = editorResave(db, id)
  expect(plan.mode).toBe(mode)
  // A sales / purchase / note without item lines opens in the accounting form — the editor's own
  // mode for it (the only reason it gives); receipts, payments and contras open there by kind.
  if (plan.mode === 'accounting') expect([null, 'it has no item lines']).toContain(plan.fallbackReason)
  saveVoucher(db, payload, id)
  expect(rows(db, id)).toEqual(before)
}

/** The hand-entered twin: the same answers typed into the accountant editors of an identical company. */
function handEntered(entries: { kind: VoucherKind; state: InvoiceFormState | AccountingFormState; form: 'invoice' | 'accounting' }[]): { twin: DB; ids: number[] } {
  const twin = company()
  const ids = entries.map((e) => {
    const vt = typeId(twin, e.kind)
    const r =
      e.form === 'invoice'
        ? buildInvoicePayload(e.state as InvoiceFormState, { ...invoiceCtx(twin), kind: e.kind }, vt, taxLedgerIdsFrom(listLedgers(twin), taxSideOf(e.kind)))
        : buildAccountingPayload(e.state as AccountingFormState, { kind: e.kind, voucherTypeId: vt, derivedPartyId: derivePartyId((e.state as AccountingFormState).rows, isPartyOrTds(twin), null) })
    if (!r.ok) throw new Error(r.error)
    return saveVoucher(twin, r.payload).id
  })
  return { twin, ids }
}

const blankAccounting = (date: string, rowsIn: AccountingFormState['rows'], billRefs: AccountingFormState['billRefs'], extra: Partial<AccountingFormState> = {}): AccountingFormState => ({
  date, number: '', rows: rowsIn, narration: '', instrumentNo: '', billRefs, advanceReceipt: false, optional: false, tds: null, tcs: null, original: null, ...extra
})
const r = (drCr: 'dr' | 'cr', ledgerId: number, amount: number) => ({ drCr, ledgerId, amount, costAllocations: [] })

/** No trace at all: row counts, the number sequences, the audit chain. */
function trace(d: DB = db): unknown {
  return {
    vouchers: count('SELECT COUNT(*) AS n FROM vouchers', d),
    lines: count('SELECT COUNT(*) AS n FROM voucher_lines', d),
    ledgers: count('SELECT COUNT(*) AS n FROM ledgers', d),
    posts: count('SELECT COUNT(*) AS n FROM simple_posts', d),
    audit: d.prepare('SELECT COUNT(*) AS n, MAX(id) AS last, (SELECT row_hash FROM audit_log ORDER BY id DESC LIMIT 1) AS hash FROM audit_log').get(),
    seq: d.prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name').all(),
    next: nextVoucherNumber(d, typeId(d, 'sales'), TODAY)
  }
}

beforeEach(() => {
  db = company()
})

// ---------------------------------------------------------------- every kind

describe('every intent kind round-trips through its editor and equals a hand-entered voucher', () => {
  it('sale with items, part paid by UPI: invoice + receipt against that bill', () => {
    const out = post({ kind: 'sale', customerId: L('Ramesh'), items: [{ itemId: I('Widget'), qty: '2', rate: '500' }], payment: { how: 'upi', amount: '500' } })
    expect(out.entries.map((e) => [e.role, e.kind])).toEqual([['bill', 'sales'], ['payment', 'receipt']])
    const [bill, receipt] = out.voucherIds as [number, number]
    roundTrips(bill, 'invoice')
    roundTrips(receipt, 'accounting')
    // The partly paid bill: ₹1,180 − ₹500 still open on it (the Outstandings allocation).
    expect(partyAllocation(db, L('Ramesh'), TODAY).bills.map((b) => [b.number, b.pending])).toEqual([[getVoucher(db, bill)!.number, 68_000]])
    const number = getVoucher(db, bill)!.number
    const { twin, ids } = handEntered([
      { kind: 'sales', form: 'invoice', state: { ...emptyInvoiceState(TODAY), partyId: L('Ramesh'), accountId: L('Sales'), rows: [{ itemId: I('Widget'), qtyText: '2', rate: 50_000, discount: null, godownId: null, batchId: null }], billName: number, billDueDate: '2025-08-29' } },
      { kind: 'receipt', form: 'accounting', state: blankAccounting(TODAY, [r('dr', L('HDFC Bank'), 50_000), r('cr', L('Ramesh'), 50_000)], [{ kind: 'against', name: number, amount: 50_000, dueDate: null }]) }
    ])
    expect(rows(twin, ids[0]!)).toEqual(rows(db, bill))
    expect(rows(twin, ids[1]!)).toEqual(rows(db, receipt))
    expect(out.sentences).toEqual(['Bill ₹1,180.00 to Ramesh.', 'Includes GST ₹180.00.', '₹500.00 received by UPI.', '₹680.00 still due from Ramesh.'])
    expect(out.summary.parties).toEqual([{ ledgerId: L('Ramesh'), name: 'Ramesh', side: 'customer', balance: 68_000 }])
  })

  it('sale of just an amount (ledger lines), walk-in paid in cash', () => {
    const out = post({ kind: 'sale', amount: { amount: '1,000', gstRate: 18 } })
    const [bill, receipt] = out.voucherIds as [number, number]
    roundTrips(bill, 'accounting')
    roundTrips(receipt, 'accounting')
    const walkIn = L('Cash sale')
    const number = getVoucher(db, bill)!.number
    const { twin, ids } = handEntered([])
    ledger(twin, 'Cash sale', 'Sundry Debtors') // the walk-in the counter creates on first use
    const vt = typeId(twin, 'sales')
    const st = blankAccounting(TODAY, [r('dr', walkIn, 118_000), r('cr', L('Sales', twin), 100_000), r('cr', L('CGST', twin), 9000), r('cr', L('SGST', twin), 9000)], [{ kind: 'new', name: number, amount: 118_000, dueDate: TODAY }], { number })
    const built = buildAccountingPayload(st, { kind: 'sales', voucherTypeId: vt, derivedPartyId: walkIn })
    if (!built.ok) throw new Error(built.error)
    ids.push(saveVoucher(twin, built.payload).id)
    expect(rows(twin, ids[0]!)).toEqual(rows(db, bill))
  })

  it('purchase with items and the supplier bill number, paid from the bank', () => {
    const out = post({ kind: 'purchase', supplierId: L('Bharat Steel'), billNo: 'BS/101', date: '2025-08-10', items: [{ itemId: I('Widget'), qty: '10', rate: '100' }], payment: { how: 'bank' } })
    const [bill, pay] = out.voucherIds as [number, number]
    roundTrips(bill, 'invoice')
    roundTrips(pay, 'accounting')
    expect(getVoucher(db, bill)!.reference).toBe('BS/101')
    const { twin, ids } = handEntered([
      { kind: 'purchase', form: 'invoice', state: { ...emptyInvoiceState('2025-08-10'), partyId: L('Bharat Steel'), accountId: L('Purchases'), rows: [{ itemId: I('Widget'), qtyText: '10', rate: 10_000, discount: null, godownId: null, batchId: null }], billName: 'BS/101', billDueDate: '2025-08-10', reference: 'BS/101' } },
      { kind: 'payment', form: 'accounting', state: blankAccounting('2025-08-10', [r('dr', L('Bharat Steel'), 118_000), r('cr', L('HDFC Bank'), 118_000)], [{ kind: 'against', name: 'BS/101', amount: 118_000, dueDate: null }]) }
    ])
    expect(rows(twin, ids[0]!)).toEqual(rows(db, bill))
    expect(rows(twin, ids[1]!)).toEqual(rows(db, pay))
    // The same supplier bill again in the year is refused at its question, with nothing saved.
    const before = trace()
    expect(() => post({ kind: 'purchase', supplierId: L('Bharat Steel'), billNo: 'bs-101', items: [{ itemId: I('Widget'), qty: '1', rate: '100' }] })).toThrow(expect.objectContaining({ code: 'simple_duplicate_bill', field: 'billNo' }))
    expect(trace()).toEqual(before)
  })

  it('purchase of an expense (ledger lines) on credit', () => {
    const out = post({ kind: 'purchase', supplierId: L('Bharat Steel'), billNo: 'R-9', amount: { amount: '1000', accountId: L('Rent') } })
    expect(out.voucherIds).toHaveLength(1)
    roundTrips(out.voucherIds[0]!, 'accounting')
    expect(getVoucher(db, out.voucherIds[0]!)!.lines.map((l) => [l.ledgerId, l.drCr, l.amount])).toEqual([
      [L('Bharat Steel'), 'cr', 118_000], [L('Rent'), 'dr', 100_000], [L('CGST'), 'dr', 9000], [L('SGST'), 'dr', 9000]
    ])
  })

  it('money in: oldest bills first equals the Outstandings engine; the extra is an advance', () => {
    const s1 = post({ kind: 'sale', customerId: L('Ramesh'), date: '2025-06-01', amount: { amount: '300', gstRate: 0 } })
    const s2 = post({ kind: 'sale', customerId: L('Ramesh'), date: '2025-05-01', amount: { amount: '500', gstRate: 0 } })
    post({ kind: 'sale', customerId: L('Ramesh'), date: '2025-07-01', amount: { amount: '400', gstRate: 0 } })
    const open = partyAllocation(db, L('Ramesh'), TODAY).bills
    expect(open.map((b) => b.pending)).toEqual([50_000, 30_000, 40_000])
    const out = post({ kind: 'money_in', customerId: L('Ramesh'), amount: '700', into: { how: 'cash' } })
    roundTrips(out.voucherIds[0]!, 'accounting')
    // The engine, after: the oldest (₹500) and the next (₹300 → ₹100 of it) cleared, ₹400 untouched.
    const after = partyAllocation(db, L('Ramesh'), TODAY).bills
    expect(after.map((b) => [b.number, b.pending])).toEqual([[getVoucher(db, s1.voucherIds[0]!)!.number, 10_000], [open[2]!.number, 40_000]])
    expect(after.find((b) => b.number === getVoucher(db, s2.voucherIds[0]!)!.number)).toBeUndefined()
    const adv = post({ kind: 'money_in', customerId: L('Ramesh'), amount: '600', into: { how: 'bank' } })
    roundTrips(adv.voucherIds[0]!, 'accounting')
    // More than is due: on account — the engine settles what is left oldest first and holds ₹100 as an advance.
    expect(getVoucher(db, adv.voucherIds[0]!)!.billRefs).toEqual([])
    const alloc = partyAllocation(db, L('Ramesh'), TODAY)
    expect(alloc.bills).toEqual([])
    expect(alloc.unappliedCredit).toBe(10_000)
    expect(adv.summary.parties).toEqual([{ ledgerId: L('Ramesh'), name: 'Ramesh', side: 'customer', balance: -10_000 }])
    expect(adv.sentences).toContain('₹100.00 kept as an advance.')
  })

  it('money in from the owner, money out to an expense and to drawings', () => {
    for (const intent of [
      { kind: 'money_in', sourceId: L("Owner's money"), amount: '5000', into: { how: 'bank' } },
      { kind: 'money_out', payeeId: L('Rent'), amount: '1500', from: { how: 'cash' } },
      { kind: 'money_out', drawings: true, amount: '200', from: { how: 'cash' } }
    ]) {
      const out = post(intent)
      roundTrips(out.voucherIds[0]!, 'accounting')
    }
    expect(count("SELECT COUNT(*) AS n FROM voucher_lines vl JOIN ledgers l ON l.id = vl.ledger_id WHERE l.name = 'Owner''s drawings' AND vl.dr_cr = 'dr'")).toBe(1)
  })

  it('money out to a supplier against their bill', () => {
    const bill = post({ kind: 'purchase', supplierId: L('Bharat Steel'), billNo: 'BS/7', amount: { amount: '1000', accountId: L('Purchases'), gstRate: 0 } })
    const out = post({ kind: 'money_out', supplierId: L('Bharat Steel'), amount: '400', from: { how: 'bank' } })
    roundTrips(out.voucherIds[0]!, 'accounting')
    expect(getVoucher(db, out.voucherIds[0]!)!.billRefs).toEqual([expect.objectContaining({ kind: 'against', name: 'BS/7', amount: 40_000 })])
    expect(partyAllocation(db, L('Bharat Steel'), TODAY).bills.map((b) => b.pending)).toEqual([60_000])
    void bill
  })

  it('move money is a contra', () => {
    const out = post({ kind: 'move_money', amount: '2,000', fromId: L('Cash'), toId: L('HDFC Bank') })
    expect(out.entries[0]!.kind).toBe('contra')
    roundTrips(out.voucherIds[0]!, 'accounting')
    const { twin, ids } = handEntered([{ kind: 'contra', form: 'accounting', state: blankAccounting(TODAY, [r('dr', L('HDFC Bank'), 200_000), r('cr', L('Cash'), 200_000)], []) }])
    expect(rows(twin, ids[0]!)).toEqual(rows(db, out.voucherIds[0]!))
  })

  it('sale return with items: a credit note linked as a return, stock back in, set against the bill', () => {
    const sale = post({ kind: 'sale', customerId: L('Ramesh'), items: [{ itemId: I('Widget'), qty: '4', rate: '500' }] })
    const v = getVoucher(db, sale.voucherIds[0]!)!
    const ret = post({ kind: 'return_sale', billId: v.id, items: [{ lineUid: v.inventory[0]!.lineUid!, qty: '1' }] })
    const note = ret.voucherIds[0]!
    roundTrips(note, 'invoice')
    const n = getVoucher(db, note)!
    expect(n.inventory[0]).toMatchObject({ direction: 'in', qtyMilli: 1000, source: { linkType: 'return' } })
    expect(n.billRefs).toEqual([expect.objectContaining({ kind: 'against', name: v.number, amount: 59_000 })])
    expect(count(`SELECT COUNT(*) AS n FROM line_links WHERE to_voucher_id = ${note} AND link_type = 'return'`)).toBe(1)
    // The rest left to return: 3 more, never 4.
    expect(() => post({ kind: 'return_sale', billId: v.id, items: [{ lineUid: v.inventory[0]!.lineUid!, qty: '4' }] })).toThrow(expect.objectContaining({ code: 'simple_return_qty', field: 'items.0.qty' }))
  })

  it('purchase return of an amount on a paid bill, refunded into the bank', () => {
    const bill = post({ kind: 'purchase', supplierId: L('Bharat Steel'), billNo: 'BS/55', amount: { amount: '1000', accountId: L('Purchases') }, payment: { how: 'bank' } })
    const ret = post({ kind: 'return_purchase', billId: bill.voucherIds[0]!, amount: { amount: '100' }, refund: { how: 'bank' } })
    expect(ret.entries.map((e) => [e.role, e.kind])).toEqual([['note', 'debit_note'], ['refund', 'receipt']])
    roundTrips(ret.voucherIds[0]!, 'accounting')
    roundTrips(ret.voucherIds[1]!, 'accounting')
    expect(partyAllocation(db, L('Bharat Steel'), TODAY).bills.filter((b) => b.pending > 0)).toEqual([])
  })
})

// ---------------------------------------------------------------- the rules

describe('rehearsal, idempotency, undo', () => {
  it('preview says what will be recorded and leaves no trace — on success and on failure', () => {
    const before = trace()
    const p = previewIntent(db, INFO, { clientId: 'preview-0001', kind: 'sale', customerId: L('Ramesh'), items: [{ itemId: I('Widget'), qty: '1', rate: '1000' }], payment: { how: 'cash', amount: '500' } }, TODAY)
    expect(p.sentences).toEqual(['Bill ₹1,180.00 to Ramesh.', 'Includes GST ₹180.00.', '₹500.00 received in cash.', '₹680.00 still due from Ramesh.'])
    expect(p.entries.map((e) => [e.kind, e.lines.map((l) => [l.name, l.drCr, l.amount])])).toEqual([
      ['sales', [['Ramesh', 'dr', 118_000], ['Sales', 'cr', 100_000], ['CGST', 'cr', 9000], ['SGST', 'cr', 9000]]],
      ['receipt', [['Cash', 'dr', 50_000], ['Ramesh', 'cr', 50_000]]]
    ])
    expect(trace()).toEqual(before)
    // A walk-in preview creates the walk-in customer and an IGST-free sale only inside the rehearsal.
    previewIntent(db, INFO, { clientId: 'preview-0002', kind: 'sale', items: [{ itemId: I('Rice'), qty: '1', rate: '10.30' }] }, TODAY)
    expect(() => previewIntent(db, INFO, { clientId: 'preview-0003', kind: 'move_money', amount: 100, fromId: L('Cash'), toId: L('Cash') }, TODAY)).toThrow(expect.objectContaining({ code: 'simple_same_account', field: 'to' }))
    expect(trace()).toEqual(before)
  })

  it('a refused post leaves no trace (the walk-in / tax ledgers it would create included)', () => {
    db.prepare("DELETE FROM ledgers WHERE name IN ('CGST', 'SGST', 'Round Off')").run()
    setFeatures(db, { ...getFeatures(db), preventNegativeStock: true })
    const before = trace()
    expect(() => post({ kind: 'sale', items: [{ itemId: I('Widget'), qty: '1000', rate: '10.30' }] })).toThrow(expect.objectContaining({ code: 'insufficient_stock', field: 'items' }))
    expect(trace()).toEqual(before)
    // …and the same sale within stock creates the ledgers it needs, like the editor does.
    const ok = post({ kind: 'sale', items: [{ itemId: I('Widget'), qty: '1', rate: '10.30' }] })
    expect(getVoucher(db, ok.voucherIds[0]!)!.lines.map((l) => l.ledgerId)).toContain(L('CGST'))
  })

  it('the same clientId returns the same vouchers and never posts twice', () => {
    const intent = { clientId: 'retry-0001', kind: 'sale', customerId: L('Ramesh'), items: [{ itemId: I('Widget'), qty: '1', rate: '1000' }], payment: { how: 'cash' } }
    const a = postIntent(db, INFO, intent, TODAY)
    const n = count('SELECT COUNT(*) AS n FROM vouchers')
    const b = postIntent(db, INFO, intent, TODAY)
    expect(b.replayed).toBe(true)
    expect(b.voucherIds).toEqual(a.voucherIds)
    expect(b.sentences).toEqual(a.sentences)
    expect(count('SELECT COUNT(*) AS n FROM vouchers')).toBe(n)
    expect(() => postIntent(db, INFO, { clientId: 'retry-0001', kind: 'move_money', amount: 100, fromId: L('Cash'), toId: L('HDFC Bank') }, TODAY)).toThrow(expect.objectContaining({ code: 'simple_client_reused' }))
    // One audit row for the intent, with the whole intent and its voucher ids.
    const audit = db.prepare("SELECT after_json AS a FROM audit_log WHERE entity = 'simple_intent'").all() as { a: string }[]
    expect(audit).toHaveLength(1)
    expect(JSON.parse(audit[0]!.a)).toMatchObject({ clientId: 'retry-0001', kind: 'sale', voucherIds: a.voucherIds, intent: { customerId: L('Ramesh') } })
  })

  it('Undo bins the bill and its receipt as ONE group; Restore brings both back', () => {
    const out = post({ kind: 'sale', customerId: L('Ramesh'), items: [{ itemId: I('Widget'), qty: '1', rate: '1000' }], payment: { how: 'cash', amount: '100' } })
    expect(out.summary.undo).toEqual({ undoable: true, reason: null })
    const { groupId, binned } = undoSave(db, out.voucherIds)
    expect(binned).toEqual(out.voucherIds)
    expect(count(`SELECT COUNT(*) AS n FROM undo_group_vouchers WHERE group_id = ${groupId}`)).toBe(2)
    expect(restoreFromBin(db, out.voucherIds[1]!).restored.sort()).toEqual([...out.voucherIds].sort())
    expect(count('SELECT COUNT(*) AS n FROM vouchers WHERE deleted_at IS NULL AND id IN (' + out.voucherIds.join(',') + ')')).toBe(2)
  })
})

describe('refusals come back on the intent’s fields', () => {
  const sale = { kind: 'sale', customerId: 0, items: [{ itemId: 0, qty: '1', rate: '100' }] }
  const s = () => ({ ...sale, customerId: L('Ramesh'), items: [{ itemId: I('Widget'), qty: '1', rate: '100' }] })

  it('lock date → date', () => {
    setLockDate(db, '2025-08-31')
    const before = trace()
    expect(() => post(s())).toThrow(expect.objectContaining({ code: 'books_locked', field: 'date' }))
    expect(trace()).toEqual(before)
  })

  it('credit hold → party (the bill part); a paid-in-full receipt cannot slip through', () => {
    setCreditHold(db, L('Ramesh'), true, 'pays late')
    const before = trace()
    expect(() => post({ ...s(), payment: { how: 'cash' } })).toThrow(expect.objectContaining({ code: 'credit_hold', field: 'party', params: expect.objectContaining({ part: 'bill', name: 'Ramesh' }) }))
    expect(trace()).toEqual(before)
  })

  it('closed year → date', () => {
    post({ ...s(), date: '2025-05-01' })
    postClose(db, INFO, 2025)
    setLockDate(db, null)
    expect(() => post({ ...s(), date: '2025-06-01' })).toThrow(expect.objectContaining({ code: 'simple_year_closed', field: 'date' }))
  })

  it('an unregistered company sells without tax (and its editor opens it the same way)', () => {
    const info: CompanyInfo = { ...INFO, gstin: null, gstRegistrationType: 'unregistered' }
    db = company(info)
    const out = post({ kind: 'sale', customerId: L('Ramesh'), items: [{ itemId: I('Widget'), qty: '1', rate: '1000' }], payment: { how: 'cash' } }, db, info)
    const v = getVoucher(db, out.voucherIds[0]!)!
    expect(v.lines.map((l) => [l.ledgerId, l.amount])).toEqual([[L('Ramesh'), 100_000], [L('Sales'), 100_000]])
    roundTrips(v.id, 'invoice')
    expect(out.sentences).toEqual(['Bill ₹1,000.00 to Ramesh.', '₹1,000.00 received in cash.'])
  })
})

describe('the simple_posts migration', () => {
  it('is the last migration', () => {
    expect(MIGRATIONS.findIndex((sql) => sql.includes('CREATE TABLE simple_posts'))).toBe(MIGRATIONS.length - 1)
  })
})

// ---------------------------------------------------------------- WP 9.2 Make a bill

describe('WP 9.2 Make a bill: the form → simple:post = the invoice + receipt an accountant enters', () => {
  /** The renderer's path: the form's answers → saleIntentFrom (shared/simple/sell.ts) with the
   *  defaults simple:sell:setup gives, then postIntent. */
  function sell(f: Partial<SellForm>): ReturnType<typeof postIntent> {
    const ctx: SellContext = { invoice: invoiceCtx(db), salesAccountId: sellSetup(db).salesAccountId }
    const form: SellForm = { ...emptySellForm(TODAY, { mode: 'items', ratesIncludeGst: false }), ...f }
    expect(sellFormErrors(form, ctx, { regular: true })).toEqual({})
    const intent = saleIntentFrom(form, ctx, sellSetup(db).defaults)
    const out = post(intent)
    // The live total the form showed is what was saved.
    expect(out.facts.total).toBe(sellTotals(form, ctx).total)
    return out
  }
  const ln = (key: number, item: string, qtyText: string, rate: number) => ({ key, itemId: I(item), qtyText, rate, discount: null })
  const inv = (party: string, rowsIn: [string, string, number][], billName: string, due: string, d: DB = db): InvoiceFormState => ({
    ...emptyInvoiceState(TODAY), partyId: L(party, d), accountId: L('Sales', d), billName, billDueDate: due,
    rows: rowsIn.map(([item, qtyText, rate]) => ({ itemId: I(item, d), qtyText, rate, discount: null, godownId: null, batchId: null }))
  })

  it('on credit: one invoice, due by the customer’s credit days', () => {
    const out = sell({ customerId: L('Ramesh'), paid: 'credit', lines: [ln(1, 'Widget', '2', 50_000)] })
    expect(out.entries.map((e) => e.kind)).toEqual(['sales'])
    const bill = out.voucherIds[0]!
    roundTrips(bill, 'invoice')
    const number = getVoucher(db, bill)!.number
    const { twin, ids } = handEntered([{ kind: 'sales', form: 'invoice', state: inv('Ramesh', [['Widget', '2', 50_000]], number, '2025-08-29') }])
    expect(rows(twin, ids[0]!)).toEqual(rows(db, bill))
    expect(out.facts).toMatchObject({ total: 118_000, paid: 0, due: 118_000, dueDate: '2025-08-29' })
  })

  it('part paid in cash: the invoice + a cash receipt against it, the rest due', () => {
    const out = sell({ customerId: L('Ramesh'), paid: 'part', partHow: 'cash', partAmount: 50_000, lines: [ln(1, 'Widget', '2', 50_000)] })
    const [bill, receipt] = out.voucherIds as [number, number]
    roundTrips(bill, 'invoice')
    roundTrips(receipt, 'accounting')
    const number = getVoucher(db, bill)!.number
    const { twin, ids } = handEntered([
      { kind: 'sales', form: 'invoice', state: inv('Ramesh', [['Widget', '2', 50_000]], number, '2025-08-29') },
      { kind: 'receipt', form: 'accounting', state: blankAccounting(TODAY, [r('dr', L('Cash'), 50_000), r('cr', L('Ramesh'), 50_000)], [{ kind: 'against', name: number, amount: 50_000, dueDate: null }]) }
    ])
    expect(rows(twin, ids[0]!)).toEqual(rows(db, bill))
    expect(rows(twin, ids[1]!)).toEqual(rows(db, receipt))
    // The sales list says the same as the Outstandings allocation.
    const row = salesList(db, '2025-04-01', TODAY, TODAY).find((x) => x.voucherId === bill)!
    expect(row).toMatchObject({ total: 118_000, paid: 50_000, due: 68_000, dueDate: '2025-08-29', walkIn: false, partyName: 'Ramesh' })
    expect(partyAllocation(db, L('Ramesh'), TODAY).bills.find((b) => b.number === number)!.pending).toBe(row.due)
    expect(saleView(db, bill, TODAY)).toMatchObject({ total: 118_000, tax: 18_000, paid: 50_000, due: 68_000, items: [{ name: 'Widget', qtyMilli: 2000, ratePaise: 50_000 }] })
  })

  it('by card (an inter-state customer): the invoice + a receipt into the card account (the first bank)', () => {
    expect(sellSetup(db).defaults.card).toBe(L('HDFC Bank'))
    const out = sell({ customerId: L('Kumar'), paid: 'card', lines: [ln(1, 'Rice', '10', 3_000), ln(2, 'Widget', '1', 20_000)] })
    const [bill, receipt] = out.voucherIds as [number, number]
    roundTrips(bill, 'invoice')
    roundTrips(receipt, 'accounting')
    const v = getVoucher(db, bill)!
    expect(v.lines.some((l) => l.ledgerId === L('IGST'))).toBe(true)
    const { twin, ids } = handEntered([
      { kind: 'sales', form: 'invoice', state: inv('Kumar', [['Rice', '10', 3_000], ['Widget', '1', 20_000]], v.number, TODAY) },
      { kind: 'receipt', form: 'accounting', state: blankAccounting(TODAY, [r('dr', L('HDFC Bank'), out.facts.total), r('cr', L('Kumar'), out.facts.total)], [{ kind: 'against', name: v.number, amount: out.facts.total, dueDate: null }]) }
    ])
    expect(rows(twin, ids[0]!)).toEqual(rows(db, bill))
    expect(rows(twin, ids[1]!)).toEqual(rows(db, receipt))
    expect(salesList(db, '2025-04-01', TODAY, TODAY).find((x) => x.voucherId === bill)).toMatchObject({ paid: out.facts.total, due: 0 })
  })

  it('cash, a walk-in: the invoice to the counter’s cash customer + a cash receipt', () => {
    const out = sell({ paid: 'cash', lines: [ln(1, 'Rice', '2', 5_000)] })
    const [bill, receipt] = out.voucherIds as [number, number]
    roundTrips(bill, 'invoice')
    roundTrips(receipt, 'accounting')
    const number = getVoucher(db, bill)!.number
    const { twin, ids } = handEntered([])
    ledger(twin, 'Cash sale', 'Sundry Debtors') // the walk-in the counter creates on first use
    const st = inv('Cash sale', [['Rice', '2', 5_000]], number, TODAY, twin)
    const b1 = buildInvoicePayload(st, { ...invoiceCtx(twin), kind: 'sales' }, typeId(twin, 'sales'), taxLedgerIdsFrom(listLedgers(twin), 'output'))
    if (!b1.ok) throw new Error(b1.error)
    ids.push(saveVoucher(twin, b1.payload).id)
    const rc = blankAccounting(TODAY, [r('dr', L('Cash', twin), 10_500), r('cr', L('Cash sale', twin), 10_500)], [{ kind: 'against', name: number, amount: 10_500, dueDate: null }])
    const b2 = buildAccountingPayload(rc, { kind: 'receipt', voucherTypeId: typeId(twin, 'receipt'), derivedPartyId: L('Cash sale', twin) })
    if (!b2.ok) throw new Error(b2.error)
    ids.push(saveVoucher(twin, b2.payload).id)
    expect(rows(twin, ids[0]!)).toEqual(rows(db, bill))
    expect(rows(twin, ids[1]!)).toEqual(rows(db, receipt))
    expect(salesList(db, '2025-04-01', TODAY, TODAY).find((x) => x.voucherId === bill)).toMatchObject({ walkIn: true, paid: 10_500, due: 0 })
    // The walk-in is the form's "Cash customer", never one of its customers.
    expect(sellSetup(db).customers.map((c) => c.name)).not.toContain('Cash sale')
  })

  it('the money account defaults: WP 5.6 memory "Receive into" (a bank), else the counter / first bank; off with Use memory off', () => {
    const sbi = ledger(db, 'SBI', 'Bank Accounts')
    expect(sellSetup(db)).toMatchObject({ defaults: { cash: L('Cash'), upi: L('HDFC Bank'), card: L('HDFC Bank'), bank: L('HDFC Bank') }, memoryId: null })
    const m = createMemory(db, { kind: 'preference', text: 'Customers pay into SBI', data: { purpose: 'receipt', ledgerId: sbi } }, { source: 'user', status: 'active', createdBy: null })
    expect(sellSetup(db)).toMatchObject({ defaults: { cash: L('Cash'), upi: sbi, card: sbi, bank: sbi }, memoryId: m.id })
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('ai', json_set(COALESCE((SELECT value FROM meta WHERE key = 'ai'), '{}'), '$.useMemory', json('false')))").run()
    expect(sellSetup(db).defaults.upi).toBe(L('HDFC Bank'))
  })

  it('a customer on hold / a locked date are refused on their questions with nothing saved', () => {
    setCreditHold(db, L('Ramesh'), true, 'Old dues')
    expect(sellSetup(db).customers.find((c) => c.id === L('Ramesh'))!.creditHold).toBe(true)
    const ctx: SellContext = { invoice: invoiceCtx(db), salesAccountId: sellSetup(db).salesAccountId }
    const f: SellForm = { ...emptySellForm(TODAY, { mode: 'items', ratesIncludeGst: false }), customerId: L('Ramesh'), paid: 'cash', lines: [ln(1, 'Widget', '1', 100)] }
    const before = trace()
    expect(() => post(saleIntentFrom(f, ctx, sellSetup(db).defaults))).toThrow(expect.objectContaining({ code: 'credit_hold', field: 'party' }))
    setLockDate(db, '2025-08-31')
    const locked = trace()
    expect(() => post(saleIntentFrom({ ...f, customerId: L('Kumar') }, ctx, sellSetup(db).defaults))).toThrow(expect.objectContaining({ code: 'books_locked', field: 'date' }))
    expect(trace()).toEqual(locked)
    expect((before as { vouchers: number }).vouchers).toBe((locked as { vouchers: number }).vouchers)
  })
})
