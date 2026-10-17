// WP 9.4 — Money in / out / move through the forms' own path (shared/simple/money.ts →
// simple:post). The plan's requirement: the flow's allocations EQUAL the Outstandings allocation —
// what the form showed ticked (billAllocation over simple:money:bills) is what the books then
// say for every bill (partyAllocation before − after), for oldest first exact, short with the
// advance answer, on account, a supplier payment and a supplier's refund. Plus: an expense with a
// GST bill is ONE purchase + payment equal to the accountant-entered pair, and its GST counts in
// GSTR-3B exactly as theirs; owner in / drawings / a loan taken / a move between accounts equal
// the hand-entered entries; the money list and an entry's view; the setup defaults (memory); the
// TDS hint uses the existing eligibility; lock / closed year / viewer refusals leave no trace.
import { TRUSTED_EVENT } from '../ipcSender.testutil'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { seededDb, TEST_INFO } from '../db/testdb'
import { readCompanyInfo, writeCompanyInfo } from '../db/seed'
import type { DB } from '../db/connection'
import type { CompanyInfo, Group, Voucher, VoucherKind } from '@shared/domain'
import { gstRegistrationOf } from '@shared/gst/registration'
import { translator } from '@shared/i18n'
import { stockItemInputSchema, type VoucherInputParsed } from '@shared/schemas'
import {
  buildAccountingPayload, buildInvoicePayload, derivePartyId, planVoucherEdit, taxLedgerIdsFrom, taxSideOf, voucherTaxLedgers,
  type AccountingFormState, type EditPlan
} from '@shared/voucherEdit'
import {
  billAllocation, billKey, emptyMoneyInForm, emptyMoneyOutForm, emptyMoveForm, moneyInErrors, moneyInIntentFrom, moneyOutErrors, moneyOutIntentFrom,
  moneyListUntil, moneyWho, moveIntentFrom, toggleBillTick, type MoneyInForm, type MoneyOutForm
} from '@shared/simple/money'
import { createLedger, createStockItem, listGroups, listLedgers, listStockItems } from './masters'
import { deleteVoucher, getVoucher, nextVoucherNumber, saveVoucher, setLockDate } from './vouchers'
import { partyAllocation, partyAllocationWithCredits } from './analysis'
import { postClose } from './yearEnd'
import { setFeatures, getFeatures } from './config'
import { gstr3b } from './gst'
import { previewIntent, postIntent } from './simplePost'
import { moneyBills, moneyEntry, moneyList, moneySetup } from './simpleMoney'
import { createMemory } from '../ai/memory'

// Review follow-up (#139): counts the receivables allocations moneySetup runs (the real function).
const allocationRuns = vi.hoisted(() => ({ receivable: 0 }))
vi.mock('./analysis', async (importOriginal) => {
  const m = await importOriginal<typeof import('./analysis')>()
  return {
    ...m,
    outstandingsWithAdvances: (...args: Parameters<typeof m.outstandingsWithAdvances>) => {
      if (args[1] === 'receivable') allocationRuns.receivable++
      return m.outstandingsWithAdvances(...args)
    }
  }
})
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
process.env.TOTAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'total-simple-money-'))
process.env.TOTAL_SUPPRESS_SYNC_WARNING = '1'

const INFO: CompanyInfo = { ...TEST_INFO, name: 'Simple Money Co', gstin: '27AAPFU0939F1ZV', stateCode: '27', gstRegistrationType: 'regular' }
const TODAY = '2025-08-14'

let db: DB
let seq = 0
const groupId = (d: DB, name: string): number => (d.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
const L = (name: string, d: DB = db): number => (d.prepare('SELECT id FROM ledgers WHERE name = ?').get(name) as { id: number }).id
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
  ledger(d, 'SBI', 'Bank Accounts')
  ledger(d, 'Rent', 'Indirect Expenses', { simpleCategory: 'rent' })
  ledger(d, 'Other income', 'Indirect Incomes')
  ledger(d, "Owner's money", 'Capital Account', { simpleCategory: 'owner_capital' })
  ledger(d, "Owner's drawings", 'Capital Account', { simpleCategory: 'owner_drawings' })
  ledger(d, 'Bank loan', 'Loans (Liability)')
  ledger(d, 'Ramesh', 'Sundry Debtors', { stateCode: '27', creditDays: 15 })
  ledger(d, 'Bharat Steel', 'Sundry Creditors', { stateCode: '27', gstin: '27AABCG3456H1ZN' })
  ledger(d, 'Delhi Traders', 'Sundry Creditors', { stateCode: '07' })
  const unit = d.prepare("SELECT id FROM units WHERE symbol = 'Nos'").get() as { id: number }
  createStockItem(d, stockItemInputSchema.parse({ name: 'Widget', unitId: unit.id, gstRate: 18, hsn: '8471', openingQtyMilli: 100_000, openingValue: 1_000_000 }))
  return d
}

const post = (intent: object, d: DB = db, info: CompanyInfo = INFO) => postIntent(d, info, { clientId: `money-${++seq}-x`, ...intent }, TODAY)

// ---------------------------------------------------------------- editor helpers (as simplePost.dbtest.ts)

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
const kindOf = (d: DB, v: Voucher): VoucherKind => (d.prepare('SELECT kind FROM voucher_types WHERE id = ?').get(v.voucherTypeId) as { kind: VoucherKind }).kind

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
    voucher: d.prepare('SELECT voucher_type_id, date, number, party_ledger_id, narration, reference, instrument_no, post_dated, is_optional FROM vouchers WHERE id = ?').get(id),
    lines: d.prepare('SELECT ledger_id, dr_cr, amount, line_order FROM voucher_lines WHERE voucher_id = ? ORDER BY line_order').all(id),
    billRefs: d.prepare('SELECT party_ledger_id, kind, name, amount, due_date FROM bill_refs WHERE voucher_id = ? ORDER BY id').all(id)
  }
}

/** Opens in the accounting editor and re-saves unchanged. */
function roundTrips(id: number): void {
  const before = rows(db, id)
  const { plan, payload } = editorResave(db, id)
  expect(plan.mode).toBe('accounting')
  saveVoucher(db, payload, id)
  expect(rows(db, id)).toEqual(before)
}

const blank = (date: string, rowsIn: AccountingFormState['rows'], billRefs: AccountingFormState['billRefs'], extra: Partial<AccountingFormState> = {}): AccountingFormState => ({
  date, number: '', rows: rowsIn, narration: '', instrumentNo: '', billRefs, advanceReceipt: false, optional: false, tds: null, tcs: null, original: null, ...extra
})
const r = (drCr: 'dr' | 'cr', ledgerId: number, amount: number) => ({ drCr, ledgerId, amount, costAllocations: [] })

/** The same entries typed into the accounting editor of an identical company. */
function handEntered(entries: { kind: VoucherKind; state: AccountingFormState }[], twin: DB = company()): { twin: DB; ids: number[] } {
  const ids = entries.map((e) => {
    const built = buildAccountingPayload(e.state, { kind: e.kind, voucherTypeId: typeId(twin, e.kind), derivedPartyId: derivePartyId(e.state.rows, isPartyOrTds(twin), null) })
    if (!built.ok) throw new Error(built.error)
    return saveVoucher(twin, built.payload).id
  })
  return { twin, ids }
}

function trace(d: DB = db): unknown {
  return {
    vouchers: count('SELECT COUNT(*) AS n FROM vouchers', d),
    lines: count('SELECT COUNT(*) AS n FROM voucher_lines', d),
    ledgers: count('SELECT COUNT(*) AS n FROM ledgers', d),
    posts: count('SELECT COUNT(*) AS n FROM simple_posts', d),
    audit: d.prepare('SELECT COUNT(*) AS n, MAX(id) AS last FROM audit_log').get(),
    seq: d.prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name').all(),
    next: nextVoucherNumber(d, typeId(d, 'receipt'), TODAY)
  }
}

// ---------------------------------------------------------------- the forms' path

/** The renderer's path for Money in: the form's answers (+ simple:money:setup / :bills) → the
 *  shared checks → moneyInIntentFrom → simple:post. Returns what the form showed ticked too. */
function moneyIn(f: Partial<MoneyInForm>) {
  const setup = moneySetup(db)
  const form: MoneyInForm = { ...emptyMoneyInForm(TODAY), ...f }
  const open = form.who === 'customer' && form.customerId != null ? moneyBills(db, form.customerId, form.date) : []
  expect(moneyInErrors(form, open, setup.defaultsIn, { ownerId: setup.ownerId })).toEqual({})
  const shown = billAllocation(open, form.amount, form.ticks, form.advance)
  const out = post(moneyInIntentFrom(form, open, setup.defaultsIn, { ownerId: setup.ownerId }))
  return { out, shown, open }
}
function moneyOut(f: Partial<MoneyOutForm>, info: CompanyInfo = INFO) {
  const setup = moneySetup(db)
  const form: MoneyOutForm = { ...emptyMoneyOutForm(TODAY), ...f }
  const open = form.who === 'supplier' && form.supplierId != null ? moneyBills(db, form.supplierId, form.date) : []
  const ctx = { facts: gstRegistrationOf(info), companyStateCode: info.stateCode, supplierState: (id: number) => setup.suppliers.find((s) => s.id === id)?.stateCode ?? null, drawingsId: setup.drawingsId }
  expect(moneyOutErrors(form, open, setup.defaultsOut, ctx)).toEqual({})
  const shown = billAllocation(open, form.amount, form.ticks, form.advance)
  const out = post(moneyOutIntentFrom(form, open, setup.defaultsOut, ctx), db, info)
  return { out, shown, open }
}

/** Pending per bill (by name) and the credit held — the Outstandings allocation. */
const allocation = (party: string): { bills: Record<string, number>; credit: number } => {
  const a = partyAllocation(db, L(party), TODAY)
  return { bills: Object.fromEntries(a.bills.map((b) => [b.number, b.pending])), credit: a.unappliedCredit }
}
/** What the form showed it would take off each bill = what the books took off it. */
function expectAllocationsEqual(before: { bills: Record<string, number>; credit: number }, after: { bills: Record<string, number>; credit: number }, shown: { settled: { name: string; amount: number }[]; advance: number }): void {
  const taken = Object.fromEntries(Object.entries(before.bills).map(([n, p]) => [n, p - (after.bills[n] ?? 0)]).filter(([, v]) => (v as number) > 0))
  expect(taken).toEqual(Object.fromEntries(shown.settled.map((s) => [s.name, s.amount])))
  expect(after.credit - before.credit).toBe(shown.advance)
}

/** Two sales bills to Ramesh on credit: ₹1,000 (1 Aug) and ₹600 (10 Aug), as ledger lines (no GST). */
function twoBills(): [string, string] {
  const a = post({ kind: 'sale', customerId: L('Ramesh'), date: '2025-08-01', amount: { amount: 100_000, gstRate: 0 }, payment: { how: 'credit' } })
  const b = post({ kind: 'sale', customerId: L('Ramesh'), date: '2025-08-10', amount: { amount: 60_000, gstRate: 0 }, payment: { how: 'credit' } })
  return [getVoucher(db, a.voucherIds[0]!)!.number, getVoucher(db, b.voucherIds[0]!)!.number]
}

beforeEach(() => {
  db = company()
})

describe('Money in: the form’s ticks equal the Outstandings allocation', () => {
  it('oldest first, exact: one and a half bills by UPI (into the UPI account), no advance', () => {
    const [b1, b2] = twoBills()
    expect(moneyBills(db, L('Ramesh'), TODAY).map((b) => [b.name, b.pending])).toEqual([[b1, 100_000], [b2, 60_000]])
    const before = allocation('Ramesh')
    const { out, shown } = moneyIn({ customerId: L('Ramesh'), amount: 130_000, how: 'upi' })
    expect(shown).toMatchObject({ settled: [{ name: b1, amount: 100_000 }, { name: b2, amount: 30_000 }], advance: 0, short: false })
    expectAllocationsEqual(before, allocation('Ramesh'), shown)
    expect(out.facts.settled).toEqual(shown.settled)
    const v = getVoucher(db, out.voucherIds[0]!)!
    expect(v.billRefs.map((x) => [x.kind, x.name, x.amount])).toEqual([['against', b1, 100_000], ['against', b2, 30_000]])
    expect(v.lines.map((l) => [l.ledgerId, l.drCr, l.amount])).toEqual([[L('HDFC Bank'), 'dr', 130_000], [L('Ramesh'), 'cr', 130_000]])
    roundTrips(v.id)
    expect(out.sentences).toEqual([`₹1,300.00 from Ramesh into HDFC Bank.`, `Pays bill ${b1}: ₹1,000.00.`, `Pays bill ${b2}: ₹300.00.`, 'Ramesh still owes ₹300.00.'])
  })

  it('ticked short of the amount with “for a bill you haven’t made yet”: those bills + a named advance', () => {
    const [b1, b2] = twoBills()
    const before = allocation('Ramesh')
    const { out, shown } = moneyIn({ customerId: L('Ramesh'), amount: 100_000, ticks: [b2], advance: true })
    expect(shown).toMatchObject({ settled: [{ name: b2, amount: 60_000 }], advance: 40_000, short: false })
    const after = allocation('Ramesh')
    expectAllocationsEqual(before, after, shown)
    expect(after.bills[b1]).toBe(100_000)
    const v = getVoucher(db, out.voucherIds[0]!)!
    // The advance is named after the entry (with the FY when sale #1 still holds that name).
    expect(v.billRefs.map((x) => [x.kind, x.name, x.amount])).toEqual([['against', b2, 60_000], ['new', v.number === b1 ? `${v.number}/25-26` : v.number, 40_000]])
    roundTrips(v.id)
    // Without the answer the form refuses under the bills (and so would simple:post).
    const setup = moneySetup(db)
    const f = { ...emptyMoneyInForm(TODAY), customerId: L('Ramesh'), amount: 100_000, ticks: [b1] }
    expect(moneyInErrors({ ...f, amount: 200_000 }, moneyBills(db, L('Ramesh'), TODAY), setup.defaultsIn, { ownerId: setup.ownerId })).toEqual({ bills: 'simple.money.err.ticksShort' })
  })

  it('on account: more than every bill, no advance answer — no bill named, the engine settles oldest first and holds the rest', () => {
    const [b1, b2] = twoBills()
    const before = allocation('Ramesh')
    const { out, shown } = moneyIn({ customerId: L('Ramesh'), amount: 200_000 })
    expect(shown).toMatchObject({ settled: [{ name: b1, amount: 100_000 }, { name: b2, amount: 60_000 }], advance: 40_000, short: false })
    expectAllocationsEqual(before, allocation('Ramesh'), shown)
    expect(getVoucher(db, out.voucherIds[0]!)!.billRefs).toEqual([])
    expect(out.facts.balance).toBe(-40_000)
  })

  it('the owner put money in, a loan taken, other income: Cr that account, equal to the hand-entered receipts', () => {
    const owner = moneyIn({ who: 'owner', amount: 500_000, how: 'bank' }).out
    const loan = moneyIn({ who: 'loan', sourceId: L('Bank loan'), amount: 1_000_000, how: 'bank', accountId: L('SBI') }).out
    const income = moneyIn({ who: 'income', sourceId: L('Other income'), amount: 2_500, how: 'cash', note: 'Scrap sold' }).out
    for (const o of [owner, loan, income]) roundTrips(o.voucherIds[0]!)
    const { twin, ids } = handEntered([
      { kind: 'receipt', state: blank(TODAY, [r('dr', L('HDFC Bank'), 500_000), r('cr', L("Owner's money"), 500_000)], []) },
      { kind: 'receipt', state: blank(TODAY, [r('dr', L('SBI'), 1_000_000), r('cr', L('Bank loan'), 1_000_000)], []) },
      { kind: 'receipt', state: blank(TODAY, [r('dr', L('Cash'), 2_500), r('cr', L('Other income'), 2_500)], [], { narration: 'Scrap sold' }) }
    ])
    expect(ids.map((id) => rows(twin, id))).toEqual([owner, loan, income].map((o) => rows(db, o.voucherIds[0]!)))
  })

  it('a refund from a supplier: against what they owe back (their advance), the allocation agrees', () => {
    const adv = moneyOut({ supplierId: L('Bharat Steel'), amount: 50_000, advance: true }).out
    expect(allocation('Bharat Steel')).toEqual({ bills: {}, credit: 50_000 })
    const { out } = moneyIn({ who: 'refund', supplierId: L('Bharat Steel'), amount: 50_000, how: 'bank' })
    const v = getVoucher(db, out.voucherIds[0]!)!
    expect(v.billRefs.map((x) => [x.kind, x.name, x.amount])).toEqual([['against', getVoucher(db, adv.voucherIds[0]!)!.number, 50_000]])
    expect(allocation('Bharat Steel')).toEqual({ bills: {}, credit: 0 })
    expect(out.facts).toMatchObject({ side: 'supplier', balance: 0 })
    roundTrips(v.id)
  })

  it('a supplier who owes us nothing back: refused on the supplier (no trace); “paying us for something else” posts it on account, = the hand-entered receipt', () => {
    const before = trace()
    expect(() => moneyIn({ who: 'refund', supplierId: L('Bharat Steel'), amount: 20_000, how: 'cash' })).toThrow(expect.objectContaining({ code: 'simple_refund_no_credit', field: 'party' }))
    expect(trace()).toEqual(before)
    const preview = (): unknown => previewIntent(db, INFO, { clientId: 'refund-none-01', kind: 'money_in', supplierId: L('Bharat Steel'), amount: 20_000, into: { how: 'cash' } }, TODAY)
    expect(preview).toThrow(expect.objectContaining({ code: 'simple_refund_no_credit', params: { name: 'Bharat Steel' } }))
    const { out } = moneyIn({ who: 'refund', supplierId: L('Bharat Steel'), amount: 20_000, how: 'cash', refundOther: true })
    const v = getVoucher(db, out.voucherIds[0]!)!
    expect(v.billRefs).toEqual([])
    roundTrips(v.id)
    const { twin, ids } = handEntered([{ kind: 'receipt', state: blank(TODAY, [r('dr', L('Cash'), 20_000), r('cr', L('Bharat Steel'), 20_000)], []) }])
    expect(rows(twin, ids[0]!)).toEqual(rows(db, v.id))
    // Now we owe them ₹200 (the money is on their account) — and a later refund is refused again.
    expect(out.facts).toMatchObject({ side: 'supplier', balance: 20_000 })
    expect(() => moneyIn({ who: 'refund', supplierId: L('Bharat Steel'), amount: 1_000, how: 'cash' })).toThrow(expect.objectContaining({ code: 'simple_refund_no_credit' }))
  })
})

describe('Money out', () => {
  it('a supplier: their bills oldest first, the allocation agrees; equal to the hand-entered payment', () => {
    const p1 = post({ kind: 'purchase', supplierId: L('Bharat Steel'), billNo: 'BS-1', date: '2025-08-02', amount: { amount: 100_000, accountId: L('Purchases'), gstRate: 18 }, payment: { how: 'credit' } })
    post({ kind: 'purchase', supplierId: L('Bharat Steel'), billNo: 'BS-2', date: '2025-08-05', amount: { amount: 50_000, accountId: L('Purchases'), gstRate: 18 }, payment: { how: 'credit' } })
    expect(p1.facts.total).toBe(118_000)
    const before = allocation('Bharat Steel')
    const { out, shown } = moneyOut({ supplierId: L('Bharat Steel'), amount: 150_000, how: 'bank' })
    expect(shown.settled).toEqual([{ name: 'BS-1', amount: 118_000 }, { name: 'BS-2', amount: 32_000 }])
    expectAllocationsEqual(before, allocation('Bharat Steel'), shown)
    const v = getVoucher(db, out.voucherIds[0]!)!
    roundTrips(v.id)
    const { twin, ids } = handEntered([
      { kind: 'payment', state: blank(TODAY, [r('dr', L('Bharat Steel'), 150_000), r('cr', L('HDFC Bank'), 150_000)], [{ kind: 'against', name: 'BS-1', amount: 118_000, dueDate: null }, { kind: 'against', name: 'BS-2', amount: 32_000, dueDate: null }]) }
    ])
    expect({ ...(rows(twin, ids[0]!) as object), voucher: null }).toEqual({ ...(rows(db, v.id) as object), voucher: null })
  })

  it('an expense with a GST bill: ONE purchase + its payment, equal to the accountant’s pair — and GSTR-3B counts its GST the same', () => {
    const before = trace()
    const { out } = moneyOut({ who: 'expense', payeeId: L('Rent'), amount: 118_000, gstBill: true, billSupplierId: L('Bharat Steel'), billNo: 'RENT-AUG', gstRate: 18, how: 'bank' })
    expect(out.entries.map((e) => [e.role, e.kind])).toEqual([['bill', 'purchase'], ['payment', 'payment']])
    expect(out.facts).toMatchObject({ kind: 'purchase', total: 118_000, tax: 18_000, paid: 118_000, balance: 0 })
    expect((trace() as { vouchers: number }).vouchers - (before as { vouchers: number }).vouchers).toBe(2)
    const [bill, pay] = out.voucherIds as [number, number]
    roundTrips(bill)
    roundTrips(pay)
    const { twin, ids } = handEntered([
      {
        kind: 'purchase',
        state: blank(TODAY, [r('cr', L('Bharat Steel'), 118_000), r('dr', L('Rent'), 100_000), r('dr', L('CGST'), 9_000), r('dr', L('SGST'), 9_000)], [{ kind: 'new', name: 'RENT-AUG', amount: 118_000, dueDate: TODAY }], { reference: 'RENT-AUG' })
      },
      { kind: 'payment', state: blank(TODAY, [r('dr', L('Bharat Steel'), 118_000), r('cr', L('HDFC Bank'), 118_000)], [{ kind: 'against', name: 'RENT-AUG', amount: 118_000, dueDate: null }]) }
    ])
    expect(rows(twin, ids[0]!)).toEqual(rows(db, bill))
    expect(rows(twin, ids[1]!)).toEqual(rows(db, pay))
    // GST on purchases (input tax) in GSTR-3B: the simple pair = the accountant's pair.
    const mine = gstr3b(db, INFO, '2025-08-01', '2025-08-31', '082025')
    const theirs = gstr3b(twin, INFO, '2025-08-01', '2025-08-31', '082025')
    expect(JSON.stringify(mine)).toBe(JSON.stringify(theirs))
    expect(JSON.stringify(mine)).toContain('9000')
  })

  it('review: a GST bill of ₹1,000.50 paid in cash — the bill and the cash paid are ₹1,000.50 (never rounded), on the INPUT tax accounts, = the accountant’s pair', () => {
    const io = (d: DB): void => {
      for (const [n, t] of [['Input CGST', 'cgst'], ['Input SGST', 'sgst'], ['Output CGST', 'cgst'], ['Output SGST', 'sgst']] as const) ledger(d, n, 'Duties & Taxes', { taxType: t })
    }
    io(db)
    const { out } = moneyOut({ who: 'expense', payeeId: L('Rent'), amount: 100_050, gstBill: true, billSupplierId: L('Bharat Steel'), billNo: 'RENT-SEP', gstRate: 18, how: 'cash' })
    const [bill, pay] = out.voucherIds as [number, number]
    expect(out.facts).toMatchObject({ total: 100_050, paid: 100_050, balance: 0 })
    const lines = (id: number) => getVoucher(db, id)!.lines.map((l) => [l.ledgerId, l.drCr, l.amount])
    // ₹847.88 + 9 % + 9 % = ₹1,000.50 exactly: no round off; the input side's accounts.
    expect(lines(bill)).toEqual([[L('Bharat Steel'), 'cr', 100_050], [L('Rent'), 'dr', 84_788], [L('Input CGST'), 'dr', 7_631], [L('Input SGST'), 'dr', 7_631]])
    expect(lines(pay)).toEqual([[L('Bharat Steel'), 'dr', 100_050], [L('Cash'), 'cr', 100_050]])
    roundTrips(bill)
    roundTrips(pay)
    const twin = company()
    io(twin)
    const { ids } = handEntered([
      {
        kind: 'purchase',
        state: blank(TODAY, [r('cr', L('Bharat Steel', twin), 100_050), r('dr', L('Rent', twin), 84_788), r('dr', L('Input CGST', twin), 7_631), r('dr', L('Input SGST', twin), 7_631)], [{ kind: 'new', name: 'RENT-SEP', amount: 100_050, dueDate: TODAY }], { reference: 'RENT-SEP' })
      },
      { kind: 'payment', state: blank(TODAY, [r('dr', L('Bharat Steel', twin), 100_050), r('cr', L('Cash', twin), 100_050)], [{ kind: 'against', name: 'RENT-SEP', amount: 100_050, dueDate: null }]) }
    ], twin)
    expect(rows(twin, ids[0]!)).toEqual(rows(db, bill))
    expect(rows(twin, ids[1]!)).toEqual(rows(db, pay))
    expect(JSON.stringify(gstr3b(db, INFO, '2025-08-01', '2025-08-31', '082025'))).toBe(JSON.stringify(gstr3b(twin, INFO, '2025-08-01', '2025-08-31', '082025')))
    // A total solveTaxable can't reach to the paisa keeps the typed total: the paisa is the round off.
    const odd = moneyOut({ who: 'expense', payeeId: L('Rent'), amount: 100_003, gstBill: true, billSupplierId: L('Bharat Steel'), billNo: 'RENT-OCT', gstRate: 18, how: 'cash' }).out
    expect(odd.facts).toMatchObject({ total: 100_003, paid: 100_003 })
    expect(getVoucher(db, odd.voucherIds[1]!)!.lines.map((l) => l.amount)).toEqual([100_003, 100_003])
    roundTrips(odd.voucherIds[0]!)
  })

  it('an inter-state supplier’s GST bill books IGST', () => {
    const { out } = moneyOut({ who: 'expense', payeeId: L('Rent'), amount: 59_000, gstBill: true, billSupplierId: L('Delhi Traders'), billNo: 'DT-7', gstRate: 18 })
    const v = getVoucher(db, out.voucherIds[0]!)!
    expect(v.lines.find((l) => l.ledgerId === L('IGST'))?.amount).toBe(9_000)
  })

  it('no GST bill (or not registered): a payment to the expense; the owner took money: drawings', () => {
    const rent = moneyOut({ who: 'expense', payeeId: L('Rent'), amount: 25_000, gstBill: false }).out
    const mine = moneyOut({ who: 'owner', amount: 10_000 }).out
    for (const o of [rent, mine]) roundTrips(o.voucherIds[0]!)
    const { twin, ids } = handEntered([
      { kind: 'payment', state: blank(TODAY, [r('dr', L('Rent'), 25_000), r('cr', L('Cash'), 25_000)], []) },
      { kind: 'payment', state: blank(TODAY, [r('dr', L("Owner's drawings"), 10_000), r('cr', L('Cash'), 10_000)], []) }
    ])
    expect(ids.map((id) => rows(twin, id))).toEqual([rent, mine].map((o) => rows(db, o.voucherIds[0]!)))
    // An unregistered company is never asked — the same answers are a plain payment.
    const info: CompanyInfo = { ...INFO, gstin: null, gstRegistrationType: 'unregistered' }
    writeCompanyInfo(db, info)
    const plain = moneyOut({ who: 'expense', payeeId: L('Rent'), amount: 11_800, gstBill: true, billSupplierId: L('Bharat Steel'), billNo: 'X', gstRate: 18 }, info).out
    expect(plain.entries.map((e) => e.kind)).toEqual(['payment'])
  })

  it('TDS on: the existing eligibility rules fire on the rehearsed payment (a hint only — nothing deducted)', () => {
    const sec = (db.prepare("SELECT id FROM tds_sections WHERE code = '194C'").get() as { id: number }).id
    const contractor = ledger(db, 'Contractor Co', 'Sundry Creditors', { tdsSectionId: sec, pan: 'ABCCE1234F' })
    const intent = { clientId: 'tds-000001', kind: 'money_out', supplierId: contractor, amount: 3_500_000, from: { how: 'bank' } }
    expect(getFeatures(db).tds).toBe(true)
    const p = previewIntent(db, INFO, intent, TODAY)
    expect(p.tds).toEqual([{ partyName: 'Contractor Co', sectionCode: '194C', tdsPaise: 70_000 }])
    expect(p.entries[0]!.lines.map((l) => l.amount)).toEqual([3_500_000, 3_500_000])
    setFeatures(db, { ...getFeatures(db), tds: false })
    expect(previewIntent(db, INFO, intent, TODAY).tds).toBeUndefined()
    // Under the threshold: nothing to say.
    setFeatures(db, { ...getFeatures(db), tds: true })
    expect(previewIntent(db, INFO, { ...intent, amount: 1_000_000 }, TODAY).tds).toBeUndefined()
  })
})

describe('Money out: a refund to a customer', () => {
  it('against the advance they paid: = the hand-entered payment in a twin company, and the Outstandings allocation agrees', () => {
    const adv = moneyIn({ customerId: L('Ramesh'), amount: 50_000, advance: true }).out
    const advName = getVoucher(db, adv.voucherIds[0]!)!.number
    expect(allocation('Ramesh')).toEqual({ bills: {}, credit: 50_000 })
    expect(moneySetup(db, { customerCredits: true }).customerCredits).toEqual([{ id: L('Ramesh'), name: 'Ramesh', credit: 50_000 }])
    const { out } = moneyOut({ who: 'refund', customerId: L('Ramesh'), amount: 30_000, how: 'bank' })
    const v = getVoucher(db, out.voucherIds[0]!)!
    expect(v.billRefs.map((x) => [x.kind, x.name, x.amount])).toEqual([['against', advName, 30_000]])
    // Where they stand after: ₹200 of theirs still with us — the allocation, and the sentence says so.
    expect(allocation('Ramesh')).toEqual({ bills: {}, credit: 20_000 })
    expect(out.facts).toMatchObject({ kind: 'money_out', side: 'customer', balance: -20_000 })
    expect(out.sentences.at(-1)).toContain('₹200.00')
    roundTrips(v.id)
    const { twin, ids } = handEntered([
      { kind: 'receipt', state: blank(TODAY, [r('dr', L('Cash'), 50_000), r('cr', L('Ramesh'), 50_000)], [{ kind: 'new', name: advName, amount: 50_000, dueDate: null }]) },
      { kind: 'payment', state: blank(TODAY, [r('dr', L('Ramesh'), 30_000), r('cr', L('HDFC Bank'), 30_000)], [{ kind: 'against', name: advName, amount: 30_000, dueDate: null }]) }
    ])
    expect(rows(twin, ids[1]!)).toEqual(rows(db, v.id))
    const ta = partyAllocation(twin, L('Ramesh', twin), TODAY)
    expect({ bills: ta.bills.length, credit: ta.unappliedCredit }).toEqual({ bills: 0, credit: 20_000 })
  })

  it('more than the credit held: the excess opens a bill named after the payment — the customer now owes it (the supplier-refund mirror)', () => {
    const adv = moneyIn({ customerId: L('Ramesh'), amount: 50_000, advance: true }).out
    const advName = getVoucher(db, adv.voucherIds[0]!)!.number
    const { out } = moneyOut({ who: 'refund', customerId: L('Ramesh'), amount: 60_000, how: 'cash' })
    const v = getVoucher(db, out.voucherIds[0]!)!
    expect(v.billRefs.map((x) => [x.kind, x.name, x.amount])).toEqual([['against', advName, 60_000]])
    expect(allocation('Ramesh')).toEqual({ bills: { [v.number]: 10_000 }, credit: 0 })
    expect(out.facts).toMatchObject({ side: 'customer', balance: 10_000 })
  })

  it('a customer whose credit is unnamed (money received on account, no advance flag) counts as credit held: the refund nets it off, no bill opens', () => {
    twoBills()
    post({ kind: 'money_in', customerId: L('Ramesh'), amount: 190_000, into: { how: 'cash' } })
    expect(allocation('Ramesh')).toEqual({ bills: {}, credit: 30_000 })
    expect(moneySetup(db, { customerCredits: true }).customerCredits).toEqual([{ id: L('Ramesh'), name: 'Ramesh', credit: 30_000 }])
    const { out } = moneyOut({ who: 'refund', customerId: L('Ramesh'), amount: 30_000, how: 'cash' })
    expect(getVoucher(db, out.voucherIds[0]!)!.billRefs).toEqual([])
    expect(allocation('Ramesh')).toEqual({ bills: {}, credit: 0 })
    expect(out.facts).toMatchObject({ side: 'customer', balance: 0 })
  })

  it('only Money out asks for the credits: the plain setup (Money in / Move money) runs no receivables allocation', () => {
    moneyIn({ customerId: L('Ramesh'), amount: 50_000, advance: true })
    const before = allocationRuns.receivable
    const plain = moneySetup(db)
    expect(allocationRuns.receivable).toBe(before)
    expect(plain.customerCredits).toBeUndefined()
    const out = moneySetup(db, { customerCredits: true })
    expect(allocationRuns.receivable).toBe(before + 1)
    expect(out.customerCredits).toEqual([{ id: L('Ramesh'), name: 'Ramesh', credit: 50_000 }])
    // everything else is the same answer
    const { customerCredits: _c, ...rest } = out
    expect(rest).toEqual(plain)
  })

  it('a customer holding no credit: refused on the customer, no trace; not offered by the setup', () => {
    twoBills()
    expect(moneySetup(db, { customerCredits: true }).customerCredits).toEqual([])
    const before = trace()
    expect(() => post({ kind: 'money_out', customerId: L('Ramesh'), amount: 1_000, from: { how: 'cash' } })).toThrow(expect.objectContaining({ code: 'simple_customer_no_credit', field: 'party' }))
    expect(trace()).toEqual(before)
  })
})

describe('to-do §4: bills of one name, and names a credit has had', () => {
  const at = (date: string, intent: object) => postIntent(db, INFO, { clientId: `twin-${++seq}-x`, ...intent }, date)
  const pending = (asOn: string) => partyAllocation(db, L('Ramesh'), asOn).bills.map((b) => [b.voucherId, b.number, b.pending])

  /** Two open bills "1" for Ramesh: FY 25-26 (₹200) and FY 26-27 (₹500) — the older was paid when
   *  the newer was made (so the newer took the plain name), then that receipt was binned. */
  function twinBills(): { older: number; newer: number } {
    const older = at('2025-08-01', { kind: 'sale', customerId: L('Ramesh'), number: '1', amount: { amount: 20_000, gstRate: 0 }, payment: { how: 'credit' } }).voucherIds[0]!
    const paid = at('2025-08-05', { kind: 'money_in', customerId: L('Ramesh'), amount: 20_000, into: { how: 'cash' } }).voucherIds[0]!
    const newer = at('2026-04-10', { kind: 'sale', customerId: L('Ramesh'), number: '1', amount: { amount: 50_000, gstRate: 0 }, payment: { how: 'credit' } }).voucherIds[0]!
    deleteVoucher(db, paid)
    return { older, newer }
  }

  it('each bill is ticked on its own (by entry); the newer one is paid after its older namesake — the Outstandings allocation agrees', () => {
    const { older, newer } = twinBills()
    const day = '2026-04-15'
    expect(pending(day)).toEqual([[older, '1', 20_000], [newer, '1', 50_000]])
    const open = moneyBills(db, L('Ramesh'), day)
    const [kOld, kNew] = open.map(billKey) as [string, string]
    expect(kOld).not.toBe(kNew)
    // Ticking the older one ticks only it: ₹200 settles just that bill.
    const onlyOld = toggleBillTick(open, [], kOld, true)
    expect(onlyOld).toEqual([kOld])
    const setup = moneySetup(db)
    const form = (amount: number, ticks: string[]): MoneyInForm => ({ ...emptyMoneyInForm(day), customerId: L('Ramesh'), amount, how: 'cash', ticks })
    const before = trace()
    // The newer alone can't be settled by name while the older is open: refused on the bill, no trace.
    expect(() => at(day, { kind: 'money_in', customerId: L('Ramesh'), amount: 50_000, into: { how: 'cash' }, bills: [{ name: '1', billId: newer }] })).toThrow(
      expect.objectContaining({ code: 'simple_bill_older_first', field: 'bills.0' })
    )
    expect(trace()).toEqual(before)
    // The form never sends that: ticking the newer brings the older (paid first).
    const both = toggleBillTick(open, [], kNew, true)
    expect(both).toEqual([kOld, kNew])
    const shown = billAllocation(open, 45_000, both, false)
    const i = moneyInIntentFrom(form(45_000, both), open, setup.defaultsIn, { ownerId: setup.ownerId })
    expect(i).toMatchObject({ bills: [{ name: '1', amount: 20_000, billId: older }, { name: '1', amount: 25_000, billId: newer }] })
    at(day, i)
    expect(shown.settled).toEqual([{ name: '1', amount: 20_000 }, { name: '1', amount: 25_000 }])
    expect(pending(day)).toEqual([[newer, '1', 25_000]])
    // Then the older one alone (now paid): the newer is the only open "1" and takes it all.
    const left = moneyBills(db, L('Ramesh'), day)
    const j = moneyInIntentFrom(form(25_000, [billKey(left[0]!)]), left, setup.defaultsIn, { ownerId: setup.ownerId })
    at(day, j)
    expect(pending(day)).toEqual([])
  })

  it('PR #171 review: a stale billId (no open bill of that entry) is refused on the bill, never a crash or another bill; no trace', () => {
    const { older } = twinBills()
    const before = trace()
    for (const billId of [999_999, older + 1_000]) {
      expect(() => at('2026-04-15', { kind: 'money_in', customerId: L('Ramesh'), amount: 20_000, into: { how: 'cash' }, bills: [{ name: '1', billId }] })).toThrow(
        expect.objectContaining({ code: 'simple_bill_unknown', field: 'bills.0' })
      )
    }
    expect(trace()).toEqual(before)
  })

  it('untouched (oldest first) reaches both bills of one name in turn, as the engine does', () => {
    const { older, newer } = twinBills()
    const out = at('2026-04-15', { kind: 'money_in', customerId: L('Ramesh'), amount: 30_000, into: { how: 'cash' } })
    expect(out.facts.settled).toEqual([{ name: '1', amount: 20_000 }, { name: '1', amount: 10_000 }])
    expect(pending('2026-04-15')).toEqual([[newer, '1', 40_000]])
    expect(older).toBeLessThan(newer)
  })

  it('a later bill never reuses the name of a credit that has been used up (it gets the year added)', () => {
    // An advance "ADV1" from Ramesh, then refunded in full: the credit is settled, its name stays taken.
    const adv = at(TODAY, { kind: 'money_in', customerId: L('Ramesh'), number: 'ADV1', amount: 10_000, into: { how: 'cash' }, bills: [], advance: true })
    expect(db.prepare("SELECT name FROM bill_refs WHERE voucher_id = ? AND kind = 'new'").all(adv.voucherIds[0]) as { name: string }[]).toEqual([{ name: 'ADV1' }])
    at(TODAY, { kind: 'money_out', customerId: L('Ramesh'), amount: 10_000, from: { how: 'cash' } })
    expect(partyAllocationWithCredits(db, L('Ramesh'), TODAY)).toMatchObject({ credits: [], unappliedCredit: 0, bills: [] })
    const sale = at(TODAY, { kind: 'sale', customerId: L('Ramesh'), number: 'ADV1', amount: { amount: 5_000, gstRate: 0 }, payment: { how: 'credit' } })
    expect(db.prepare("SELECT name FROM bill_refs WHERE voucher_id = ? AND kind = 'new'").all(sale.voucherIds[0]) as { name: string }[]).toEqual([{ name: 'ADV1/25-26' }])
    expect(partyAllocation(db, L('Ramesh'), TODAY).bills.map((b) => [b.number, b.pending])).toEqual([['ADV1/25-26', 5_000]])
  })
})

describe('PR #171 review: default numbering next to an advance', () => {
  const nameOf = (vid: number) => (db.prepare("SELECT name FROM bill_refs WHERE voucher_id = ? AND kind = 'new'").all(vid) as { name: string }[]).map((r) => r.name)
  it('an advance named by the default receipt number that is still OPEN: the first sale takes the year (as before this PR)', () => {
    const adv = post({ kind: 'money_in', customerId: L('Ramesh'), amount: 10_000, into: { how: 'cash' }, bills: [], advance: true })
    const advName = nameOf(adv.voucherIds[0]!)[0]!
    const sale = post({ kind: 'sale', customerId: L('Ramesh'), amount: { amount: 5_000, gstRate: 0 }, payment: { how: 'credit' } })
    // Both series start at "1" in a fresh company: receipt 1 = the advance's name, sale 1 takes the year.
    expect([advName, getVoucher(db, sale.voucherIds[0]!)!.number, nameOf(sale.voucherIds[0]!)]).toEqual(['1', '1', ['1/25-26']])
  })
  it('the same advance USED UP (refunded): a sale numbered like it still takes the year — only this party, only that number', () => {
    const adv = post({ kind: 'money_in', customerId: L('Ramesh'), amount: 10_000, into: { how: 'cash' }, bills: [], advance: true })
    const advName = nameOf(adv.voucherIds[0]!)[0]!
    post({ kind: 'money_out', customerId: L('Ramesh'), amount: 10_000, from: { how: 'cash' } })
    const sale = post({ kind: 'sale', customerId: L('Ramesh'), number: advName, amount: { amount: 5_000, gstRate: 0 }, payment: { how: 'credit' } })
    expect(nameOf(sale.voucherIds[0]!)).toEqual([`${advName}/25-26`])
    // Another customer's bill of that number is untouched.
    const other = ledger(db, 'Suresh', 'Sundry Debtors', { stateCode: '27' })
    const s2 = post({ kind: 'sale', customerId: other, number: `${advName}-x`, amount: { amount: 5_000, gstRate: 0 }, payment: { how: 'credit' } })
    expect(nameOf(s2.voucherIds[0]!)).toEqual([`${advName}-x`])
    // And Undo of the year-suffixed sale is offered (nothing rests on its own name) — the point of the rule.
    expect(db.prepare("SELECT COUNT(*) AS n FROM bill_refs WHERE kind = 'against' AND name = ? AND party_ledger_id = ?").get(`${advName}/25-26`, L('Ramesh'))).toEqual({ n: 0 })
  })
})

describe('Move money, the list, the setup', () => {
  it('a move between accounts is a contra (Dr to, Cr from), equal to the hand-entered one', () => {
    const out = post(moveIntentFrom({ ...emptyMoveForm(TODAY), fromId: L('Cash'), toId: L('HDFC Bank'), amount: 300_000, note: 'Deposit' }))
    expect(out.entries.map((e) => e.kind)).toEqual(['contra'])
    roundTrips(out.voucherIds[0]!)
    const { twin, ids } = handEntered([{ kind: 'contra', state: blank(TODAY, [r('dr', L('HDFC Bank'), 300_000), r('cr', L('Cash'), 300_000)], [], { narration: 'Deposit' }) }])
    expect(rows(twin, ids[0]!)).toEqual(rows(db, out.voucherIds[0]!))
  })

  it('the money list: receipts, payments and moves in the books, newest first, with who / how / what', () => {
    const [b1] = twoBills()
    const mi = moneyIn({ customerId: L('Ramesh'), amount: 100_000, how: 'upi' }).out
    const mo = moneyOut({ who: 'owner', amount: 5_000 }).out
    const mv = post(moveIntentFrom({ ...emptyMoveForm(TODAY), fromId: L('Cash'), toId: L('SBI'), amount: 1_000 }))
    const list = moneyList(db, '2025-04-01', TODAY)
    expect(list.map((x) => [x.voucherId, x.direction, x.who, x.account, x.amount, x.chips])).toEqual([
      [mv.voucherIds[0], 'move', 'SBI', 'Cash', 1_000, []],
      [mo.voucherIds[0], 'out', "Owner's drawings", 'Cash', 5_000, ['owner']],
      [mi.voucherIds[0], 'in', 'Ramesh', 'HDFC Bank', 100_000, ['bills']]
    ])
    expect(moneyEntry(db, mi.voucherIds[0]!)).toMatchObject({ kind: 'receipt', bills: [{ name: b1, amount: 100_000, advance: false }], billCount: 1 })
    // A binned entry leaves the list and its view.
    db.prepare("UPDATE vouchers SET deleted_at = '2025-08-14T00:00:00Z' WHERE id = ?").run(mo.voucherIds[0])
    expect(moneyList(db, '2025-04-01', TODAY).map((x) => x.voucherId)).not.toContain(mo.voucherIds[0])
    expect(moneyEntry(db, mo.voucherIds[0]!)).toBeNull()
    // A sales bill is not a money entry.
    expect(moneyEntry(db, getVoucher(db, mi.voucherIds[0]!)!.id - 1)).toBeNull()
  })

  it('to-do §4: paying a GST bill for an expense names the expense (“Rent (Bharat Steel)”) and carries the expense chip — read from the bill it settles', () => {
    const rent = moneyOut({ who: 'expense', payeeId: L('Rent'), amount: 118_000, gstBill: true, billSupplierId: L('Bharat Steel'), billNo: 'RENT-AUG', gstRate: 18, how: 'bank' }).out
    const pay = rent.voucherIds[1]!
    // A goods bill (Purchases) paid now: the supplier only, as before.
    const goods = post({ kind: 'purchase', supplierId: L('Bharat Steel'), billNo: 'BS-1', date: TODAY, amount: { amount: 50_000, gstRate: 0 }, payment: { how: 'cash' } })
    // A later payment of a part-paid expense bill, from Money out → a supplier: the bill it settles says what it was for.
    const part = post({ kind: 'purchase', supplierId: L('Delhi Traders'), billNo: 'DT-RENT', date: TODAY, amount: { amount: 10_000, accountId: L('Rent'), gstRate: 18 }, payment: { how: 'credit' } })
    expect(part.facts.forWhat).toBe('Rent')
    const later = moneyOut({ who: 'supplier', supplierId: L('Delhi Traders'), amount: 11_800, how: 'cash' }).out
    const list = moneyList(db, '2025-04-01', TODAY)
    const row = (id: number) => list.find((x) => x.voucherId === id)!
    expect(row(pay)).toMatchObject({ who: 'Bharat Steel', forWhat: 'Rent', chips: ['bills', 'expense'] })
    expect(row(goods.voucherIds[1]!)).toMatchObject({ who: 'Bharat Steel', chips: ['bills'] })
    expect(row(goods.voucherIds[1]!).forWhat).toBeUndefined()
    expect(row(later.voucherIds[0]!)).toMatchObject({ who: 'Delhi Traders', forWhat: 'Rent', chips: ['bills', 'expense'] })
    expect(moneyEntry(db, pay)).toMatchObject({ forWhat: 'Rent', chips: ['bills', 'expense'] })
    expect(moneyWho(row(pay), translator('en'))).toBe('Rent (Bharat Steel)')
    // Binning the bill: nothing to read it from, the payment names the supplier only.
    db.prepare("UPDATE vouchers SET deleted_at = '2025-08-14T00:00:00Z' WHERE id = ?").run(rent.voucherIds[0])
    expect(moneyEntry(db, pay)!.forWhat).toBeUndefined()
  })

  it('PR #171 review: one bill over two expense accounts, two bills of different expenses — neither named; two Rent bills — Rent', () => {
    const elec = ledger(db, 'Electricity', 'Indirect Expenses')
    // An accountant's bill split over Rent + Electricity (and its GST), then paid in full.
    const { ids: [split] } = handEntered(
      [{ kind: 'purchase', state: blank(TODAY, [r('cr', L('Delhi Traders'), 23_600), r('dr', L('Rent'), 10_000), r('dr', elec, 10_000), r('dr', L('IGST'), 3_600)], [{ kind: 'new', name: 'SPLIT', amount: 23_600, dueDate: null }], { reference: 'SPLIT' }) }],
      db
    )
    expect(split).toBeGreaterThan(0)
    const paySplit = moneyOut({ who: 'supplier', supplierId: L('Delhi Traders'), amount: 23_600, how: 'cash' }).out.voucherIds[0]!
    // Two bills of Bharat Steel: rent and electricity, paid together.
    post({ kind: 'purchase', supplierId: L('Bharat Steel'), billNo: 'R-1', date: TODAY, amount: { amount: 10_000, accountId: L('Rent'), gstRate: 18 }, payment: { how: 'credit' } })
    post({ kind: 'purchase', supplierId: L('Bharat Steel'), billNo: 'E-1', date: TODAY, amount: { amount: 10_000, accountId: elec, gstRate: 18 }, payment: { how: 'credit' } })
    const payBoth = moneyOut({ who: 'supplier', supplierId: L('Bharat Steel'), amount: 23_600, how: 'cash' }).out.voucherIds[0]!
    // Two Rent bills paid together: Rent.
    post({ kind: 'purchase', supplierId: L('Bharat Steel'), billNo: 'R-2', date: TODAY, amount: { amount: 10_000, accountId: L('Rent'), gstRate: 18 }, payment: { how: 'credit' } })
    post({ kind: 'purchase', supplierId: L('Bharat Steel'), billNo: 'R-3', date: TODAY, amount: { amount: 10_000, accountId: L('Rent'), gstRate: 18 }, payment: { how: 'credit' } })
    const payRents = moneyOut({ who: 'supplier', supplierId: L('Bharat Steel'), amount: 23_600, how: 'cash' }).out.voucherIds[0]!
    const list = moneyList(db, '2025-04-01', TODAY)
    const row = (id: number) => list.find((x) => x.voucherId === id)!
    expect(row(paySplit).forWhat).toBeUndefined()
    expect(row(payBoth).forWhat).toBeUndefined()
    expect(row(payBoth).chips).toEqual(['bills'])
    expect(row(payRents)).toMatchObject({ forWhat: 'Rent', chips: ['bills', 'expense'] })
    expect(moneyWho(row(payRents), translator('hi'))).toBe('Rent (Bharat Steel)')
  })

  it('the money list reaches as far ahead as simple:post allows (+30 days); rows after today say “dated ahead”', () => {
    const ahead = post(moveIntentFrom({ ...emptyMoveForm('2025-09-10'), fromId: L('Cash'), toId: L('SBI'), amount: 2_000 }))
    const now = post(moveIntentFrom({ ...emptyMoveForm(TODAY), fromId: L('Cash'), toId: L('SBI'), amount: 1_000 }))
    // 31 days ahead is refused by simple:post, so the list never needs to look further.
    expect(() => post(moveIntentFrom({ ...emptyMoveForm('2025-09-14'), fromId: L('Cash'), toId: L('SBI'), amount: 500 }))).toThrow(/days ahead/)
    const until = moneyListUntil(TODAY, '2026-03-31')
    expect(until).toBe('2025-09-13')
    const list = moneyList(db, '2025-04-01', until, TODAY)
    expect(list.map((x) => [x.voucherId, x.ahead ?? false])).toEqual([[ahead.voucherIds[0], true], [now.voucherIds[0], false]])
    // "Ahead" is measured from the date passed in (the working date the range uses): a day earlier
    // marks today's entry ahead too.
    expect(moneyList(db, '2025-04-01', until, '2025-08-13').map((x) => x.ahead ?? false)).toEqual([true, true])
    // The working date past the period's end: the period's own end, as before.
    expect(moneyListUntil('2026-05-01', '2026-03-31')).toBe('2026-03-31')
  })

  it('the setup: parties, accounts, defaults (WP 5.6 memory per side), owner / drawings / loans', () => {
    const s = moneySetup(db)
    expect(s.customers.map((c) => c.name)).toEqual(['Ramesh'])
    expect(s.suppliers.map((c) => c.name)).toEqual(['Bharat Steel', 'Delhi Traders'])
    expect(s).toMatchObject({ ownerId: L("Owner's money"), drawingsId: L("Owner's drawings"), loans: [{ id: L('Bank loan'), name: 'Bank loan' }], tds: true, payroll: true, memoryIn: null })
    expect(s.defaultsIn).toEqual({ cash: L('Cash'), upi: L('HDFC Bank'), card: L('HDFC Bank'), bank: L('HDFC Bank') })
    const m = createMemory(db, { kind: 'preference', text: 'Customers pay into SBI', data: { purpose: 'receipt', ledgerId: L('SBI') } }, { source: 'user', status: 'active', createdBy: null })
    const s2 = moneySetup(db)
    expect(s2).toMatchObject({ memoryIn: m.id, memoryOut: null })
    expect(s2.defaultsIn.upi).toBe(L('SBI'))
    expect(s2.defaultsOut.upi).toBe(L('HDFC Bank'))
  })
})

describe('review: the owner’s account when none carries the category', () => {
  it('is the first ledger DIRECTLY under Capital Account — never one under Reserves & Surplus (as the openings choose)', () => {
    db.prepare("UPDATE ledgers SET simple_category = NULL WHERE simple_category IN ('owner_capital', 'owner_drawings')").run()
    ledger(db, 'A General Reserve', 'Reserves & Surplus')
    expect(moneySetup(db)).toMatchObject({ ownerId: L("Owner's money"), drawingsId: L("Owner's drawings") })
    const { out } = moneyIn({ who: 'owner', amount: 10_000 })
    expect(getVoucher(db, out.voucherIds[0]!)!.lines.find((l) => l.drCr === 'cr')?.ledgerId).toBe(L("Owner's money"))
  })
})

describe('refusals leave no trace', () => {
  it('a locked date → date; a closed year → date', () => {
    twoBills()
    setLockDate(db, '2025-08-31')
    const before = trace()
    const setup = moneySetup(db)
    const f = { ...emptyMoneyInForm(TODAY), customerId: L('Ramesh'), amount: 10_000 }
    expect(() => post(moneyInIntentFrom(f, moneyBills(db, L('Ramesh'), TODAY), setup.defaultsIn, { ownerId: setup.ownerId }))).toThrow(expect.objectContaining({ code: 'books_locked', field: 'date' }))
    expect(() => post(moveIntentFrom({ ...emptyMoveForm(TODAY), fromId: L('Cash'), toId: L('SBI'), amount: 1 }))).toThrow(expect.objectContaining({ code: 'books_locked', field: 'date' }))
    expect(trace()).toEqual(before)
    setLockDate(db, null)
    postClose(db, INFO, 2025)
    setLockDate(db, null)
    const closed = trace()
    expect(() => post({ kind: 'money_out', payeeId: L('Rent'), amount: 100, from: { how: 'cash' }, date: '2025-09-01' })).toThrow(expect.objectContaining({ code: 'simple_year_closed', field: 'date' }))
    expect(trace()).toEqual(closed)
  })

  it('a viewer reads the Money screens but can’t save (simple:post refused, nothing written)', async () => {
    const ipc = await import('../ipc')
    ipc.registerIpc()
    const call = async (ch: string, p?: unknown) => handlers.get(ch)!(TRUSTED_EVENT, p)
    const ok = async <T,>(ch: string, p?: unknown): Promise<T> => {
      const res = await call(ch, p)
      if (!res.ok) throw new Error(`${ch}: ${res.error}`)
      return res.data as T
    }
    const { slug } = await ok<{ slug: string }>('company:create', { name: 'Viewer Money Co', stateCode: '27', gstin: null, gstRegistrationType: 'unregistered', address: '', booksFrom: 2025, email: null, phone: null, pan: null, tan: null })
    await ok('company:open', { slug })
    await ok('users:save', { data: { name: 'Olive', role: 'owner', pin: '1111' } })
    const viewer = await ok<{ id: number }>('users:save', { data: { name: 'Vik', role: 'viewer', pin: '2222' } })
    await ok('auth:logout')
    await ok('auth:login', { userId: viewer.id, pin: '2222' })
    const setup = await ok<{ moneyAccounts: { id: number; kind: string }[]; customerCredits?: unknown }>('simple:money:setup')
    expect(setup.customerCredits).toBeUndefined()
    expect((await ok<{ customerCredits?: unknown }>('simple:money:setup', { customerCredits: true })).customerCredits).toEqual([])
    expect(await call('simple:money:setup', { side: 'out' })).toMatchObject({ ok: false }) // strict
    const cash = setup.moneyAccounts.find((a) => a.kind === 'cash')!.id
    const before = await ok<unknown[]>('simple:money:list', { from: '2025-04-01', to: '2026-03-31' })
    const res = await call('simple:post', { intent: { clientId: 'viewer-0001', kind: 'move_money', amount: 100, fromId: cash, toId: cash + 999 }, today: TODAY })
    expect(res).toMatchObject({ ok: false, code: 'not_permitted' })
    expect(await ok<unknown[]>('simple:money:list', { from: '2025-04-01', to: '2026-03-31' })).toEqual(before)
  })
})
