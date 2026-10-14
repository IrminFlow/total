// WP 9.6 — the simple Bank screen over the real services: suggestions without a key (the matcher's
// proposal, narration history, a named party), accepted lines saved through the simple:post
// service and reconciled by bankImport.reconcileSavedDraft (match row, voucher in the books, the
// existing BRS shows the line cleared, an import undo keeps the voucher as a confirmed match),
// the one sentence equal to the BRS service's figures, idempotent retries and refusals that leave
// no trace.
import { beforeEach, describe, expect, it } from 'vitest'
import { seededDb, TEST_INFO } from '../db/testdb'
import { writeCompanyInfo } from '../db/seed'
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import { bankSentence, type BankAcceptItem, type BankView } from '@shared/simple/bank'
import { createLedger } from './masters'
import { getVoucher, IN_BOOKS, setLockDate } from './vouchers'
import { partyAllocation } from './analysis'
import { brs } from './banking'
import { commitStatement, statementWorkspace, undoLastImport } from './bankImport'
import { postIntent } from './simplePost'
import { acceptLines, bankSetup, bankView } from './simpleBank'

const INFO: CompanyInfo = { ...TEST_INFO, name: 'Bank Simple Co', gstRegistrationType: 'unregistered' }
const TODAY = '2025-08-20'
const HEADER = 'Date,Narration,Chq/Ref No,Withdrawal,Deposit,Balance'

let db: DB
let seq = 0
let ids: Record<string, number>
const groupId = (name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
const count = (sql: string, ...args: unknown[]): number => (db.prepare(sql).get(...args) as { n: number }).n

function ledger(name: string, group: string, extra: Record<string, unknown> = {}): number {
  return createLedger(db, {
    name, groupId: groupId(group), openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null,
    tdsSectionId: null, pan: null, creditDays: null, exportType: null, ...extra
  }).id
}

const post = (intent: Record<string, unknown>) => postIntent(db, INFO, { clientId: `seed-${++seq}-xxxxxx`, ...intent }, TODAY)
const statement = (rows: string[], fileName = 'hdfc.csv') => commitStatement(db, ids.bank!, { fileName, text: [HEADER, ...rows].join('\n') })
const view = (): Promise<BankView> => bankView(db, ids.bank!, TODAY)
const lineOf = (v: BankView, text: string) => v.lines.find((l) => l.description.includes(text))!
const accept = (items: Omit<BankAcceptItem, 'clientId'>[], clientIds?: string[]) =>
  acceptLines(db, INFO, ids.bank!, items.map((it, i) => ({ ...it, clientId: clientIds?.[i] ?? `bank-${it.lineId}-${++seq}-x` })) as BankAcceptItem[], TODAY)

beforeEach(() => {
  db = seededDb()
  writeCompanyInfo(db, INFO)
  ids = {
    bank: ledger('HDFC Bank', 'Bank Accounts'),
    cash: (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id,
    sales: ledger('Sales', 'Sales Accounts', { simpleCategory: 'sales' }),
    charges: ledger('Bank charges', 'Indirect Expenses', { simpleCategory: 'bank_charges' }),
    office: ledger('Office expenses', 'Indirect Expenses', { simpleCategory: 'office' }),
    owner: ledger("Owner's money", 'Capital Account', { simpleCategory: 'owner_capital' }),
    drawings: ledger("Owner's drawings", 'Capital Account', { simpleCategory: 'owner_drawings' }),
    ramesh: ledger('Ramesh Traders', 'Sundry Debtors'),
    kumar: ledger('Kumar Stores', 'Sundry Debtors'),
    bharat: ledger('Bharat Steel', 'Sundry Creditors')
  }
  // Two credit bills for Ramesh (₹3,000 on 1 Aug, ₹2,000 on 5 Aug).
  post({ kind: 'sale', date: '2025-08-01', customerId: ids.ramesh, amount: { amount: 300_000 }, payment: { how: 'credit' } })
  post({ kind: 'sale', date: '2025-08-05', customerId: ids.ramesh, amount: { amount: 200_000 }, payment: { how: 'credit' } })
  // Entered by hand before the statement came: Kumar paid ₹1,000 into the bank; the July SMS charges.
  post({ kind: 'money_in', date: '2025-08-10', customerId: ids.kumar, amount: 100_000, into: { how: 'bank', accountId: ids.bank } })
  post({ kind: 'money_out', date: '2025-07-05', payeeId: ids.charges, amount: 5_900, from: { how: 'bank', accountId: ids.bank }, narration: 'SMS CHARGES APR-JUN' })
})

const ROWS = [
  '05/07/2025,SMS CHARGES APR-JUN,S1,"59.00",,',
  '10/08/2025,CASH DEP KUMAR,C1,,"1,000.00",',
  '12/08/2025,NEFT-RAMESH TRADERS-UTR998877,N1,,"4,000.00",',
  '14/08/2025,UPI-STATIONERY MART-PAPER,U1,"450.00",,',
  '16/08/2025,SMS CHARGES JUL-SEP,S2,"59.00",,',
  '17/08/2025,CASH DEPOSIT SELF,C2,,"10,000.00",',
  '18/08/2025,ATM WDL MG ROAD,A1,"2,500.00",,'
]

describe('simple Bank (WP 9.6)', () => {
  it('suggests without a key: the entry already in the books, narration history, the customer the bank names', async () => {
    statement(ROWS)
    const v = await view()
    expect(v.lines).toHaveLength(7)
    expect(v.lines.every((l) => l.status === 'open')).toBe(true)
    expect(lineOf(v, 'KUMAR').suggestion).toMatchObject({ choice: { kind: 'existing' }, source: 'match' })
    expect(lineOf(v, 'APR-JUN').suggestion).toMatchObject({ choice: { kind: 'existing' }, source: 'match' })
    expect(lineOf(v, 'RAMESH').suggestion).toMatchObject({ choice: { kind: 'customer', partyId: ids.ramesh }, source: 'party', because: { key: 'simple.bank.because.party', vars: { name: 'Ramesh Traders' } } })
    expect(lineOf(v, 'JUL-SEP').suggestion).toMatchObject({ choice: { kind: 'charges', accountId: ids.charges }, source: 'history', because: { key: 'simple.bank.because.history' } })
    expect(lineOf(v, 'STATIONERY').suggestion).toBeNull()
    // The two hand entries are in the books but not yet tied to the bank (the BRS lists them), and
    // seven lines still need an answer.
    expect(v.sentence).toMatchObject({ asOn: '2025-08-18', open: 7, differ: 2 })
    expect(bankSentence(v.sentence).tone).toBe('differ')
    const setup = bankSetup(db)
    expect(setup.banks.map((b) => b.id)).toEqual([ids.bank])
    expect(setup.ids).toEqual({ bankCharges: ids.charges, interest: null, ownerMoney: ids.owner, drawings: ids.drawings })
  })

  it('a saved suggestion reconciles its statement line; the BRS agrees; an import undo keeps the confirmed match’s voucher', async () => {
    statement(ROWS)
    const v = await view()
    const items: Omit<BankAcceptItem, 'clientId'>[] = [
      ...v.lines.filter((l) => l.suggestion).map((l) => ({ lineId: l.id, choice: l.suggestion!.choice as BankAcceptItem['choice'] })),
      { lineId: lineOf(v, 'STATIONERY').id, choice: { kind: 'expense', accountId: ids.office } },
      { lineId: lineOf(v, 'DEPOSIT SELF').id, choice: { kind: 'owner', accountId: ids.owner } },
      { lineId: lineOf(v, 'ATM').id, choice: { kind: 'transfer', accountId: ids.cash } }
    ]
    const before = count(`SELECT COUNT(*) AS n FROM vouchers v WHERE ${IN_BOOKS}`)
    const r = accept(items)
    expect(r.failed).toEqual([])
    expect(r.done).toHaveLength(7)
    // Five new entries (the two "already recorded" lines save none).
    expect(count(`SELECT COUNT(*) AS n FROM vouchers v WHERE ${IN_BOOKS}`)).toBe(before + 5)

    // Every line has a live match row; every voucher is in the books with the line's date as bank date.
    for (const l of v.lines) {
      const m = db.prepare(`SELECT m.voucher_id AS vid, m.created_voucher AS created FROM bank_statement_matches m JOIN vouchers v ON v.id = m.voucher_id WHERE m.statement_line_id = ? AND ${IN_BOOKS}`).all(l.id) as { vid: number; created: number }[]
      expect(m.length, l.description).toBe(1)
      expect(m[0]!.created, l.description).toBe(0) // confirmed matches, never "created from the statement"
      const bankLine = getVoucher(db, m[0]!.vid)!.lines.find((x) => x.ledgerId === ids.bank)!
      expect(bankLine.bankDate, l.description).toBe(l.date)
      expect(bankLine.drCr).toBe(l.side === 'deposit' ? 'dr' : 'cr')
      expect(bankLine.amount).toBe(l.amount)
    }
    // Ramesh's ₹4,000 settled his bills oldest first: ₹1,000 still due on the 5 Aug bill.
    const alloc = partyAllocation(db, ids.ramesh, TODAY)
    expect(alloc.bills.filter((b) => b.pending > 0).map((b) => b.pending)).toEqual([100_000])
    // The existing BRS shows nothing outstanding; the workspace shows every line matched.
    const report = brs(db, ids.bank, '2025-08-18')
    expect(report.uncredited).toEqual([])
    expect(report.unpresented).toEqual([])
    expect(statementWorkspace(db, ids.bank, { includeDone: true }).lines.every((l) => l.status === 'matched')).toBe(true)
    const after = await view()
    expect(after.lines.every((l) => l.status === 'done')).toBe(true)
    expect(lineOf(after, 'RAMESH').done[0]!.name).toBe('Ramesh Traders')
    expect(after.sentence).toEqual({ asOn: '2025-08-18', differ: 0, difference: 0, open: 0 })
    expect(bankSentence(after.sentence)).toMatchObject({ key: 'simple.bank.sentence.agree', tone: 'agree' })

    // Undo the import: the statement lines go, the vouchers the user saved stay (bank date reset).
    const rameshVoucher = r.done.find((d) => d.lineId === lineOf(v, 'RAMESH').id)!.voucherIds[0]!
    const imp = statementWorkspace(db, ids.bank, { includeDone: true }).imports[0]!
    const undo = undoLastImport(db, ids.bank, imp.id)
    expect(undo.binned).toBe(0)
    const kept = getVoucher(db, rameshVoucher)!
    expect(kept.deletedAt).toBeNull()
    expect(kept.lines.find((x) => x.ledgerId === ids.bank)!.bankDate).toBeNull()
  })

  it('the sentence equals the BRS service: entries in the books the bank has not shown', async () => {
    statement(ROWS)
    const v = await view()
    accept(v.lines.filter((l) => l.suggestion?.choice.kind === 'existing').map((l) => ({ lineId: l.id, choice: { kind: 'existing' as const } })))
    // A cheque to Bharat Steel (₹5,000) and a deposit (₹700) entered in the books, not yet on the statement.
    post({ kind: 'money_out', date: '2025-08-15', supplierId: ids.bharat, amount: 500_000, from: { how: 'bank', accountId: ids.bank } })
    post({ kind: 'money_in', date: '2025-08-16', sourceId: ids.owner, amount: 70_000, into: { how: 'bank', accountId: ids.bank } })
    const s = (await view()).sentence
    const report = brs(db, ids.bank, s.asOn!)
    expect(s.differ).toBe(report.uncredited.length + report.unpresented.length)
    expect(s.differ).toBe(2)
    expect(s.difference).toBe(report.uncreditedTotal - report.unpresentedTotal)
    expect(s.difference).toBe(report.bookBalance - report.bankBalance)
    expect(bankSentence(s)).toMatchObject({ key: 'simple.bank.differ', vars: { count: 2 }, tone: 'differ' })
  })

  it('a retry with the same clientId saves nothing new; a wrong-side answer and a locked date are refused on the line with no trace', async () => {
    statement(ROWS)
    const v = await view()
    const ramesh = lineOf(v, 'RAMESH')
    const item = { lineId: ramesh.id, choice: { kind: 'customer' as const, partyId: ids.ramesh } }
    const first = accept([item], ['bank-retry-12345'])
    const n = count(`SELECT COUNT(*) AS n FROM vouchers v WHERE ${IN_BOOKS}`)
    const again = accept([item], ['bank-retry-12345'])
    expect(again.done).toEqual(first.done)
    expect(count(`SELECT COUNT(*) AS n FROM vouchers v WHERE ${IN_BOOKS}`)).toBe(n)
    // The same line answered again under another id: already done.
    expect(accept([item]).failed[0]!.error).toMatchObject({ code: 'simple_bank_line_done', field: 'line' })

    const audit = count('SELECT COUNT(*) AS n FROM audit_log')
    const wrong = accept([{ lineId: lineOf(v, 'STATIONERY').id, choice: { kind: 'customer', partyId: ids.kumar } }])
    expect(wrong.failed[0]!.error).toMatchObject({ code: 'simple_bank_wrong_choice', field: 'choice' })
    setLockDate(db, '2025-08-15')
    const locked = accept([{ lineId: lineOf(v, 'STATIONERY').id, choice: { kind: 'expense', accountId: ids.office } }])
    expect(locked.failed[0]!.error).toMatchObject({ code: 'books_locked', field: 'date' })
    setLockDate(db, null)
    // Only the lock's own audit rows were written; the line is still open.
    expect(count("SELECT COUNT(*) AS n FROM audit_log WHERE entity NOT IN ('company')")).toBe(audit)
    expect(lineOf(await view(), 'STATIONERY').status).toBe('open')
    expect(count('SELECT COUNT(*) AS n FROM simple_posts')).toBe(5) // the four seed posts + Ramesh's
  })
})
