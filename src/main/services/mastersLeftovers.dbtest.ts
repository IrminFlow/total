// 1.0 cleanup review: budgets and loan schedules are gone from the app, but books from before keep
// their `budget_lines` / `loans` rows, which point at ledgers and groups. No screen can remove
// them any more, so deleting the ledger / group removes them (each audited with its whole
// before-image). A loan's nullable bank / interest ledger is cleared instead (audited loan
// update — an unused account must not need a voucher binned); deleting the loan record itself is
// refused while its entries are in the books, with a mapped message naming the loan. Vouchers are
// never touched.
import { describe, expect, it } from 'vitest'
import { seededDb } from '../db/testdb'
import type { DB } from '../db/connection'
import { AppError } from '@shared/errors'
import { createGroup, createLedger, deleteGroup, deleteLedger } from './masters'
import { deleteCostCentre, saveCostCentre } from './costCentres'
import { deleteVoucher, saveVoucher } from './vouchers'
import { runImport, undoImport } from './dataImport'
import { autoPlan, parseImportFile } from './importFiles'

const gid = (db: DB, name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
const ledger = (db: DB, name: string, group: string, openingBalance = 0): number => createLedger(db, { name, groupId: gid(db, group), openingBalance }).id
const count = (db: DB, sql: string, ...args: unknown[]): number => (db.prepare(sql).get(...args) as { n: number }).n
const audit = (db: DB, entity: string, entityId: number) =>
  db.prepare('SELECT action, before_json AS b, after_json AS a FROM audit_log WHERE entity = ? AND entity_id = ? ORDER BY id DESC LIMIT 1').get(entity, entityId) as
    | { action: string; b: string | null; a: string | null }
    | undefined

/** A budget as the removed Budgets screen stored it, with one ledger line and one group line. */
function legacyBudget(db: DB, ledgerId: number, groupId: number): number {
  const id = Number(db.prepare("INSERT INTO budgets (name, fy_start_year) VALUES ('Opex', 2026)").run().lastInsertRowid)
  db.prepare('INSERT INTO budget_lines (budget_id, ledger_id, group_id, month, amount) VALUES (?, ?, NULL, NULL, 1200000)').run(id, ledgerId)
  db.prepare('INSERT INTO budget_lines (budget_id, ledger_id, group_id, month, amount) VALUES (?, NULL, ?, NULL, 500000)').run(id, groupId)
  return id
}

/** A loan as the removed Loans screen stored it: schedule, a prepayment, an interest ledger. */
function legacyLoan(db: DB, loanLedger: number, bank: number, interest: number | null, name = 'Term loan'): number {
  const id = Number(db.prepare(
    `INSERT INTO loans (name, loan_ledger_id, bank_ledger_id, interest_ledger_id, principal, annual_rate_milli, tenure_months, disbursed_on, first_due_date)
     VALUES (?, ?, ?, ?, 10000000, 12000, 12, '2026-05-01', '2026-06-05')`
  ).run(name, loanLedger, bank, interest).lastInsertRowid)
  db.prepare("INSERT INTO loan_schedules (loan_id, seq, due_date, kind, opening, payment, interest, principal, closing) VALUES (?, 1, '2026-06-05', 'emi', 10000000, 888488, 100000, 788488, 9211512)").run(id)
  db.prepare("INSERT INTO loan_prepayments (loan_id, date, amount, effect) VALUES (?, '2026-08-01', 1000000, 'reduce_emi')").run(id)
  return id
}

/** The loan's disbursement as Loans → "Record the disbursement" posted it (Dr bank / Cr loan). */
function disbursement(db: DB, loanId: number, bank: number, loanLedger: number): number {
  const vt = (db.prepare("SELECT id FROM voucher_types WHERE kind = 'receipt' ORDER BY id LIMIT 1").get() as { id: number }).id
  const v = saveVoucher(db, {
    voucherTypeId: vt, date: '2026-05-01', partyLedgerId: null, narration: 'Loan disbursed', reference: null, inventory: [], billRefs: [], tds: null,
    lines: [{ ledgerId: bank, drCr: 'dr', amount: 1_00_000_00, costAllocations: [] }, { ledgerId: loanLedger, drCr: 'cr', amount: 1_00_000_00, costAllocations: [] }]
  })
  db.prepare("INSERT INTO loan_vouchers (voucher_id, loan_id, seq, kind) VALUES (?, ?, 0, 'disbursement')").run(v.id, loanId)
  return v.id
}

describe('deleting a ledger or group that leftover budgets / loans point at', () => {
  it('a ledger with a budget line: the line goes (budget audited with its whole before-image), the ledger is deleted', () => {
    const db = seededDb()
    const rent = ledger(db, 'Office Rent', 'Indirect Expenses')
    const budget = legacyBudget(db, rent, gid(db, 'Indirect Expenses'))
    deleteLedger(db, rent)
    expect(count(db, 'SELECT COUNT(*) AS n FROM ledgers WHERE id = ?', rent)).toBe(0)
    expect(count(db, 'SELECT COUNT(*) AS n FROM budget_lines WHERE budget_id = ?', budget)).toBe(1)
    const row = audit(db, 'budget', budget)!
    expect(row.action).toBe('update')
    expect(JSON.parse(row.b!).lines).toHaveLength(2)
    expect(JSON.parse(row.a!).lines).toHaveLength(1)
    expect(JSON.parse(audit(db, 'ledger', rent)!.b!).cascaded).toMatchObject({ budget_lines: 1 })
  })

  it('a group with a budget line: the line goes, the group is deleted', () => {
    const db = seededDb()
    const g = createGroup(db, { name: 'Shop expenses', parentId: gid(db, 'Indirect Expenses') }).id
    const budget = legacyBudget(db, ledger(db, 'Electricity', 'Indirect Expenses'), g)
    deleteGroup(db, g)
    expect(count(db, 'SELECT COUNT(*) AS n FROM groups WHERE id = ?', g)).toBe(0)
    expect(count(db, 'SELECT COUNT(*) AS n FROM budget_lines WHERE group_id = ?', g)).toBe(0)
    expect(count(db, 'SELECT COUNT(*) AS n FROM budget_lines WHERE budget_id = ?', budget)).toBe(1)
    expect(JSON.parse(audit(db, 'budget', budget)!.b!).lines).toHaveLength(2)
  })

  it('a pre-books loan ledger with only an opening: the loan record (schedule, prepayment) goes, audited whole', () => {
    const db = seededDb()
    const loanLedger = ledger(db, 'Term Loan', 'Secured Loans', -1_00_000_00)
    const bank = ledger(db, 'HDFC', 'Bank Accounts')
    const interest = ledger(db, 'Interest on loan', 'Indirect Expenses')
    const loan = legacyLoan(db, loanLedger, bank, interest)
    deleteLedger(db, loanLedger)
    expect(count(db, 'SELECT COUNT(*) AS n FROM loans WHERE id = ?', loan)).toBe(0)
    expect(count(db, 'SELECT COUNT(*) AS n FROM loan_schedules WHERE loan_id = ?', loan)).toBe(0)
    expect(count(db, 'SELECT COUNT(*) AS n FROM loan_prepayments WHERE loan_id = ?', loan)).toBe(0)
    const row = audit(db, 'loan', loan)!
    expect(row.action).toBe('delete')
    expect(JSON.parse(row.b!)).toMatchObject({ name: 'Term loan', schedule: [expect.objectContaining({ seq: 1 })], prepayments: [expect.objectContaining({ amount: 1000000 })] })
    expect(row.a).toBeNull()
    // the bank and the interest ledger stay
    expect(count(db, 'SELECT COUNT(*) AS n FROM ledgers WHERE id IN (?, ?)', bank, interest)).toBe(2)
  })

  it('an unused interest ledger of a loan with live entries: deleted; the loan keeps, its interest ledger cleared (audited)', () => {
    const db = seededDb()
    const loanLedger = ledger(db, 'Term Loan', 'Secured Loans')
    const bank = ledger(db, 'HDFC', 'Bank Accounts')
    const interest = ledger(db, 'Interest on loan', 'Indirect Expenses')
    const loan = legacyLoan(db, loanLedger, bank, interest)
    const v = disbursement(db, loan, bank, loanLedger)
    deleteLedger(db, interest)
    expect(count(db, 'SELECT COUNT(*) AS n FROM ledgers WHERE id = ?', interest)).toBe(0)
    expect(db.prepare('SELECT interest_ledger_id AS i, bank_ledger_id AS b FROM loans WHERE id = ?').get(loan)).toEqual({ i: null, b: bank })
    const row = audit(db, 'loan', loan)!
    expect(row.action).toBe('update')
    expect(JSON.parse(row.b!)).toMatchObject({ interest_ledger_id: interest })
    expect(JSON.parse(row.a!)).toMatchObject({ interest_ledger_id: null })
    expect(count(db, 'SELECT COUNT(*) AS n FROM vouchers WHERE id = ? AND deleted_at IS NULL', v)).toBe(1)
  })

  it('the loan ledger itself while the loan still has entries in the books: refused, naming the loan; nothing is removed', () => {
    const db = seededDb()
    const loanLedger = ledger(db, 'Term Loan', 'Secured Loans', -1_00_000_00)
    const bank = ledger(db, 'HDFC', 'Bank Accounts')
    const other = ledger(db, 'Director loan', 'Unsecured Loans')
    const interest = ledger(db, 'Interest on loan', 'Indirect Expenses')
    const loan = legacyLoan(db, loanLedger, bank, interest)
    // Loan vouchers are ordinary since the cleanup: its disbursement was edited onto another ledger.
    const v = disbursement(db, loan, bank, other)
    const auditRows = count(db, 'SELECT COUNT(*) AS n FROM audit_log')
    let err: unknown
    try { deleteLedger(db, loanLedger) } catch (e) { err = e }
    expect(err).toBeInstanceOf(AppError)
    expect(err).toMatchObject({ code: 'ledger_loan_in_use', params: { loan: 'Term loan' } })
    expect((err as Error).message).toContain('Term loan')
    expect(count(db, 'SELECT COUNT(*) AS n FROM loans WHERE id = ?', loan)).toBe(1)
    expect(count(db, 'SELECT COUNT(*) AS n FROM ledgers WHERE id = ?', loanLedger)).toBe(1)
    expect(count(db, 'SELECT COUNT(*) AS n FROM audit_log')).toBe(auditRows)

    // Once its entries are binned the loan record (and the binned voucher's link) can go; the
    // binned voucher itself stays in the bin, untouched.
    deleteVoucher(db, v)
    deleteLedger(db, loanLedger)
    expect(count(db, 'SELECT COUNT(*) AS n FROM loans WHERE id = ?', loan)).toBe(0)
    expect(count(db, 'SELECT COUNT(*) AS n FROM loan_vouchers WHERE loan_id = ?', loan)).toBe(0)
    expect(count(db, 'SELECT COUNT(*) AS n FROM vouchers WHERE id = ? AND deleted_at IS NOT NULL', v)).toBe(1)
    expect(JSON.parse(audit(db, 'loan', loan)!.b!).voucherLinks).toEqual([expect.objectContaining({ voucherId: v, kind: 'disbursement' })])
  })

  it('a cost centre a budget line is split by: the line goes (budget audited), the cost centre is deleted', () => {
    const db = seededDb()
    const rent = ledger(db, 'Office Rent', 'Indirect Expenses')
    const budget = legacyBudget(db, rent, gid(db, 'Indirect Expenses'))
    const cc = saveCostCentre(db, { name: 'Mumbai', parentId: null, active: true }).id
    db.prepare('UPDATE budget_lines SET cost_centre_id = ? WHERE budget_id = ? AND ledger_id = ?').run(cc, budget, rent)
    deleteCostCentre(db, cc)
    expect(count(db, 'SELECT COUNT(*) AS n FROM cost_centres WHERE id = ?', cc)).toBe(0)
    expect(count(db, 'SELECT COUNT(*) AS n FROM budget_lines WHERE budget_id = ?', budget)).toBe(1)
    expect(JSON.parse(audit(db, 'budget', budget)!.b!).lines).toHaveLength(2)
    expect(JSON.parse(audit(db, 'costCentre', cc)!.b!).cascaded).toMatchObject({ budget_lines: 1 })
  })

  it('import undo: an imported cost centre a budget line is split by is deleted (budget audited); an imported loan ledger with live entries is kept, the reason naming the loan', () => {
    const db = seededDb()
    const csv = (text: string, profileId: string) => {
      const f = parseImportFile('x.csv', new TextEncoder().encode(text))
      const { steps, profile } = autoPlan(db, f, '27', { profileId })
      return runImport(db, steps, {}, { source: profile.source, profileId: profile.id, fileName: 'x.csv' }, false)
    }
    const ccRun = csv('Name,Under\nPune office,', 'generic:costCentres')
    const cc = (db.prepare("SELECT id FROM cost_centres WHERE name = 'Pune office'").get() as { id: number }).id
    const budget = legacyBudget(db, ledger(db, 'Office Rent', 'Indirect Expenses'), gid(db, 'Indirect Expenses'))
    db.prepare('UPDATE budget_lines SET cost_centre_id = ? WHERE budget_id = ? AND ledger_id IS NOT NULL').run(cc, budget)
    expect(undoImport(db, ccRun.batchId!)).toMatchObject({ deleted: 1, kept: [] })
    expect(count(db, 'SELECT COUNT(*) AS n FROM cost_centres WHERE id = ?', cc)).toBe(0)
    expect(count(db, 'SELECT COUNT(*) AS n FROM budget_lines WHERE budget_id = ?', budget)).toBe(1)
    expect(audit(db, 'budget', budget)!.action).toBe('update')

    // The realistic case: the disbursement credits the imported loan ledger itself (its own entries
    // keep it — ledger_in_use); with an imported opening (cleared, kept) and without (kept as is):
    // the reason names the loan, never "purge the bin".
    const ledgerRun = csv('Name,Group\nImported Term Loan,Secured Loans\nSecond Term Loan,Secured Loans', 'generic:ledgers')
    const idOf = (name: string): number => (db.prepare('SELECT id FROM ledgers WHERE name = ?').get(name) as { id: number }).id
    const [l1, l2] = [idOf('Imported Term Loan'), idOf('Second Term Loan')]
    db.prepare('UPDATE ledgers SET opening_balance = -500000 WHERE id = ?').run(l2) // as the import gave it
    const bank = ledger(db, 'HDFC', 'Bank Accounts')
    const loan1 = legacyLoan(db, l1, bank, null)
    const loan2 = legacyLoan(db, l2, bank, null, 'Second loan')
    disbursement(db, loan1, bank, l1)
    disbursement(db, loan2, bank, l2)
    const u = undoImport(db, ledgerRun.batchId!)
    const reasonOf = (id: number): string => u.kept.find((k) => k.id === id)!.reason
    expect(reasonOf(l1)).toContain('loan “Term loan”')
    expect(reasonOf(l2)).toMatch(/opening cleared .*loan “Second loan”/)
    for (const id of [l1, l2]) expect(reasonOf(id)).not.toMatch(/purge the bin/)
    expect(count(db, 'SELECT COUNT(*) AS n FROM loans WHERE id IN (?, ?)', loan1, loan2)).toBe(2)
    expect(count(db, 'SELECT COUNT(*) AS n FROM ledgers WHERE id IN (?, ?)', l1, l2)).toBe(2)
    expect(JSON.parse(audit(db, 'costCentre', cc)!.b!).cascaded).toMatchObject({ budget_lines: 1 })
  })
})
