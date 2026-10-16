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
import { commitStatement, statementWorkspace, undoLastImport, unmatchLine } from './bankImport'
import { postIntent } from './simplePost'
import { acceptLines, bankSetup, bankView } from './simpleBank'
import { gstr3b } from './gst'
import { gstRegistrationOf } from '@shared/gst/registration'
import { validateGstin } from '@shared/gst/validate'
import { emptyMoneyOutForm, moneyOutIntentFrom, type MoneyOutForm } from '@shared/simple/money'

const INFO: CompanyInfo = { ...TEST_INFO, name: 'Bank Simple Co', gstRegistrationType: 'unregistered' }
const TODAY = '2025-08-20'
const HEADER = 'Date,Narration,Chq/Ref No,Withdrawal,Deposit,Balance'

let db: DB
let seq = 0
type Ids = Record<'bank' | 'cash' | 'sales' | 'charges' | 'office' | 'owner' | 'drawings' | 'ramesh' | 'kumar' | 'bharat', number>
let ids: Ids
const groupId = (name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
const count = (sql: string, ...args: unknown[]): number => (db.prepare(sql).get(...args) as { n: number }).n

function ledger(name: string, group: string, extra: Record<string, unknown> = {}): number {
  return createLedger(db, {
    name, groupId: groupId(group), openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null,
    tdsSectionId: null, pan: null, creditDays: null, exportType: null, ...extra
  }).id
}

const post = (intent: Record<string, unknown>) => postIntent(db, INFO, { clientId: `seed-${++seq}-xxxxxx`, ...intent }, TODAY)
const statement = (rows: string[], fileName = 'hdfc.csv') => commitStatement(db, ids.bank, { fileName, text: [HEADER, ...rows].join('\n') })
const view = (): Promise<BankView> => bankView(db, ids.bank, TODAY)
const lineOf = (v: BankView, text: string) => v.lines.find((l) => l.description.includes(text))!
const accept = (items: Omit<BankAcceptItem, 'clientId'>[], clientIds?: string[]) =>
  acceptLines(db, INFO, ids.bank, items.map((it, i) => ({ ...it, clientId: clientIds?.[i] ?? `bank-${it.lineId}-${++seq}-x` })) as BankAcceptItem[], TODAY)

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

  it('Hindi leftovers: the "because …" date is in the reader\'s language (default: the company\'s)', async () => {
    statement(ROWS)
    const dateOf = (v: BankView): string => String(lineOf(v, 'KUMAR').suggestion?.because.vars?.date ?? '')
    const en = dateOf(await view())
    expect(en).toMatch(/^\d{1,2} [A-Z][a-z]{2} 2025$/)
    const hi = dateOf(await bankView(db, ids.bank, TODAY, 'hi'))
    expect(hi).toMatch(/[\u0900-\u097F]/)
    expect(dateOf(await bankView(db, ids.bank, TODAY, 'hinglish'))).toBe(en)
    // No language sent → the company's, as before.
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('ui', ?)").run(JSON.stringify({ mode: 'simple', language: 'hi' }))
    expect(dateOf(await view())).toBe(hi)
    expect(dateOf(await bankView(db, ids.bank, TODAY, 'en'))).toBe(en)
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
    expect(after.sentence).toMatchObject({ asOn: '2025-08-18', differ: 0, difference: 0, open: 0, statementBalance: null })
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

  it('WP 10.8: every line answered is "agree" only when the statement’s own closing balance is the books’', async () => {
    const rows = (closing: string) => ['05/07/2025,SMS CHARGES APR-JUN,S1,"59.00",,"-59.00"', `10/08/2025,CASH DEP KUMAR,C1,,"1,000.00","${closing}"`]
    statement(rows('49,941.00'))
    let v = await view()
    accept(v.lines.filter((l) => l.suggestion?.choice.kind === 'existing').map((l) => ({ lineId: l.id, choice: { kind: 'existing' as const } })))
    v = await view()
    expect(v.sentence).toMatchObject({ differ: 0, open: 0, statementBalance: 49_941_00, bankBalance: 941_00 })
    expect(bankSentence(v.sentence)).toMatchObject({ key: 'simple.bank.sentence.balance', tone: 'balance', vars: { bank: '₹49,941.00', books: '₹941.00', gap: '₹49,000.00' } })
    // The same lines with a closing balance the books agree with.
    expect(bankSentence({ ...v.sentence, statementBalance: 941_00 })).toMatchObject({ tone: 'agree' })
  })

  it('WP 10.8 review: a newest-first file is read at the END of its last day, not its last line', async () => {
    post({ kind: 'money_out', date: '2025-08-10', payeeId: ids.charges, amount: 4_100, from: { how: 'bank', accountId: ids.bank }, narration: 'CHQ BOOK CHARGES' })
    // Books: −59 + 1,000 − 41 = ₹900. The file runs newest first; the day's last line is its FIRST.
    statement(['10/08/2025,CHQ BOOK CHARGES,K1,"41.00",,"900.00"', '10/08/2025,CASH DEP KUMAR,C1,,"1,000.00","941.00"', '05/07/2025,SMS CHARGES APR-JUN,S1,"59.00",,"-59.00"'])
    let v = await view()
    accept(v.lines.filter((l) => l.suggestion?.choice.kind === 'existing').map((l) => ({ lineId: l.id, choice: { kind: 'existing' as const } })))
    v = await view()
    expect(v.sentence).toMatchObject({ differ: 0, open: 0, statementBalance: 900_00, bankBalance: 900_00 })
    expect(bankSentence(v.sentence)).toMatchObject({ tone: 'agree' })
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

  it('"Not this" on a Done line = the full app’s unmatch: the match row goes, the voucher stays in the books, the line is open with its suggestion', async () => {
    statement(ROWS)
    const v = await view()
    const ramesh = lineOf(v, 'RAMESH')
    const r = accept([{ lineId: ramesh.id, choice: { kind: 'customer', partyId: ids.ramesh } }])
    const voucherId = r.done[0]!.voucherIds[0]!
    expect(lineOf(await view(), 'RAMESH').status).toBe('done')
    const vouchersBefore = count(`SELECT COUNT(*) AS n FROM vouchers v WHERE ${IN_BOOKS}`)

    // bankImport:unmatch — the channel the simple screen's "Not this" calls.
    unmatchLine(db, ids.bank, ramesh.id)
    expect(count('SELECT COUNT(*) AS n FROM bank_statement_matches WHERE statement_line_id = ?', ramesh.id)).toBe(0)
    expect(count(`SELECT COUNT(*) AS n FROM vouchers v WHERE v.id = ? AND ${IN_BOOKS}`, voucherId)).toBe(1)
    expect(count(`SELECT COUNT(*) AS n FROM vouchers v WHERE ${IN_BOOKS}`)).toBe(vouchersBefore)
    expect(getVoucher(db, voucherId)!.lines.find((x) => x.ledgerId === ids.bank)!.bankDate).toBeNull()
    expect(count("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'bank_statement_line' AND entity_id = ?", ramesh.id)).toBeGreaterThan(0)
    // Open again; the entry still in the books is what the matcher now offers ("Already recorded").
    const back = lineOf(await view(), 'RAMESH')
    expect(back.status).toBe('open')
    expect(back.suggestion).toMatchObject({ choice: { kind: 'existing' }, source: 'match' })
    expect(back.match?.amount).toBe(400_000)
    // A line that is not done is refused (nothing to take off).
    expect(() => unmatchLine(db, ids.bank, ramesh.id)).toThrow(/not matched/)
  })
})

describe('GST bills on bank lines (Money out’s purchase, a regular registration)', () => {
  const REG: CompanyInfo = { ...TEST_INFO, name: 'Bank GST Co', gstin: '27AAPFU0939F1ZV', stateCode: '27', gstRegistrationType: 'regular' }
  const RENT_ROW = '14/08/2025,NEFT-SHREE PROPERTIES RENT AUG,R1,"11,800.00",,'
  const CHARGE_ROW = '16/08/2025,SMS CHARGES JUL-SEP INCL GST,S2,"118.00",,'

  /** A regular company set up the same way every time (so ledger ids agree with its twin). */
  function regular(): { d: DB; L: (name: string) => number } {
    const d = seededDb()
    writeCompanyInfo(d, REG)
    const mk = (name: string, group: string, extra: Record<string, unknown> = {}): number =>
      createLedger(d, {
        name, groupId: (d.prepare('SELECT id FROM groups WHERE name = ?').get(group) as { id: number }).id, openingBalance: 0, gstin: null, stateCode: null, address: null,
        taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null, ...extra
      }).id
    mk('HDFC Bank', 'Bank Accounts')
    mk('Rent', 'Indirect Expenses', { simpleCategory: 'rent' })
    mk('Bank charges', 'Indirect Expenses', { simpleCategory: 'bank_charges' })
    for (const [n, t] of [['Input CGST', 'cgst'], ['Input SGST', 'sgst'], ['Input IGST', 'igst'], ['Output CGST', 'cgst'], ['Output SGST', 'sgst'], ['Output IGST', 'igst']] as const) mk(n, 'Duties & Taxes', { taxType: t })
    mk('Round Off', 'Indirect Expenses')
    mk('Bharat Steel', 'Sundry Creditors', { stateCode: '27', gstin: '27AABCG3456H1ZN' })
    return { d, L: (name) => (d.prepare('SELECT id FROM ledgers WHERE name = ?').get(name) as { id: number }).id }
  }
  const rows = (d: DB, id: number): unknown => ({
    voucher: d.prepare('SELECT voucher_type_id, date, number, party_ledger_id, narration, reference, instrument_no FROM vouchers WHERE id = ?').get(id),
    lines: d.prepare('SELECT ledger_id, dr_cr, amount, line_order FROM voucher_lines WHERE voucher_id = ? ORDER BY line_order').all(id),
    billRefs: d.prepare('SELECT party_ledger_id, kind, name, amount, due_date FROM bill_refs WHERE voucher_id = ? ORDER BY id').all(id)
  })
  const g3b = (d: DB): string => JSON.stringify(gstr3b(d, REG, '2025-08-01', '2025-08-31', '082025'))
  /** Money out's own path in the twin: the form's answers → moneyOutIntentFrom → simple:post. */
  function moneyOutTwin(twin: DB, L: (n: string) => number, f: Partial<MoneyOutForm>): number[] {
    const ctx = { facts: gstRegistrationOf(REG), companyStateCode: '27', supplierState: (id: number) => (twin.prepare('SELECT state_code AS s FROM ledgers WHERE id = ?').get(id) as { s: string | null }).s, drawingsId: null }
    const intent = moneyOutIntentFrom({ ...emptyMoneyOutForm('2025-08-14'), how: 'bank', accountId: L('HDFC Bank'), ...f }, [], { cash: null, upi: null, card: null, bank: L('HDFC Bank') }, ctx)
    return postIntent(twin, REG, { clientId: 'twin-money-out-1', ...intent }, TODAY).voucherIds
  }
  const lineIdOf = (d: DB, text: string): number => (d.prepare('SELECT id FROM bank_statement_lines WHERE description LIKE ?').get(`%${text}%`) as { id: number }).id
  const matchedTo = (d: DB, lineId: number): number[] =>
    (d.prepare(`SELECT m.voucher_id AS id FROM bank_statement_matches m JOIN vouchers v ON v.id = m.voucher_id WHERE m.statement_line_id = ? AND ${IN_BOOKS}`).all(lineId) as { id: number }[]).map((r) => r.id)

  it('an expense with a GST bill: the same purchase + payment as Money out, the payment tied to the line — and the same GSTR-3B', () => {
    const { d, L } = regular()
    commitStatement(d, L('HDFC Bank'), { fileName: 'hdfc.csv', text: [HEADER, RENT_ROW].join('\n') })
    const lineId = lineIdOf(d, 'RENT AUG')
    const r = acceptLines(d, REG, L('HDFC Bank'), [{ lineId, clientId: 'bank-rent-0001', choice: { kind: 'expense', accountId: L('Rent'), gstBill: { supplierId: L('Bharat Steel'), billNo: 'RENT-AUG', gstRate: 18 } } }], TODAY)
    expect(r.failed).toEqual([])
    const [bill, pay] = r.done[0]!.voucherIds as [number, number]
    expect(getVoucher(d, bill)!.lines.map((l) => [l.ledgerId, l.drCr, l.amount])).toEqual([[L('Bharat Steel'), 'cr', 1_180_000], [L('Rent'), 'dr', 1_000_000], [L('Input CGST'), 'dr', 90_000], [L('Input SGST'), 'dr', 90_000]])
    expect(matchedTo(d, lineId)).toEqual([pay])
    expect(getVoucher(d, pay)!.lines.find((l) => l.ledgerId === L('HDFC Bank'))).toMatchObject({ drCr: 'cr', amount: 1_180_000, bankDate: '2025-08-14' })

    const twin = regular()
    const theirs = moneyOutTwin(twin.d, twin.L, { who: 'expense', payeeId: twin.L('Rent'), amount: 1_180_000, gstBill: true, billSupplierId: twin.L('Bharat Steel'), billNo: 'RENT-AUG', gstRate: 18, reference: 'R1', note: 'NEFT-SHREE PROPERTIES RENT AUG' })
    expect(theirs.map((id) => rows(twin.d, id))).toEqual([bill, pay].map((id) => rows(d, id)))
    expect(g3b(d)).toBe(g3b(twin.d))
    expect(g3b(d)).toContain('90000')
  })

  it('a bank charge with GST: the bank as the supplier (its GSTIN), the input tax split out — = Money out’s purchase, the same GSTR-3B', () => {
    const { d, L } = regular()
    // A valid GSTIN for the bank (the check character found by the validator itself).
    const head = '27AAACH2702H1Z'
    const gstin = [...'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((ch) => head + ch).find((g) => validateGstin(g).valid)!
    commitStatement(d, L('HDFC Bank'), { fileName: 'hdfc.csv', text: [HEADER, CHARGE_ROW].join('\n') })
    const lineId = lineIdOf(d, 'SMS CHARGES')
    // A bad GSTIN is refused on its field, with no trace (no supplier added, nothing saved).
    const before = (d.prepare('SELECT COUNT(*) AS n FROM ledgers').get() as { n: number }).n
    const bad = acceptLines(d, REG, L('HDFC Bank'), [{ lineId, clientId: 'bank-chg-bad-01', choice: { kind: 'charges', accountId: L('Bank charges'), gstBill: { gstRate: 18, gstin: '27AAACH2702H1ZZ' } } }], TODAY)
    expect(bad.failed[0]!.error).toMatchObject({ code: 'simple_bank_bad_gstin', field: 'gstin' })
    expect((d.prepare('SELECT COUNT(*) AS n FROM ledgers').get() as { n: number }).n).toBe(before)
    expect((d.prepare('SELECT COUNT(*) AS n FROM vouchers').get() as { n: number }).n).toBe(0)

    const r = acceptLines(d, REG, L('HDFC Bank'), [{ lineId, clientId: 'bank-chg-0001', choice: { kind: 'charges', accountId: L('Bank charges'), gstBill: { gstRate: 18, gstin } } }], TODAY)
    expect(r.failed).toEqual([])
    const supplier = d.prepare("SELECT id, gstin, state_code AS s FROM ledgers WHERE name = 'HDFC Bank (charges)'").get() as { id: number; gstin: string; s: string }
    expect(supplier).toMatchObject({ gstin, s: '27' })
    const [bill, pay] = r.done[0]!.voucherIds as [number, number]
    expect(getVoucher(d, bill)!.lines.map((l) => [l.ledgerId, l.drCr, l.amount])).toEqual([[supplier.id, 'cr', 11_800], [L('Bank charges'), 'dr', 10_000], [L('Input CGST'), 'dr', 900], [L('Input SGST'), 'dr', 900]])
    expect(matchedTo(d, lineId)).toEqual([pay])
    // One supplier for the bank.
    expect((d.prepare("SELECT COUNT(*) AS n FROM ledgers WHERE name LIKE 'HDFC Bank (charges)%'").get() as { n: number }).n).toBe(1)

    const twin = regular()
    const sid = createLedger(twin.d, {
      name: 'HDFC Bank (charges)', groupId: (twin.d.prepare("SELECT id FROM groups WHERE name = 'Sundry Creditors'").get() as { id: number }).id, openingBalance: 0, gstin, stateCode: '27',
      address: null, taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
    }).id
    expect(sid).toBe(supplier.id)
    const theirs = moneyOutTwin(twin.d, twin.L, { date: '2025-08-16', who: 'expense', payeeId: twin.L('Bank charges'), amount: 11_800, gstBill: true, billSupplierId: sid, billNo: '', gstRate: 18, reference: 'S2', note: 'SMS CHARGES JUL-SEP INCL GST' })
    expect(theirs.map((id) => rows(twin.d, id))).toEqual([bill, pay].map((id) => rows(d, id)))
    expect(g3b(d)).toBe(g3b(twin.d))
  })

  it('an incomplete GST bill is refused on the line; an unregistered company’s answer is the plain payment', async () => {
    const { d, L } = regular()
    commitStatement(d, L('HDFC Bank'), { fileName: 'hdfc.csv', text: [HEADER, RENT_ROW].join('\n') })
    const lineId = lineIdOf(d, 'RENT AUG')
    const r = acceptLines(d, REG, L('HDFC Bank'), [{ lineId, clientId: 'bank-rent-inc-1', choice: { kind: 'expense', accountId: L('Rent'), gstBill: { gstRate: 18 } } }], TODAY)
    expect(r.failed[0]!.error).toMatchObject({ code: 'simple_bank_bill_incomplete', field: 'gstBill' })
    expect((d.prepare('SELECT COUNT(*) AS n FROM vouchers').get() as { n: number }).n).toBe(0)
    // The unregistered company of the other tests: a GST bill answer saves the payment only.
    statement(['14/08/2025,UPI-STATIONERY MART-PAPER,U1,"450.00",,'])
    const line = lineOf(await view(), 'STATIONERY')
    const plain = accept([{ lineId: line.id, choice: { kind: 'expense', accountId: ids.office, gstBill: { supplierId: ids.bharat, billNo: 'SM-1', gstRate: 18 } } }])
    expect(plain.failed).toEqual([])
    expect(plain.done[0]!.voucherIds).toHaveLength(1)
    expect(getVoucher(db, plain.done[0]!.voucherIds[0]!)!.lines.map((l) => [l.ledgerId, l.drCr, l.amount])).toEqual([[ids.office, 'dr', 45_000], [ids.bank, 'cr', 45_000]])
  })
})
