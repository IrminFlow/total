// WP 4.1 — banking depth: migration 032, statement import + dedupe, matching workspace,
// learn → suggest, bulk confirm, bulk create, undo import, cheque books + register, PDC
// register + mature + bounce, bulk payment export, dashboard PDC reminder. Every write audited.
import { beforeEach, describe, expect, it } from 'vitest'
import { seededDb } from '../db/testdb'
import { createLedger } from './masters'
import { saveVoucher, getVoucher, maturePdcNow, maturePostDated } from './vouchers'
import { listAudit, setAuditContext } from './audit'
import { bankRecon, saveRule } from './banking'
import {
  commitStatement, confirmMatches, createVouchersFromLines, deleteLearnedRule, getImportProfile, listLearnedRules, previewStatement, setLineIgnored,
  statementWorkspace, undoLastImport, unmatchLine, updateLearnedRule
} from './bankImport'
import { chequeRegister, deleteChequeBook, issueCheque, nextChequeNumber, saveChequeBook, setChequeStatus } from './cheques'
import { bouncePdc, pdcRegisterFull, pdcsMaturing } from './pdc'
import { exportPaymentBatch, listBeneficiaries, listPaymentTemplates, paymentCandidates, savePaymentTemplate, setBankDetails } from './bulkPayments'
import { dashboardSeries } from './dashboard'
import { buildChequeHtml, buildGridHtml } from './cheque'
import { getChequeConfig, setChequeConfig } from './config'
import { chequeFields } from '@shared/cheque'
import { BUILTIN_PAYMENT_TEMPLATES } from '@shared/bulkPayments'
import type { DB } from '../db/connection'

type Db = ReturnType<typeof seededDb>

function ledger(db: Db, name: string, groupName: string): number {
  const group = db.prepare('SELECT id FROM groups WHERE name = ?').get(groupName) as { id: number }
  return createLedger(db, {
    name, groupId: group.id, openingBalance: 0, gstin: null, stateCode: null, address: null,
    taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
  }).id
}

function vtId(db: Db, kind: string): number {
  return (db.prepare('SELECT id FROM voucher_types WHERE kind = ? AND is_system = 1').get(kind) as { id: number }).id
}

function pay(db: Db, o: { bank: number; to: number; amount: number; date: string; party?: number | null; instrumentNo?: string; postDated?: boolean; narration?: string }) {
  return saveVoucher(db, {
    voucherTypeId: vtId(db, 'payment'), date: o.date, partyLedgerId: o.party ?? null, narration: o.narration ?? null, instrumentNo: o.instrumentNo ?? null,
    postDated: o.postDated,
    lines: [
      { ledgerId: o.to, drCr: 'dr', amount: o.amount, costAllocations: [] },
      { ledgerId: o.bank, drCr: 'cr', amount: o.amount, costAllocations: [] }
    ]
  })
}

function receive(db: Db, o: { bank: number; from: number; amount: number; date: string; party?: number | null; instrumentNo?: string; postDated?: boolean }) {
  return saveVoucher(db, {
    voucherTypeId: vtId(db, 'receipt'), date: o.date, partyLedgerId: o.party ?? null, instrumentNo: o.instrumentNo ?? null, postDated: o.postDated,
    lines: [
      { ledgerId: o.bank, drCr: 'dr', amount: o.amount, costAllocations: [] },
      { ledgerId: o.from, drCr: 'cr', amount: o.amount, costAllocations: [] }
    ]
  })
}

const csv = (rows: string[]): { fileName: string; text: string } => ({ fileName: 'stmt.csv', text: ['Date,Narration,Chq/Ref No,Withdrawal,Deposit,Balance', ...rows].join('\n') })

let db: Db
let hdfc: number
let rent: number
let acme: number
let gupta: number
let charges: number

beforeEach(() => {
  setAuditContext({ appVersion: '0.8.0-test', getUserName: () => 'Tester' })
  db = seededDb()
  hdfc = ledger(db, 'HDFC Bank', 'Bank Accounts')
  rent = ledger(db, 'Office Rent', 'Indirect Expenses')
  charges = ledger(db, 'Bank Charges', 'Indirect Expenses')
  acme = ledger(db, 'Acme Traders', 'Sundry Debtors')
  gupta = ledger(db, 'Gupta Stores', 'Sundry Debtors')
})

const entities = (d: DB, entity: string): string[] => listAudit(d, { entity }).rows.map((r) => r.action)

describe('migration 032', () => {
  it('adds the bank-detail columns, the tables, and the PDC maturity trigger', () => {
    const cols = (db.prepare('PRAGMA table_info(ledgers)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toEqual(expect.arrayContaining(['bank_account_no', 'bank_ifsc', 'bank_account_name', 'bank_email']))
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name)
    for (const t of ['bank_import_profiles', 'bank_statement_imports', 'bank_statement_lines', 'bank_statement_matches', 'bank_learned_rules', 'cheque_books', 'cheques', 'pdc_events', 'bank_payment_templates', 'bank_payment_batches', 'bank_payment_batch_items']) {
      expect(tables).toContain(t)
    }
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'pdc_mark_matured'").get()).toBeTruthy()
  })

  it('import_hash is unique per bank ledger, and a line is a deposit xor a withdrawal', () => {
    const imp = Number(db.prepare("INSERT INTO bank_statement_imports (bank_ledger_id, format) VALUES (?, 'csv')").run(hdfc).lastInsertRowid)
    const ins = db.prepare("INSERT INTO bank_statement_lines (import_id, bank_ledger_id, line_no, date, deposit, withdrawal, import_hash) VALUES (?, ?, 1, '2026-08-01', ?, ?, ?)")
    ins.run(imp, hdfc, 100, 0, 'h1')
    expect(() => ins.run(imp, hdfc, 100, 0, 'h1')).toThrow(/UNIQUE/)
    expect(() => ins.run(imp, hdfc, 100, 100, 'h2')).toThrow(/CHECK/)
    expect(() => ins.run(imp, hdfc, 0, 0, 'h3')).toThrow(/CHECK/)
  })
})

describe('statement import + dedupe', () => {
  it('previews, commits with the detected mapping saved, and skips duplicates on re-import', () => {
    const src = csv(['02/08/2026,NEFT CR-ICIC0000104-ACME TRADERS,N1,,"25,000.00","1,25,000.00"', '03/08/2026,UPI-RAVI KUMAR-RENT AUG,U1,"18,000.00",,"1,07,000.00"'])
    const p = previewStatement(db, hdfc, src)
    expect(p.format).toBe('csv')
    expect(p.profileSource).toBe('detected')
    expect(p.newCount).toBe(2)
    const c = commitStatement(db, hdfc, src)
    expect(c).toMatchObject({ inserted: 2, duplicates: 0 })
    expect(getImportProfile(db, hdfc, 'csv')).toMatchObject({ dateCol: 0, debitCol: 3, creditCol: 4 })
    // Overlapping statement: one old line + one new.
    const src2 = csv(['03/08/2026,UPI-RAVI KUMAR-RENT AUG,U1,"18,000.00",,"1,07,000.00"', '04/08/2026,IMPS GUPTA STORES,I1,,"5,000.00","1,12,000.00"'])
    const p2 = previewStatement(db, hdfc, src2)
    expect(p2.profileSource).toBe('saved')
    expect(p2.lines.map((l) => l.duplicate)).toEqual([true, false])
    expect(commitStatement(db, hdfc, src2)).toMatchObject({ inserted: 1, duplicates: 1 })
    expect(commitStatement(db, hdfc, src2)).toMatchObject({ importId: null, inserted: 0, duplicates: 2 })
    expect(entities(db, 'bank_statement')).toEqual(['import', 'import'])
    expect(entities(db, 'bank_import_profile')).toContain('create')
  })

  it('reads MT940 and pasted PDF text through the same path', () => {
    const mt = ':20:X\n:25:ACC\n:60F:C260801INR0,\n:61:2608020802C100,50NTRFREF1\n:86:NEFT ACME\n:62F:C260802INR100,50'
    expect(commitStatement(db, hdfc, { fileName: 'a.sta', text: mt })).toMatchObject({ inserted: 1 })
    const pasted = 'Opening Balance 1,000.00\n05/08/2026 CASH DEPOSIT 500.00 1,500.00'
    expect(commitStatement(db, hdfc, { fileName: 'pasted', text: pasted, format: 'pasted' })).toMatchObject({ inserted: 1 })
    const ws = statementWorkspace(db, hdfc)
    expect(ws.lines.map((l) => [l.date, l.side, l.amount])).toEqual([['2026-08-02', 'deposit', 10050], ['2026-08-05', 'deposit', 50000]])
  })

  it('refuses a ledger that is not a bank account', () => {
    expect(() => previewStatement(db, rent, csv([]))).toThrow(/not a bank account/)
  })
})

describe('matching workspace, bulk confirm, learn → suggest', () => {
  it('proposes exact one-to-one matches, confirms them in bulk, sets bank dates and learns', () => {
    const r1 = receive(db, { bank: hdfc, from: acme, party: acme, amount: 2500000, date: '2026-08-01' })
    const p1 = pay(db, { bank: hdfc, to: rent, amount: 1800000, date: '2026-08-03' })
    commitStatement(db, hdfc, csv(['02/08/2026,NEFT CR-ICIC0000104-ACME TRADERS PVT LTD,N1,,"25,000.00",', '03/08/2026,UPI-RAVI KUMAR-ravi@okhdfc-321456789012-RENT AUG,U1,"18,000.00",,']))
    const ws = statementWorkspace(db, hdfc)
    expect(ws.lines.map((l) => [l.proposal?.kind, l.proposal?.entries.map((e) => e.voucherId)])).toEqual([
      ['one_to_one', [r1.id]],
      ['one_to_one', [p1.id]]
    ])
    expect(ws.lines[0]!.proposal!.reasons).toContain('party name in narration')
    const res = confirmMatches(db, hdfc, ws.lines.map((l) => ({ lineIds: [l.id], voucherIds: l.proposal!.entries.map((e) => e.voucherId) })))
    expect(res.confirmed).toBe(2)
    expect(getVoucher(db, r1.id)!.lines.find((l) => l.ledgerId === hdfc)!.bankDate).toBe('2026-08-02')
    expect(statementWorkspace(db, hdfc).lines).toEqual([])
    expect(statementWorkspace(db, hdfc, { includeDone: true }).lines.map((l) => l.status)).toEqual(['matched', 'matched'])
    const learned = listLearnedRules(db)
    expect(learned.map((r) => [r.direction, r.tokens, r.ledgerName])).toEqual(
      expect.arrayContaining([['deposit', ['ACME', 'TRADERS'], 'Acme Traders'], ['withdrawal', ['RAVI', 'KUMAR', 'RENT', 'AUG'], 'Office Rent']])
    )
    expect(entities(db, 'bank_statement_line')).toEqual(['update', 'update'])
    expect(entities(db, 'bank_learned_rule')).toEqual(['create', 'create'])
    // Confirming the same line again is refused.
    expect(() => confirmMatches(db, hdfc, [{ lineIds: [ws.lines[0]!.id], voucherIds: [r1.id] }])).toThrow(/already/)
  })

  it('a learned rule is suggested on the next import ("Suggested from N earlier matches") and bulk-creates vouchers', () => {
    // Teach twice (confirm matches against existing rent payments).
    for (const [i, d] of ['2026-06-03', '2026-07-03'].entries()) {
      const v = pay(db, { bank: hdfc, to: rent, amount: 1800000, date: d })
      const day = d.slice(8, 10)
      const mon = d.slice(5, 7)
      commitStatement(db, hdfc, csv([`${day}/${mon}/2026,UPI-RAVI KUMAR-ravi@okhdfc-32145678${i}012-RENT,U${i},"18,000.00",,`]))
      const line = statementWorkspace(db, hdfc).lines[0]!
      confirmMatches(db, hdfc, [{ lineIds: [line.id], voucherIds: [v.id] }])
    }
    const rule = listLearnedRules(db).find((r) => r.ledgerId === rent)!
    expect(rule.hits).toBe(2)
    expect(rule.tokens).toEqual(['RAVI', 'KUMAR', 'RENT'])
    // New statement with no book entry: suggestion from the learned rule.
    commitStatement(db, hdfc, csv(['03/08/2026,UPI-RAVI KUMAR-ravi@okhdfc-999999999012-RENT,U9,"18,000.00",,', '04/08/2026,SOMETHING NEW ENTIRELY,X,"10.00",,']))
    const ws = statementWorkspace(db, hdfc)
    const [rentLine, unknown] = ws.lines
    expect(rentLine!.proposal).toBeNull()
    expect(rentLine!.suggestion).toMatchObject({ source: 'learned', ledgerId: rent, ledgerName: 'Office Rent', evidence: 2, voucherKind: 'payment' })
    expect(unknown!.suggestion).toBeNull()

    const out = createVouchersFromLines(db, hdfc, [
      { lineId: rentLine!.id, ledgerId: rentLine!.suggestion!.ledgerId, source: { kind: 'learned', ruleId: rentLine!.suggestion!.ruleId } },
      { lineId: unknown!.id, ledgerId: charges }
    ])
    expect(out.failed).toEqual([])
    expect(out.created).toHaveLength(2)
    const v = getVoucher(db, out.created[0]!.voucherId)!
    expect(v.date).toBe('2026-08-03')
    expect(v.lines.find((l) => l.ledgerId === hdfc)).toMatchObject({ drCr: 'cr', amount: 1800000, bankDate: '2026-08-03' })
    expect(listLearnedRules(db).find((r) => r.id === rule.id)!.applied).toBe(1)
    // The unknown line taught a new candidate.
    expect(listLearnedRules(db).some((r) => r.ledgerId === charges && r.tokens.includes('SOMETHING'))).toBe(true)
    expect(entities(db, 'voucher').filter((a) => a === 'create').length).toBeGreaterThanOrEqual(4)
  })

  it('a manual bank rule wins over a learned one; accepting / editing / deleting learned rules is audited', () => {
    commitStatement(db, hdfc, csv(['03/08/2026,UPI RAVI KUMAR RENT,U1,"18,000.00",,']))
    const line = statementWorkspace(db, hdfc).lines[0]!
    createVouchersFromLines(db, hdfc, [{ lineId: line.id, ledgerId: rent }])
    const learned = listLearnedRules(db)[0]!
    expect(learned.status).toBe('candidate')
    const accepted = updateLearnedRule(db, learned.id, { status: 'accepted', narrationTemplate: 'Rent — {narration}' })
    expect(accepted.confidence).toBeGreaterThanOrEqual(0.9)
    commitStatement(db, hdfc, csv(['03/09/2026,UPI RAVI KUMAR RENT SEP,U2,"18,000.00",,']))
    let s = statementWorkspace(db, hdfc).lines[0]!.suggestion!
    expect(s).toMatchObject({ source: 'learned', narration: 'Rent — UPI RAVI KUMAR RENT SEP', status: 'accepted' })
    saveRule(db, { pattern: 'RAVI KUMAR', ledgerId: charges, kind: 'payment', active: true })
    s = statementWorkspace(db, hdfc).lines[0]!.suggestion!
    expect(s).toMatchObject({ source: 'rule', ledgerId: charges })
    deleteLearnedRule(db, learned.id)
    expect(listLearnedRules(db)).toEqual([])
    expect(entities(db, 'bank_learned_rule')).toEqual(['delete', 'update', 'create'])
  })

  it('one bank credit against several receipts of the same party (many-to-one), with unmatch', () => {
    const a = receive(db, { bank: hdfc, from: gupta, party: gupta, amount: 1000000, date: '2026-08-01' })
    const b = receive(db, { bank: hdfc, from: gupta, party: gupta, amount: 2000000, date: '2026-08-02' })
    commitStatement(db, hdfc, csv(['04/08/2026,NEFT GUPTA STORES,N1,,"30,000.00",']))
    const line = statementWorkspace(db, hdfc).lines[0]!
    expect(line.proposal).toMatchObject({ kind: 'entries_to_line' })
    expect(line.proposal!.entries.map((e) => e.voucherId).sort()).toEqual([a.id, b.id].sort())
    confirmMatches(db, hdfc, [{ lineIds: [line.id], voucherIds: [a.id, b.id] }])
    expect(getVoucher(db, a.id)!.lines.find((l) => l.ledgerId === hdfc)!.bankDate).toBe('2026-08-04')
    unmatchLine(db, hdfc, line.id)
    expect(getVoucher(db, a.id)!.lines.find((l) => l.ledgerId === hdfc)!.bankDate).toBeNull()
    expect(statementWorkspace(db, hdfc).lines).toHaveLength(1)
    // Amounts that don't add up are refused.
    expect(() => confirmMatches(db, hdfc, [{ lineIds: [line.id], voucherIds: [a.id] }])).toThrow(/differ/)
    expect(confirmMatches(db, hdfc, [{ lineIds: [line.id], voucherIds: [a.id] }], 2000000).confirmed).toBe(1)
  })

  it('one book entry split across several bank lines (one-to-many)', () => {
    const v = receive(db, { bank: hdfc, from: acme, party: acme, amount: 1000000, date: '2026-08-01' })
    commitStatement(db, hdfc, csv(['02/08/2026,CLG CHQ 1,C1,,"4,000.00",', '03/08/2026,CLG CHQ 2,C2,,"6,000.00",']))
    const lines = statementWorkspace(db, hdfc).lines
    expect(lines[0]!.proposal).toMatchObject({ kind: 'lines_to_entry', lineIds: lines.map((l) => l.id) })
    confirmMatches(db, hdfc, [{ lineIds: lines.map((l) => l.id), voucherIds: [v.id] }])
    expect(getVoucher(db, v.id)!.lines.find((l) => l.ledgerId === hdfc)!.bankDate).toBe('2026-08-03')
  })

  it('ignore / restore a line', () => {
    commitStatement(db, hdfc, csv(['02/08/2026,INTEREST,I,,"4.00",']))
    const line = statementWorkspace(db, hdfc).lines[0]!
    setLineIgnored(db, hdfc, line.id, true)
    expect(statementWorkspace(db, hdfc).lines).toEqual([])
    setLineIgnored(db, hdfc, line.id, false)
    expect(statementWorkspace(db, hdfc).lines).toHaveLength(1)
  })
})

describe('undo last import', () => {
  it('bins the vouchers it created, restores bank dates of its matches, and removes its lines (audited)', () => {
    const existing = pay(db, { bank: hdfc, to: rent, amount: 50000, date: '2026-08-01' })
    commitStatement(db, hdfc, csv(['01/08/2026,OLD,O,"1.00",,']))
    const first = commitStatement(db, hdfc, csv(['02/08/2026,RENT,R,"500.00",,', '02/08/2026,FEE,F,"20.00",,']))
    const ws = statementWorkspace(db, hdfc, { importId: first.importId! })
    const rentLine = ws.lines.find((l) => l.description === 'RENT')!
    const feeLine = ws.lines.find((l) => l.description === 'FEE')!
    confirmMatches(db, hdfc, [{ lineIds: [rentLine.id], voucherIds: [existing.id] }])
    const made = createVouchersFromLines(db, hdfc, [{ lineId: feeLine.id, ledgerId: charges }]).created[0]!
    expect(() => undoLastImport(db, hdfc, first.importId! - 1)).toThrow(/latest/)
    const res = undoLastImport(db, hdfc, first.importId!)
    expect(res).toEqual({ binned: 1, unmatched: 1, removedLines: 2 })
    expect(getVoucher(db, made.voucherId)!.deletedAt).not.toBeNull()
    expect(getVoucher(db, existing.id)!.lines.find((l) => l.ledgerId === hdfc)!.bankDate).toBeNull()
    expect(statementWorkspace(db, hdfc, { includeDone: true }).lines.map((l) => l.description)).toEqual(['OLD'])
    expect(entities(db, 'bank_statement')[0]).toBe('delete')
    expect(listAudit(db, { entity: 'voucher' }).rows.some((r) => r.action === 'delete' && r.entityId === made.voucherId)).toBe(true)
    // The same statement can be imported again afterwards (its hashes are gone).
    expect(commitStatement(db, hdfc, csv(['02/08/2026,RENT,R,"500.00",,'])).inserted).toBe(1)
  })
})

describe('cheque books, register, printing layout', () => {
  it('issues the next leaf to a payment, derives cleared from the bank date, cancels / stops leaves', () => {
    const book = saveChequeBook(db, { bankLedgerId: hdfc, name: 'Book 1', fromNo: 457, toNo: 460, width: 6, receivedOn: null, active: true })
    expect(book.leaves).toBe(4)
    expect(() => saveChequeBook(db, { bankLedgerId: hdfc, name: 'Clash', fromNo: 460, toNo: 470, width: 6, receivedOn: null, active: true })).toThrow(/overlap/)
    const v = pay(db, { bank: hdfc, to: acme, party: acme, amount: 1234550, date: '2026-08-05' })
    const row = issueCheque(db, v.id, hdfc)
    expect(row).toMatchObject({ number: '000457', status: 'issued', payee: 'Acme Traders', amount: 1234550, voucherId: v.id })
    expect(getVoucher(db, v.id)!.instrumentNo).toBe('000457')
    expect(issueCheque(db, v.id, hdfc).chequeId).toBe(row.chequeId) // re-print re-uses the leaf
    expect(nextChequeNumber(db, hdfc)?.label).toBe('000458')
    setChequeStatus(db, { bankLedgerId: hdfc, number: '458', status: 'cancelled', note: 'spoilt' })
    setChequeStatus(db, { bankLedgerId: hdfc, number: '000459', status: 'stopped', note: 'lost' })
    expect(nextChequeNumber(db, hdfc)?.label).toBe('000460')
    db.prepare('UPDATE voucher_lines SET bank_date = ? WHERE voucher_id = ? AND ledger_id = ?').run('2026-08-07', v.id, hdfc)
    expect(chequeRegister(db, hdfc).map((r) => [r.number, r.status])).toEqual([
      ['000457', 'cleared'], ['000458', 'cancelled'], ['000459', 'stopped'], ['000460', 'available']
    ])
    expect(() => deleteChequeBook(db, book.id)).toThrow(/deactivate/)
    expect(entities(db, 'cheque')).toEqual(['create', 'create', 'create'])
    expect(entities(db, 'cheque_book')).toEqual(['create'])
  })

  it('a voucher instrument number that is a free leaf is used; no books → a clear error', () => {
    const v = pay(db, { bank: hdfc, to: acme, party: acme, amount: 100, date: '2026-08-05', instrumentNo: '000777' })
    expect(() => issueCheque(db, v.id, hdfc)).toThrow(/add a cheque book/)
    saveChequeBook(db, { bankLedgerId: hdfc, name: '', fromNo: 770, toNo: 779, width: 6, receivedOn: null, active: true })
    expect(issueCheque(db, v.id, hdfc).number).toBe('000777')
  })

  it('layout: amount in words (Indian numbering), offsets and page size in the printed HTML', () => {
    setChequeConfig(db, hdfc, { ...getChequeConfig(db, hdfc), pageWidthMm: 210, pageHeightMm: 297, offsetXMm: 4, offsetYMm: 10, acPayeePos: { xMm: 6, yMm: 5 } })
    const cfg = getChequeConfig(db, hdfc)
    const html = buildChequeHtml(cfg, chequeFields({ date: '2026-08-05', payee: 'Acme & Co', amount: 25000000 }))
    expect(html).toContain('Two Lakh Fifty Thousand Rupees Only')
    expect(html).toContain('2,50,000.00/-')
    expect(html).toContain('Acme &amp; Co')
    expect(html).toContain('width: 210mm; height: 297mm')
    expect(html).toContain('left: 4mm; top: 10mm')
    expect(html).toContain('left:6mm; top:5mm;')
    expect(buildGridHtml(cfg)).toContain('a/c payee (6, 5)')
  })
})

describe('post-dated cheques', () => {
  it('register lists received and issued PDCs; maturity keeps them listed; dashboard reminder', () => {
    const r = receive(db, { bank: hdfc, from: acme, party: acme, amount: 500000, date: '2026-08-10', instrumentNo: '111', postDated: true })
    const p = pay(db, { bank: hdfc, to: rent, amount: 200000, date: '2026-08-20', instrumentNo: '222', postDated: true })
    let reg = pdcRegisterFull(db, '2026-08-08')
    expect(reg.map((x) => [x.number, x.direction, x.status, x.amount])).toEqual([[r.number, 'received', 'pending', 500000], [p.number, 'issued', 'pending', 200000]])
    expect(pdcsMaturing(db, '2026-08-08', 7)).toMatchObject({ received: { count: 1, amount: 500000 }, issued: { count: 0 } })
    const series = dashboardSeries(db, { name: 'T', address: '', gstRegistrationType: 'unregistered' } as never, { today: '2026-08-08', from: '2026-04-01', to: '2027-03-31', backups: [] } as never)
    expect(series.pdc).toMatchObject({ ok: true, data: { received: { count: 1 } } })
    maturePostDated(db, '2026-08-10')
    maturePdcNow(db, p.id)
    reg = pdcRegisterFull(db, '2026-08-11')
    expect(reg.map((x) => x.status)).toEqual(['matured', 'matured'])
    expect(reg[0]!.maturedAt).not.toBeNull()
  })

  it('bounce reverses the entry and books charges (recovered from the party or expensed)', () => {
    const r = receive(db, { bank: hdfc, from: acme, party: acme, amount: 500000, date: '2026-08-10', instrumentNo: '111', postDated: true })
    expect(() => bouncePdc(db, { voucherId: r.id, date: '2026-08-12', charges: 0, chargesLedgerId: null, recoverChargesFromParty: false, reason: '' })).toThrow(/not matured/)
    maturePdcNow(db, r.id)
    const res = bouncePdc(db, { voucherId: r.id, date: '2026-08-12', charges: 59000, chargesLedgerId: null, recoverChargesFromParty: true, reason: 'Funds insufficient' })
    const rev = getVoucher(db, res.reversalVoucherId)!
    expect(rev.lines.map((l) => [l.ledgerId, l.drCr, l.amount])).toEqual([[hdfc, 'cr', 500000], [acme, 'dr', 500000]])
    expect(rev.narration).toMatch(/bounced.*Funds insufficient/)
    const ch = getVoucher(db, res.chargesVoucherId!)!
    expect(ch.lines.map((l) => [l.ledgerId, l.drCr, l.amount])).toEqual([[acme, 'dr', 59000], [hdfc, 'cr', 59000]])
    expect(pdcRegisterFull(db, '2026-08-12')[0]).toMatchObject({ status: 'bounced', bouncedOn: '2026-08-12', bounceCharges: 59000 })
    expect(() => bouncePdc(db, { voucherId: r.id, date: '2026-08-12', charges: 0, chargesLedgerId: null, recoverChargesFromParty: false, reason: '' })).toThrow(/already/)
    expect(entities(db, 'pdc')).toEqual(['update'])
    // Bank balance: +5000 −5000 −590 = −590.
    const recon = bankRecon(db, hdfc, '2026-04-01', '2027-03-31')
    expect(recon.bookBalance).toBe(-59000)
  })

  it('an issued cheque bounce becomes a receipt back into the bank; charges need a ledger', () => {
    const p = pay(db, { bank: hdfc, to: rent, amount: 200000, date: '2026-08-05', instrumentNo: '222' })
    expect(() => bouncePdc(db, { voucherId: p.id, date: '2026-08-07', charges: 100, chargesLedgerId: null, recoverChargesFromParty: false, reason: '' })).toThrow(/ledger/)
    const res = bouncePdc(db, { voucherId: p.id, date: '2026-08-07', charges: 100, chargesLedgerId: charges, recoverChargesFromParty: false, reason: '' })
    expect(getVoucher(db, res.reversalVoucherId)!.lines.map((l) => [l.ledgerId, l.drCr])).toEqual([[rent, 'cr'], [hdfc, 'dr']])
    expect(getVoucher(db, res.chargesVoucherId!)!.lines[0]!.ledgerId).toBe(charges)
  })
})

describe('bulk payment files', () => {
  it('validates beneficiaries, renders the template, records the batch (audited)', () => {
    const shree = ledger(db, 'Shree Packaging', 'Sundry Creditors')
    const v1 = pay(db, { bank: hdfc, to: shree, party: shree, amount: 1234550, date: '2026-08-12', narration: 'July bill' })
    const v2 = pay(db, { bank: hdfc, to: rent, amount: 25000000, date: '2026-08-12' })
    const cands = paymentCandidates(db, hdfc, '2026-08-01', '2026-08-31')
    expect(cands.map((c) => [c.number, c.problems.length > 0])).toEqual([[v1.number, true], [v2.number, true]])
    const key = 'builtin:unionbank-neft-rtgs'
    expect(() => exportPaymentBatch(db, { bankLedgerId: hdfc, voucherIds: [v1.id], templateKey: key, date: '2026-08-12' })).toThrow(/Fix these/)
    expect(() => setBankDetails(db, shree, { accountNo: '1111', ifsc: 'BAD', accountName: null, email: null })).toThrow(/IFSC/)
    setBankDetails(db, shree, { accountNo: '1111 2222 3333', ifsc: 'icic0000001', accountName: 'Shree Packaging', email: 'a@b.in' })
    setBankDetails(db, rent, { accountNo: '22222222222', ifsc: 'UTIB0000002', accountName: 'Landlord', email: null })
    setBankDetails(db, hdfc, { accountNo: '566802070000001', ifsc: 'UBIN0556688', accountName: null, email: null })
    expect(listBeneficiaries(db).find((b) => b.ledgerId === shree)).toMatchObject({ accountNo: '111122223333', ifsc: 'ICIC0000001', problems: [] })
    const out = exportPaymentBatch(db, { bankLedgerId: hdfc, voucherIds: [v1.id, v2.id], templateKey: key, date: '2026-08-12', corporateId: 'DEMOCORP', remarks: 'AUG' })
    expect(out.text.split('\r\n')).toEqual([
      'FILEHDR|DEMOCORP|1|N|AUG',
      'NEFT|UBIN0556688|566802070000001|ICIC0000001|111122223333|INR|12345.50|July bill|Shree Packaging|a@b.in|',
      `RTGS|UBIN0556688|566802070000001|UTIB0000002|22222222222|INR|250000.00|Payment ${v2.number}|Landlord||`,
      ''
    ])
    expect(out.fileName).toBe('bulk-payments-hdfc-bank-2026-08-12-1.txt')
    expect(paymentCandidates(db, hdfc, '2026-08-01', '2026-08-31')[0]!.exportedIn).toHaveLength(1)
    expect(entities(db, 'payment_batch')).toEqual(['create'])
    expect(entities(db, 'ledger').filter((a) => a === 'update')).toHaveLength(3)
  })

  it('user templates: built-in names are reserved, CRUD audited', () => {
    const base = BUILTIN_PAYMENT_TEMPLATES[1]!
    const { key: _k, source: _s, ...spec } = base
    expect(() => savePaymentTemplate(db, spec)).toThrow(/built-in/)
    const t = savePaymentTemplate(db, { ...spec, name: 'HDFC ENet (mine)' })
    expect(listPaymentTemplates(db).map((x) => x.key)).toContain(`user:${t.id}`)
    expect(entities(db, 'payment_template')).toEqual(['create'])
  })
})
