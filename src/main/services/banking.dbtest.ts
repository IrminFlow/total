import { describe, it, expect } from 'vitest'
import { seededDb } from '../db/testdb'
import { createLedger } from './masters'
import { setAuditContext, listAudit } from './audit'
import { listRules, saveRule, deleteRule, recordRuleHit, suggestVouchers, importStatement } from './banking'

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
