// WP 9.8 — the simple People screens' service (services/simplePeople.ts). The plan's requirement:
// the list's balances ARE the accountant Outstandings as on today, to the paisa, for debtors and
// creditors — with an advance received / paid, opening bills (WP 8.7) and returns (credit /
// debit notes) in the books — and their sums are Home's "customers owe you" / "you owe
// suppliers" tiles (and their advances). Plus: a person's open bills = the Outstandings rows;
// Bills to pay = every supplier's open bill with the week / month totals; a sent reminder is a
// reminder_log row with its audit row (WhatsApp → 'whatsapp', SMS → 'sms' since PR #148, copied → 'other'; refused when
// nothing is late); phone / WhatsApp / days to pay go through masters.updateLedger (one audited
// `ledger` update; a bad number refused on its field, nothing written); a viewer reads the
// People channels and can't write through them.
import { TRUSTED_EVENT } from '../ipcSender.testutil'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { seededDb, TEST_INFO } from '../db/testdb'
import { writeCompanyInfo } from '../db/seed'
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import { createLedger, getLedger } from './masters'
import { outstandings, outstandingsWithAdvances, partyAllocation } from './analysis'
import { openingBillsByParty, replaceOpeningBills } from './openingBills'
import { postIntent } from './simplePost'
import { simpleHome } from './simpleHome'
import { reminderLog } from './receivables'
import { billsToPay, peopleList, personReminded, personView, updatePerson } from './simplePeople'

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
process.env.TOTAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'total-simple-people-'))
process.env.TOTAL_SUPPRESS_SYNC_WARNING = '1'

const INFO: CompanyInfo = { ...TEST_INFO, name: 'People Co', gstin: null, stateCode: '27', gstRegistrationType: 'unregistered' }
const TODAY = '2025-08-14'

let db: DB
let seq = 0
const groupId = (name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
const L = (name: string): number => (db.prepare('SELECT id FROM ledgers WHERE name = ?').get(name) as { id: number }).id
const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n

function ledger(name: string, group: string, extra: Record<string, unknown> = {}): number {
  return createLedger(db, {
    name, groupId: groupId(group), openingBalance: 0, gstin: null, stateCode: '27', address: null, taxType: null, gstRate: null, hsn: null,
    tdsSectionId: null, pan: null, creditDays: null, exportType: null, ...extra
  }).id
}
const post = (intent: Record<string, unknown>) => postIntent(db, INFO, { clientId: `people-${++seq}-xxxx`, ...intent }, TODAY)

/** A trader with every kind of balance the People list must agree on. */
function books(): void {
  db = seededDb()
  writeCompanyInfo(db, INFO)
  ledger('Sales', 'Sales Accounts', { simpleCategory: 'sales' })
  ledger('Purchases', 'Purchase Accounts', { simpleCategory: 'purchases' })
  ledger('HDFC Bank', 'Bank Accounts')
  // Ramesh: two credit bills (one late), a part payment, a return on the late one.
  ledger('Ramesh', 'Sundry Debtors', { creditDays: 15, phone: '98765 43210' })
  // Sita: paid ₹500 ahead (an advance received).
  ledger('Sita', 'Sundry Debtors')
  // Gopal: an opening ₹3,000 in two opening bills, one of them late.
  ledger('Gopal', 'Sundry Debtors', { openingBalance: 300_000, creditDays: 30 })
  replaceOpeningBills(db, L('Gopal'), [
    { name: 'OB-1', date: '2025-04-01', dueDate: '2025-05-01', amount: 200_000 },
    { name: 'OB-2', date: '2025-04-01', dueDate: '2025-12-31', amount: 100_000 }
  ])
  // Nobody: no entries at all.
  ledger('Nobody', 'Sundry Debtors')
  // Bharat Steel: two bills (one late), a debit note on one.
  ledger('Bharat Steel', 'Sundry Creditors', { creditDays: 30 })
  // Lakshmi: an opening you owe ₹1,200 (a credit opening) and an advance paid that exceeds nothing.
  ledger('Lakshmi', 'Sundry Creditors', { openingBalance: -120_000 })
  // Kiran: you paid ₹700 ahead.
  ledger('Kiran', 'Sundry Creditors')

  const r1 = post({ kind: 'sale', date: '2025-06-01', customerId: L('Ramesh'), amount: { amount: '2000' }, payment: { how: 'credit' } })
  post({ kind: 'sale', date: '2025-08-10', customerId: L('Ramesh'), amount: { amount: '600' }, payment: { how: 'credit' } })
  post({ kind: 'money_in', date: '2025-08-12', customerId: L('Ramesh'), amount: '500', into: { how: 'cash' } })
  post({ kind: 'return_sale', date: '2025-08-13', billId: r1.voucherIds[0]!, amount: { amount: '250' } })
  post({ kind: 'money_in', date: '2025-08-01', customerId: L('Sita'), amount: '500', into: { how: 'cash' }, advance: true })
  const b1 = post({ kind: 'purchase', date: '2025-05-20', supplierId: L('Bharat Steel'), billNo: 'BS-1', amount: { amount: '4000', accountId: L('Purchases') }, payment: { how: 'credit' } })
  post({ kind: 'purchase', date: '2025-08-05', supplierId: L('Bharat Steel'), billNo: 'BS-2', amount: { amount: '1500', accountId: L('Purchases') }, payment: { how: 'credit' } })
  post({ kind: 'return_purchase', date: '2025-08-06', billId: b1.voucherIds[0]!, amount: { amount: '400' } })
  post({ kind: 'money_out', date: '2025-08-02', supplierId: L('Kiran'), amount: '700', from: { how: 'cash' }, advance: true })
}

beforeEach(() => {
  seq = 0
  books()
})

describe('the People list = the Outstandings allocation as on today', () => {
  it('each person’s open / late / paid-ahead equal Outstandings (debtors and creditors) to the paisa', () => {
    const list = peopleList(db, TODAY)
    for (const side of ['receivable', 'payable'] as const) {
      const o = outstandingsWithAdvances(db, side, TODAY)
      const wantSide = side === 'receivable' ? 'customer' : 'supplier'
      for (const p of list.people.filter((x) => x.side === wantSide)) {
        const row = o.parties.find((r) => r.ledgerId === p.ledgerId)
        expect(p.open, p.name).toBe(row?.pending ?? 0)
        expect(p.late, p.name).toBe((row?.bills ?? []).filter((b) => b.overdueDays > 0).reduce((s, b) => s + b.pending, 0))
        expect(p.ahead, p.name).toBe(partyAllocation(db, p.ledgerId, TODAY).unappliedCredit)
      }
      // Every Outstandings row is in the list.
      for (const r of outstandings(db, side, TODAY)) expect(list.people.some((p) => p.ledgerId === r.ledgerId)).toBe(true)
    }
  })

  it('hand-worked figures: returns, an advance, opening bills, a credit opening', () => {
    const by = new Map(peopleList(db, TODAY).people.map((p) => [p.name, p]))
    // Ramesh: ₹2,000 + ₹600 − ₹500 received (oldest first → bill 1 ₹1,500) − ₹250 returned on bill 1 = ₹1,850,
    // of which bill 1's ₹1,250 is late (due 16 Jun).
    expect(by.get('Ramesh')).toMatchObject({ side: 'customer', open: 185_000, late: 125_000, lateBills: 1, ahead: 0, creditDays: 15, phone: '98765 43210' })
    expect(by.get('Sita')).toMatchObject({ open: 0, ahead: 50_000 })
    expect(by.get('Gopal')).toMatchObject({ open: 300_000, late: 200_000, lateBills: 1 })
    expect(by.get('Nobody')).toMatchObject({ open: 0, ahead: 0, late: 0 })
    // Bharat Steel: ₹4,000 + ₹1,500 − ₹400 returned on BS-1 = ₹5,100; BS-1's ₹3,600 is late (due 19 Jun).
    expect(by.get('Bharat Steel')).toMatchObject({ side: 'supplier', open: 510_000, late: 360_000 })
    expect(by.get('Lakshmi')).toMatchObject({ side: 'supplier', open: 120_000 })
    expect(by.get('Kiran')).toMatchObject({ side: 'supplier', open: 0, ahead: 70_000 })
    // The walk-in customer is left out (no balance).
    expect([...by.values()].some((p) => p.walkIn)).toBe(false)
  })

  it('the totals are Home’s tiles: customers owe you / you owe suppliers, and the advances', () => {
    const list = peopleList(db, TODAY)
    const home = simpleHome(db, INFO, { today: TODAY, backups: [] })
    expect(list.totals.owesYou).toBe(home.receivables.total)
    expect(list.totals.youOwe).toBe(home.payables.total)
    expect(list.totals.customersAhead).toBe(home.receivables.advances)
    expect(list.totals.suppliersAhead).toBe(home.payables.advances)
    expect(list.totals).toEqual({ owesYou: 185_000 + 300_000, youOwe: 510_000 + 120_000, customersAhead: 50_000, suppliersAhead: 70_000 })
  })

  it('a person’s open bills are their Outstandings rows, oldest first; a supplier has no reminder', () => {
    const ramesh = personView(db, INFO, L('Ramesh'), TODAY)!
    const rows = outstandings(db, 'receivable', TODAY).find((r) => r.ledgerId === L('Ramesh'))!.bills.filter((b) => b.pending > 0)
    expect(ramesh.bills.map((b) => [b.name, b.pending, b.overdueDays])).toEqual(rows.map((b) => [b.number, b.pending, b.overdueDays]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
    expect(ramesh.bills.map((b) => b.date)).toEqual([...ramesh.bills.map((b) => b.date)].sort())
    expect(ramesh.reminder).toMatchObject({ bucket: 'firm', amount: 125_000, lastSent: null, allowed: true })
    expect(ramesh.company).toBe('People Co')
    expect(personView(db, INFO, L('Bharat Steel'), TODAY)!.reminder).toBeNull()
    expect(personView(db, INFO, L('Sales'), TODAY)).toBeNull()
  })

  it('Bills to pay: every supplier’s open bill, most late first, with this week / month', () => {
    const b = billsToPay(db, TODAY)
    const want = outstandings(db, 'payable', TODAY).flatMap((p) => p.bills.filter((x) => x.pending > 0).map((x) => x.pending)).reduce((s, x) => s + x, 0)
    expect(b.bills.reduce((s, x) => s + x.pending, 0)).toBe(want)
    expect(b.bills.slice(0, 2).map((x) => [x.party, x.name, x.pending])).toEqual([['Lakshmi', 'Opening', 120_000], ['Bharat Steel', 'BS-1', 360_000]])
    expect(b.bills.map((x) => x.overdueDays)).toEqual([...b.bills.map((x) => x.overdueDays)].sort((x, y) => y - x))
    // 14 Aug 2025 is a Thursday: the week ends Sunday 17 Aug. Late: BS-1 ₹3,600 and Lakshmi's
    // opening (books-begin 1 Apr, no credit days) ₹1,200; BS-2 (5 Aug + 30 days) is due 4 Sep.
    expect(b).toMatchObject({ weekEnd: '2025-08-17', monthEnd: '2025-08-31', late: 480_000, dueThisWeek: 480_000, dueThisMonth: 480_000 })
  })
})

describe('writes', () => {
  it('a sent reminder is a reminder_log row + its audit row; nothing late = refused', () => {
    const before = count("SELECT COUNT(*) n FROM audit_log WHERE entity = 'reminder'")
    const { logId } = personReminded(db, L('Ramesh'), 'whatsapp', TODAY)
    const [row] = reminderLog(db, TODAY, TODAY, L('Ramesh'))
    expect(row).toMatchObject({ id: logId, bucket: 'firm', date: TODAY, amount: 125_000, channel: 'whatsapp', documentPath: null, days: 59 })
    const audit = db.prepare("SELECT after_json AS a FROM audit_log WHERE entity = 'reminder' ORDER BY id DESC LIMIT 1").get() as { a: string }
    expect(JSON.parse(audit.a)).toMatchObject({ via: 'whatsapp', channel: 'whatsapp', forced: false })
    expect(count("SELECT COUNT(*) n FROM audit_log WHERE entity = 'reminder'")).toBe(before + 1)
    personReminded(db, L('Ramesh'), 'copied', TODAY)
    expect(reminderLog(db, TODAY, TODAY, L('Ramesh')).map((r) => r.channel)).toEqual(['other', 'whatsapp'])
    // The second one sits inside the "don't remind within N days" window — logged, flagged.
    expect(JSON.parse((db.prepare("SELECT after_json AS a FROM audit_log WHERE entity = 'reminder' ORDER BY id DESC LIMIT 1").get() as { a: string }).a)).toMatchObject({ via: 'copied', forced: true })
    expect(personView(db, INFO, L('Ramesh'), TODAY)!.reminder).toMatchObject({ lastSent: TODAY, allowed: false })
    personReminded(db, L('Ramesh'), 'sms', TODAY)
    expect(reminderLog(db, TODAY, TODAY, L('Ramesh')).map((r) => r.channel)).toEqual(['sms', 'other', 'whatsapp'])
    expect(JSON.parse((db.prepare("SELECT after_json AS a FROM audit_log WHERE entity = 'reminder' ORDER BY id DESC LIMIT 1").get() as { a: string }).a)).toMatchObject({ via: 'sms', channel: 'sms', forced: true })
    expect(() => personReminded(db, L('Sita'), 'sms', TODAY)).toThrow(expect.objectContaining({ code: 'simple_people_nothing_late' }))
    expect(() => personReminded(db, L('Bharat Steel'), 'sms', TODAY)).toThrow(expect.objectContaining({ code: 'simple_people_nothing_late' }))
    expect(() => personReminded(db, L('Sales'), 'sms', TODAY)).toThrow(expect.objectContaining({ code: 'simple_people_not_party' }))
  })

  it('phone / WhatsApp / days to pay: one audited ledger update, the rest of the account unchanged', () => {
    const id = L('Ramesh')
    const before = getLedger(db, id)!
    const audits = count("SELECT COUNT(*) n FROM audit_log WHERE entity = 'ledger'")
    expect(updatePerson(db, { id, whatsapp: '+91 99999 11111', creditDays: 20 })).toEqual({ ledgerId: id, phone: '98765 43210', whatsapp: '+91 99999 11111', creditDays: 20 })
    expect(count("SELECT COUNT(*) n FROM audit_log WHERE entity = 'ledger'")).toBe(audits + 1)
    const after = getLedger(db, id)!
    expect({ ...after, whatsapp: undefined, creditDays: before.creditDays }).toEqual({ ...before, whatsapp: undefined })
    const a = db.prepare("SELECT before_json AS b, after_json AS a FROM audit_log WHERE entity = 'ledger' ORDER BY id DESC LIMIT 1").get() as { b: string; a: string }
    expect(JSON.parse(a.b)).toMatchObject({ creditDays: 15 })
    expect(JSON.parse(a.a)).toMatchObject({ creditDays: 20, whatsapp: '+91 99999 11111' })
    // '' clears; null = no days to pay.
    expect(updatePerson(db, { id, phone: '', creditDays: null })).toMatchObject({ phone: null, creditDays: null })
    // A bad number is refused on its field; nothing is written.
    const n = count("SELECT COUNT(*) n FROM audit_log WHERE entity = 'ledger'")
    expect(() => updatePerson(db, { id, whatsapp: 'call me' })).toThrow(expect.objectContaining({ code: 'simple_people_bad_phone', field: 'whatsapp' }))
    expect(count("SELECT COUNT(*) n FROM audit_log WHERE entity = 'ledger'")).toBe(n)
    expect(() => updatePerson(db, { id: L('Sales'), phone: '9876543210' })).toThrow(expect.objectContaining({ code: 'simple_people_not_party' }))
  })

  it('editing a person with opening bills keeps every bill (guardOpeningChange is not touched)', () => {
    const id = L('Gopal')
    const bills = openingBillsByParty(db, [id]).get(id)
    const view = personView(db, INFO, id, TODAY)!
    expect(bills?.map((b) => b.name)).toEqual(['OB-1', 'OB-2'])
    const billAudits = count("SELECT COUNT(*) n FROM audit_log WHERE entity = 'opening_bills'")
    updatePerson(db, { id, phone: '98765 00000', whatsapp: '98765 00000', creditDays: 45 })
    expect(openingBillsByParty(db, [id]).get(id)).toEqual(bills)
    expect(count("SELECT COUNT(*) n FROM audit_log WHERE entity = 'opening_bills'")).toBe(billAudits)
    // The bills keep their own due dates; the figures don't move.
    const after = personView(db, INFO, id, TODAY)!
    expect(after.bills).toEqual(view.bills)
    expect(after.open).toBe(view.open)
  })
})

describe('roles', () => {
  it('a viewer reads People but can’t change a phone or log a reminder', async () => {
    const ipc = await import('../ipc')
    ipc.registerIpc()
    const call = async (ch: string, p?: unknown) => handlers.get(ch)!(TRUSTED_EVENT, p)
    const ok = async <T,>(ch: string, p?: unknown): Promise<T> => {
      const res = await call(ch, p)
      if (!res.ok) throw new Error(`${ch}: ${res.error}`)
      return res.data as T
    }
    const { slug } = await ok<{ slug: string }>('company:create', { name: 'Viewer People Co', stateCode: '27', gstin: null, gstRegistrationType: 'unregistered', address: '', booksFrom: 2025, email: null, phone: null, pan: null, tan: null })
    await ok('company:open', { slug })
    const groups = await ok<{ id: number; name: string }[]>('master:groups:list')
    const debtors = groups.find((g) => g.name === 'Sundry Debtors')!.id
    const ramesh = await ok<{ id: number }>('master:ledgers:create', { name: 'Ramesh', groupId: debtors, openingBalance: 50_000, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null })
    await ok('users:save', { data: { name: 'Olive', role: 'owner', pin: '1111' } })
    const viewer = await ok<{ id: number }>('users:save', { data: { name: 'Vik', role: 'viewer', pin: '2222' } })
    await ok('auth:logout')
    await ok('auth:login', { userId: viewer.id, pin: '2222' })
    const list = await ok<{ people: { ledgerId: number; open: number }[] }>('simple:people:list', { today: TODAY })
    expect(list.people.find((p) => p.ledgerId === ramesh.id)?.open).toBe(50_000)
    expect(await ok<{ ledgerId: number } | null>('simple:people:person', { id: ramesh.id, today: TODAY })).toMatchObject({ ledgerId: ramesh.id })
    expect(await ok<{ bills: unknown[] }>('simple:people:billsToPay', { today: TODAY })).toMatchObject({ bills: [] })
    expect(await call('simple:people:update', { id: ramesh.id, phone: '9876543210' })).toMatchObject({ ok: false, code: 'not_permitted' })
    expect(await call('simple:people:reminded', { id: ramesh.id, via: 'copied', today: TODAY })).toMatchObject({ ok: false, code: 'not_permitted' })
    // Strict payloads.
    expect(await call('simple:people:person', { id: ramesh.id, extra: 1 })).toMatchObject({ ok: false, code: 'invalid_input' })
  })
})
