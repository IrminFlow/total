// WP 9.5 — Return a sale / Return a purchase. The return screens' answers (shared/simple/returns.ts)
// → simple:post → a credit / debit note linked to the bill's lines as a `return` (+ the refund):
//   - stock and GST reverse EXACTLY: closing stock, GSTR-1 and GSTR-3B after the return equal an
//     identical company where an accountant entered the same note (and refund) in the editors;
//   - I1–I7 hold: an over-return is refused on its question (and by the save's own capacity rule),
//     the link rows point at the bill's lines, the return never re-opens an order;
//   - a refund settles the NOTE's bill and Outstandings agrees; credit kept is unapplied credit;
//   - refusals (lock, closed year, viewer, over-quantity) leave no trace; Undo bins note + refund
//     as one group;
//   - the reads: partly returned bills, bills of a closed / locked period, bills without products,
//     the sales list's returned chip.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3-multiple-ciphers'
import { seededDb, TEST_INFO } from '../db/testdb'
import { readCompanyInfo, writeCompanyInfo } from '../db/seed'
import type { DB } from '../db/connection'
import type { CompanyInfo, VoucherKind } from '@shared/domain'
import { gstRegistrationOf } from '@shared/gst/registration'
import { stockItemInputSchema } from '@shared/schemas'
import {
  buildAccountingPayload, buildInvoicePayload, derivePartyId, emptyInvoiceState, taxLedgerIdsFrom, taxSideOf,
  type AccountingFormState, type InvoiceFormState
} from '@shared/voucherEdit'
import { qtyText } from '@shared/voucherEdit/payload'
import { emptyReturnForm, returnFormErrors, returnIntentFrom, returnTotals, type ReturnContext, type ReturnForm } from '@shared/simple/returns'
import { createLedger, createStockItem, listLedgers, listStockItems } from './masters'
import { listTradeDocTypes } from './tradeDocTypes'
import { getVoucher, nextVoucherNumber, saveVoucher, setLockDate } from './vouchers'
import { partyAllocation, partyAllocationWithCredits } from './analysis'
import { stockSummary } from './stockAnalysis'
import { gstr1, gstr3b } from './gst'
import { postClose } from './yearEnd'
import { restoreFromBin, undoSave } from './undo'
import { postIntent, previewIntent } from './simplePost'
import { returnBill, returnBills } from './simpleReturns'
import { saleView, salesList, sellSetup } from './simpleSell'
import { purchasesList, purchaseView } from './simpleBuy'
import { purchaseStatus } from '@shared/simple/buy'
import { getTradeDoc, saveTradeDoc } from './tradeDocs'

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<{ ok: boolean; data?: unknown; error?: string; code?: string }>>()
vi.mock('electron', () => ({
  app: { getVersion: () => '0.12.0-test', getPath: () => tmpdir(), isPackaged: false, on: () => {} },
  ipcMain: { handle: (ch: string, fn: (e: unknown, p: unknown) => Promise<{ ok: boolean }>) => handlers.set(ch.replace(/^total:/, ''), fn) },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openPath: async () => '', showItemInFolder: () => {} },
  Notification: class {},
  BrowserWindow: class {},
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../updater', () => ({ checkForUpdatesInteractive: async () => null }))
const DATA_DIR = mkdtempSync(join(tmpdir(), 'total-simple-returns-'))
process.env.TOTAL_DATA_DIR = DATA_DIR
process.env.TOTAL_SUPPRESS_SYNC_WARNING = '1'

const INFO: CompanyInfo = { ...TEST_INFO, name: 'Returns Co', gstin: '27AAPFU0939F1ZV', stateCode: '27', gstRegistrationType: 'regular' }
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
  ledger(d, 'Ramesh', 'Sundry Debtors', { stateCode: '27', creditDays: 15 })
  ledger(d, 'Kumar', 'Sundry Debtors', { stateCode: '29', gstin: '29AABCF9012G1ZQ' })
  ledger(d, 'Bharat Steel', 'Sundry Creditors', { stateCode: '27', gstin: '27AABCG3456H1ZN' })
  const unit = d.prepare("SELECT id FROM units WHERE symbol = 'Nos'").get() as { id: number }
  createStockItem(d, stockItemInputSchema.parse({ name: 'Widget', unitId: unit.id, gstRate: 18, hsn: '8471', openingQtyMilli: 100_000, openingValue: 1_000_000 }))
  createStockItem(d, stockItemInputSchema.parse({ name: 'Rice', unitId: unit.id, gstRate: 5, hsn: '1006', openingQtyMilli: 50_000, openingValue: 150_000 }))
  return d
}

const post = (intent: Record<string, unknown>, d: DB = db, info: CompanyInfo = INFO) => postIntent(d, info, { clientId: `ret-${++seq}-xx`, ...intent }, TODAY)

function invoiceCtx(d: DB, info: CompanyInfo = INFO) {
  const ledgers = listLedgers(d)
  const items = listStockItems(d)
  return {
    companyStateCode: info.stateCode, ...gstRegistrationOf(readCompanyInfo(d)),
    items: new Map(items.map((i) => [i.id, { gstRate: i.gstRate, cessRate: i.cessRate }])),
    ledgers: new Map(ledgers.map((l) => [l.id, { stateCode: l.stateCode, gstRate: l.gstRate, tdsPayableSectionId: l.tdsPayableSectionId }]))
  }
}
const isParty = (d: DB) => (id: number): boolean => {
  const g = (d.prepare('SELECT g.name FROM ledgers l JOIN groups g ON g.id = l.group_id WHERE l.id = ?').get(id) as { name: string } | undefined)?.name
  return g === 'Sundry Debtors' || g === 'Sundry Creditors'
}

/** The accountant at the editor: an invoice-form entry / an accounting-form entry. */
function enterInvoice(d: DB, kind: VoucherKind, state: InvoiceFormState): number {
  const r = buildInvoicePayload(state, { ...invoiceCtx(d), kind }, typeId(d, kind), taxLedgerIdsFrom(listLedgers(d), taxSideOf(kind)))
  if (!r.ok) throw new Error(r.error)
  return saveVoucher(d, r.payload).id
}
function enterAccounting(d: DB, kind: VoucherKind, state: AccountingFormState): number {
  const r = buildAccountingPayload(state, { kind, voucherTypeId: typeId(d, kind), derivedPartyId: derivePartyId(state.rows, isParty(d), null) })
  if (!r.ok) throw new Error(r.error)
  return saveVoucher(d, r.payload).id
}
const acc = (date: string, rows: AccountingFormState['rows'], billRefs: AccountingFormState['billRefs'], extra: Partial<AccountingFormState> = {}): AccountingFormState => ({
  date, number: '', rows, narration: '', instrumentNo: '', billRefs, advanceReceipt: false, optional: false, tds: null, tcs: null, original: null, ...extra
})
const r = (drCr: 'dr' | 'cr', ledgerId: number, amount: number) => ({ drCr, ledgerId, amount, costAllocations: [] })

/** What a return changes, as the reports read it: closing stock, GSTR-1, GSTR-3B. */
function reports(d: DB) {
  const stock = stockSummary(d, TODAY).map((s) => [s.name, s.closingQtyMilli, s.closingValue])
  const g1 = gstr1(d, INFO, '2025-08-01', '2025-08-31', '082025')
  const g3 = gstr3b(d, INFO, '2025-08-01', '2025-08-31', '082025')
  return { stock, g1: JSON.parse(JSON.stringify(g1)), g3: JSON.parse(JSON.stringify(g3)) }
}

/** Every stored row of a voucher, ids stripped. */
function rows(d: DB, id: number): unknown {
  return {
    voucher: d.prepare('SELECT voucher_type_id, date, number, party_ledger_id, narration, reference, instrument_no, pos_override, post_dated, is_optional FROM vouchers WHERE id = ?').get(id),
    lines: d.prepare('SELECT ledger_id, dr_cr, amount, line_order FROM voucher_lines WHERE voucher_id = ? ORDER BY line_order').all(id),
    inventory: d.prepare('SELECT stock_item_id, godown_id, batch_id, qty_milli, rate_paise, discount_paise, amount, direction, moves_stock, line_order FROM inventory_lines WHERE voucher_id = ? ORDER BY line_order').all(id),
    billRefs: d.prepare('SELECT party_ledger_id, kind, name, amount, due_date FROM bill_refs WHERE voucher_id = ? ORDER BY id').all(id),
    links: d.prepare('SELECT from_voucher_id, link_type, qty_milli FROM line_links WHERE to_voucher_id = ? ORDER BY id').all(id)
  }
}

/** No trace at all: row counts, the number sequences, the audit chain. */
function trace(d: DB = db): unknown {
  return {
    vouchers: count('SELECT COUNT(*) AS n FROM vouchers', d),
    lines: count('SELECT COUNT(*) AS n FROM voucher_lines', d),
    links: count('SELECT COUNT(*) AS n FROM line_links', d),
    ledgers: count('SELECT COUNT(*) AS n FROM ledgers', d),
    posts: count('SELECT COUNT(*) AS n FROM simple_posts', d),
    audit: d.prepare('SELECT COUNT(*) AS n, MAX(id) AS last FROM audit_log').get(),
    next: nextVoucherNumber(d, typeId(d, 'credit_note'), TODAY)
  }
}

const ctxOf = (d: DB = db): ReturnContext => ({ invoice: invoiceCtx(d) })
const formFor = (patch: Partial<ReturnForm>): ReturnForm => ({ ...emptyReturnForm(TODAY), ...patch })
const due = (name: string, d: DB = db) => partyAllocation(d, L(name, d), TODAY)

beforeEach(() => {
  db = company()
})

// ---------------------------------------------------------------- stock and GST reverse

describe('stock and GST reverse exactly (= the accountant-entered note in a twin company)', () => {
  it('a sale return of products with a UPI refund: closing stock, GSTR-1, GSTR-3B and every row equal the hand-entered credit note + payment', () => {
    // The bill: 4 Widget @ ₹500 (18%) + 10 Rice @ ₹100 (5%) to Ramesh, paid in cash.
    const sale = post({ kind: 'sale', customerId: L('Ramesh'), items: [{ itemId: I('Widget'), qty: '4', rate: '500' }, { itemId: I('Rice'), qty: '10', rate: '100' }], payment: { how: 'cash' } })
    const bill = returnBill(db, INFO, 'sale', sale.voucherIds[0]!, TODAY)!
    expect(bill).toMatchObject({ mode: 'items', pending: 0, carriesGst: true, rates: [18, 5], total: 341_000 })
    // The form: 1 Widget + 2 Rice back, money back by UPI (into the bank).
    const form = formFor({ qty: { [bill.lines[0]!.lineUid]: '1', [bill.lines[1]!.lineUid]: '2' }, settle: 'refund', how: 'upi', reason: 'Damaged' })
    const totals = returnTotals(form, bill, ctxOf())
    // 500 + 18% = 590; 200 + 5% = 210 → 800.
    expect(totals).toMatchObject({ taxable: 70_000, tax: 10_000, total: 80_000 })
    expect(returnFormErrors(form, bill, ctxOf(), { refundAccount: true })).toEqual({})
    const out = post(returnIntentFrom(form, bill, ctxOf(), sellSetup(db).defaults))
    expect(out.entries.map((e) => [e.role, e.kind])).toEqual([['note', 'credit_note'], ['refund', 'payment']])
    expect(out.facts).toMatchObject({ total: totals.total, tax: totals.tax, credit: 80_000, paid: 80_000, how: 'upi' })

    // The twin: the accountant enters the same sale + receipt, then the note with its return
    // lines and the payment against the note's bill (named apart from sale "1", which its receipt
    // settled by that name).
    const twin = company()
    const t = (n: string) => L(n, twin)
    const ti = (n: string) => I(n, twin)
    const saleId = enterInvoice(twin, 'sales', {
      ...emptyInvoiceState(TODAY), number: '1', partyId: t('Ramesh'), accountId: t('Sales'), billName: '1', billDueDate: '2025-08-29',
      rows: [{ itemId: ti('Widget'), qtyText: '4', rate: 50_000, discount: null, godownId: null, batchId: null }, { itemId: ti('Rice'), qtyText: '10', rate: 10_000, discount: null, godownId: null, batchId: null }]
    })
    enterAccounting(twin, 'receipt', acc(TODAY, [r('dr', t('Cash'), 341_000), r('cr', t('Ramesh'), 341_000)], [{ kind: 'against', name: '1', amount: 341_000, dueDate: null }], { number: '1' }))
    const lines = getVoucher(twin, saleId)!.inventory
    const noteId = enterInvoice(twin, 'credit_note', {
      ...emptyInvoiceState(TODAY), number: '1', partyId: t('Ramesh'), accountId: t('Sales'), narration: 'Damaged', reference: '1', manualNewBillMode: true, billName: '1/25-26', billDueDate: TODAY,
      rows: [
        { itemId: ti('Widget'), qtyText: qtyText(1000), rate: 50_000, discount: null, godownId: null, batchId: null, source: { lineUid: lines[0]!.lineUid!, linkType: 'return' } },
        { itemId: ti('Rice'), qtyText: qtyText(2000), rate: 10_000, discount: null, godownId: null, batchId: null, source: { lineUid: lines[1]!.lineUid!, linkType: 'return' } }
      ]
    })
    const payId = enterAccounting(twin, 'payment', acc(TODAY, [r('dr', t('Ramesh'), 80_000), r('cr', t('HDFC Bank'), 80_000)], [{ kind: 'against', name: '1/25-26', amount: 80_000, dueDate: null }], { number: '1', narration: 'Damaged' }))

    expect(rows(db, out.voucherIds[0]!)).toEqual(rows(twin, noteId))
    expect(rows(db, out.voucherIds[1]!)).toEqual(rows(twin, payId))
    const mine = reports(db)
    expect(mine).toEqual(reports(twin))
    // Stock really came back in: 100 − 4 + 1 Widget, 50 − 10 + 2 Rice.
    expect(mine.stock.find((s) => s[0] === 'Widget')![1]).toBe(97_000)
    expect(mine.stock.find((s) => s[0] === 'Rice')![1]).toBe(42_000)
    // GSTR-3B outward tax = the sale's less the note's (90 + 90 + 2.5 + 2.5 + … : 18% of 2000 + 5% of 1000 − 18% of 500 − 5% of 200).
    expect(mine.g3.outward.cgst + mine.g3.outward.sgst).toBe(41_000 - 10_000)
    // Refund against the note's own bill; the customer is square.
    expect(due('Ramesh')).toMatchObject({ bills: [], unappliedCredit: 0 })
  })

  it('a purchase return of products with the credit kept: stock, GSTR-3B input tax and every row equal the hand-entered debit note', () => {
    const buy = post({ kind: 'purchase', supplierId: L('Bharat Steel'), billNo: 'BS/9', items: [{ itemId: I('Widget'), qty: '10', rate: '300' }], payment: { how: 'bank' } })
    const bill = returnBill(db, INFO, 'purchase', buy.voucherIds[0]!, TODAY)!
    expect(bill).toMatchObject({ billNo: 'BS/9', pending: 0, total: 354_000 })
    const form = formFor({ qty: { [bill.lines[0]!.lineUid]: '2' }, settle: 'credit' })
    const out = post(returnIntentFrom(form, bill, ctxOf(), sellSetup(db).defaults))
    expect(out.entries.map((e) => e.kind)).toEqual(['debit_note'])
    // 2 × 300 + 18% = 708, kept: the supplier owes it back.
    expect(due('Bharat Steel')).toMatchObject({ bills: [], unappliedCredit: 70_800 })
    expect(out.sentences).toContain('Bharat Steel owes you ₹708.00 back, kept for a later bill.')

    const twin = company()
    const t = (n: string) => L(n, twin)
    const buyId = enterInvoice(twin, 'purchase', {
      ...emptyInvoiceState(TODAY), number: '1', partyId: t('Bharat Steel'), accountId: t('Purchases'), billName: 'BS/9', billDueDate: TODAY, reference: 'BS/9',
      rows: [{ itemId: I('Widget', twin), qtyText: '10', rate: 30_000, discount: null, godownId: null, batchId: null }]
    })
    enterAccounting(twin, 'payment', acc(TODAY, [r('dr', t('Bharat Steel'), 354_000), r('cr', t('HDFC Bank'), 354_000)], [{ kind: 'against', name: 'BS/9', amount: 354_000, dueDate: null }], { number: '1' }))
    const noteId = enterInvoice(twin, 'debit_note', {
      ...emptyInvoiceState(TODAY), number: '1', partyId: t('Bharat Steel'), accountId: t('Purchases'), reference: 'BS/9', manualNewBillMode: true, billName: '1', billDueDate: TODAY,
      rows: [{ itemId: I('Widget', twin), qtyText: '2', rate: 30_000, discount: null, godownId: null, batchId: null, source: { lineUid: getVoucher(twin, buyId)!.inventory[0]!.lineUid!, linkType: 'return' } }]
    })
    expect(rows(db, out.voucherIds[0]!)).toEqual(rows(twin, noteId))
    const mine = reports(db)
    expect(mine).toEqual(reports(twin))
    expect(mine.stock.find((s) => s[0] === 'Widget')![1]).toBe(108_000)
  })

  it('a return of just an amount (a bill without products) takes its GST from the bill and comes off it while unpaid', () => {
    // The GST returns read a ledger-line bill's rate from its account (gst.ts), so the account carries it.
    const repairs = ledger(db, 'Repairs', 'Sales Accounts', { gstRate: 12 })
    const sale = post({ kind: 'sale', customerId: L('Kumar'), amount: { amount: '1000', gstRate: 12, accountId: repairs } })
    const bill = returnBill(db, INFO, 'sale', sale.voucherIds[0]!, TODAY)!
    expect(bill).toMatchObject({ mode: 'amount', rates: [12], amountTaxable: 100_000, amountLeft: 100_000, pending: 112_000, lines: [] })
    const form = formFor({ amount: 25_000 })
    expect(returnTotals(form, bill, ctxOf())).toMatchObject({ taxable: 25_000, tax: 3_000, total: 28_000 })
    const before = reports(db)
    const out = post(returnIntentFrom(form, bill, ctxOf(), sellSetup(db).defaults))
    // Inter-state: IGST 12% of 250 = 30; all of it comes off the unpaid bill.
    expect(getVoucher(db, out.voucherIds[0]!)!.billRefs).toEqual([expect.objectContaining({ kind: 'against', name: '1', amount: 28_000 })])
    expect(due('Kumar').bills.map((b) => b.pending)).toEqual([84_000])
    const after = reports(db)
    expect(after.g3.outward.igst).toBe(before.g3.outward.igst - 3_000)
    expect(after.stock).toEqual(before.stock)
    // What is left to return drops; more than that is refused on the amount.
    expect(returnBill(db, INFO, 'sale', sale.voucherIds[0]!, TODAY)!.amountLeft).toBe(75_000)
    const b2 = returnBill(db, INFO, 'sale', sale.voucherIds[0]!, TODAY)!
    expect(returnFormErrors(formFor({ amount: 80_000 }), b2, ctxOf())).toEqual({ amount: 'simple.returns.err.amountTooMuch' })
    const t0 = trace()
    expect(() => post({ kind: 'return_sale', billId: sale.voucherIds[0]!, amount: { amount: 80_000 } })).toThrow(expect.objectContaining({ code: 'simple_return_amount', field: 'amount' }))
    expect(trace()).toEqual(t0)
  })
})

describe('s.34 after leaving GST: the return keeps the bill’s GST (= the accountant twin) (review)', () => {
  it('a sale of a GST-charging period returned after the business became unregistered: same rows, GSTR-1 and GSTR-3B as the editor’s note', () => {
    const left: CompanyInfo = { ...INFO, gstRegistrationType: 'unregistered', gstRegistrationSince: '2025-08-10', gstPreviousRegistrationType: 'regular' }
    const twin = company()
    // The sale while still registered: 2 Widget @ ₹500 + 18%.
    const sale = post({ kind: 'sale', customerId: L('Ramesh'), items: [{ itemId: I('Widget'), qty: '2', rate: '500' }], date: '2025-08-05' })
    const t = (n: string) => L(n, twin)
    const saleId = enterInvoice(twin, 'sales', {
      ...emptyInvoiceState('2025-08-05'), number: '1', partyId: t('Ramesh'), accountId: t('Sales'), billName: '1', billDueDate: '2025-08-20',
      rows: [{ itemId: I('Widget', twin), qtyText: '2', rate: 50_000, discount: null, godownId: null, batchId: null }]
    })
    expect(rows(db, sale.voucherIds[0]!)).toEqual(rows(twin, saleId))
    // Then the business leaves GST (effective 10 Aug).
    writeCompanyInfo(db, left)
    writeCompanyInfo(twin, left)
    const bill = returnBill(db, left, 'sale', sale.voucherIds[0]!, TODAY)!
    const form = formFor({ qty: { [bill.lines[0]!.lineUid]: '1' } })
    const totals = returnTotals(form, bill, ctxOf())
    expect(totals).toMatchObject({ taxable: 50_000, tax: 9_000, total: 59_000, charges: true })
    const out = post(returnIntentFrom(form, bill, ctxOf(), sellSetup(db).defaults), db, left)
    expect(out.facts).toMatchObject({ total: 59_000, tax: 9_000 })
    const noteId = enterInvoice(twin, 'credit_note', {
      ...emptyInvoiceState(TODAY), number: '1', partyId: t('Ramesh'), accountId: t('Sales'), reference: '1', taxedOriginal: true, noteBillRefs: [{ kind: 'against', name: '1', amount: 59_000, dueDate: null }],
      rows: [{ itemId: I('Widget', twin), qtyText: '1', rate: 50_000, discount: null, godownId: null, batchId: null, source: { lineUid: getVoucher(twin, saleId)!.inventory[0]!.lineUid!, linkType: 'return' } }]
    })
    expect(rows(db, out.voucherIds[0]!)).toEqual(rows(twin, noteId))
    const g = (d: DB) => ({
      g1: JSON.parse(JSON.stringify(gstr1(d, left, '2025-08-01', '2025-08-31', '082025'))),
      g3: JSON.parse(JSON.stringify(gstr3b(d, left, '2025-08-01', '2025-08-31', '082025')))
    })
    const mine = g(db)
    expect(mine).toEqual(g(twin))
    // The note reduces August's outward tax by its own GST (18% of 1000 − 18% of 500).
    expect(mine.g3.outward.cgst + mine.g3.outward.sgst).toBe(18_000 - 9_000)
  })
})

// ---------------------------------------------------------------- I1–I7

describe('the trade-cycle rules hold (I1–I7)', () => {
  it('link rows point at the bill lines; an over-return is refused on its question, and the save refuses it too (I1)', () => {
    const sale = post({ kind: 'sale', customerId: L('Ramesh'), items: [{ itemId: I('Widget'), qty: '3', rate: '400' }] })
    const v = getVoucher(db, sale.voucherIds[0]!)!
    const uid = v.inventory[0]!.lineUid!
    const out = post({ kind: 'return_sale', billId: v.id, items: [{ lineUid: uid, qty: '2' }] })
    const note = out.voucherIds[0]!
    expect(db.prepare('SELECT link_type AS t, from_voucher_id AS f, from_line_uid AS u, qty_milli AS q FROM line_links WHERE to_voucher_id = ?').all(note)).toEqual([{ t: 'return', f: v.id, u: uid, q: 2000 }])
    // I2: same party, same item.
    const n = getVoucher(db, note)!
    expect([n.partyLedgerId, n.inventory[0]!.stockItemId, n.inventory[0]!.direction]).toEqual([v.partyLedgerId, v.inventory[0]!.stockItemId, 'in'])
    // Only 1 left: the form and the intent say so on the quantity — nothing saved.
    const bill = returnBill(db, INFO, 'sale', v.id, TODAY)!
    expect(bill.lines[0]!.leftMilli).toBe(1000)
    expect(returnFormErrors(formFor({ qty: { [uid]: '2' } }), bill, ctxOf())).toEqual({ items: 'simple.returns.err.tooMany' })
    const t0 = trace()
    expect(() => post({ kind: 'return_sale', billId: v.id, items: [{ lineUid: uid, qty: '2' }] })).toThrow(expect.objectContaining({ code: 'simple_return_qty', field: 'items.0.qty' }))
    expect(trace()).toEqual(t0)
    // The save's own capacity rule (I1) refuses it as well, whatever the screen sent.
    const p = previewIntent(db, INFO, { clientId: 'ret-preview-1', kind: 'return_sale', billId: v.id, items: [{ lineUid: uid, qty: '1' }] }, TODAY)
    expect(p.facts.total).toBeGreaterThan(0)
    const raw = { ...getVoucher(db, note)!, id: undefined }
    expect(() => saveVoucher(db, { ...raw, number: 'X-9', inventory: raw.inventory.map((l) => ({ ...l, lineUid: undefined, source: { lineUid: uid, linkType: 'return' as const } })) } as never)).toThrow(/would be returned/)
    expect(trace()).toEqual(t0)
    // Binning the first return frees its quantity again (only live links count).
    undoSave(db, out.voucherIds)
    expect(returnBill(db, INFO, 'sale', v.id, TODAY)!.lines[0]!.leftMilli).toBe(3000)
  })

  it('a return never re-opens an order', () => {
    const so = saveTradeDoc(db, {
      docTypeId: listTradeDocTypes(db).find((t) => t.kind === 'sales_order')!.id, date: '2025-08-01', number: 'SO-1', partyLedgerId: L('Ramesh'), terms: '',
      lines: [{ stockItemId: I('Widget'), qtyMilli: 5000, ratePaise: 40_000, discountPaise: 0, amount: 200_000, description: '' }]
    }).doc
    const st = invoiceCtx(db)
    const saleId = saveVoucher(
      db,
      (() => {
        const b = buildInvoicePayload(
          { ...emptyInvoiceState('2025-08-02'), number: '1', partyId: L('Ramesh'), accountId: L('Sales'), billName: '1', billDueDate: '2025-08-02', rows: [{ itemId: I('Widget'), qtyText: '5', rate: 40_000, discount: null, godownId: null, batchId: null, source: { lineUid: so.lines[0]!.lineUid, linkType: 'fulfil' } }] },
          { ...st, kind: 'sales' }, typeId(db, 'sales'), taxLedgerIdsFrom(listLedgers(db), 'output')
        )
        if (!b.ok) throw new Error(b.error)
        return b.payload
      })()
    ).id
    const before = getTradeDoc(db, so.id, TODAY)!
    expect(before.lines[0]!.pendingMilli).toBe(0)
    const bill = returnBill(db, INFO, 'sale', saleId, TODAY)!
    post(returnIntentFrom(formFor({ qty: { [bill.lines[0]!.lineUid]: '2' } }), bill, ctxOf(), sellSetup(db).defaults))
    const after = getTradeDoc(db, so.id, TODAY)!
    expect(after.lines[0]!.pendingMilli).toBe(0)
    expect(after.status).toBe(before.status)
  })
})

// ---------------------------------------------------------------- money: refund / credit

describe('refund or credit — Outstandings agrees', () => {
  it('a part-paid bill: the due part comes off the bill, the rest is refunded against the NOTE’s bill', () => {
    const sale = post({ kind: 'sale', customerId: L('Ramesh'), items: [{ itemId: I('Rice'), qty: '10', rate: '100' }], payment: { how: 'cash', amount: '900' } })
    // 1050 bill, 900 paid → 150 due. Return 4 Rice = 420: 150 off the bill, 270 back.
    const bill = returnBill(db, INFO, 'sale', sale.voucherIds[0]!, TODAY)!
    expect(bill.pending).toBe(15_000)
    const form = formFor({ qty: { [bill.lines[0]!.lineUid]: '4' }, settle: 'refund', how: 'cash' })
    const out = post(returnIntentFrom(form, bill, ctxOf(), sellSetup(db).defaults))
    const [note, refund] = out.voucherIds.map((id) => getVoucher(db, id)!)
    expect(note!.billRefs.map((b) => [b.kind, b.amount])).toEqual([['against', 15_000], ['new', 27_000]])
    expect(note!.billRefs[0]!.name).toBe('1')
    expect(refund!.billRefs).toEqual([expect.objectContaining({ kind: 'against', name: note!.billRefs[1]!.name, amount: 27_000 })])
    expect(due('Ramesh')).toMatchObject({ bills: [], unappliedCredit: 0 })
    expect(out.facts).toMatchObject({ offBill: 15_000, credit: 27_000, paid: 27_000, balance: 0 })
    // The sales list: the bill is not "part paid" by the return — paid = 900, returned chip 420.
    expect(salesList(db, '2025-04-01', TODAY, TODAY).find((x) => x.voucherId === sale.voucherIds[0])).toMatchObject({ total: 105_000, paid: 90_000, due: 0, returned: 42_000 })
    expect(saleView(db, sale.voucherIds[0]!, TODAY)).toMatchObject({ paid: 90_000, due: 0, returned: 42_000 })
  })

  it('credit kept is unapplied credit (the next bill can use it); a return on an unpaid bill has nothing to refund', () => {
    const sale = post({ kind: 'sale', customerId: L('Ramesh'), amount: { amount: '500', gstRate: 0 }, payment: { how: 'upi' } })
    const bill = returnBill(db, INFO, 'sale', sale.voucherIds[0]!, TODAY)!
    post(returnIntentFrom(formFor({ amount: 20_000, settle: 'credit' }), bill, ctxOf(), sellSetup(db).defaults))
    expect(due('Ramesh')).toMatchObject({ bills: [], unappliedCredit: 20_000 })
    expect(partyAllocationWithCredits(db, L('Ramesh'), TODAY).credits.map((c) => c.amount)).toEqual([20_000])
    // An unpaid bill: the form never sends a refund (the return comes off it).
    const unpaid = post({ kind: 'sale', customerId: L('Kumar'), amount: { amount: '500', gstRate: 0 } })
    const ub = returnBill(db, INFO, 'sale', unpaid.voucherIds[0]!, TODAY)!
    const intent = returnIntentFrom(formFor({ amount: 10_000, settle: 'refund', how: 'cash' }), ub, ctxOf(), sellSetup(db).defaults)
    expect('refund' in intent).toBe(false)
    expect(post(intent).entries.map((e) => e.kind)).toEqual(['credit_note'])
    expect(due('Kumar').bills.map((b) => b.pending)).toEqual([40_000])
  })
})

// ---------------------------------------------------------------- refusals, undo

describe('refusals leave no trace; Undo bins the return and its refund together', () => {
  it('lock date and closed year → the date; a bill of a closed / locked period can still be returned today', () => {
    const lastYear: CompanyInfo = { ...INFO, booksFrom: 2024 }
    db = company(lastYear)
    const old = post({ kind: 'sale', customerId: L('Ramesh'), items: [{ itemId: I('Widget'), qty: '2', rate: '500' }], date: '2025-02-10', payment: { how: 'cash' } }, db, lastYear)
    postClose(db, lastYear, 2024)
    const bill = returnBill(db, lastYear, 'sale', old.voucherIds[0]!, TODAY)!
    expect(bill.lines[0]!.leftMilli).toBe(2000)
    expect(returnBills(db, lastYear, 'sale', TODAY).find((b) => b.voucherId === bill.voucherId)).toMatchObject({ left: 'all', mode: 'items' })
    const intent = (date: string) => ({ kind: 'return_sale', date, billId: bill.voucherId, items: [{ lineUid: bill.lines[0]!.lineUid, qty: '1' }], refund: { how: 'cash' } })
    let t0 = trace()
    // Dated in the closed year (inside its lock too): refused at the date, nothing saved.
    expect(() => post(intent('2025-03-01'), db, lastYear)).toThrow(expect.objectContaining({ field: 'date' }))
    expect(trace()).toEqual(t0)
    // A lock over this year's first months: refused at the date as well.
    setLockDate(db, '2025-07-31')
    t0 = trace()
    expect(() => post(intent('2025-07-15'), db, lastYear)).toThrow(expect.objectContaining({ code: 'books_locked', field: 'date' }))
    expect(trace()).toEqual(t0)
    // Today (the NOTE's date is what counts): fine.
    const out = post(intent(TODAY), db, lastYear)
    expect(out.entries.map((e) => e.kind)).toEqual(['credit_note', 'payment'])
  })

  it('over-quantity on a later line is refused on that line; Undo bins note + refund as one group, Restore brings both back', () => {
    const sale = post({ kind: 'sale', customerId: L('Ramesh'), items: [{ itemId: I('Widget'), qty: '1', rate: '500' }, { itemId: I('Rice'), qty: '2', rate: '100' }], payment: { how: 'cash' } })
    const bill = returnBill(db, INFO, 'sale', sale.voucherIds[0]!, TODAY)!
    const t0 = trace()
    expect(() => post({ kind: 'return_sale', billId: bill.voucherId, items: [{ lineUid: bill.lines[0]!.lineUid, qty: '1' }, { lineUid: bill.lines[1]!.lineUid, qty: '3' }] })).toThrow(
      expect.objectContaining({ code: 'simple_return_qty', field: 'items.1.qty' })
    )
    expect(trace()).toEqual(t0)
    const out = post(returnIntentFrom(formFor({ qty: { [bill.lines[0]!.lineUid]: '1' }, settle: 'refund', how: 'cash' }), bill, ctxOf(), sellSetup(db).defaults))
    expect(out.summary.undo).toEqual({ undoable: true, reason: null })
    const stockAfter = stockSummary(db, TODAY).find((s) => s.name === 'Widget')!.closingQtyMilli
    const g = undoSave(db, out.voucherIds)
    expect(g.binned.sort()).toEqual([...out.voucherIds].sort())
    expect(count(`SELECT COUNT(*) AS n FROM vouchers WHERE id IN (${out.voucherIds.join(',')}) AND deleted_at IS NOT NULL`)).toBe(2)
    expect(stockSummary(db, TODAY).find((s) => s.name === 'Widget')!.closingQtyMilli).toBe(stockAfter - 1000)
    expect(returnBill(db, INFO, 'sale', bill.voucherId, TODAY)!.lines[0]!.leftMilli).toBe(1000)
    expect(restoreFromBin(db, out.voucherIds[1]!).restored.sort()).toEqual([...out.voucherIds].sort())
    expect(due('Ramesh')).toMatchObject({ bills: [], unappliedCredit: 0 })
  })
})

// ---------------------------------------------------------------- the reads

describe('the purchase list / bill view show the returns (WP 9.3 + 9.5)', () => {
  it('a return off an unpaid purchase bill is a chip, not a payment; a paid one stays paid', () => {
    const unpaid = post({ kind: 'purchase', supplierId: L('Bharat Steel'), billNo: 'BS/1', items: [{ itemId: I('Widget'), qty: '10', rate: '100' }] })
    const b = returnBill(db, INFO, 'purchase', unpaid.voucherIds[0]!, TODAY)!
    post(returnIntentFrom(formFor({ qty: { [b.lines[0]!.lineUid]: '2' } }), b, ctxOf(), sellSetup(db).defaults))
    // 10 × 100 + 18% = 1180; 2 back = 236 off the bill; nothing paid.
    const row = purchasesList(db, '2025-04-01', TODAY, TODAY).find((x) => x.voucherId === unpaid.voucherIds[0])!
    expect(row).toMatchObject({ total: 118_000, due: 94_400, paid: 0, returned: 23_600 })
    expect(purchaseStatus(row.total, row.due, row.overdueDays, row.paid)).toBe('due')
    expect(purchaseView(db, unpaid.voucherIds[0]!, TODAY)).toMatchObject({ paid: 0, due: 94_400, returned: 23_600 })
    // Review fix: the rest comes back too — nothing to pay, and still nothing PAID (not "Paid").
    const b2 = returnBill(db, INFO, 'purchase', unpaid.voucherIds[0]!, TODAY)!
    post(returnIntentFrom(formFor({ qty: { [b2.lines[0]!.lineUid]: '8' } }), b2, ctxOf(), sellSetup(db).defaults))
    const cleared = purchasesList(db, '2025-04-01', TODAY, TODAY).find((x) => x.voucherId === unpaid.voucherIds[0])!
    expect(cleared).toMatchObject({ total: 118_000, due: 0, paid: 0, returned: 118_000 })
    expect(purchaseStatus(cleared.total, cleared.due, cleared.overdueDays, cleared.paid)).toBe('returned')
    expect(due('Bharat Steel')).toMatchObject({ bills: [], unappliedCredit: 0 })
    const paid = post({ kind: 'purchase', supplierId: L('Bharat Steel'), billNo: 'BS/2', amount: { amount: '500', accountId: L('Purchases'), gstRate: 0 }, payment: { how: 'bank' } })
    const pb = returnBill(db, INFO, 'purchase', paid.voucherIds[0]!, TODAY)!
    post(returnIntentFrom(formFor({ amount: 10_000, settle: 'credit' }), pb, ctxOf(), sellSetup(db).defaults))
    expect(purchasesList(db, '2025-04-01', TODAY, TODAY).find((x) => x.voucherId === paid.voucherIds[0])).toMatchObject({ total: 50_000, paid: 50_000, due: 0, returned: 10_000 })
    expect(purchasesList(db, '2025-04-01', TODAY, TODAY).filter((x) => x.returned === 0)).toEqual([])
  })
})

describe('a return belongs to ITS bill when numbers repeat across years (review fix)', () => {
  it("a return on this year's bill \"1\" is not counted against last year's bill \"1\" of the same party", () => {
    const lastYear: CompanyInfo = { ...INFO, booksFrom: 2024 }
    db = company(lastYear)
    const oldAmount = post({ kind: 'sale', customerId: L('Ramesh'), amount: { amount: '1000', gstRate: 0 }, date: '2025-02-10', payment: { how: 'cash' } }, db, lastYear)
    const oldItems = post({ kind: 'sale', customerId: L('Kumar'), items: [{ itemId: I('Widget'), qty: '2', rate: '500' }], date: '2025-02-11', payment: { how: 'cash' } }, db, lastYear)
    const newAmount = post({ kind: 'sale', customerId: L('Ramesh'), amount: { amount: '800', gstRate: 0 }, date: '2025-08-01', payment: { how: 'cash' } }, db, lastYear)
    const newItems = post({ kind: 'sale', customerId: L('Kumar'), items: [{ itemId: I('Widget'), qty: '3', rate: '500' }], date: '2025-08-02', payment: { how: 'cash' } }, db, lastYear)
    // Same party, same number, a year apart (numbering restarts every year).
    expect(getVoucher(db, oldAmount.voucherIds[0]!)!.number).toBe(getVoucher(db, newAmount.voucherIds[0]!)!.number)
    expect(getVoucher(db, oldItems.voucherIds[0]!)!.number).toBe(getVoucher(db, newItems.voucherIds[0]!)!.number)
    const na = returnBill(db, lastYear, 'sale', newAmount.voucherIds[0]!, TODAY)!
    post(returnIntentFrom(formFor({ amount: 30_000, settle: 'credit' }), na, ctxOf(), sellSetup(db).defaults), db, lastYear)
    const ni = returnBill(db, lastYear, 'sale', newItems.voucherIds[0]!, TODAY)!
    post(returnIntentFrom(formFor({ qty: { [ni.lines[0]!.lineUid]: '1' }, settle: 'credit' }), ni, ctxOf(), sellSetup(db).defaults), db, lastYear)
    // Last year's bills: nothing came back, all of it still returnable.
    expect(returnBill(db, lastYear, 'sale', oldAmount.voucherIds[0]!, TODAY)).toMatchObject({ amountLeft: 100_000, earlier: [] })
    expect(returnBill(db, lastYear, 'sale', oldItems.voucherIds[0]!, TODAY)!.earlier).toEqual([])
    const list = returnBills(db, lastYear, 'sale', TODAY)
    for (const id of [oldAmount.voucherIds[0]!, oldItems.voucherIds[0]!]) expect(list.find((x) => x.voucherId === id)).toMatchObject({ returns: 0, returned: 0, left: 'all' })
    // This year's: the return each.
    expect(returnBill(db, lastYear, 'sale', newAmount.voucherIds[0]!, TODAY)).toMatchObject({ amountLeft: 50_000 })
    expect(list.find((x) => x.voucherId === newAmount.voucherIds[0])).toMatchObject({ returns: 1, returned: 30_000 })
    expect(list.find((x) => x.voucherId === newItems.voucherIds[0])).toMatchObject({ returns: 1, returned: 59_000 })
    // The sales list's chips and paid figures follow.
    const sales = salesList(db, '2024-04-01', TODAY, TODAY)
    expect(sales.find((x) => x.voucherId === oldAmount.voucherIds[0])).toMatchObject({ total: 100_000, paid: 100_000, due: 0, returned: 0 })
    expect(sales.find((x) => x.voucherId === oldItems.voucherIds[0])).toMatchObject({ returned: 0 })
    expect(sales.find((x) => x.voucherId === newAmount.voucherIds[0])).toMatchObject({ total: 80_000, paid: 80_000, due: 0, returned: 30_000 })
  })
})

describe('simple:returns reads', () => {
  it('the list: newest first with what came back and what is left; search reaches by party and number', () => {
    const a = post({ kind: 'sale', customerId: L('Ramesh'), items: [{ itemId: I('Widget'), qty: '2', rate: '500' }], date: '2025-08-01' })
    const b = post({ kind: 'sale', customerId: L('Kumar'), amount: { amount: '300', gstRate: 0 }, date: '2025-08-02' })
    const ab = returnBill(db, INFO, 'sale', a.voucherIds[0]!, TODAY)!
    post(returnIntentFrom(formFor({ qty: { [ab.lines[0]!.lineUid]: '1' } }), ab, ctxOf(), sellSetup(db).defaults))
    const list = returnBills(db, INFO, 'sale', TODAY)
    expect(list.map((x) => [x.voucherId, x.mode, x.left, x.returns])).toEqual([[b.voucherIds[0], 'amount', 'all', 0], [a.voucherIds[0], 'items', 'part', 1]])
    expect(list[1]!.returned).toBe(59_000)
    expect(returnBills(db, INFO, 'sale', TODAY, 'kum').map((x) => x.voucherId)).toEqual([b.voucherIds[0]])
    expect(returnBills(db, INFO, 'sale', TODAY, '%').map((x) => x.voucherId)).toEqual([])
    expect(returnBills(db, INFO, 'purchase', TODAY)).toEqual([])
    // Return the rest: nothing left.
    const ab2 = returnBill(db, INFO, 'sale', a.voucherIds[0]!, TODAY)!
    expect(ab2.earlier).toHaveLength(1)
    post(returnIntentFrom(formFor({ qty: { [ab2.lines[0]!.lineUid]: '1' } }), ab2, ctxOf(), sellSetup(db).defaults))
    expect(returnBills(db, INFO, 'sale', TODAY).find((x) => x.voucherId === a.voucherIds[0])!.left).toBe('none')
    // A bill of the other side is not a sale bill.
    expect(returnBill(db, INFO, 'purchase', a.voucherIds[0]!, TODAY)).toBeNull()
  })
})

// ---------------------------------------------------------------- roles (through IPC)

describe('roles: a viewer reads the bills but cannot save a return', () => {
  let ipc: typeof import('../ipc')
  const call = (channel: string, payload?: unknown) => {
    const h = handlers.get(channel)
    if (!h) throw new Error(`no handler ${channel}`)
    return h({}, payload)
  }
  const ok = async <T>(channel: string, payload?: unknown): Promise<T> => {
    const res = await call(channel, payload)
    if (!res.ok) throw new Error(`${channel}: ${res.error}`)
    return res.data as T
  }
  beforeAll(async () => {
    ipc = await import('../ipc')
    ipc.registerIpc()
  })

  it('simple:returns:* are viewer reads; simple:post refuses a viewer with nothing saved', async () => {
    expect(ipc.CHANNEL_ROLES.get('simple:returns:bills')).toBe('viewer')
    expect(ipc.CHANNEL_ROLES.get('simple:returns:bill')).toBe('viewer')
    const { slug } = await ok<{ slug: string }>('company:create', {
      name: 'Viewer Returns', stateCode: '27', gstin: null, gstRegistrationType: 'unregistered', address: '', booksFrom: 2025, email: null, phone: null, pan: null, tan: null
    })
    await ok('company:open', { slug })
    const groups = await ok<{ id: number; name: string }[]>('master:groups:list')
    const gid = (n: string): number => groups.find((g) => g.name === n)!.id
    await ok('master:ledgers:create', { name: 'Sales', groupId: gid('Sales Accounts') })
    const customer = (await ok<{ id: number }>('master:ledgers:create', { name: 'Gupta', groupId: gid('Sundry Debtors') })).id
    const sale = await ok<{ voucherIds: number[] }>('simple:post', { intent: { clientId: 'viewer-sale-1', kind: 'sale', date: TODAY, customerId: customer, amount: { amount: 50_000 } }, today: TODAY })
    await ok('users:save', { data: { name: 'Owner', pin: '1111', role: 'owner', active: true } })
    const viewer = await ok<{ id: number }>('users:save', { data: { name: 'Looker', pin: '3333', role: 'viewer', active: true } })
    await ok('auth:login', { userId: viewer.id, pin: '3333' })
    const bills = await ok<{ voucherId: number }[]>('simple:returns:bills', { side: 'sale', today: TODAY })
    expect(bills.map((b) => b.voucherId)).toEqual(sale.voucherIds)
    expect(await ok<{ mode: string }>('simple:returns:bill', { side: 'sale', id: sale.voucherIds[0], asOn: TODAY })).toMatchObject({ mode: 'amount', pending: 50_000 })
    const vouchers = (): number => {
      const d = new Database(join(DATA_DIR, 'companies', slug, 'company.db'), { readonly: true })
      try {
        return (d.prepare('SELECT COUNT(*) AS n FROM vouchers').get() as { n: number }).n
      } finally {
        d.close()
      }
    }
    const before = vouchers()
    const res = await call('simple:post', { intent: { clientId: 'viewer-return-1', kind: 'return_sale', date: TODAY, billId: sale.voucherIds[0], amount: { amount: 10_000 } }, today: TODAY })
    expect(res).toMatchObject({ ok: false, code: 'not_permitted' })
    expect(vouchers()).toBe(before)
    expect((await call('simple:returns:bills', { side: 'refund' })).ok).toBe(false)
  })
})
