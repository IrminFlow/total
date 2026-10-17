// To-do §4 / WP 4.4 — "Record the disbursement": a loan's disbursement as a Receipt (Dr bank / Cr
// the loan ledger) linked in loan_vouchers (kind 'disbursement'), bin-only like the instalments;
// a loan taken before the books began takes the loan ledger's opening instead (masters, no voucher).
import { describe, expect, it } from 'vitest'
import { seededDb } from '../db/testdb'
import type { DB } from '../db/connection'
import { createLedger, getLedger } from './masters'
import { deleteVoucher, getVoucher, purgeVoucher, restoreVoucher, saveVoucher, setLockDate } from './vouchers'
import { trialBalance } from './reports'
import { addPrepayment, deleteLoan, getLoan, postEmi, recordDisbursement, saveLoan } from './loans'
import type { VoucherInput } from '@shared/schemas'

const gid = (db: DB, name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
const ledger = (db: DB, name: string, group: string, openingBalance = 0): number => createLedger(db, { name, groupId: gid(db, group), openingBalance }).id
const vt = (db: DB, kind: string): number => (db.prepare('SELECT id FROM voucher_types WHERE kind = ? ORDER BY id LIMIT 1').get(kind) as { id: number }).id
const TERMS = { name: 'HDFC term loan', principal: 1_00_000_00, annualRateMilli: 12_000, tenureMonths: 12, disbursedOn: '2026-04-01', firstDueDate: '2026-05-05' }

function books(terms: Partial<typeof TERMS> = {}) {
  const db = seededDb()
  const bank = ledger(db, 'HDFC Current', 'Bank Accounts', 5_00_000_00)
  const loanLedger = ledger(db, 'HDFC Term Loan', 'Secured Loans')
  const d = saveLoan(db, { ...TERMS, ...terms, loanLedgerId: loanLedger, bankLedgerId: bank })
  return { db, bank, loanLedger, d }
}
const editAttempt = (db: DB, id: number): void => {
  const v = getVoucher(db, id)!
  saveVoucher(db, { ...v, narration: 'changed', lines: v.lines.map((l) => ({ ...l, costAllocations: [] })), inventory: [], billRefs: [], tds: null } as unknown as VoucherInput, id)
}
const shape = (db: DB, id: number) => {
  const v = getVoucher(db, id)!
  const name = (lid: number): string => getLedger(db, lid)!.name
  return { type: v.voucherTypeId, date: v.date, party: v.partyLedgerId, lines: v.lines.map((l) => [name(l.ledgerId), l.drCr, l.amount]), billRefs: v.billRefs }
}

describe('Record the disbursement — a voucher', () => {
  it('posts the receipt the accountant would enter by hand; the schedule outstanding = the principal = the ledger', () => {
    const { db, loanLedger, d } = books()
    expect(d.loan).toMatchObject({ disbursement: null, beforeBooks: false, disbursementAmount: 1_00_000_00 })
    const after = recordDisbursement(db, { loanId: d.loan.id })
    const dis = after.loan.disbursement
    expect(dis).toMatchObject({ mode: 'voucher', date: '2026-04-01', amount: 1_00_000_00 })
    const id = dis!.mode === 'voucher' ? dis!.voucherId : 0
    expect(getVoucher(db, id)!.narration).toBe('Disbursement — HDFC term loan (principal ₹1,00,000.00)')
    expect(db.prepare('SELECT loan_id AS loanId, seq, kind FROM loan_vouchers WHERE voucher_id = ?').get(id)).toEqual({ loanId: d.loan.id, seq: 0, kind: 'disbursement' })

    // The hand-entered twin: a Receipt Dr HDFC Current / Cr HDFC Term Loan on the same date.
    const twin = books()
    const tid = saveVoucher(twin.db, {
      voucherTypeId: vt(twin.db, 'receipt'), date: '2026-04-01', partyLedgerId: null, narration: null, reference: null,
      lines: [{ ledgerId: twin.bank, drCr: 'dr', amount: 1_00_000_00, costAllocations: [] }, { ledgerId: twin.loanLedger, drCr: 'cr', amount: 1_00_000_00, costAllocations: [] }],
      inventory: [], billRefs: [], tds: null
    }).id
    expect(shape(db, id)).toEqual(shape(twin.db, tid))
    expect(trialBalance(db, '2026-04-30').rows).toEqual(trialBalance(twin.db, '2026-04-30').rows)

    const loan = getLoan(db, d.loan.id, '2026-04-02').loan
    expect(loan.outstanding).toBe(1_00_000_00)
    expect(loan.ledgerBalance).toBe(1_00_000_00)
    expect(getLedger(db, loanLedger)!.openingBalance).toBe(0)
    // Recorded once only; the audit row names the voucher.
    expect(() => recordDisbursement(db, { loanId: d.loan.id })).toThrow(/already posted/)
    const audit = db.prepare("SELECT after_json AS a FROM audit_log WHERE entity = 'loan' AND after_json LIKE '%disbursement%' ORDER BY id DESC LIMIT 1").get() as { a: string }
    expect(JSON.parse(audit.a).disbursement).toMatchObject({ mode: 'voucher', voucherId: id, amount: 1_00_000_00 })
  })

  it('edit refused; bin → record again → restore refused; bin → restore brings it back', () => {
    const { db, d } = books()
    const first = recordDisbursement(db, { loanId: d.loan.id }).loan.disbursement as { voucherId: number }
    expect(() => editAttempt(db, first.voucherId)).toThrow(/posted from Loans \(the disbursement\)/)
    deleteVoucher(db, first.voucherId)
    expect(getLoan(db, d.loan.id).loan.disbursement).toBeNull()
    restoreVoucher(db, first.voucherId)
    expect(getLoan(db, d.loan.id).loan.disbursement).toMatchObject({ voucherId: first.voucherId })
    deleteVoucher(db, first.voucherId)
    const again = recordDisbursement(db, { loanId: d.loan.id }).loan.disbursement as { voucherId: number }
    expect(again.voucherId).not.toBe(first.voucherId)
    expect(() => restoreVoucher(db, first.voucherId)).toThrow(/recorded again/)
    expect(db.prepare("SELECT COUNT(*) AS n FROM vouchers WHERE deleted_at IS NULL").get()).toEqual({ n: 1 })
  })

  it('a changed principal makes a binned disbursement unrestorable; terms are fixed while it is live; delete waits for the purge', () => {
    const { db, d, loanLedger, bank } = books()
    const first = recordDisbursement(db, { loanId: d.loan.id }).loan.disbursement as { voucherId: number }
    const input = { ...TERMS, loanLedgerId: loanLedger, bankLedgerId: bank }
    expect(() => saveLoan(db, { ...input, principal: 90_000_00 }, d.loan.id)).toThrow(/disbursement is posted/)
    expect(saveLoan(db, { ...input, name: 'Renamed' }, d.loan.id).loan.name).toBe('Renamed')
    expect(() => deleteLoan(db, d.loan.id)).toThrow(/disbursement is posted/)
    deleteVoucher(db, first.voucherId)
    saveLoan(db, { ...input, principal: 90_000_00 }, d.loan.id)
    expect(() => restoreVoucher(db, first.voucherId)).toThrow(/principal, date or ledger changed/)
    expect(() => deleteLoan(db, d.loan.id)).toThrow(/in the bin/)
    purgeVoucher(db, first.voucherId)
    deleteLoan(db, d.loan.id)
  })

  it('schedule regeneration keeps the link (a prepayment after an EMI)', () => {
    const { db, d } = books()
    const dis = recordDisbursement(db, { loanId: d.loan.id }).loan.disbursement as { voucherId: number }
    postEmi(db, { scheduleId: d.schedule[0]!.id })
    const r = addPrepayment(db, { loanId: d.loan.id, date: '2026-05-20', amount: 30_000_00, effect: 'reduce_tenure' })
    expect(r.loan.disbursement).toMatchObject({ mode: 'voucher', voucherId: dis.voucherId })
    expect(db.prepare("SELECT COUNT(*) AS n FROM loan_vouchers WHERE kind = 'disbursement'").get()).toEqual({ n: 1 })
    expect(r.loan.ledgerBalance).toBe(r.loan.outstanding)
  })

  it('refuses a non-bank account and a locked date', () => {
    const { db, d } = books()
    const rent = ledger(db, 'Rent', 'Indirect Expenses')
    expect(() => recordDisbursement(db, { loanId: d.loan.id, bankLedgerId: rent })).toThrow(/cash or bank/)
    setLockDate(db, '2026-04-30')
    expect(() => recordDisbursement(db, { loanId: d.loan.id })).toThrow(/locked/)
    expect(db.prepare('SELECT COUNT(*) AS n FROM vouchers').get()).toEqual({ n: 0 })
  })
})

describe('Record the disbursement — a loan taken before the books began', () => {
  // Books begin 1 Apr 2025 (TEST_INFO). Taken 10 Jan 2025, first EMI 10 Feb: two EMIs (Feb, Mar)
  // fell due before the books — the opening is the closing after the March instalment.
  it('sets the loan ledger opening (no voucher); instalments before the books are part of it', () => {
    const { db, loanLedger, d } = books({ disbursedOn: '2025-01-10', firstDueDate: '2025-02-10' })
    expect(d.loan.beforeBooks).toBe(true)
    const marchClose = d.schedule[1]!.closing
    expect(d.schedule[1]!.dueDate).toBe('2025-03-10')
    expect(d.loan.disbursementAmount).toBe(marchClose)
    const after = recordDisbursement(db, { loanId: d.loan.id })
    expect(after.loan.disbursement).toEqual({ mode: 'opening', amount: marchClose })
    expect(getLedger(db, loanLedger)!.openingBalance).toBe(-marchClose)
    expect(db.prepare('SELECT COUNT(*) AS n FROM vouchers').get()).toEqual({ n: 0 })
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'ledger' AND action = 'update' AND entity_id = ?").get(loanLedger)).toEqual({ n: 1 })
    expect(() => recordDisbursement(db, { loanId: d.loan.id })).toThrow(/already in the loan ledger/)
    // February's instalment is in the opening; April's (the first in the books) posts without it.
    expect(() => postEmi(db, { scheduleId: d.schedule[0]!.id })).toThrow(/before the books began/)
    postEmi(db, { scheduleId: d.schedule[2]!.id })
    const l = getLoan(db, d.loan.id, '2025-04-30').loan
    expect(l.ledgerBalance).toBe(d.schedule[2]!.closing)
  })

  it('refuses when the loan ledger already carries an opening on the other side', () => {
    const { db, loanLedger, d } = books({ disbursedOn: '2025-01-10', firstDueDate: '2025-02-10' })
    db.prepare('UPDATE ledgers SET opening_balance = 500 WHERE id = ?').run(loanLedger)
    expect(() => recordDisbursement(db, { loanId: d.loan.id })).toThrow(/already has an opening balance/)
  })
})
