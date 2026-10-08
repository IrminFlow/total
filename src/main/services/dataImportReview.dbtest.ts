// WP 6.3 review fixes — the reviewer's missing tests: FY-aware duplicates, openings checked once
// for every target, undo hardening, owner-gated books-from, "create renamed" remapping.
import { describe, expect, it } from 'vitest'
import { seededDb } from '../db/testdb'
import type { DB } from '../db/connection'
import { readCompanyInfo } from '../db/seed'
import { runImport, undoImport, type ImportOptions, type PlanStep } from './dataImport'
import { autoPlan, parseImportFile, planSteps } from './importFiles'
import { buildBooksWorkbook } from './booksExport'
import { xlsxBytes } from './xlsxFile'
import { createLedger, getLedger, updateLedger } from './masters'
import { getVoucher, saveVoucher } from './vouchers'
import { canonicalDump } from './canonicalDump.testutil'

const enc = new TextEncoder()
const meta = { source: 'generic', profileId: null, fileName: 'x' }

function run(db: DB, csv: string, opts: Partial<ImportOptions> = {}, profileId?: string, dryRun = false) {
  const f = parseImportFile('x.csv', enc.encode(csv))
  const { steps, profile } = autoPlan(db, f, '27', { profileId })
  return runImport(db, steps, opts, { source: profile.source, profileId: profile.id, fileName: 'x.csv' }, dryRun)
}
const id = (db: DB, sql: string, ...p: unknown[]): number | undefined => (db.prepare(sql).get(...p) as { id: number } | undefined)?.id
const groupId = (db: DB, name: string): number => id(db, 'SELECT id FROM groups WHERE name = ?', name)!
const count = (db: DB, sql: string, ...p: unknown[]): number => (db.prepare(`SELECT COUNT(*) AS n FROM ${sql}`).get(...p) as { n: number }).n
const books = (db: DB): Uint8Array => xlsxBytes(buildBooksWorkbook(db, readCompanyInfo(db), 't').sheets)
function importBooks(dst: DB, bytes: Uint8Array, opts: Partial<ImportOptions> = {}) {
  const f = parseImportFile('b.xlsx', bytes)
  return runImport(dst, planSteps(f), { sourceNamespace: `${f.manifest!.company}|`, ...opts }, { source: 'total-books', profileId: null, fileName: 'b.xlsx' }, false)
}

function twoReceipts(): DB {
  const db = seededDb()
  const party = createLedger(db, { name: 'Acme', groupId: groupId(db, 'Sundry Debtors'), pan: null })
  const cash = id(db, "SELECT id FROM ledgers WHERE name = 'Cash'")!
  const rv = id(db, "SELECT id FROM voucher_types WHERE kind = 'receipt'")!
  for (const date of ['2025-06-01', '2026-06-01']) {
    saveVoucher(db, {
      voucherTypeId: rv, number: '1', date, partyLedgerId: party.id, narration: `Receipt ${date}`,
      lines: [{ ledgerId: cash, drCr: 'dr', amount: 1000, costAllocations: [] }, { ledgerId: party.id, drCr: 'cr', amount: 1000, costAllocations: [] }]
    })
  }
  return db
}

describe('#1 duplicates are per financial year (and by Source ID)', () => {
  it('two receipts "1" in FY 2025-26 and FY 2026-27 round-trip under skip and under update', () => {
    const src = twoReceipts()
    const dst = seededDb()
    expect(importBooks(dst, books(src)).steps.find((s) => s.target === 'vouchers')).toMatchObject({ created: 2 })
    const first = canonicalDump(dst)
    expect(importBooks(dst, books(src), { duplicate: 'skip' }).steps.find((s) => s.target === 'vouchers')).toMatchObject({ created: 0, skipped: 2 })
    expect(importBooks(dst, books(src), { duplicate: 'update' }).steps.find((s) => s.target === 'vouchers')).toMatchObject({ created: 0, updated: 2 })
    expect(canonicalDump(dst)).toEqual(first)
    expect(count(dst, "vouchers WHERE number = '1'")).toBe(2)
  })

  it('a plain file (no Source ID) matches type + number within the FY only', () => {
    const db = twoReceipts()
    const csv = [
      'Voucher Type,Date,Number,Party,Ledger,Debit,Credit,Narration',
      'Receipt,2025-06-01,1,Acme,Cash,10,,again', ',,,,Acme,,10,',
      'Receipt,2027-06-01,1,Acme,Cash,10,,next year', ',,,,Acme,,10,'
    ].join('\n')
    expect(run(db, csv).steps[0]).toMatchObject({ skipped: 1, created: 1 })
    expect(count(db, "vouchers WHERE number = '1'")).toBe(3)
  })

  it('"create" on a taken number assigns the next free one', () => {
    const db = twoReceipts()
    const r = run(db, 'Voucher Type,Date,Number,Party,Ledger,Debit,Credit\nReceipt,2025-06-02,1,Acme,Cash,10,\n,,,,Acme,,10', { duplicate: 'create' })
    expect(r.steps[0]).toMatchObject({ created: 1 })
    expect(r.outcomes[0]!.message).toMatch(/Numbered .* — 1 was taken/)
    expect(count(db, "vouchers WHERE number = '1' AND date BETWEEN '2025-04-01' AND '2026-03-31'")).toBe(1)
  })
})

describe('#3 / #4 openings: checked once, after everything, for every target that carries them', () => {
  it('item opening ₹100 against capital ₹100 balances — no suspense posting even with "suspense" chosen', () => {
    const src = seededDb()
    createLedger(src, { name: 'Capital', groupId: groupId(src, 'Capital Account'), openingBalance: -10000, pan: null })
    run(src, 'Item,Unit,Opening Qty,Opening Value\nWidget,Nos,1,100', { openingDifference: 'leave' })
    const dst = seededDb()
    // The workbook imports ledgers BEFORE stock items: a per-step check would post ₹100 to suspense.
    const r = importBooks(dst, books(src), { openingDifference: 'suspense' })
    expect(r.blocked).toBeUndefined()
    expect(id(dst, "SELECT id FROM ledgers WHERE name = 'Difference in Opening Balances'")).toBeUndefined()
    expect(r.openingCheck).toMatchObject({ difference: 0, stockOpening: 10000 })
  })

  it('Stop refuses a ledgers import whose openings do not tie — nothing written, no "create" rows', () => {
    const db = seededDb()
    const before = count(db, 'ledgers')
    const r = run(db, 'Name,Group,Opening Balance\nA,Sundry Debtors,100 Dr\nB,Capital Account,90 Cr')
    expect(r.blocked).toMatch(/do not tie.*₹10\.00 Dr/)
    expect(r.batchId).toBeNull()
    expect(r.outcomes.every((o) => o.action !== 'create')).toBe(true)
    expect(r.steps[0]!.created).toBe(0)
    expect(count(db, 'ledgers')).toBe(before)
    expect(count(db, 'import_batches')).toBe(0)
  })

  it('suspense posts only the difference the import introduced; leave warns', () => {
    const db = seededDb()
    run(db, 'Name,Group,Opening Balance\nA,Sundry Debtors,100 Dr\nB,Capital Account,90 Cr', { openingDifference: 'suspense' })
    expect(getLedger(db, id(db, "SELECT id FROM ledgers WHERE name = 'Difference in Opening Balances'")!)!.openingBalance).toBe(-1000)
    const r = run(db, 'Name,Group,Opening Balance\nC,Sundry Debtors,5 Dr', { openingDifference: 'leave' })
    expect(r.warnings).toEqual([expect.stringMatching(/differ by ₹5\.00 Dr/)])
  })

  it('a company already out of balance is warned, not blocked, when the import adds nothing to the gap', () => {
    const db = seededDb()
    createLedger(db, { name: 'Old', groupId: groupId(db, 'Sundry Debtors'), openingBalance: 700, pan: null })
    const r = run(db, 'Name,Group\nNew Party,Sundry Debtors')
    expect(r.blocked).toBeUndefined()
    expect(r.warnings).toEqual([expect.stringMatching(/already differed by ₹7\.00/)])
  })
})

describe('#7 undo', () => {
  it('restores the full before-image of an updated voucher (lines, refs), and is idempotent', () => {
    const db = twoReceipts()
    const v = id(db, "SELECT id FROM vouchers WHERE date = '2025-06-01'")!
    const before = getVoucher(db, v)!
    const r = run(db, 'Voucher Type,Date,Number,Party,Ledger,Debit,Credit,Narration\nReceipt,2025-06-01,1,Acme,Cash,25,,changed\n,,,,Acme,,25,', { duplicate: 'update' })
    expect(r.steps[0]).toMatchObject({ updated: 1 })
    expect(getVoucher(db, v)!.lines[0]!.amount).toBe(2500)
    expect(undoImport(db, r.batchId!)).toMatchObject({ restored: 1, kept: [] })
    const after = getVoucher(db, v)!
    expect(after.lines.map((l) => [l.ledgerId, l.drCr, l.amount])).toEqual(before.lines.map((l) => [l.ledgerId, l.drCr, l.amount]))
    expect(after.narration).toBe(before.narration)
    expect(() => undoImport(db, r.batchId!)).toThrow(/already undone/)
  })

  it('leaves a record edited after the import alone and reports it; a retry does not redo finished items', () => {
    const db = seededDb()
    const r = run(db, 'Name,Group\nP1,Sundry Debtors\nP2,Sundry Debtors')
    const p1 = id(db, "SELECT id FROM ledgers WHERE name = 'P1'")!
    const l = getLedger(db, p1)!
    // A user edits P1 after the import.
    updateLedger(db, p1, { ...l, address: 'Edited by hand' } as never)
    const u = undoImport(db, r.batchId!)
    expect(u.deleted).toBe(1) // P2
    expect(u.kept).toEqual([expect.objectContaining({ id: p1, reason: expect.stringMatching(/edited after the import/) })])
    expect(id(db, "SELECT id FROM ledgers WHERE name = 'P1'")).toBe(p1)
    const again = undoImport(db, r.batchId!) // partly undone → retry: P2 is not touched again
    expect(again.deleted).toBe(0)
    expect(again.kept).toHaveLength(1)
  })

  it('reverses a bank-statement hand-off: the bank dates it set are cleared', () => {
    const db = seededDb()
    const bank = createLedger(db, { name: 'HDFC', groupId: groupId(db, 'Bank Accounts'), pan: null })
    const party = createLedger(db, { name: 'Acme', groupId: groupId(db, 'Sundry Debtors'), pan: null })
    const rv = id(db, "SELECT id FROM voucher_types WHERE kind = 'receipt'")!
    const v = saveVoucher(db, { voucherTypeId: rv, date: '2025-06-10', partyLedgerId: party.id, lines: [{ ledgerId: bank.id, drCr: 'dr', amount: 50000, costAllocations: [] }, { ledgerId: party.id, drCr: 'cr', amount: 50000, costAllocations: [] }] })
    const r = run(db, 'Date,Description,Deposit\n12/06/2025,NEFT ACME,500.00', { bankLedgerId: bank.id }, 'generic:bank')
    expect(r.bank).toMatchObject({ matched: 1 })
    const lineId = getVoucher(db, v.id)!.lines[0]!.id
    expect((db.prepare('SELECT bank_date FROM voucher_lines WHERE id = ?').get(lineId) as { bank_date: string }).bank_date).toBe('2025-06-12')
    expect(undoImport(db, r.batchId!)).toMatchObject({ restored: 1 })
    expect((db.prepare('SELECT bank_date FROM voucher_lines WHERE id = ?').get(lineId) as { bank_date: string | null }).bank_date).toBeNull()
  })
})

describe('#8 books-from is owner-only and reported', () => {
  it('an accountant gets a warning; an owner sets it (when the company has no vouchers)', () => {
    const plan: PlanStep[] = [{ rows: { target: 'groups', rows: [] } }]
    const db = seededDb()
    const a = runImport(db, plan, { applyBooksFrom: 2023, canSetBooksFrom: false, userName: 'asha' }, meta, false)
    expect(a.booksFromSet).toBeNull()
    expect(a.warnings).toEqual([expect.stringMatching(/only an owner/)])
    expect(readCompanyInfo(db).booksFrom).toBe(2025)
    expect(db.prepare('SELECT created_by FROM import_batches WHERE id = ?').get(a.batchId)).toEqual({ created_by: 'asha' })
    const o = runImport(db, plan, { applyBooksFrom: 2023, canSetBooksFrom: true }, meta, false)
    expect(o.booksFromSet).toBe(2023)
    expect(readCompanyInfo(db).booksFrom).toBe(2023)
  })
})

describe('#9 "create renamed" and unknown groups on update', () => {
  it('vouchers in the same file follow a master created under a new name', () => {
    const db = seededDb()
    createLedger(db, { name: 'Acme', groupId: groupId(db, 'Sundry Creditors'), pan: null })
    const plan: PlanStep[] = [
      { rows: { target: 'ledgers', rows: [{ line: 2, name: 'Acme', group: 'Sundry Debtors', opening: null, gstin: null, stateCode: null, pan: null, creditDays: null, creditLimit: null, address: null, taxType: null, gstRate: null, hsn: null }] } },
      {
        rows: {
          target: 'vouchers',
          rows: [{
            key: 'k', lines: [3], typeName: 'Receipt', kind: 'receipt', date: '2025-06-01', number: 'R9', party: 'Acme', narration: null, reference: null,
            ledgerLines: [{ line: 3, ledger: 'Cash', drCr: 'dr', amount: 100 }, { line: 3, ledger: 'Acme', drCr: 'cr', amount: 100 }],
            items: [], bills: [], tds: null, tcs: null, posOverride: null, currencyCode: null, exchangeRate: null, isOptional: false, notes: []
          }]
        }
      }
    ]
    const r = runImport(db, plan, { duplicate: 'create' }, meta, false)
    expect(r.steps.flatMap((s) => s.errors)).toEqual([])
    const renamed = id(db, "SELECT id FROM ledgers WHERE name = 'Acme (2)'")!
    const v = getVoucher(db, id(db, "SELECT id FROM vouchers WHERE number = 'R9'")!)!
    expect(v.partyLedgerId).toBe(renamed)
    expect(v.lines.map((l) => l.ledgerId)).toContain(renamed)
  })

  it('an update naming an unknown group keeps the ledger where it is (never Suspense)', () => {
    const db = seededDb()
    createLedger(db, { name: 'Acme', groupId: groupId(db, 'Sundry Debtors'), pan: null })
    const r = run(db, 'Name,Group,Credit Days\nAcme,Imaginary Group,45', { duplicate: 'update' })
    expect(r.steps[0]).toMatchObject({ updated: 1 })
    expect(r.steps[0]!.warnings[0]).toMatch(/keeps its group/)
    const l = getLedger(db, id(db, "SELECT id FROM ledgers WHERE name = 'Acme'")!)!
    expect(l.groupId).toBe(groupId(db, 'Sundry Debtors'))
    expect(l.creditDays).toBe(45)
  })
})
