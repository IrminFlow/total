import { describe, it, expect } from 'vitest'
import { seededDb } from '../db/testdb'
import { createLedger } from './masters'
import { setAuditContext, listAudit } from './audit'
import {
  listRules, saveRule, deleteRule, recordRuleHit, suggestVouchers, importStatement,
  matchSuggestions, brs, bankRecon, reconciliationStatus, setBankDate
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

describe('reconciliationStatus — where every account stands', () => {
  it('counts reconciled against total, per account', () => {
    const db = seededDb()
    const bank = bankLedger(db)
    const office = expenseLedger(db, 'Office Supplies')
    const cleared = bookBankEntry(db, bank.id, office.id, '2026-08-01', 100000, 'cr')
    bookBankEntry(db, bank.id, office.id, '2026-08-02', 200000, 'cr')
    setBankDate(db, cleared, '2026-08-03')

    const [status] = reconciliationStatus(db, '2026-08-31')
    expect(status!.name).toBe(bank.name)
    expect(status!.totalLines).toBe(2)
    expect(status!.reconciledLines).toBe(1)
    expect(status!.lastReconciledDate).toBe('2026-08-03')
  })

  it('treats an entry cleared after the date as still open on it', () => {
    // The same rule bankRecon uses. Getting this wrong would make a back-dated status disagree
    // with the BRS printed from the same date, which is the one comparison anyone makes.
    const db = seededDb()
    const bank = bankLedger(db)
    const office = expenseLedger(db, 'Office Supplies')
    const line = bookBankEntry(db, bank.id, office.id, '2026-08-01', 100000, 'cr')
    setBankDate(db, line, '2026-09-15')

    expect(reconciliationStatus(db, '2026-08-31')[0]!.reconciledLines).toBe(0)
    expect(reconciliationStatus(db, '2026-09-30')[0]!.reconciledLines).toBe(1)
  })

  it('derives the bank balance the same way the BRS does', () => {
    const db = seededDb()
    const bank = bankLedger(db)
    const office = expenseLedger(db, 'Office Supplies')
    bookBankEntry(db, bank.id, office.id, '2026-08-01', 100000, 'cr')

    const status = reconciliationStatus(db, '2026-08-31')[0]!
    const recon = bankRecon(db, bank.id, '2026-08-01', '2026-08-31')
    expect(status.bookBalance).toBe(recon.bookBalance)
    expect(status.bankBalance).toBe(recon.bankBalance)
  })

  it('ages open entries into buckets and names the oldest', () => {
    const db = seededDb()
    const bank = bankLedger(db)
    const office = expenseLedger(db, 'Office Supplies')
    bookBankEntry(db, bank.id, office.id, '2026-08-20', 1000, 'cr') // 11 days
    bookBankEntry(db, bank.id, office.id, '2026-06-20', 1000, 'cr') // 72 days
    bookBankEntry(db, bank.id, office.id, '2026-01-01', 1000, 'cr') // 242 days

    const status = reconciliationStatus(db, '2026-08-31')[0]!
    expect(status.ageing).toEqual([1, 0, 1, 1])
    expect(status.oldestUnreconciledDays).toBe(242)
  })

  it('reports a clean account as fully reconciled with nothing open', () => {
    const db = seededDb()
    const bank = bankLedger(db)
    const office = expenseLedger(db, 'Office Supplies')
    const line = bookBankEntry(db, bank.id, office.id, '2026-08-01', 100000, 'cr')
    setBankDate(db, line, '2026-08-02')

    const status = reconciliationStatus(db, '2026-08-31')[0]!
    expect(status.reconciledLines).toBe(status.totalLines)
    expect(status.oldestUnreconciledDays).toBe(0)
    expect(status.ageing).toEqual([0, 0, 0, 0])
    // With nothing outstanding the two balances agree, which is what "reconciled" means.
    expect(status.bankBalance).toBe(status.bookBalance)
  })

  it('reports an account that has never been reconciled honestly', () => {
    const db = seededDb()
    const bank = bankLedger(db)
    const office = expenseLedger(db, 'Office Supplies')
    bookBankEntry(db, bank.id, office.id, '2026-08-01', 100000, 'cr')

    const status = reconciliationStatus(db, '2026-08-31')[0]!
    expect(status.lastReconciledDate).toBeNull()
    expect(status.reconciledLines).toBe(0)
  })
})
