// WP 9.10 — the Accountant-view hand-off.
//   - simple:intentForm is a viewer read whose rehearsal leaves no trace (rows, sequences, audit
//     chain), and the editor state it returns, saved the way the full editor saves it (its own
//     builders + voucher:save's saveVoucher), equals what simple:post saves for the same answers —
//     for every intent kind;
//   - rows the rehearsal created (the walk-in customer) are never referenced, they are named;
//   - simple:handoffTarget: a voucher's kind while in the books, a note's original bill (by the
//     return link, else its reference), a ledger's party-ness.
// The round trip of every simple:post kind through its editor is WP 9.1's (simplePost.dbtest.ts,
// simpleStock.dbtest.ts) and is not repeated here.
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { seededDb, TEST_INFO } from '../db/testdb'
import { readCompanyInfo, writeCompanyInfo } from '../db/seed'
import type { DB } from '../db/connection'
import type { CompanyInfo, Group, VoucherKind } from '@shared/domain'
import { gstRegistrationOf } from '@shared/gst/registration'
import { stockItemInputSchema } from '@shared/schemas'
import {
  buildAccountingPayload, buildInvoicePayload, buildPhysicalPayload, derivePartyId, taxLedgerIdsFrom, taxSideOf,
  type AccountingFormState, type InvoiceFormState
} from '@shared/voucherEdit'
import type { HandoffCreate, HandoffEntry } from '@shared/simple/handoff'
import { createLedger, createStockItem, listGroups, listLedgers, listStockItems } from './masters'
import { getVoucher, nextVoucherNumber, saveVoucher } from './vouchers'
import { intentForm, postIntent } from './simplePost'
import { handoffFacts } from './simpleHandoff'
import { setBom } from './bom'
import { ensureWalkIn } from './counter'
import { rehearse } from '../ai/drafting/rehearse'

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
process.env.TOTAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'total-simple-handoff-'))
process.env.TOTAL_SUPPRESS_SYNC_WARNING = '1'

const INFO: CompanyInfo = { ...TEST_INFO, name: 'Hand-off Co', gstin: '27AAPFU0939F1ZV', stateCode: '27', gstRegistrationType: 'regular' }
const TODAY = '2025-08-14'

let db: DB
let seq = 0
const groupId = (d: DB, name: string): number => (d.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
const L = (name: string): number => (db.prepare('SELECT id FROM ledgers WHERE name = ?').get(name) as { id: number }).id
const I = (name: string): number => (db.prepare('SELECT id FROM stock_items WHERE name = ?').get(name) as { id: number }).id
const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n

function ledger(d: DB, name: string, group: string, extra: Record<string, unknown> = {}): number {
  return createLedger(d, {
    name, groupId: groupId(d, group), openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null,
    tdsSectionId: null, pan: null, creditDays: null, exportType: null, ...extra
  }).id
}

function company(): DB {
  const d = seededDb()
  writeCompanyInfo(d, INFO)
  ledger(d, 'Sales', 'Sales Accounts')
  ledger(d, 'Purchases', 'Purchase Accounts')
  ledger(d, 'CGST', 'Duties & Taxes', { taxType: 'cgst' })
  ledger(d, 'SGST', 'Duties & Taxes', { taxType: 'sgst' })
  ledger(d, 'IGST', 'Duties & Taxes', { taxType: 'igst' })
  ledger(d, 'Round Off', 'Indirect Expenses')
  ledger(d, 'HDFC Bank', 'Bank Accounts')
  ledger(d, 'Rent', 'Indirect Expenses', { gstRate: 18 })
  ledger(d, 'Ramesh', 'Sundry Debtors', { stateCode: '27', creditDays: 15 })
  ledger(d, 'Bharat Steel', 'Sundry Creditors', { stateCode: '27', gstin: '27AABCG3456H1ZN' })
  const unit = d.prepare("SELECT id FROM units WHERE symbol = 'Nos'").get() as { id: number }
  createStockItem(d, stockItemInputSchema.parse({ name: 'Widget', unitId: unit.id, gstRate: 18, hsn: '8471', openingQtyMilli: 100_000, openingValue: 1_000_000 }))
  createStockItem(d, stockItemInputSchema.parse({ name: 'Flour', unitId: unit.id, gstRate: 5, hsn: '1101', openingQtyMilli: 100_000, openingValue: 400_000 }))
  createStockItem(d, stockItemInputSchema.parse({ name: 'Bread', unitId: unit.id, gstRate: 5, hsn: '1905' }))
  return d
}

const intent = (i: Record<string, unknown>): Record<string, unknown> => ({ clientId: `handoff-${++seq}-x`, ...i })
const post = (i: Record<string, unknown>) => postIntent(db, INFO, intent(i), TODAY)

function trace(): unknown {
  return {
    vouchers: count('SELECT COUNT(*) AS n FROM vouchers'),
    lines: count('SELECT COUNT(*) AS n FROM voucher_lines'),
    ledgers: count('SELECT COUNT(*) AS n FROM ledgers'),
    posts: count('SELECT COUNT(*) AS n FROM simple_posts'),
    drafts: count('SELECT COUNT(*) AS n FROM ai_drafts'),
    audit: db.prepare('SELECT COUNT(*) AS n, MAX(id) AS last, (SELECT row_hash FROM audit_log ORDER BY id DESC LIMIT 1) AS hash FROM audit_log').get(),
    seq: db.prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name').all(),
    next: nextVoucherNumber(db, (db.prepare("SELECT id FROM voucher_types WHERE kind = 'sales' ORDER BY id").get() as { id: number }).id, TODAY)
  }
}

/** Every stored row of a voucher, ids stripped. */
function rows(id: number): unknown {
  return {
    voucher: db.prepare('SELECT voucher_type_id, date, number, party_ledger_id, narration, reference, instrument_no, instrument_date, pos_override, post_dated, is_optional FROM vouchers WHERE id = ?').get(id),
    lines: db.prepare('SELECT ledger_id, dr_cr, amount, line_order FROM voucher_lines WHERE voucher_id = ? ORDER BY line_order').all(id),
    inventory: db.prepare('SELECT stock_item_id, godown_id, batch_id, qty_milli, rate_paise, discount_paise, amount, direction, moves_stock, line_order FROM inventory_lines WHERE voucher_id = ? ORDER BY line_order').all(id),
    billRefs: db.prepare('SELECT party_ledger_id, kind, name, amount, due_date FROM bill_refs WHERE voucher_id = ? ORDER BY id').all(id),
    links: db.prepare('SELECT from_voucher_id, link_type, qty_milli FROM line_links WHERE to_voucher_id = ? ORDER BY id').all(id)
  }
}

function isPartyOrTds(): (id: number) => boolean {
  const ledgers = listLedgers(db)
  const groups = new Map(listGroups(db).map((g) => [g.id, g]))
  return (id) => {
    const l = ledgers.find((x) => x.id === id)
    if (!l) return false
    for (let g: Group | undefined = groups.get(l.groupId); g; g = g.parentId ? groups.get(g.parentId) : undefined) {
      if (g.name === 'Sundry Debtors' || g.name === 'Sundry Creditors') return true
    }
    return l.tdsSectionId != null
  }
}

/** What the full editor posts for a handed-off entry when the user hits Save without changing
 *  anything: the number its number field gives, the bill name following it when blank. */
function editorSave(e: HandoffEntry): number {
  const number = nextVoucherNumber(db, e.voucherTypeId, e.state.date)
  const kind = e.kind
  if (e.form === 'invoice') {
    const ledgers = listLedgers(db)
    const items = listStockItems(db)
    const ctx = {
      companyStateCode: INFO.stateCode, ...gstRegistrationOf(readCompanyInfo(db)), kind,
      items: new Map(items.map((i) => [i.id, { gstRate: i.gstRate, cessRate: i.cessRate }])),
      ledgers: new Map(ledgers.map((l) => [l.id, { stateCode: l.stateCode, gstRate: l.gstRate, tdsPayableSectionId: l.tdsPayableSectionId }]))
    }
    const state: InvoiceFormState = { ...e.state, number, billName: e.state.billName || number }
    const r = buildInvoicePayload(state, ctx, e.voucherTypeId, taxLedgerIdsFrom(ledgers, taxSideOf(kind as VoucherKind)))
    if (!r.ok) throw new Error(r.error)
    return saveVoucher(db, r.payload).id
  }
  if (e.form === 'accounting') {
    const state: AccountingFormState = { ...e.state, number }
    const r = buildAccountingPayload(state, { kind, voucherTypeId: e.voucherTypeId, derivedPartyId: derivePartyId(state.rows, isPartyOrTds(), null) })
    if (!r.ok) throw new Error(r.error)
    return saveVoucher(db, r.payload).id
  }
  if (e.form === 'physical') {
    const r = buildPhysicalPayload({ ...e.state, number }, { voucherTypeId: e.voucherTypeId, itemName: () => '' })
    if (!r.ok) throw new Error(r.error)
    return saveVoucher(db, r.payload).id
  }
  throw new Error('the manufacture form saves through its screen')
}

/** The entry with its pending accounts filled in as the editor does on save (`ids` by create kind). */
function withPending(e: HandoffEntry, walkIn: number, tax: (c: HandoffCreate) => number = () => { throw new Error('no tax ledger expected') }): HandoffEntry {
  const idOf = (c: HandoffCreate): number => (c.kind === 'walkIn' ? walkIn : tax(c))
  if (e.form === 'invoice' && e.pending?.party) return { ...e, state: { ...e.state, partyId: idOf(e.pending.party.create) } }
  if (e.form === 'accounting' && e.pending?.rows) {
    const p = e.pending.rows
    return { ...e, state: { ...e.state, rows: e.state.rows.map((r, i) => (p[i] ? { ...r, ledgerId: idOf(p[i]!.create) } : r)) } }
  }
  return e
}

/** The hand-off of `i`: no trace; its entries saved like the editor = what simple:post saves. */
function handsOffAsPosted(i: Record<string, unknown>, forms: HandoffEntry['form'][]): void {
  const before = trace()
  const hf = intentForm(db, INFO, intent(i), TODAY)
  expect(trace()).toEqual(before)
  expect(hf.entries.map((e) => e.form)).toEqual(forms)
  expect(hf.missing).toEqual([])
  const viaEditor = rehearse(db, () => hf.entries.map((e) => rows(editorSave(e))))
  const out = post(i)
  expect(out.voucherIds.map((id) => rows(id))).toEqual(viaEditor)
}

beforeEach(() => {
  db = company()
})

describe('simple:intentForm — the editor state of the current answers', () => {
  it('a sale with items, part paid: the bill in the invoice form, the payment named apart', () => {
    handsOffAsPosted({ kind: 'sale', customerId: L('Ramesh'), items: [{ itemId: I('Widget'), qty: '2', rate: '500' }], payment: { how: 'upi', amount: '500' } }, ['invoice', 'accounting'])
    const hf = intentForm(db, INFO, intent({ kind: 'sale', customerId: L('Ramesh'), items: [{ itemId: I('Widget'), qty: '1', rate: '100' }], payment: { how: 'cash' } }), TODAY)
    expect(hf.entries.map((e) => [e.role, e.kind, e.amount])).toEqual([['bill', 'sales', 11_800], ['payment', 'receipt', 11_800]])
    const bill = hf.entries[0]!
    if (bill.form !== 'invoice') throw new Error('invoice form')
    expect(bill.state).toMatchObject({ partyId: L('Ramesh'), number: '', billName: '', rows: [expect.objectContaining({ itemId: I('Widget'), qtyText: '1', rate: 10_000 })] })
  })

  it('a sale of just an amount on credit (the accounting form)', () => {
    handsOffAsPosted({ kind: 'sale', customerId: L('Ramesh'), amount: { amount: '1,000', gstRate: 18 }, payment: { how: 'credit' } }, ['accounting'])
  })

  it('a purchase with the supplier bill number, paid from the bank', () => {
    handsOffAsPosted({ kind: 'purchase', supplierId: L('Bharat Steel'), billNo: 'BS/101', date: '2025-08-10', items: [{ itemId: I('Widget'), qty: '10', rate: '100' }], payment: { how: 'bank' } }, ['invoice', 'accounting'])
  })

  it('an expense bill on credit', () => {
    handsOffAsPosted({ kind: 'purchase', supplierId: L('Bharat Steel'), billNo: 'R-9', amount: { amount: '1000', accountId: L('Rent') } }, ['accounting'])
  })

  it('money in against a bill, money out to an expense, move money', () => {
    post({ kind: 'sale', customerId: L('Ramesh'), date: '2025-06-01', amount: { amount: '300', gstRate: 0 } })
    handsOffAsPosted({ kind: 'money_in', customerId: L('Ramesh'), amount: '200', into: { how: 'cash' } }, ['accounting'])
    handsOffAsPosted({ kind: 'money_out', payeeId: L('Rent'), amount: '1500', from: { how: 'cash' } }, ['accounting'])
    handsOffAsPosted({ kind: 'move_money', amount: '2,000', fromId: L('Cash'), toId: L('HDFC Bank') }, ['accounting'])
  })

  it('a sale return with items (the credit note, linked as a return) and a purchase return refunded', () => {
    const sale = post({ kind: 'sale', customerId: L('Ramesh'), items: [{ itemId: I('Widget'), qty: '4', rate: '500' }] })
    const v = getVoucher(db, sale.voucherIds[0]!)!
    handsOffAsPosted({ kind: 'return_sale', billId: v.id, items: [{ lineUid: v.inventory[0]!.lineUid!, qty: '1' }] }, ['invoice'])
    const bill = post({ kind: 'purchase', supplierId: L('Bharat Steel'), billNo: 'BS/55', amount: { amount: '1000', accountId: L('Purchases') }, payment: { how: 'bank' } })
    handsOffAsPosted({ kind: 'return_purchase', billId: bill.voucherIds[0]!, amount: { amount: '100' }, refund: { how: 'bank' } }, ['accounting', 'accounting'])
  })

  it('a stock count (the physical stock form)', () => {
    handsOffAsPosted({ kind: 'stock_count', date: TODAY, counts: [{ itemId: I('Widget'), qty: '98' }] }, ['physical'])
  })

  it('made goods: the manufacture form with the recipe, quantity and price; nothing written', () => {
    setBom(db, { itemId: I('Bread'), lines: [{ componentId: I('Flour'), qtyMilliPerUnit: 500 }] })
    const before = trace()
    const hf = intentForm(db, INFO, intent({ kind: 'make_goods', date: TODAY, itemId: I('Bread'), qty: '10', price: '50' }), TODAY)
    expect(trace()).toEqual(before)
    const e = hf.entries[0]!
    if (e.form !== 'manufacture') throw new Error('manufacture form')
    expect(e.state).toMatchObject({ finishedItemId: I('Bread'), qtyText: '10', saleRatePaise: 5000, number: '' })
    expect(e.state.rows.filter((r) => r.itemId != null)).toEqual([expect.objectContaining({ itemId: I('Flour'), qtyText: '5' })])
  })

  it('a walk-in sale: the cash customer the save would create is named and created on save, never referenced', () => {
    expect(db.prepare("SELECT 1 FROM ledgers WHERE name = 'Cash sale'").get()).toBeUndefined()
    const i = { kind: 'sale', items: [{ itemId: I('Widget'), qty: '1', rate: '100' }], payment: { how: 'cash' } }
    const before = trace()
    const hf = intentForm(db, INFO, intent(i), TODAY)
    expect(trace()).toEqual(before)
    expect(hf.missing).toEqual([])
    expect(hf.addedOnSave).toEqual(['Cash sale'])
    const bill = hf.entries[0]!
    if (bill.form !== 'invoice') throw new Error('invoice form')
    expect(bill.state.partyId).toBeNull()
    expect(bill.pending).toEqual({ party: { name: 'Cash sale', create: { kind: 'walkIn' } } })
    const payment = hf.entries[1]!
    if (payment.form !== 'accounting') throw new Error('accounting form')
    const at = payment.state.rows.findIndex((r) => r.ledgerId == null)
    expect(at).toBeGreaterThanOrEqual(0)
    expect(payment.pending?.rows?.[at]).toEqual({ name: 'Cash sale', create: { kind: 'walkIn' } })
    // The editor creates it on save (the counter's own rule) — and then saves what simple:post saves.
    const viaEditor = rehearse(db, () => {
      const walkIn = ensureWalkIn(db)
      return hf.entries.map((e) => rows(editorSave(withPending(e, walkIn))))
    })
    const out = post(i)
    expect(out.voucherIds.map((id) => rows(id))).toEqual(viaEditor)
  })

  it('a walk-in sale where the counter\'s "Cash sale" exists: the editor shows it', () => {
    const walkIn = ensureWalkIn(db)
    const hf = intentForm(db, INFO, intent({ kind: 'sale', items: [{ itemId: I('Widget'), qty: '1', rate: '100' }], payment: { how: 'cash' } }), TODAY)
    expect(hf.missing).toEqual([])
    expect(hf.addedOnSave).toEqual([])
    const bill = hf.entries[0]!
    if (bill.form !== 'invoice') throw new Error('invoice form')
    expect(bill.state.partyId).toBe(walkIn)
    expect(bill.pending).toBeUndefined()
  })

  it('review: GST and round-off ledgers the save would create are named in their rows and created on save like the editor does', () => {
    db.prepare("DELETE FROM ledgers WHERE name IN ('CGST', 'SGST', 'Round Off')").run()
    const i = { kind: 'sale', customerId: L('Ramesh'), amount: { amount: '999', gstRate: 18 }, payment: { how: 'credit' } }
    const before = trace()
    const hf = intentForm(db, INFO, intent(i), TODAY)
    expect(trace()).toEqual(before)
    expect(hf.missing).toEqual([])
    expect([...(hf.addedOnSave ?? [])].sort()).toEqual(['CGST', 'Round Off', 'SGST'])
    const bill = hf.entries[0]!
    if (bill.form !== 'accounting') throw new Error('accounting form')
    const pendingRows = bill.state.rows.map((r, at) => [r.ledgerId, bill.pending?.rows?.[at] ?? null] as const).filter(([, p]) => p != null)
    expect(pendingRows.map(([id]) => id)).toEqual([null, null, null])
    expect(pendingRows.map(([, p]) => p!.create).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))).toEqual([
      { kind: 'roundOff' }, { kind: 'tax', taxType: 'cgst', side: 'output' }, { kind: 'tax', taxType: 'sgst', side: 'output' }
    ])
    // Created on save as the editor's useTaxLedgers does (same names / groups), then saved = simple:post.
    const editorCreate = (c: HandoffCreate): number => {
      if (c.kind === 'roundOff') return ledger(db, 'Round Off', 'Indirect Expenses')
      if (c.kind === 'tax') return ledger(db, c.taxType.toUpperCase(), 'Duties & Taxes', { taxType: c.taxType })
      throw new Error('no walk-in expected')
    }
    const viaEditor = rehearse(db, () => {
      const made = new Map<string, number>()
      const once = (c: HandoffCreate): number => {
        const k = JSON.stringify(c)
        if (!made.has(k)) made.set(k, editorCreate(c))
        return made.get(k)!
      }
      return hf.entries.map((e) => rows(editorSave(withPending(e, 0, once))))
    })
    const out = post(i)
    expect(out.voucherIds.map((id) => rows(id))).toEqual(viaEditor)
  })

  it('answers that cannot be used are refused like the preview, writing nothing', () => {
    const before = trace()
    expect(() => intentForm(db, INFO, intent({ kind: 'purchase', supplierId: L('Bharat Steel'), items: [{ itemId: 99_999, qty: '1', rate: '100' }] }), TODAY)).toThrow()
    expect(trace()).toEqual(before)
  })
})

describe('simple:handoffTarget — what "Back to simple" needs', () => {
  it('a voucher in the books with its kind; a note with its original bill; a binned voucher has none', () => {
    const sale = post({ kind: 'sale', customerId: L('Ramesh'), items: [{ itemId: I('Widget'), qty: '4', rate: '500' }] })
    const v = getVoucher(db, sale.voucherIds[0]!)!
    const ret = post({ kind: 'return_sale', billId: v.id, items: [{ lineUid: v.inventory[0]!.lineUid!, qty: '1' }] })
    expect(handoffFacts(db, { voucherId: v.id })).toEqual({ voucher: { id: v.id, kind: 'sales', originalId: null } })
    expect(handoffFacts(db, { voucherId: ret.voucherIds[0]! })).toEqual({ voucher: { id: ret.voucherIds[0]!, kind: 'credit_note', originalId: v.id } })
    // A bill without item lines: the note carries the bill as its reference.
    const bill = post({ kind: 'purchase', supplierId: L('Bharat Steel'), billNo: 'BS/9', amount: { amount: '1000', accountId: L('Purchases') } })
    const dn = post({ kind: 'return_purchase', billId: bill.voucherIds[0]!, amount: { amount: '100' } })
    expect(handoffFacts(db, { voucherId: dn.voucherIds[0]! }).voucher).toEqual({ id: dn.voucherIds[0]!, kind: 'debit_note', originalId: bill.voucherIds[0]! })
    db.prepare("UPDATE vouchers SET deleted_at = '2025-08-14T00:00:00Z' WHERE id = ?").run(v.id)
    expect(handoffFacts(db, { voucherId: v.id })).toEqual({})
  })

  it('a ledger: a customer / supplier or not', () => {
    expect(handoffFacts(db, { ledgerId: L('Ramesh') })).toEqual({ ledger: { id: L('Ramesh'), isParty: true } })
    expect(handoffFacts(db, { ledgerId: L('Rent') })).toEqual({ ledger: { id: L('Rent'), isParty: false } })
    expect(handoffFacts(db, { ledgerId: 99_999 })).toEqual({})
  })

  it('both are viewer reads over IPC; neither writes', async () => {
    const ipc = await import('../ipc')
    ipc.registerIpc()
    const call = async (ch: string, p?: unknown) => handlers.get(ch)!({}, p)
    const ok = async <T,>(ch: string, p?: unknown): Promise<T> => {
      const res = await call(ch, p)
      if (!res.ok) throw new Error(`${ch}: ${res.error}`)
      return res.data as T
    }
    const { slug } = await ok<{ slug: string }>('company:create', { name: 'Viewer Handoff Co', stateCode: '27', gstin: null, gstRegistrationType: 'unregistered', address: '', booksFrom: 2025, email: null, phone: null, pan: null, tan: null })
    await ok('company:open', { slug })
    const cash = (await ok<{ id: number; name: string }[]>('master:ledgers:list')).find((l) => l.name === 'Cash')!
    const unit = (await ok<{ id: number; symbol: string }[]>('master:units:list')).find((u) => u.symbol === 'Nos')!
    const item = await ok<{ id: number }>('master:stockItems:create', { name: 'Soap', unitId: unit.id, openingQtyMilli: 5000, openingValue: 5000 })
    await ok('users:save', { data: { name: 'Olive', role: 'owner', pin: '1111' } })
    const viewer = await ok<{ id: number }>('users:save', { data: { name: 'Vik', role: 'viewer', pin: '2222' } })
    await ok('auth:logout')
    await ok('auth:login', { userId: viewer.id, pin: '2222' })
    const hf = await ok<{ kind: string; entries: unknown[] }>('simple:intentForm', { intent: { clientId: 'viewer-handoff-1', kind: 'stock_count', date: '2025-08-14', counts: [{ itemId: item.id, qty: 1000 }] }, today: '2025-08-14' })
    expect(hf.kind).toBe('stock_count')
    expect(hf.entries).toHaveLength(1)
    expect(await ok('simple:handoffTarget', { ledgerId: cash.id })).toEqual({ ledger: { id: cash.id, isParty: false } })
    expect(await call('simple:handoffTarget', { voucherId: 'x' })).toMatchObject({ ok: false })
    expect((await ok<unknown[]>('report:dayBook', { from: '2025-04-01', to: '2026-03-31' })).length).toBe(0)
  })
})
