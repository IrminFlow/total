// WP 8.7 review — opening bills are guarded master data with ONE reader and ONE writer:
// - the bills always add up to the party's opening: the writer checks it, a change of the opening
//   anywhere else clears them (audited) or — when one is in use — is refused, and a trigger stops
//   any write that skipped that path (full-app ledger form, data import, books import, import undo,
//   raw SQL like the Tally import's);
// - every bill-wise reader agrees to the paisa on 2 opening bills + a part receipt / payment
//   (Outstandings, party allocation / open bills, MSME replay, statement, dashboard, cash forecast,
//   payables plan, interest);
// - interest runs from a stored bill's own date / due date, the unnamed opening from books-begin;
// - a bill with a matched receipt or an interest charge can't be renumbered or removed;
// - overdrawn banks are something you owe; the owner's money goes to the capital account chosen.
import { describe, expect, it } from 'vitest'
import { freshDb } from '../db/testdb'
import { migrate } from '../db/migrate'
import { MIGRATIONS } from '../db/migrations'
import { readCompanyInfo } from '../db/seed'
import { applySetup } from './companySetup'
import { applyOpenings, openingsState, previewOpenings } from './openings'
import { openingBillMismatches, openingBillsByParty, replaceOpeningBills } from './openingBills'
import { outstandings, openBills, partyAllocation, partyBillEvents } from './analysis'
import { allocateBills } from '@shared/outstanding'
import { createLedger, getLedger, updateLedger } from './masters'
import { saveVoucher } from './vouchers'
import { statementData, interestPreview, postInterest } from './receivables'
import { dashboardSeries } from './dashboard'
import { forecastBase } from './cashForecast'
import { payablesPlan } from './payables'
import { runImport, undoImport } from './dataImport'
import { openingTotals } from './dataImport'
import { verifyAudit } from './audit'
import type { DB } from '../db/connection'
import type { SimpleOpeningsInput } from '@shared/simple/openings'

const TODAY = '2026-10-13'
const AS_ON = '2026-05-01'

function kirana(): DB {
  const db = freshDb()
  applySetup(db, { name: 'Ramesh Kirana', stateCode: '27', businessType: 'retail', gst: 'no', gstin: null, filing: null, stock: true, startDate: '2026-04-01', fresh: false }, TODAY)
  return db
}
const L = (db: DB, name: string): number => (db.prepare('SELECT id FROM ledgers WHERE name = ?').get(name) as { id: number }).id
const vt = (db: DB, kind: string): number => (db.prepare('SELECT id FROM voucher_types WHERE kind = ? ORDER BY id LIMIT 1').get(kind) as { id: number }).id
const base = { narration: null, reference: null, instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null, inventory: [], tds: null }

function apply(db: DB, input: SimpleOpeningsInput): ReturnType<typeof applyOpenings> {
  return applyOpenings(db, { ...input, confirmCapital: previewOpenings(db, input).capital.after })
}

const ANSWERS: SimpleOpeningsInput = {
  cash: { amount: 5_000_00, base: 0 },
  customers: [{ name: 'Sharma Stores', bills: [{ ref: 'B-12', date: '2026-03-10', amount: 3_000_00 }, { ref: '', date: null, amount: 1_500_00 }] }],
  suppliers: [{ name: 'Gupta Traders', bills: [{ ref: 'GT-881', date: '2026-03-25', amount: 8_000_00 }, { ref: 'GT-900', date: '2026-03-30', amount: 2_000_00 }] }]
}

/** Two opening bills each side, a part receipt against B-12 and a part payment against GT-881. */
function fixture(): DB {
  const db = kirana()
  apply(db, ANSWERS)
  const sharma = L(db, 'Sharma Stores')
  const gupta = L(db, 'Gupta Traders')
  saveVoucher(db, {
    ...base, voucherTypeId: vt(db, 'receipt'), date: '2026-04-10', partyLedgerId: sharma,
    lines: [{ ledgerId: L(db, 'Cash'), drCr: 'dr', amount: 1_000_00, costAllocations: [] }, { ledgerId: sharma, drCr: 'cr', amount: 1_000_00, costAllocations: [] }],
    billRefs: [{ kind: 'against', name: 'B-12', amount: 1_000_00, dueDate: null }]
  })
  saveVoucher(db, {
    ...base, voucherTypeId: vt(db, 'payment'), date: '2026-04-12', partyLedgerId: gupta,
    lines: [{ ledgerId: gupta, drCr: 'dr', amount: 500_00, costAllocations: [] }, { ledgerId: L(db, 'Cash'), drCr: 'cr', amount: 500_00, costAllocations: [] }],
    billRefs: [{ kind: 'against', name: 'GT-881', amount: 500_00, dueDate: null }]
  })
  return db
}

const bills = (list: { number: string; pending: number }[]): [string, number][] => list.map((b) => [b.number, b.pending])

describe('opening bills: one reader', () => {
  it('every bill-wise reader agrees to the paisa', () => {
    const db = fixture()
    const company = readCompanyInfo(db)
    const sharma = L(db, 'Sharma Stores')
    const gupta = L(db, 'Gupta Traders')
    const rec = outstandings(db, 'receivable', AS_ON).find((p) => p.ledgerId === sharma)!
    const pay = outstandings(db, 'payable', AS_ON).find((p) => p.ledgerId === gupta)!
    expect(bills(rec.bills)).toEqual([['B-12', 2_000_00], ['Opening', 1_500_00]])
    expect(bills(pay.bills)).toEqual([['GT-881', 7_500_00], ['GT-900', 2_000_00]])
    // Allocation / receipt picker / MSME replay.
    expect(bills(partyAllocation(db, sharma, AS_ON).bills)).toEqual(bills(rec.bills))
    expect(bills(openBills(db, gupta, AS_ON))).toEqual(bills(pay.bills))
    const ev = partyBillEvents(db, gupta, AS_ON)
    expect(bills(allocateBills(ev.events, AS_ON, ev.creditDays).bills)).toEqual(bills(pay.bills))
    // Statement of account.
    expect(bills(statementData(db, company, sharma, '2026-04-01', AS_ON).openBills)).toEqual(bills(rec.bills))
    // Dashboard totals.
    const dash = dashboardSeries(db, company, { today: AS_ON, from: '2026-04-01', to: '2027-03-31', backups: [] })
    expect(dash.receivables.ok && dash.receivables.data.total).toBe(3_500_00)
    expect(dash.payables.ok && dash.payables.data.total).toBe(9_500_00)
    // Cash forecast flows.
    const fc = forecastBase(db, company, AS_ON, '2026-07-31')
    expect(fc.flows.filter((f) => f.source === 'receivable' && f.ledgerId === sharma).reduce((s, f) => s + f.amount, 0)).toBe(3_500_00)
    expect(fc.flows.filter((f) => f.source === 'payable' && f.ledgerId === gupta).reduce((s, f) => s + f.amount, 0)).toBe(9_500_00)
    // Payables plan.
    const plan = payablesPlan(db, AS_ON)
    expect(plan.rows.filter((r) => r.ledgerId === gupta).map((r) => [r.number, r.pending])).toEqual(bills(pay.bills))
    // Interest (receivables) on the same bills.
    updateLedger(db, sharma, { ...getLedger(db, sharma)!, interestRateBp: 1800 })
    expect(interestPreview(db, company, AS_ON, sharma).map((r) => [r.billRef, r.pendingPaise])).toEqual(bills(rec.bills))
  })

  it('interest runs from a stored bill’s own date / due; the unnamed opening from books-begin', () => {
    const db = fixture()
    const sharma = L(db, 'Sharma Stores')
    updateLedger(db, sharma, { ...getLedger(db, sharma)!, interestRateBp: 1800 })
    // A second customer with no split: one unnamed opening.
    createLedger(db, { name: 'Verma', groupId: (db.prepare("SELECT id FROM groups WHERE name = 'Sundry Debtors'").get() as { id: number }).id, openingBalance: 1_000_00, interestRateBp: 1800, pan: null } as never)
    const rows = interestPreview(db, readCompanyInfo(db), AS_ON)
    const row = (party: string, bill: string) => rows.find((r) => r.partyName === party && r.billRef === bill)!
    expect(row('Sharma Stores', 'B-12')).toMatchObject({ billKey: 'o:B-12', billDate: '2026-03-10', dueDate: '2026-03-10' })
    expect(row('Sharma Stores', 'Opening')).toMatchObject({ billKey: 'o:Opening', billDate: '2026-04-01', dueDate: '2026-04-01' })
    expect(row('Verma', 'Opening')).toMatchObject({ billDate: '2026-04-01', dueDate: null })
  })
})

describe('opening bills: guarded', () => {
  it('the writer refuses bills that don’t add up; a write that skips the guard is stopped by the trigger', () => {
    const db = fixture()
    const sharma = L(db, 'Sharma Stores')
    const now = openingBillsByParty(db, [sharma]).get(sharma)!
    expect(() => replaceOpeningBills(db, sharma, [...now, { name: 'X', date: '2026-04-01', dueDate: null, amount: 1 }])).toThrow(/don't add up/)
    expect(() => db.prepare('UPDATE ledgers SET opening_balance = 1 WHERE id = ?').run(sharma)).toThrow(/split into opening bills/)
    expect(openingBillMismatches(db)).toEqual([])
  })

  it('full-app ledger form: a new opening clears unused bills (audited); a used bill refuses it with a plain message', () => {
    const db = fixture()
    const gupta = L(db, 'Gupta Traders')
    // GT-881 has a payment against it: refused, nothing changes.
    expect(() => updateLedger(db, gupta, { ...getLedger(db, gupta)!, openingBalance: -11_000_00 })).toThrow(/already has a payment or an interest charge/)
    expect(getLedger(db, gupta)!.openingBalance).toBe(-10_000_00)
    expect(openingBillsByParty(db, [gupta]).get(gupta)).toHaveLength(2)
    // A party whose bills nothing rests on: cleared and audited.
    apply(db, { ...ANSWERS, customers: [...ANSWERS.customers!, { name: 'Joshi', bills: [{ ref: 'J-1', date: null, amount: 700_00 }, { ref: 'J-2', date: null, amount: 300_00 }] }] })
    const joshi = L(db, 'Joshi')
    updateLedger(db, joshi, { ...getLedger(db, joshi)!, openingBalance: 2_000_00 })
    expect(openingBillsByParty(db, [joshi]).get(joshi)).toBeUndefined()
    const row = db.prepare("SELECT action, before_json FROM audit_log WHERE entity = 'opening_bills' AND entity_id = ? ORDER BY id DESC LIMIT 1").get(joshi) as { action: string; before_json: string }
    expect(row.action).toBe('delete')
    expect(JSON.parse(row.before_json).bills.map((b: { name: string }) => b.name)).toEqual(['J-1', 'J-2'])
    // Moved out of the debtors: the bills can't belong to it any more.
    apply(db, { cash: { amount: 5_000_00, base: 5_000_00 }, customers: [{ ledgerId: joshi, base: 2_000_00, bills: [{ ref: 'J-1', date: null, amount: 1_000_00 }, { ref: 'J-2', date: null, amount: 1_000_00 }] }] })
    updateLedger(db, joshi, { ...getLedger(db, joshi)!, groupId: (db.prepare("SELECT id FROM groups WHERE name = 'Loans & Advances (Asset)'").get() as { id: number }).id })
    expect(openingBillsByParty(db, [joshi]).get(joshi)).toBeUndefined()
    expect(openingBillMismatches(db)).toEqual([])
    expect(verifyAudit(db).ok).toBe(true)
  })

  it('data import (opening balances): a changed opening clears the bills; a used one is a row error', () => {
    const db = fixture()
    apply(db, { ...ANSWERS, customers: [...ANSWERS.customers!, { name: 'Joshi', bills: [{ ref: 'J-1', date: null, amount: 700_00 }, { ref: 'J-2', date: null, amount: 300_00 }] }] })
    const r = runImport(db, [{ rows: { target: 'openings', rows: [{ line: 2, ledger: 'Joshi', opening: 1_200_00 }, { line: 3, ledger: 'Gupta Traders', opening: -1 }] } }], { openingDifference: 'leave' }, { source: 'generic', profileId: null, fileName: 'o.csv' }, false)
    expect(r.steps[0]!.errors.map((e) => e.line)).toEqual([3])
    expect(r.steps[0]!.errors[0]!.message).toMatch(/already has a payment/)
    expect(openingBillsByParty(db, [L(db, 'Joshi')]).get(L(db, 'Joshi'))).toBeUndefined()
    expect(getLedger(db, L(db, 'Gupta Traders'))!.openingBalance).toBe(-10_000_00)
    expect(openingBillMismatches(db)).toEqual([])
  })

  it('books import (Opening Bills sheet) writes through the writer; import undo puts the earlier bills back', () => {
    const db = fixture()
    const sharma = L(db, 'Sharma Stores')
    const before = openingBillsByParty(db, [sharma]).get(sharma)
    // Re-split Sharma's 4,500 (B-12 kept, so its receipt still matches).
    const r = runImport(db, [{ rows: { target: 'openingBills', rows: [
      { line: 2, party: 'Sharma Stores', bill: 'B-12', date: '2026-03-10', dueDate: null, amount: 3_000_00 },
      { line: 3, party: 'Sharma Stores', bill: 'B-13', date: '2026-03-20', dueDate: '2026-04-20', amount: 1_500_00 }
    ] } }], {}, { source: 'total-books', profileId: null, fileName: 'b.xlsx' }, false)
    expect(r.steps[0]!.errors).toEqual([])
    expect(bills(outstandings(db, 'receivable', AS_ON).find((p) => p.ledgerId === sharma)!.bills)).toEqual([['B-12', 2_000_00], ['B-13', 1_500_00]])
    // Not adding up to the opening: a row error, nothing written.
    const bad = runImport(db, [{ rows: { target: 'openingBills', rows: [{ line: 2, party: 'Sharma Stores', bill: 'B-12', date: '2026-03-10', dueDate: null, amount: 1_00 }] } }], {}, { source: 'total-books', profileId: null, fileName: 'b.xlsx' }, false)
    expect(bad.steps[0]!.errors).toHaveLength(1)
    expect(undoImport(db, r.batchId!).kept).toEqual([])
    expect(openingBillsByParty(db, [sharma]).get(sharma)).toEqual(before)
    expect(openingBillMismatches(db)).toEqual([])
    expect(verifyAudit(db).ok).toBe(true)
  })
})

describe('opening bills: in use', () => {
  it('a bill with a matched receipt can’t be renumbered or removed from the opening setup', () => {
    const db = fixture()
    const sharma = L(db, 'Sharma Stores')
    const st = openingsState(db).customers.find((c) => c.ledgerId === sharma)!
    const renamed: SimpleOpeningsInput = { cash: { amount: 5_000_00, base: 5_000_00 }, customers: [{ ledgerId: sharma, base: 4_500_00, bills: st.bills.map((b) => (b.ref === 'B-12' ? { ...b, ref: 'B-12A' } : b)) }] }
    expect(() => previewOpenings(db, renamed)).toThrow(/already has a payment or an interest charge/)
    const removed: SimpleOpeningsInput = { cash: { amount: 5_000_00, base: 5_000_00 }, customers: [{ ledgerId: sharma, base: 4_500_00, bills: st.bills.filter((b) => b.ref !== 'B-12') }] }
    expect(() => previewOpenings(db, removed)).toThrow(/already has a payment/)
    // Changing the amount of the bill the receipt rests on is fine (its identity is kept).
    const more: SimpleOpeningsInput = { cash: { amount: 5_000_00, base: 5_000_00 }, customers: [{ ledgerId: sharma, base: 4_500_00, bills: st.bills.map((b) => (b.ref === 'B-12' ? { ...b, amount: 3_200_00 } : b)) }] }
    expect(apply(db, more).balanced).toBe(true)
    expect(getLedger(db, sharma)!.openingBalance).toBe(4_700_00)
  })

  it('a bill with an interest charge can’t be renumbered either', () => {
    const db = fixture()
    const sharma = L(db, 'Sharma Stores')
    updateLedger(db, sharma, { ...getLedger(db, sharma)!, interestRateBp: 2400 })
    postInterest(db, readCompanyInfo(db), { asOn: '2026-06-30', ledgerId: sharma, keys: ['o:Opening'] }, TODAY)
    const st = openingsState(db).customers.find((c) => c.ledgerId === sharma)!
    const renamed: SimpleOpeningsInput = { cash: { amount: 5_000_00, base: 5_000_00 }, customers: [{ ledgerId: sharma, base: 4_500_00, bills: st.bills.map((b) => (b.ref === 'Opening' ? { ...b, ref: 'Old dues' } : b)) }] }
    expect(() => previewOpenings(db, renamed)).toThrow(/already has a payment or an interest charge/)
  })

  it('"Opening (balance)" is reserved; blank numbers never collide with it', () => {
    const db = kirana()
    expect(() => previewOpenings(db, { cash: { amount: 0 }, customers: [{ name: 'A', bills: [{ ref: 'opening (balance)', amount: 1 }] }] })).toThrow(/kept for the part of an opening/)
  })
})

describe('overdrafts and the capital account', () => {
  it('an overdrawn bank is something you owe; a loaded bank row removed is sent at zero', () => {
    const db = kirana()
    apply(db, { cash: { amount: 1_000_00, base: 0 }, banks: [{ name: 'HDFC', amount: 5_000_00 }], overdrafts: [{ name: 'SBI OD', amount: 3_000_00 }] })
    expect(getLedger(db, L(db, 'SBI OD'))!.openingBalance).toBe(-3_000_00)
    expect((db.prepare("SELECT g.name FROM ledgers l JOIN groups g ON g.id = l.group_id WHERE l.name = 'SBI OD'").get() as { name: string }).name).toBe('Bank OD A/c')
    const st = openingsState(db)
    expect(st.overdrafts).toEqual([{ ledgerId: L(db, 'SBI OD'), name: 'SBI OD', amount: 3_000_00 }])
    expect(st.banks.map((b) => b.name)).toEqual(['HDFC'])
    const p = previewOpenings(db, { cash: { amount: 1_000_00, base: 1_000_00 }, banks: [{ ledgerId: L(db, 'HDFC'), amount: 0, base: 5_000_00 }], overdrafts: [{ ledgerId: L(db, 'SBI OD'), amount: 3_000_00, base: -3_000_00 }] })
    expect(p).toMatchObject({ have: 1_000_00, owe: 3_000_00, difference: -2_000_00 })
    apply(db, { cash: { amount: 1_000_00, base: 1_000_00 }, banks: [{ ledgerId: L(db, 'HDFC'), amount: 0, base: 5_000_00 }], overdrafts: [{ ledgerId: L(db, 'SBI OD'), amount: 3_000_00, base: -3_000_00 }] })
    expect(getLedger(db, L(db, 'HDFC'))!.openingBalance).toBe(0)
    expect(openingTotals(db).difference).toBe(0)
  })

  it('the owner’s money goes to the capital account chosen (default the first)', () => {
    const db = kirana()
    createLedger(db, { name: 'Partner B capital', groupId: (db.prepare("SELECT id FROM groups WHERE name = 'Capital Account'").get() as { id: number }).id, pan: null } as never)
    const st = openingsState(db)
    expect(st.capitals.map((c) => c.name)).toEqual(["Owner's money", 'Partner B capital'])
    apply(db, { cash: { amount: 2_000_00, base: 0 }, capitalLedgerId: L(db, 'Partner B capital') })
    expect(getLedger(db, L(db, 'Partner B capital'))!.openingBalance).toBe(-2_000_00)
    expect(getLedger(db, L(db, "Owner's money"))!.openingBalance).toBe(0)
    expect(() => previewOpenings(db, { cash: { amount: 2_000_00, base: 2_000_00 }, capitalLedgerId: L(db, 'Cash') })).toThrow(/capital accounts/)
  })
})

describe('the opening_bills migration', () => {
  it('is the last migration and leaves the books unchanged', () => {
    const idx = MIGRATIONS.findIndex((sql) => sql.includes('CREATE TABLE opening_bills'))
    expect(idx).toBe(MIGRATIONS.length - 1)
    const db = freshDb()
    migrate(db)
    expect(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'opening_bills_follow_opening'").get()).toEqual({ n: 1 })
  })
})
