import { describe, it, expect } from 'vitest'
import { seededDb } from '../db/testdb'
import { createLedger } from './masters'
import { setAuditContext, listAudit } from './audit'
import {
  listRules, saveRule, deleteRule, recordRuleHit, suggestVouchers, importStatement,
  matchSuggestions, brs, bankRecon, reconciliationWorkspace, classifyStatementRow,
  rejectRuleSuggestion, rollbackRule, transferSuggestions, postTransfer,
  chargeExtractionSuggestions, postChargeExtraction, chequeLifecycle, updateChequeStatus,
  cashLedgers, cashCountPreview, saveCashCount, postCashCount
} from './banking'

function bankLedger(db: ReturnType<typeof seededDb>, name = 'HDFC Bank') {
  const group = db.prepare("SELECT id FROM groups WHERE name = 'Bank Accounts'").get() as { id: number }
  return createLedger(db, {
    name, groupId: group.id, openingBalance: 0, gstin: null, stateCode: null, address: null,
    taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
  })
}

function expenseLedger(db: ReturnType<typeof seededDb>, name: string) {
  const group = db.prepare("SELECT id FROM groups WHERE name = 'Direct Expenses'").get() as { id: number }
  return createLedger(db, {
    name, groupId: group.id, openingBalance: 0, gstin: null, stateCode: null, address: null,
    taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
  })
}

const CSV_HEADER = 'Date,Description,Debit,Credit'

describe('bank rules CRUD', () => {
  it('saveRule creates, updates, and audits both; listRules joins the ledger name', () => {
    setAuditContext({ appVersion: '1.0.0', getUserName: () => 'Tester' })
    const db = seededDb()
    const office = expenseLedger(db, 'Office Supplies')

    const created = saveRule(db, { pattern: 'Acme', ledgerId: office.id, kind: 'payment', active: true })
    expect(created.pattern).toBe('Acme')
    expect(created.ledgerName).toBe('Office Supplies')
    expect(created.hits).toBe(0)
    expect(listRules(db).map((r) => r.id)).toEqual([created.id])

    const updated = saveRule(db, { pattern: 'Acme Traders', ledgerId: office.id, kind: 'payment', active: false }, created.id)
    expect(updated.pattern).toBe('Acme Traders')
    expect(updated.active).toBe(false)
    expect(listRules(db)).toHaveLength(1)

    const rows = listAudit(db, { entity: 'bank_rule' })
    expect(rows.rows.map((r) => r.action)).toEqual(['update', 'create'])
    expect(rows.rows.every((r) => r.entityId === created.id)).toBe(true)
  })

  it('deleteRule removes the row and writes a delete audit entry', () => {
    setAuditContext({ appVersion: '1.0.0', getUserName: () => 'Tester' })
    const db = seededDb()
    const office = expenseLedger(db, 'Office Supplies')
    const rule = saveRule(db, { pattern: 'Acme', ledgerId: office.id, kind: 'payment', active: true })

    deleteRule(db, rule.id)
    expect(listRules(db)).toHaveLength(0)
    const rows = listAudit(db, { entity: 'bank_rule' })
    expect(rows.rows[0]!.action).toBe('delete')
  })

  it('recordRuleHit increments hits and throws for an unknown id', () => {
    const db = seededDb()
    const office = expenseLedger(db, 'Office Supplies')
    const rule = saveRule(db, { pattern: 'Acme', ledgerId: office.id, kind: 'payment', active: true })

    recordRuleHit(db, rule.id)
    recordRuleHit(db, rule.id)
    expect(listRules(db)[0]!.hits).toBe(2)

    expect(() => recordRuleHit(db, 999999)).toThrow('not found')
  })

  it('scores reviewed mappings and supports rejection plus one-click rollback', () => {
    const db = seededDb()
    const office = expenseLedger(db, 'Courier charges')
    const rule = saveRule(db, { pattern: 'BLUE DART', ledgerId: office.id, kind: 'payment', active: true, source: 'learned' })
    expect(rule).toMatchObject({ source: 'learned', confidenceBp: 6000, reviewedHits: 0, rejectedHits: 0 })

    recordRuleHit(db, rule.id)
    expect(listRules(db)[0]).toMatchObject({ confidenceBp: 6500, reviewedHits: 1 })
    rejectRuleSuggestion(db, rule.id)
    expect(listRules(db)[0]).toMatchObject({ confidenceBp: 5000, rejectedHits: 1 })
    const rolledBack = rollbackRule(db, rule.id)
    expect(rolledBack.active).toBe(false)
    expect(rolledBack.rolledBackAt).not.toBeNull()
  })
})

describe('durable reconciliation workspace', () => {
  it('retains statement evidence, separates all five states, and explains opening difference', () => {
    const db = seededDb()
    const bank = bankLedger(db)
    const office = expenseLedger(db, 'Banking workspace expense')
    db.prepare('UPDATE ledgers SET opening_balance = 100000 WHERE id = ?').run(bank.id)
    bookBankEntry(db, bank.id, office.id, '2026-07-31', 20000, 'dr', { kind: 'receipt', number: 'PRE/1' })
    bookBankEntry(db, bank.id, office.id, '2026-08-03', 50000, 'dr', { kind: 'receipt', number: 'REC/1' })
    bookBankEntry(db, bank.id, office.id, '2026-08-04', 70000, 'cr', { kind: 'payment', number: 'PAY/1' })

    const csv = [
      'Date,Description,Debit,Credit,Balance',
      '2026-08-03,Customer receipt,,500.00,1750.00',
      '2026-08-04,Unbooked bank fee,250.00,,1500.00'
    ].join('\n')
    const result = importStatement(db, bank.id, csv, { actor: 'Asha', fileName: 'aug.csv' })
    expect(result).toMatchObject({ openingBalance: 125000, closingBalance: 150000, matched: 1 })
    expect(result.importId).not.toBeNull()

    let workspace = reconciliationWorkspace(db, bank.id)
    expect(workspace.latestImport).toMatchObject({ fileName: 'aug.csv', importedBy: 'Asha' })
    expect(workspace).toMatchObject({ bookOpeningBalance: 120000, statementOpeningBalance: 125000, openingDifference: 5000 })
    expect(workspace.counts).toMatchObject({ matched: 1, bankOnly: 1, bookOnly: 1, ignored: 0, timingDifference: 0 })
    expect(workspace.bookOnlyRows[0]).toMatchObject({ number: 'PAY/1', amount: 70000 })

    const bankOnly = workspace.statementRows.find((row) => row.status === 'bank_only')!
    classifyStatementRow(db, bankOnly.id, 'timing_difference', 'Settles next period', 'Asha')
    workspace = reconciliationWorkspace(db, bank.id)
    expect(workspace.counts).toMatchObject({ bankOnly: 0, timingDifference: 1 })
    expect(workspace.statementRows.find((row) => row.id === bankOnly.id)).toMatchObject({ reviewedBy: 'Asha', note: 'Settles next period' })

    // The exact same bytes return the existing import instead of duplicating evidence.
    expect(importStatement(db, bank.id, csv).importId).toBe(result.importId)
    expect(db.prepare('SELECT COUNT(*) AS n FROM bank_statement_imports').get()).toEqual({ n: 1 })
  })
})

describe('inter-bank transfer matching', () => {
  it('pairs opposite statement sides and posts one linked Contra voucher after review', () => {
    const db = seededDb()
    const hdfc = bankLedger(db, 'HDFC Transfer')
    const icici = bankLedger(db, 'ICICI Transfer')
    importStatement(db, hdfc.id, [CSV_HEADER, '2026-08-10,SELF TRANSFER,2500.00,'].join('\n'), { actor: 'Asha' })
    importStatement(db, icici.id, [CSV_HEADER, '2026-08-11,SELF TRANSFER,,2500.00'].join('\n'), { actor: 'Asha' })

    const suggestions = transferSuggestions(db)
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0]).toMatchObject({ fromLedgerId: hdfc.id, toLedgerId: icici.id, amount: 250000 })
    const posted = postTransfer(db, suggestions[0]!.withdrawalRowId, suggestions[0]!.depositRowId, 'Asha')
    const voucher = db.prepare(`SELECT vt.kind FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id WHERE v.id = ?`).get(posted.voucherId)
    expect(voucher).toEqual({ kind: 'contra' })
    expect(db.prepare('SELECT status, matched_line_id AS matchedLineId FROM bank_statement_rows ORDER BY id').all())
      .toEqual([{ status: 'matched', matchedLineId: expect.any(Number) }, { status: 'matched', matchedLineId: expect.any(Number) }])
    expect(transferSuggestions(db)).toHaveLength(0)
    expect(() => postTransfer(db, suggestions[0]!.withdrawalRowId, suggestions[0]!.depositRowId, 'Asha')).toThrow(/bank-only/)
  })
})

describe('bank-charge extraction', () => {
  it('explains a net settlement with a linked fee/tax payment voucher', () => {
    const db = seededDb()
    const bank = bankLedger(db, 'Gateway Bank')
    const clearing = expenseLedger(db, 'Gateway clearing')
    const fee = expenseLedger(db, 'Gateway fees')
    const tax = expenseLedger(db, 'Input GST on fees')
    const settlementLineId = bookBankEntry(db, bank.id, clearing.id, '2026-08-10', 118000, 'dr', { kind: 'receipt', number: 'SET/1' })
    const imported = importStatement(db, bank.id, [CSV_HEADER, '2026-08-10,GATEWAY NET SETTLEMENT,,1000.00'].join('\n'), { actor: 'Asha' })
    expect(imported.unmatched).toHaveLength(1)
    const suggestions = chargeExtractionSuggestions(db)
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0]).toMatchObject({ settlementLineId, grossBookAmount: 118000, netAmount: 100000, deductionAmount: 18000 })

    const posted = postChargeExtraction(db, {
      statementRowId: suggestions[0]!.statementRowId, settlementLineId,
      feeLedgerId: fee.id, taxLedgerId: tax.id, feeAmount: 15000, taxAmount: 3000
    }, 'Asha')
    const lines = db.prepare('SELECT ledger_id AS ledgerId, dr_cr AS drCr, amount, bank_date AS bankDate FROM voucher_lines WHERE voucher_id = ? ORDER BY id').all(posted.voucherId)
    expect(lines).toEqual([
      { ledgerId: fee.id, drCr: 'dr', amount: 15000, bankDate: null },
      { ledgerId: tax.id, drCr: 'dr', amount: 3000, bankDate: null },
      { ledgerId: bank.id, drCr: 'cr', amount: 18000, bankDate: '2026-08-10' }
    ])
    expect(db.prepare('SELECT status, matched_line_id AS matchedLineId, created_voucher_id AS createdVoucherId FROM bank_statement_rows').get())
      .toEqual({ status: 'matched', matchedLineId: settlementLineId, createdVoucherId: posted.voucherId })
    const workspace = reconciliationWorkspace(db, bank.id)
    expect(workspace.counts).toMatchObject({ matched: 1, bankOnly: 0, bookOnly: 0 })
    expect(workspace.bookOnlyRows).toEqual([])
    const reconciliation = bankRecon(db, bank.id, '2026-08-01', '2026-08-31')
    expect(reconciliation).toMatchObject({
      bookBalance: 100000,
      bankBalance: 100000,
      unreconciledDeposits: 0,
      unreconciledWithdrawals: 0
    })
    expect(chargeExtractionSuggestions(db)).toHaveLength(0)
  })
})

describe('cheque lifecycle', () => {
  it('derives issued/stale states and synchronizes cleared/bounced with the bank date', () => {
    const db = seededDb()
    const bank = bankLedger(db, 'Cheque Bank')
    const office = expenseLedger(db, 'Cheque supplier')
    const bankLineId = bookBankEntry(db, bank.id, office.id, '2026-01-01', 50000, 'cr', { kind: 'payment', number: 'CHQ/1' })
    const voucherId = (db.prepare("SELECT id FROM vouchers WHERE number = 'CHQ/1'").get() as { id: number }).id
    db.prepare("UPDATE vouchers SET instrument_no = '001122', instrument_date = '2026-01-02' WHERE id = ?").run(voucherId)
    expect(chequeLifecycle(db, '2026-02-01')[0]).toMatchObject({ status: 'issued', instrumentNo: '001122' })
    expect(chequeLifecycle(db, '2026-05-01')[0]).toMatchObject({ status: 'stale' })

    updateChequeStatus(db, voucherId, 'cleared', '2026-02-03', 'Presented', 'Asha')
    expect(chequeLifecycle(db, '2026-05-01')[0]).toMatchObject({ status: 'cleared', statusDate: '2026-02-03', updatedBy: 'Asha' })
    expect(db.prepare('SELECT bank_date AS bankDate FROM voucher_lines WHERE id = ?').get(bankLineId)).toEqual({ bankDate: '2026-02-03' })
    updateChequeStatus(db, voucherId, 'bounced', '2026-02-05', 'Funds insufficient', 'Asha')
    expect(chequeLifecycle(db, '2026-05-01')[0]).toMatchObject({ status: 'bounced' })
    expect(db.prepare('SELECT bank_date AS bankDate FROM voucher_lines WHERE id = ?').get(bankLineId)).toEqual({ bankDate: null })
  })
})

describe('cash denomination counts', () => {
  it('captures the physical count and posts only an owner-approved difference journal', () => {
    const db = seededDb()
    const cash = cashLedgers(db)[0]!
    const adjustment = expenseLedger(db, 'Cash Short and Over')
    db.prepare('UPDATE ledgers SET opening_balance = 100000 WHERE id = ?').run(cash.id)
    const lines = [{ denominationPaise: 50000, count: 3 }, { denominationPaise: 10000, count: 0 }]
    expect(cashCountPreview(db, cash.id, '2026-08-10', lines)).toMatchObject({ physicalTotal: 150000, bookBalance: 100000, difference: 50000 })
    const saved = saveCashCount(db, cash.id, '2026-08-10', lines, 'Front counter', 'Asha')
    expect(saved).toMatchObject({ status: 'draft', countedBy: 'Asha', difference: 50000 })
    const posted = postCashCount(db, saved.id, adjustment.id, 'Owner')
    expect(posted).toMatchObject({ status: 'posted', postedBy: 'Owner', adjustmentVoucherId: expect.any(Number) })
    const voucherLines = db.prepare('SELECT ledger_id AS ledgerId, dr_cr AS drCr, amount FROM voucher_lines WHERE voucher_id = ? ORDER BY id').all(posted.adjustmentVoucherId)
    expect(voucherLines).toEqual([
      { ledgerId: cash.id, drCr: 'dr', amount: 50000 },
      { ledgerId: adjustment.id, drCr: 'cr', amount: 50000 }
    ])
    expect(() => postCashCount(db, saved.id, adjustment.id, 'Owner')).toThrow(/draft/)
  })
})

describe('suggestVouchers', () => {
  it('suggests a balanced voucher draft for a rule-matched unmatched row, and null for a non-matching one', () => {
    const db = seededDb()
    const bank = bankLedger(db)
    const office = expenseLedger(db, 'Office Supplies')
    saveRule(db, { pattern: 'ACME SUPPLIES', ledgerId: office.id, kind: 'payment', active: true })

    const csv = [
      CSV_HEADER,
      '2026-08-10,NEFT-000123 ACME SUPPLIES 10/08,1500.00,',
      '2026-08-11,UNKNOWN VENDOR PAYMENT,750.00,'
    ].join('\n')

    const rows = suggestVouchers(db, bank.id, csv)
    expect(rows).toHaveLength(2)

    const matched = rows.find((r) => r.statementRow.description.includes('ACME'))!
    expect(matched.suggestion).not.toBeNull()
    expect(matched.suggestion!.ledgerId).toBe(office.id)
    expect(matched.suggestion!.ledgerName).toBe('Office Supplies')
    expect(matched.suggestion!.kind).toBe('payment')
    const draft = matched.suggestion!.voucherDraft
    expect(draft.date).toBe('2026-08-10')
    expect(draft.narration).toBe('NEFT-000123 ACME SUPPLIES 10/08')
    expect(draft.lines).toEqual([
      { ledgerId: office.id, drCr: 'dr', amount: 150000 },
      { ledgerId: bank.id, drCr: 'cr', amount: 150000 }
    ])
    // Balanced: one dr, one cr, equal amounts.
    const total = draft.lines.reduce((s, l) => s + (l.drCr === 'dr' ? l.amount : -l.amount), 0)
    expect(total).toBe(0)

    const unmatched = rows.find((r) => r.statementRow.description.includes('UNKNOWN'))!
    expect(unmatched.suggestion).toBeNull()
  })

  it('builds a receipt-direction draft (dr bank / cr rule ledger) for a deposit row', () => {
    const db = seededDb()
    const bank = bankLedger(db)
    const sales = db.prepare("SELECT id FROM ledgers WHERE name = 'Sales Account'").get() as { id: number } | undefined
    const salesLedger = sales
      ? { id: sales.id }
      : createLedger(db, {
          name: 'Sales Account',
          groupId: (db.prepare("SELECT id FROM groups WHERE name = 'Sales Accounts'").get() as { id: number }).id,
          openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null,
          tdsSectionId: null, pan: null, creditDays: null, exportType: null
        })
    saveRule(db, { pattern: 'ACME CUSTOMER', ledgerId: salesLedger.id, kind: 'receipt', active: true })

    const csv = [CSV_HEADER, '2026-08-12,IMPS ACME CUSTOMER REFUND 12/08,,2500.00'].join('\n')
    const rows = suggestVouchers(db, bank.id, csv)
    expect(rows).toHaveLength(1)
    const draft = rows[0]!.suggestion!.voucherDraft
    expect(draft.lines).toEqual([
      { ledgerId: salesLedger.id, drCr: 'cr', amount: 250000 },
      { ledgerId: bank.id, drCr: 'dr', amount: 250000 }
    ])
  })

  it('excludes rows that already match an open book entry (only genuinely unmatched rows get suggestions)', () => {
    const db = seededDb()
    const bank = bankLedger(db)
    const office = expenseLedger(db, 'Office Supplies')
    saveRule(db, { pattern: 'ACME', ledgerId: office.id, kind: 'payment', active: true })

    // A book entry that the first statement row below matches by amount+direction+date — it
    // should reconcile via the ordinary matcher and never reach the rule-suggestion step.
    const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'payment'").get() as { id: number }
    db.prepare(`INSERT INTO vouchers (voucher_type_id, date, number) VALUES (?, '2026-08-10', 'PMT/1')`).run(vt.id)
    const voucherId = db.prepare("SELECT id FROM vouchers WHERE number = 'PMT/1'").get() as { id: number }
    db.prepare(`INSERT INTO voucher_lines (voucher_id, ledger_id, dr_cr, amount) VALUES (?, ?, 'dr', 150000)`).run(voucherId.id, office.id)
    db.prepare(`INSERT INTO voucher_lines (voucher_id, ledger_id, dr_cr, amount) VALUES (?, ?, 'cr', 150000)`).run(voucherId.id, bank.id)

    const csv = [
      CSV_HEADER,
      '2026-08-10,ACME SUPPLIES BOOKED,1500.00,',
      '2026-08-11,ACME SUPPLIES NOT IN BOOKS,900.00,'
    ].join('\n')

    // Sanity check: importStatement (the same matcher suggestVouchers reuses) does reconcile
    // the first row against the open book entry, and leaves only the second as unmatched.
    const imported = importStatement(db, bank.id, csv)
    expect(imported.matched).toBe(1)
    expect(imported.unmatched).toHaveLength(1)
    expect(imported.unmatched[0]!.description).toBe('ACME SUPPLIES NOT IN BOOKS')

    // suggestVouchers runs its own read-only matching pass (not dependent on importStatement
    // having already run) and must reach the same conclusion: only the second row shows up.
    const bank2 = bankLedger(db, 'ICICI Bank')
    const vt2 = db.prepare("SELECT id FROM voucher_types WHERE kind = 'payment'").get() as { id: number }
    db.prepare(`INSERT INTO vouchers (voucher_type_id, date, number) VALUES (?, '2026-08-10', 'PMT/2')`).run(vt2.id)
    const voucherId2 = db.prepare("SELECT id FROM vouchers WHERE number = 'PMT/2'").get() as { id: number }
    db.prepare(`INSERT INTO voucher_lines (voucher_id, ledger_id, dr_cr, amount) VALUES (?, ?, 'dr', 150000)`).run(voucherId2.id, office.id)
    db.prepare(`INSERT INTO voucher_lines (voucher_id, ledger_id, dr_cr, amount) VALUES (?, ?, 'cr', 150000)`).run(voucherId2.id, bank2.id)

    const rows = suggestVouchers(db, bank2.id, csv)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.statementRow.description).toBe('ACME SUPPLIES NOT IN BOOKS')
    expect(rows[0]!.suggestion).not.toBeNull()
  })

  it('an inactive rule never produces a suggestion', () => {
    const db = seededDb()
    const bank = bankLedger(db)
    const office = expenseLedger(db, 'Office Supplies')
    const rule = saveRule(db, { pattern: 'ACME', ledgerId: office.id, kind: 'payment', active: true })
    saveRule(db, { pattern: 'ACME', ledgerId: office.id, kind: 'payment', active: false }, rule.id)

    const csv = [CSV_HEADER, '2026-08-10,ACME SUPPLIES,1500.00,'].join('\n')
    const rows = suggestVouchers(db, bank.id, csv)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.suggestion).toBeNull()
  })
})

// ---------- task Y2: rules v2, truthful import, matching v2, BRS ----------

/** Books a simple two-line voucher against the bank ledger and returns the bank line id. */
function bookBankEntry(
  db: ReturnType<typeof seededDb>,
  bankId: number,
  counterId: number,
  date: string,
  amount: number,
  bankSide: 'dr' | 'cr',
  opts: { number?: string; partyLedgerId?: number; kind?: string; postDated?: boolean; isOptional?: boolean } = {}
): number {
  const vt = db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(opts.kind ?? 'payment') as { id: number }
  const number = opts.number ?? `T/${Math.random().toString(36).slice(2, 8)}`
  db.prepare('INSERT INTO vouchers (voucher_type_id, date, number, party_ledger_id, post_dated, is_optional) VALUES (?, ?, ?, ?, ?, ?)')
    .run(vt.id, date, number, opts.partyLedgerId ?? null, opts.postDated ? 1 : 0, opts.isOptional ? 1 : 0)
  const vid = (db.prepare('SELECT id FROM vouchers WHERE number = ?').get(number) as { id: number }).id
  db.prepare("INSERT INTO voucher_lines (voucher_id, ledger_id, dr_cr, amount) VALUES (?, ?, ?, ?)")
    .run(vid, counterId, bankSide === 'cr' ? 'dr' : 'cr', amount)
  const res = db.prepare("INSERT INTO voucher_lines (voucher_id, ledger_id, dr_cr, amount) VALUES (?, ?, ?, ?)")
    .run(vid, bankId, bankSide, amount)
  return Number(res.lastInsertRowid)
}

describe('bank rules v2 fields', () => {
  it('persists matchField/minAmount/maxAmount/autoApply and defaults them for legacy payloads', () => {
    const db = seededDb()
    const office = expenseLedger(db, 'Office Supplies')

    const legacy = saveRule(db, { pattern: 'ACME', ledgerId: office.id, kind: 'payment', active: true })
    expect(legacy).toMatchObject({ matchField: 'description', minAmount: null, maxAmount: null, autoApply: false })

    const full = saveRule(db, {
      pattern: 'UTR99', ledgerId: office.id, kind: 'payment', active: true,
      matchField: 'reference', minAmount: 100000, maxAmount: 500000, autoApply: true
    })
    expect(full).toMatchObject({ matchField: 'reference', minAmount: 100000, maxAmount: 500000, autoApply: true })
    expect(listRules(db).find((r) => r.id === full.id)).toMatchObject({ matchField: 'reference', autoApply: true })

    expect(() =>
      saveRule(db, { pattern: 'BAD', ledgerId: office.id, kind: 'payment', active: true, minAmount: 500, maxAmount: 100 })
    ).toThrow(/Minimum/)
  })
})

describe('importStatement v2', () => {
  it('rolls back accounting, evidence, rule hits, and audit together, then retries once', () => {
    const db = seededDb()
    const bank = bankLedger(db)
    const office = expenseLedger(db, 'Atomic bank import expense')
    const matchedLineId = bookBankEntry(db, bank.id, office.id, '2026-08-10', 150000, 'cr')
    const rule = saveRule(db, {
      pattern: 'ATOMIC SUBSCRIPTION', ledgerId: office.id, kind: 'payment', active: true, autoApply: true
    })
    const csv = [
      CSV_HEADER,
      '2026-08-10,BOOKED PAYMENT,1500.00,',
      '2026-08-11,ATOMIC SUBSCRIPTION,999.00,'
    ].join('\n')
    const vouchersBefore = (db.prepare('SELECT COUNT(*) AS n FROM vouchers').get() as { n: number }).n
    const auditBefore = (db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n

    db.exec(`CREATE TRIGGER fail_statement_evidence
      BEFORE INSERT ON bank_statement_rows
      BEGIN SELECT RAISE(ABORT, 'injected statement evidence failure'); END`)
    expect(() => importStatement(db, bank.id, csv)).toThrow(/injected statement evidence failure/)

    expect(db.prepare('SELECT bank_date AS bankDate FROM voucher_lines WHERE id=?').get(matchedLineId))
      .toEqual({ bankDate: null })
    expect(db.prepare('SELECT COUNT(*) AS n FROM vouchers').get()).toEqual({ n: vouchersBefore })
    expect(db.prepare('SELECT COUNT(*) AS n FROM bank_statement_imports').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM bank_statement_rows').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT hits FROM bank_rules WHERE id=?').get(rule.id)).toEqual({ hits: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM audit_log').get()).toEqual({ n: auditBefore })

    db.exec('DROP TRIGGER fail_statement_evidence')
    const applied = importStatement(db, bank.id, csv)
    expect(applied).toMatchObject({ matched: 1, autoCreated: [expect.objectContaining({ ruleId: rule.id })] })
    expect(db.prepare('SELECT COUNT(*) AS n FROM bank_statement_imports').get()).toEqual({ n: 1 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM bank_statement_rows').get()).toEqual({ n: 2 })
    expect(db.prepare('SELECT hits FROM bank_rules WHERE id=?').get(rule.id)).toEqual({ hits: 1 })

    const voucherCountAfterApply = db.prepare('SELECT COUNT(*) AS n FROM vouchers').get()
    const retry = importStatement(db, bank.id, csv)
    expect(retry.importId).toBe(applied.importId)
    expect(retry.autoCreated).toHaveLength(0)
    expect(db.prepare('SELECT COUNT(*) AS n FROM vouchers').get()).toEqual(voucherCountAfterApply)
    expect(db.prepare('SELECT COUNT(*) AS n FROM bank_statement_rows').get()).toEqual({ n: 2 })
    expect(db.prepare('SELECT hits FROM bank_rules WHERE id=?').get(rule.id)).toEqual({ hits: 1 })
  })

  it('refuses to reclassify a matched row without breaking its reconciliation link', () => {
    const db = seededDb()
    const bank = bankLedger(db)
    const office = expenseLedger(db, 'Matched row guard expense')
    const matchedLineId = bookBankEntry(db, bank.id, office.id, '2026-08-10', 150000, 'cr')
    importStatement(db, bank.id, [CSV_HEADER, '2026-08-10,BOOKED PAYMENT,1500.00,'].join('\n'))
    const row = db.prepare(
      'SELECT id,status,matched_line_id AS matchedLineId FROM bank_statement_rows'
    ).get() as { id: number; status: string; matchedLineId: number | null }
    expect(row).toMatchObject({ status: 'matched', matchedLineId })
    const auditBefore = (db.prepare(
      "SELECT COUNT(*) AS n FROM audit_log WHERE entity='bank_statement_row'"
    ).get() as { n: number }).n

    expect(() => classifyStatementRow(db, row.id, 'ignored', 'Not actually matched', 'Reviewer'))
      .toThrow(/Matched statement rows cannot be reclassified/)

    expect(db.prepare(
      'SELECT status,matched_line_id AS matchedLineId,note,reviewed_by AS reviewedBy FROM bank_statement_rows WHERE id=?'
    ).get(row.id)).toEqual({ status: 'matched', matchedLineId, note: null, reviewedBy: null })
    expect(db.prepare('SELECT bank_date AS bankDate FROM voucher_lines WHERE id=?').get(matchedLineId))
      .toEqual({ bankDate: '2026-08-10' })
    expect(db.prepare(
      "SELECT COUNT(*) AS n FROM audit_log WHERE entity='bank_statement_row'"
    ).get()).toEqual({ n: auditBefore })
  })

  it('reports alreadyReconciled truthfully for re-imported rows', () => {
    const db = seededDb()
    const bank = bankLedger(db)
    const office = expenseLedger(db, 'Office Supplies')
    bookBankEntry(db, bank.id, office.id, '2026-08-10', 150000, 'cr')

    const csv = [CSV_HEADER, '2026-08-10,ACME PAYMENT,1500.00,'].join('\n')
    const first = importStatement(db, bank.id, csv)
    expect(first.matched).toBe(1)
    expect(first.alreadyReconciled).toBe(0)

    // Same statement again: the entry now carries a bank_date, so it must be reported as
    // already reconciled — not silently dropped into unmatched.
    const second = importStatement(db, bank.id, csv)
    expect(second.matched).toBe(0)
    expect(second.alreadyReconciled).toBe(1)
    expect(second.unmatched).toHaveLength(0)
  })

  it('dryRun previews matches without writing bank_date', () => {
    const db = seededDb()
    const bank = bankLedger(db)
    const office = expenseLedger(db, 'Office Supplies')
    const lineId = bookBankEntry(db, bank.id, office.id, '2026-08-10', 150000, 'cr')

    const csv = [CSV_HEADER, '2026-08-10,ACME PAYMENT,1500.00,'].join('\n')
    const preview = importStatement(db, bank.id, csv, { apply: false })
    expect(preview.matched).toBe(1)
    expect(preview.matches).toEqual([
      { date: '2026-08-10', description: 'ACME PAYMENT', amount: 150000, kind: 'withdrawal', lineId }
    ])
    const row = db.prepare('SELECT bank_date AS bd FROM voucher_lines WHERE id = ?').get(lineId) as { bd: string | null }
    expect(row.bd).toBeNull()

    // applying afterwards writes it
    importStatement(db, bank.id, csv)
    const after = db.prepare('SELECT bank_date AS bd FROM voucher_lines WHERE id = ?').get(lineId) as { bd: string | null }
    expect(after.bd).toBe('2026-08-10')
  })

  it('auto_apply rules create the voucher on an applying import (audited, reconciled, hit-counted) — and never on dryRun', () => {
    setAuditContext({ appVersion: '1.0.0', getUserName: () => 'Tester' })
    const db = seededDb()
    const bank = bankLedger(db)
    const office = expenseLedger(db, 'Office Supplies')
    const rule = saveRule(db, { pattern: 'ACME SUBSCRIPTION', ledgerId: office.id, kind: 'payment', active: true, autoApply: true })

    const csv = [CSV_HEADER, '2026-08-12,ACME SUBSCRIPTION AUG,999.00,'].join('\n')

    const preview = importStatement(db, bank.id, csv, { apply: false })
    expect(preview.autoCreated).toHaveLength(0)
    expect((db.prepare('SELECT COUNT(*) AS n FROM vouchers').get() as { n: number }).n).toBe(0)

    const applied = importStatement(db, bank.id, csv)
    expect(applied.autoCreated).toHaveLength(1)
    expect(applied.unmatched).toHaveLength(0)
    const created = applied.autoCreated[0]!
    expect(created.ruleId).toBe(rule.id)

    const lines = db
      .prepare('SELECT ledger_id AS ledgerId, dr_cr AS drCr, amount, bank_date AS bankDate FROM voucher_lines WHERE voucher_id = ?')
      .all(created.voucherId) as { ledgerId: number; drCr: string; amount: number; bankDate: string | null }[]
    expect(lines).toHaveLength(2)
    const bankLine = lines.find((l) => l.ledgerId === bank.id)!
    expect(bankLine).toMatchObject({ drCr: 'cr', amount: 99900, bankDate: '2026-08-12' })
    expect(lines.find((l) => l.ledgerId === office.id)).toMatchObject({ drCr: 'dr', amount: 99900 })

    expect(listRules(db).find((r) => r.id === rule.id)!.hits).toBe(1)
    // audited via the ordinary voucher audit trail
    const audit = listAudit(db, { entity: 'voucher' })
    expect(audit.rows.some((r) => r.entityId === created.voucherId && r.action === 'create')).toBe(true)

    // a rule without auto_apply must NOT create anything
    const db2 = seededDb()
    const bank2 = bankLedger(db2)
    const office2 = expenseLedger(db2, 'Office Supplies')
    saveRule(db2, { pattern: 'ACME SUBSCRIPTION', ledgerId: office2.id, kind: 'payment', active: true })
    const applied2 = importStatement(db2, bank2.id, csv)
    expect(applied2.autoCreated).toHaveLength(0)
    expect(applied2.unmatched).toHaveLength(1)
  })
})

describe('matchSuggestions (tolerance + many-to-one, read-only)', () => {
  it('suggests a near-miss single within ±₹1 without touching bank_date', () => {
    const db = seededDb()
    const bank = bankLedger(db)
    const office = expenseLedger(db, 'Office Supplies')
    const lineId = bookBankEntry(db, bank.id, office.id, '2026-08-10', 150075, 'cr') // ₹1,500.75 in books

    const csv = [CSV_HEADER, '2026-08-10,ACME PAYMENT,1500.00,'].join('\n') // bank says ₹1,500.00
    const suggestions = matchSuggestions(db, bank.id, csv)
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0]!.kind).toBe('tolerance')
    expect(suggestions[0]!.lines.map((l) => l.lineId)).toEqual([lineId])

    const row = db.prepare('SELECT bank_date AS bd FROM voucher_lines WHERE id = ?').get(lineId) as { bd: string | null }
    expect(row.bd).toBeNull()
  })

  it('suggests ≤3 same-party open entries summing to one statement row', () => {
    const db = seededDb()
    const bank = bankLedger(db)
    const debtors = db.prepare("SELECT id FROM groups WHERE name = 'Sundry Debtors'").get() as { id: number }
    const party = createLedger(db, {
      name: 'Acme & Sons', groupId: debtors.id, openingBalance: 0, gstin: null, stateCode: null, address: null,
      taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
    })
    const otherParty = createLedger(db, {
      name: 'Other Traders', groupId: debtors.id, openingBalance: 0, gstin: null, stateCode: null, address: null,
      taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
    })
    // Three receipts from the same party: 1000 + 2500 + 1500 = 5000
    const l1 = bookBankEntry(db, bank.id, party.id, '2026-08-01', 100000, 'dr', { kind: 'receipt', partyLedgerId: party.id })
    const l2 = bookBankEntry(db, bank.id, party.id, '2026-08-03', 250000, 'dr', { kind: 'receipt', partyLedgerId: party.id })
    const l3 = bookBankEntry(db, bank.id, party.id, '2026-08-05', 150000, 'dr', { kind: 'receipt', partyLedgerId: party.id })
    // Decoy from another party that would also fit if parties were ignored
    bookBankEntry(db, bank.id, otherParty.id, '2026-08-04', 500000, 'dr', { kind: 'receipt', partyLedgerId: otherParty.id })

    // The single 5,000 exact decoy is consumed by pass 1? No — pass 1 requires exact amount AND
    // it does: 5,000 exact single WOULD match pass 1. So the statement row here is 5,000 and the
    // decoy line is deliberately dated far outside the ±5-day window to stay out of pass 1.
    db.prepare("UPDATE vouchers SET date = '2026-01-01' WHERE id = (SELECT voucher_id FROM voucher_lines WHERE ledger_id = ? AND amount = 500000)")
      .run(bank.id)

    const csv = [CSV_HEADER, '2026-08-06,NEFT ACME SETTLEMENT,,5000.00'].join('\n')
    const suggestions = matchSuggestions(db, bank.id, csv)
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0]!.kind).toBe('many_to_one')
    expect(suggestions[0]!.lines.map((l) => l.lineId).sort()).toEqual([l1, l2, l3].sort())
  })
})

describe('BRS', () => {
  it('splits open entries into uncredited/unpresented and derives the bank balance', () => {
    const db = seededDb()
    const bank = bankLedger(db)
    const office = expenseLedger(db, 'Office Supplies')
    // Deposit ₹10,000 (cleared), withdrawal ₹3,000 (open), deposit ₹2,000 (open)
    const cleared = bookBankEntry(db, bank.id, office.id, '2026-08-01', 1000000, 'dr')
    db.prepare("UPDATE voucher_lines SET bank_date = '2026-08-02' WHERE id = ?").run(cleared)
    bookBankEntry(db, bank.id, office.id, '2026-08-10', 300000, 'cr')
    bookBankEntry(db, bank.id, office.id, '2026-08-12', 200000, 'dr')

    const r = brs(db, bank.id, '2026-08-31')
    expect(r.bookBalance).toBe(1000000 - 300000 + 200000)
    expect(r.uncredited.map((i) => i.amount)).toEqual([200000])
    expect(r.unpresented.map((i) => i.amount)).toEqual([300000])
    expect(r.bankBalance).toBe(r.bookBalance - 200000 + 300000)
  })

  it('counts an entry cleared AFTER the as-on date as still outstanding on that date', () => {
    const db = seededDb()
    const bank = bankLedger(db)
    const office = expenseLedger(db, 'Office Supplies')
    const lineId = bookBankEntry(db, bank.id, office.id, '2026-08-10', 300000, 'cr')
    db.prepare("UPDATE voucher_lines SET bank_date = '2026-09-05' WHERE id = ?").run(lineId)

    const asOnAug = brs(db, bank.id, '2026-08-31')
    expect(asOnAug.unpresented.map((i) => i.lineId)).toEqual([lineId]) // cleared later → outstanding in Aug
    const asOnSep = brs(db, bank.id, '2026-09-30')
    expect(asOnSep.unpresented).toHaveLength(0) // cleared by end-Sep
  })

  it('excludes optional (memorandum) and unmatured post-dated vouchers from the BRS and recon pools (IN_BOOKS)', () => {
    const db = seededDb()
    const bank = bankLedger(db)
    const office = expenseLedger(db, 'Office Supplies')
    // One real open withdrawal of ₹3,000.
    const realLine = bookBankEntry(db, bank.id, office.id, '2026-08-05', 300000, 'cr')
    // Optional (memorandum) withdrawal of ₹500 and an unmatured PDC of ₹700 — both out of the
    // books, so the ledger statement/balance sheet exclude them and the BRS must too.
    bookBankEntry(db, bank.id, office.id, '2026-08-10', 50000, 'cr', { isOptional: true })
    bookBankEntry(db, bank.id, office.id, '2026-08-20', 70000, 'cr', { postDated: true })

    const r = brs(db, bank.id, '2026-08-31')
    expect(r.bookBalance).toBe(-300000) // only the real withdrawal
    expect(r.unpresented.map((i) => i.lineId)).toEqual([realLine])
    expect(r.uncredited).toHaveLength(0)
    expect(r.bankBalance).toBe(r.bookBalance + 300000)

    // The reconcile view shares the scope: out-of-books entries never appear, so a bank date
    // can't be assigned to them.
    const recon = bankRecon(db, bank.id, '2026-08-01', '2026-08-31')
    expect(recon.rows.map((row) => row.lineId)).toEqual([realLine])
    expect(recon.bookBalance).toBe(-300000)

    // And statement matching can't silently reconcile an out-of-books entry: the ₹500 optional
    // withdrawal finds no open book entry.
    const csv = [CSV_HEADER, '2026-08-10,MEMO ENTRY,500.00,'].join('\n')
    const result = importStatement(db, bank.id, csv)
    expect(result.matched).toBe(0)
  })
})
