/**
 * Statement import profiles (#131), learned narration matching (#133) and bulk accept (#134),
 * against a real DB. The pure parsing/confidence maths is unit-tested in src/shared; what is
 * exercised here is everything that only exists once a database does: stored profiles, learned
 * memory accumulating across matches, and vouchers actually being filed.
 */
import { describe, it, expect } from 'vitest'
import { seededDb } from '../db/testdb'
import { createLedger } from './masters'
import {
  bulkAcceptSuggestions, deleteImportProfile, forgetNarration, importStatement, inspectStatement,
  learnFromMatch, listImportProfiles, listNarrationMemory, resolveProfile, saveImportProfile,
  saveRule, suggestVouchers
} from './banking'

type Db = ReturnType<typeof seededDb>

function ledgerIn(db: Db, group: string, name: string): { id: number } {
  const g = db.prepare('SELECT id FROM groups WHERE name = ?').get(group) as { id: number }
  return createLedger(db, {
    name, groupId: g.id, openingBalance: 0, gstin: null, stateCode: null, address: null,
    taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
  })
}

const bankLedger = (db: Db, name = 'HDFC Bank'): { id: number } => ledgerIn(db, 'Bank Accounts', name)
const expenseLedger = (db: Db, name: string): { id: number } => ledgerIn(db, 'Direct Expenses', name)

const HDFC_CSV = [
  'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance',
  '10/08/2026,NEFT DR-ACME SUPPLIES-N001,N001,10/08/2026,"1,500.00",,"98,500.00"',
  '11/08/2026,UPI-MAHANAGAR GAS-9988,UPI9988,11/08/2026,"750.00",,"97,750.00"'
].join('\n')

// Same two transactions, as Kotak writes them: one amount column and a direction flag.
const KOTAK_CSV = [
  'Sl. No.,Transaction Date,Value Date,Description,Chq / Ref No.,Amount,Dr / Cr,Balance',
  '1,10/08/2026,10/08/2026,ACME SUPPLIES,N001,"1,500.00",DR,"98,500.00"',
  '2,11/08/2026,11/08/2026,MAHANAGAR GAS,R002,"750.00",DR,"97,750.00"'
].join('\n')

describe('import profiles (#131)', () => {
  it('lists the five built-in banks before any profile has been saved', () => {
    const db = seededDb()
    const names = listImportProfiles(db).map((p) => p.name)
    expect(names).toEqual([
      'HDFC Bank', 'ICICI Bank', 'State Bank of India', 'Axis Bank', 'Kotak Mahindra Bank'
    ])
    expect(listImportProfiles(db).every((p) => p.builtIn)).toBe(true)
  })

  it('saves, lists, updates and deletes a user profile', () => {
    const db = seededDb()
    const saved = saveImportProfile(db, {
      name: 'Saraswat Co-op',
      dateFormat: 'dmy',
      convention: 'signed',
      debitFlag: null,
      columns: { date: 'Posting Day', narration: 'Memo', amount: 'Value' }
    })
    expect(saved.id).toMatch(/^user:\d+$/)
    expect(listImportProfiles(db)).toHaveLength(6)

    const numericId = Number(saved.id.split(':')[1])
    const updated = saveImportProfile(db, {
      name: 'Saraswat Co-operative Bank',
      dateFormat: 'mdy',
      convention: 'signed',
      debitFlag: null,
      columns: { date: 'Posting Day', narration: 'Memo', amount: 'Value' }
    }, numericId)
    expect(updated.name).toBe('Saraswat Co-operative Bank')
    expect(updated.dateFormat).toBe('mdy')
    expect(listImportProfiles(db)).toHaveLength(6)

    deleteImportProfile(db, numericId)
    expect(listImportProfiles(db)).toHaveLength(5)
    expect(() => deleteImportProfile(db, numericId)).toThrow('not found')
  })

  it('refuses a Dr/Cr profile with nothing to recognise a withdrawal by', () => {
    const db = seededDb()
    expect(() =>
      saveImportProfile(db, {
        name: 'Broken', dateFormat: 'dmy', convention: 'flagged', debitFlag: '  ',
        columns: { date: 'Date', narration: 'Memo', amount: 'Amount', drCr: 'Type' }
      })
    ).toThrow(/withdrawal/i)
  })

  it('inspects an HDFC file, names the profile, and reads every row', () => {
    const db = seededDb()
    const found = inspectStatement(db, HDFC_CSV)
    expect(found.profileId).toBe('builtin:hdfc')
    expect(found.detected).toBe(true)
    expect(found.rowsReadable).toBe(2)
    expect(found.rowsSkipped).toBe(0)
    expect(found.error).toBeNull()
    expect(found.sample[0]).toMatchObject({ date: '2026-08-10', withdrawal: 150000 })
  })

  it('reads a Kotak Dr/Cr-flag file as withdrawals, not deposits', () => {
    const db = seededDb()
    const found = inspectStatement(db, KOTAK_CSV)
    expect(found.profileId).toBe('builtin:kotak')
    expect(found.sample.map((r) => r.withdrawal)).toEqual([150000, 75000])
    expect(found.sample.every((r) => r.deposit === 0)).toBe(true)
  })

  it('says so instead of failing when nothing recognises the file', () => {
    const db = seededDb()
    const csv = ['Posting Day,Memo,Value', '10/08/2026,SOMETHING,-1500.00'].join('\n')
    const found = inspectStatement(db, csv)
    // No built-in claims these headers and 'Posting Day' does not read as a date column to the
    // wording heuristic either, so there is nothing to fall back on — and it says so instead of
    // returning an empty statement that looks like a file with no transactions in it.
    expect(found.detected).toBe(false)
    expect(found.profileId).toBeNull()
    expect(found.header).toEqual(['Posting Day', 'Memo', 'Value'])
    expect(found.rowsReadable).toBe(0)
    expect(found.error).toMatch(/pick the columns/i)
  })

  it('reads that same file once the user maps the columns by hand', () => {
    const db = seededDb()
    const csv = ['Posting Day,Memo,Value', '10/08/2026,SOMETHING,-1500.00'].join('\n')
    const adHoc = {
      dateFormat: 'dmy' as const,
      convention: 'signed' as const,
      debitFlag: null,
      columns: { date: 'Posting Day', narration: 'Memo', amount: 'Value' }
    }
    const found = inspectStatement(db, csv, { adHoc })
    expect(found.rowsReadable).toBe(1)
    expect(found.sample[0]).toMatchObject({ description: 'SOMETHING', withdrawal: 150000 })
  })

  it('reports the wrong profile as unreadable rather than importing nonsense', () => {
    const db = seededDb()
    const bank = bankLedger(db)
    // Kotak's mapping on an HDFC file: no Amount column, so there is nothing to read.
    const found = inspectStatement(db, HDFC_CSV, { profileId: 'builtin:kotak' })
    expect(found.rowsReadable).toBe(0)
    expect(found.error).toMatch(/amount column/i)

    const profile = resolveProfile(db, { profileId: 'builtin:kotak' })
    expect(() => importStatement(db, bank.id, HDFC_CSV, { profile })).toThrow(/amount column/i)
  })

  it('reads an ambiguous 03/04/2026 the way the chosen profile says', () => {
    const db = seededDb()
    const csv = [
      'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance',
      '03/04/2026,RENT,R1,03/04/2026,"1,000.00",,"1,000.00"'
    ].join('\n')
    expect(inspectStatement(db, csv).sample[0]!.date).toBe('2026-04-03')

    const numericId = Number(
      saveImportProfile(db, {
        name: 'US-order bank', dateFormat: 'mdy', convention: 'debit_credit', debitFlag: null,
        columns: { date: 'Date', narration: 'Narration', debit: 'Withdrawal Amt.', credit: 'Deposit Amt.' }
      }).id.split(':')[1]
    )
    const asMdy = inspectStatement(db, csv, { profileId: `user:${numericId}` })
    expect(asMdy.sample[0]!.date).toBe('2026-03-04')
  })

  it('imports under a named profile and reports which one read the file', () => {
    const db = seededDb()
    const bank = bankLedger(db)
    const profile = resolveProfile(db, { profileId: 'builtin:hdfc' })
    const result = importStatement(db, bank.id, HDFC_CSV, { apply: false, profile })
    expect(result.profileName).toBe('HDFC Bank')
    expect(result.statementRows).toBe(2)
    expect(result.skipped).toBe(0)
  })

  it('counts the bank’s own zero-amount and footer lines as skipped, not as transactions', () => {
    const db = seededDb()
    const bank = bankLedger(db)
    const csv = [
      'Date,Description,Debit,Credit',
      '10/08/2026,REAL PAYMENT,1500.00,',
      '11/08/2026,CHARGE REVERSED,0.00,0.00',
      'This statement is computer generated,,,'
    ].join('\n')
    const result = importStatement(db, bank.id, csv, { apply: false })
    expect(result.statementRows).toBe(1)
    expect(result.skipped).toBe(2)
  })

  it('re-importing the same statement reconciles nothing twice', () => {
    const db = seededDb()
    const bank = bankLedger(db)
    const office = expenseLedger(db, 'Office Supplies')
    const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'payment'").get() as { id: number }
    db.prepare("INSERT INTO vouchers (voucher_type_id, date, number) VALUES (?, '2026-08-10', 'PMT/1')").run(vt.id)
    const v = db.prepare("SELECT id FROM vouchers WHERE number = 'PMT/1'").get() as { id: number }
    db.prepare("INSERT INTO voucher_lines (voucher_id, ledger_id, dr_cr, amount) VALUES (?, ?, 'dr', 150000)").run(v.id, office.id)
    db.prepare("INSERT INTO voucher_lines (voucher_id, ledger_id, dr_cr, amount) VALUES (?, ?, 'cr', 150000)").run(v.id, bank.id)

    const first = importStatement(db, bank.id, HDFC_CSV)
    expect(first.matched).toBe(1)
    expect(first.alreadyReconciled).toBe(0)

    const second = importStatement(db, bank.id, HDFC_CSV)
    expect(second.matched).toBe(0)
    // The row is reported truthfully as already done rather than as a new unmatched line.
    expect(second.alreadyReconciled).toBe(1)
    const bankDates = db
      .prepare('SELECT COUNT(*) AS n FROM voucher_lines WHERE ledger_id = ? AND bank_date IS NOT NULL')
      .get(bank.id) as { n: number }
    expect(bankDates.n).toBe(1)
  })
})

describe('narration memory (#133)', () => {
  it('learns the significant words of a narration and ignores the bank plumbing', () => {
    const db = seededDb()
    const office = expenseLedger(db, 'Office Supplies')
    expect(learnFromMatch(db, 'NEFT DR-ACME SUPPLIES-N001', office.id, 'payment')).toEqual(['acme', 'supplies'])
    // Nothing but plumbing and a reference number: nothing worth remembering.
    expect(learnFromMatch(db, 'NEFT CHARGES 0912', office.id, 'payment')).toEqual([])
    expect(listNarrationMemory(db).map((m) => m.keyword).sort()).toEqual(['acme', 'supplies'])
  })

  it('counts repeats as evidence rather than as new rows', () => {
    const db = seededDb()
    const office = expenseLedger(db, 'Office Supplies')
    for (let i = 0; i < 3; i++) learnFromMatch(db, 'ACME SUPPLIES', office.id, 'payment')
    const memory = listNarrationMemory(db)
    expect(memory).toHaveLength(2)
    expect(memory.every((m) => m.hits === 3)).toBe(true)
    expect(memory[0]!.ledgerName).toBe('Office Supplies')
  })

  it('refuses to learn against a ledger that does not exist', () => {
    const db = seededDb()
    expect(() => learnFromMatch(db, 'ACME SUPPLIES', 999999, 'payment')).toThrow('Ledger not found')
  })

  it('forgets a pair on request, and says so when there is nothing to forget', () => {
    const db = seededDb()
    const office = expenseLedger(db, 'Office Supplies')
    learnFromMatch(db, 'ACME SUPPLIES', office.id, 'payment')
    forgetNarration(db, 'acme', office.id, 'payment')
    expect(listNarrationMemory(db).map((m) => m.keyword)).toEqual(['supplies'])
    expect(() => forgetNarration(db, 'acme', office.id, 'payment')).toThrow(/nothing learned/i)
  })

  it('will not suggest from one sighting, and does once the same words come back', () => {
    const db = seededDb()
    const bank = bankLedger(db)
    const gas = expenseLedger(db, 'Gas Charges')
    const csv = HDFC_CSV

    learnFromMatch(db, 'UPI-MAHANAGAR GAS-9988', gas.id, 'payment')
    const once = suggestVouchers(db, bank.id, csv).find((r) => r.statementRow.description.includes('MAHANAGAR'))!
    expect(once.suggestion).toMatchObject({ ledgerId: gas.id, source: 'learned', confidence: 40 })

    learnFromMatch(db, 'UPI-MAHANAGAR GAS-1122', gas.id, 'payment')
    learnFromMatch(db, 'UPI-MAHANAGAR GAS-3344', gas.id, 'payment')
    const thrice = suggestVouchers(db, bank.id, csv).find((r) => r.statementRow.description.includes('MAHANAGAR'))!
    expect(thrice.suggestion).toMatchObject({ ledgerId: gas.id, confidence: 100, ambiguous: false })
    expect(thrice.suggestion!.voucherDraft.lines).toEqual([
      { ledgerId: gas.id, drCr: 'dr', amount: 75000 },
      { ledgerId: bank.id, drCr: 'cr', amount: 75000 }
    ])
  })

  it('a written rule outranks anything learned, at full confidence', () => {
    const db = seededDb()
    const bank = bankLedger(db)
    const gas = expenseLedger(db, 'Gas Charges')
    const misc = expenseLedger(db, 'Miscellaneous')
    for (let i = 0; i < 5; i++) learnFromMatch(db, 'MAHANAGAR GAS', misc.id, 'payment')
    saveRule(db, { pattern: 'MAHANAGAR', ledgerId: gas.id, kind: 'payment', active: true })

    const row = suggestVouchers(db, bank.id, HDFC_CSV).find((r) => r.statementRow.description.includes('MAHANAGAR'))!
    expect(row.suggestion).toMatchObject({ ledgerId: gas.id, source: 'rule', confidence: 100 })
    expect(row.suggestion!.ruleId).not.toBeNull()
  })

  it('refuses to choose when a narration points at two ledgers equally', () => {
    const db = seededDb()
    const bank = bankLedger(db)
    const a = expenseLedger(db, 'Acme Depot A')
    const b = expenseLedger(db, 'Acme Depot B')
    for (let i = 0; i < 4; i++) {
      learnFromMatch(db, 'ACME SUPPLIES', a.id, 'payment')
      learnFromMatch(db, 'ACME SUPPLIES', b.id, 'payment')
    }
    const row = suggestVouchers(db, bank.id, HDFC_CSV).find((r) => r.statementRow.description.includes('ACME'))!
    expect(row.suggestion!.ambiguous).toBe(true)
    // Halved, so it can never clear a bulk-accept threshold on its own.
    expect(row.suggestion!.confidence).toBe(50)
  })
})

describe('bulk accept (#134)', () => {
  /** Two learned payees, one well-observed and one seen once, on a two-row statement. */
  function scenario(): { db: Db; bank: { id: number }; gas: { id: number }; acme: { id: number } } {
    const db = seededDb()
    const bank = bankLedger(db)
    const gas = expenseLedger(db, 'Gas Charges')
    const acme = expenseLedger(db, 'Acme Supplies')
    for (let i = 0; i < 3; i++) learnFromMatch(db, `UPI-MAHANAGAR GAS-${i}`, gas.id, 'payment')
    learnFromMatch(db, 'NEFT DR-ACME SUPPLIES-X', acme.id, 'payment')
    return { db, bank, gas, acme }
  }

  it('previews the count and the total without writing anything', () => {
    const { db, bank, gas } = scenario()
    const preview = bulkAcceptSuggestions(db, bank.id, HDFC_CSV, 80)
    expect(preview.applied).toBe(false)
    expect(preview.count).toBe(1)
    expect(preview.accepted[0]).toMatchObject({ ledgerId: gas.id, confidence: 100, amount: 75000 })
    expect(preview.withdrawalTotal).toBe(75000)
    expect(preview.depositTotal).toBe(0)
    // The single-sighting row is deliberately left alone.
    expect(preview.skipped).toBe(1)
    const vouchers = db.prepare('SELECT COUNT(*) AS n FROM vouchers').get() as { n: number }
    expect(vouchers.n).toBe(0)
  })

  it('applies exactly what it previewed: vouchers filed and the bank line reconciled', () => {
    const { db, bank, gas } = scenario()
    const preview = bulkAcceptSuggestions(db, bank.id, HDFC_CSV, 80)
    const applied = bulkAcceptSuggestions(db, bank.id, HDFC_CSV, 80, { apply: true })

    expect(applied.count).toBe(preview.count)
    expect(applied.withdrawalTotal).toBe(preview.withdrawalTotal)
    expect(applied.applied).toBe(true)
    expect(applied.accepted[0]!.voucherId).toBeGreaterThan(0)

    const lines = db
      .prepare(
        `SELECT vl.ledger_id AS ledgerId, vl.dr_cr AS drCr, vl.amount, vl.bank_date AS bankDate
         FROM voucher_lines vl WHERE vl.voucher_id = ?`
      )
      .all(applied.accepted[0]!.voucherId) as { ledgerId: number; drCr: string; amount: number; bankDate: string | null }[]
    expect(lines).toHaveLength(2)
    expect(lines.find((l) => l.ledgerId === gas.id)).toMatchObject({ drCr: 'dr', amount: 75000 })
    // The bank side IS the statement row, so it is reconciled in the same breath.
    expect(lines.find((l) => l.ledgerId === bank.id)).toMatchObject({ drCr: 'cr', bankDate: '2026-08-11' })
  })

  it('touches nothing below the threshold, whatever the threshold is', () => {
    const { db, bank } = scenario()
    expect(bulkAcceptSuggestions(db, bank.id, HDFC_CSV, 100).count).toBe(1)
    // At 50 the single-sighting row (40) is still below the bar — one observation never counts.
    expect(bulkAcceptSuggestions(db, bank.id, HDFC_CSV, 50).count).toBe(1)
    const none = bulkAcceptSuggestions(db, bank.id, HDFC_CSV, 100, { apply: true })
    expect(none.count).toBe(1)
    const vouchers = db.prepare('SELECT COUNT(*) AS n FROM vouchers').get() as { n: number }
    expect(vouchers.n).toBe(1)
  })

  it('never accepts an ambiguous suggestion, however low the bar is set', () => {
    const db = seededDb()
    const bank = bankLedger(db)
    const a = expenseLedger(db, 'Acme Depot A')
    const b = expenseLedger(db, 'Acme Depot B')
    for (let i = 0; i < 6; i++) {
      learnFromMatch(db, 'ACME SUPPLIES', a.id, 'payment')
      learnFromMatch(db, 'ACME SUPPLIES', b.id, 'payment')
    }
    const csv = ['Date,Description,Debit,Credit', '10/08/2026,NEFT DR-ACME SUPPLIES-N001,1500.00,'].join('\n')
    const result = bulkAcceptSuggestions(db, bank.id, csv, 50, { apply: true })
    expect(result.count).toBe(0)
    expect(result.skipped).toBe(1)
    expect((db.prepare('SELECT COUNT(*) AS n FROM vouchers').get() as { n: number }).n).toBe(0)
  })

  it('accepting teaches the engine, so the same narration is stronger next month', () => {
    const { db, bank, gas } = scenario()
    const before = listNarrationMemory(db).find((m) => m.keyword === 'mahanagar')!.hits
    bulkAcceptSuggestions(db, bank.id, HDFC_CSV, 80, { apply: true })
    const after = listNarrationMemory(db).find((m) => m.keyword === 'mahanagar')!.hits
    expect(after).toBe(before + 1)
    expect(listNarrationMemory(db).every((m) => m.ledgerName.length > 0)).toBe(true)
    expect(gas.id).toBeGreaterThan(0)
  })

  it('rows that already match a book entry are never in scope — bulk accept cannot double-post', () => {
    const { db, bank, gas } = scenario()
    const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'payment'").get() as { id: number }
    db.prepare("INSERT INTO vouchers (voucher_type_id, date, number) VALUES (?, '2026-08-11', 'PMT/9')").run(vt.id)
    const v = db.prepare("SELECT id FROM vouchers WHERE number = 'PMT/9'").get() as { id: number }
    db.prepare("INSERT INTO voucher_lines (voucher_id, ledger_id, dr_cr, amount) VALUES (?, ?, 'dr', 75000)").run(v.id, gas.id)
    db.prepare("INSERT INTO voucher_lines (voucher_id, ledger_id, dr_cr, amount) VALUES (?, ?, 'cr', 75000)").run(v.id, bank.id)

    const result = bulkAcceptSuggestions(db, bank.id, HDFC_CSV, 80)
    expect(result.count).toBe(0)
  })
})
