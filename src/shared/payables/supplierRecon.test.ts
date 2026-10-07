import { describe, expect, it } from 'vitest'
import { parseStatementDate, parseSupplierStatementCsv, reconcileSupplier, type BookLedgerLine, type SupplierLedgerLine } from './supplierRecon'

const S = (line: number, date: string, docNo: string, debit: number, credit = 0): SupplierLedgerLine => ({ line, date, docNo, narration: '', debit, credit })
const B = (voucherId: number, date: string, number: string, supplierRef: string | null, debit: number, credit: number): BookLedgerLine => ({
  voucherId, date, number, supplierRef, voucherType: credit > 0 ? 'Purchase' : 'Payment', debit, credit
})

describe('supplier statement CSV', () => {
  it('reads Debit / Credit columns, skips opening and closing rows', () => {
    const csv = [
      'Ledger: Total Traders',
      'Date,Invoice No,Particulars,Debit,Credit',
      '01/04/2026,,Opening Balance,0.00,',
      '05/04/2026,INV-101,Sales,"11,800.00",',
      '20-Apr-2026,RCPT-7,Payment received,,11800.00',
      ',,Closing Balance,,'
    ].join('\n')
    const r = parseSupplierStatementCsv(csv)
    expect(r.error).toBeNull()
    expect(r.lines).toEqual([
      { line: 4, date: '2026-04-05', docNo: 'INV-101', narration: 'Sales', debit: 1_180_000, credit: 0 },
      { line: 5, date: '2026-04-20', docNo: 'RCPT-7', narration: 'Payment received', debit: 0, credit: 1_180_000 }
    ])
    expect(r.skipped.map((s) => s.line)).toEqual([3, 6])
  })
  it('reads an Amount column with Dr/Cr, and "1,000.00 Cr" amounts', () => {
    const r = parseSupplierStatementCsv('Date,Ref,Amount,Dr/Cr\n2026-04-05,INV-1,500.00,Dr\n2026-04-06,P-1,200.00,Cr\n')
    expect(r.lines.map((l) => [l.debit, l.credit])).toEqual([[50_000, 0], [0, 20_000]])
    const r2 = parseSupplierStatementCsv('Date,Doc No,Amount\n2026-04-05,INV-1,500.00 Dr\n2026-04-06,P-1,200.00 Cr\n')
    expect(r2.lines.map((l) => [l.debit, l.credit])).toEqual([[50_000, 0], [0, 20_000]])
  })
  it('says so when it finds no header', () => {
    expect(parseSupplierStatementCsv('a,b,c\n1,2,3\n').error).toMatch(/No header row/)
  })
  it('dates in the usual export formats', () => {
    expect(parseStatementDate('2026-04-05')).toBe('2026-04-05')
    expect(parseStatementDate('5/4/26')).toBe('2026-04-05')
    expect(parseStatementDate('05.04.2026')).toBe('2026-04-05')
    expect(parseStatementDate('5 Sept 2026')).toBe('2026-09-05')
    expect(parseStatementDate('31/02/2026')).toBeNull()
  })
})

describe('supplier reconciliation matcher', () => {
  it('pairs bills by invoice number (exact, then fuzzy), payments by amount + date, lists the rest', () => {
    const supplier = [
      S(1, '2026-04-05', 'INV-101', 1_180_000),
      S(2, '2026-04-12', 'TT/2026-27/0102', 590_000),
      S(3, '2026-04-20', 'RCPT-7', 0, 1_180_000),
      S(4, '2026-04-28', 'INV-103', 300_000),
      S(5, '2026-04-29', 'INV-104', 100_000)
    ]
    const books = [
      B(11, '2026-04-06', 'P-1', 'INV-101', 0, 1_180_000),
      B(12, '2026-04-12', 'P-2', '102', 0, 590_000),
      B(13, '2026-04-18', 'PMT-3', null, 1_180_000, 0),
      B(14, '2026-04-29', 'P-4', 'INV-104', 0, 99_000),
      B(15, '2026-04-30', 'PMT-9', null, 50_000, 0)
    ]
    const r = reconcileSupplier(supplier, books, { amountPaise: 100, dateDays: 7 })
    const by = (doc: string) => r.pairs.find((p) => p.supplier?.docNo === doc)!
    expect(by('INV-101')).toMatchObject({ status: 'matched', matchedBy: 'number', book: { voucherId: 11 }, dateDiffDays: 1 })
    expect(by('TT/2026-27/0102')).toMatchObject({ status: 'matched', matchedBy: 'number_core', book: { voucherId: 12 } })
    expect(by('RCPT-7')).toMatchObject({ status: 'matched', matchedBy: 'amount_date', book: { voucherId: 13 }, side: 'payment' })
    expect(by('INV-104')).toMatchObject({ status: 'amount_diff', amountDiff: 1_000 })
    expect(by('INV-103')).toMatchObject({ status: 'only_supplier', book: null })
    expect(r.pairs.find((p) => p.book?.voucherId === 15)).toMatchObject({ status: 'only_books', supplier: null })
    expect(r.counts).toEqual({ matched: 3, amount_diff: 1, only_supplier: 1, only_books: 1 })
    expect(r.supplierBalance).toBe(1_180_000 + 590_000 - 1_180_000 + 300_000 + 100_000)
    expect(r.bookBalance).toBe(1_180_000 + 590_000 - 1_180_000 + 99_000 - 50_000)
  })
  it('never pairs a bill with a payment, and is one-to-one', () => {
    const r = reconcileSupplier([S(1, '2026-04-05', 'X-1', 50_000), S(2, '2026-04-05', 'X-1', 50_000)], [B(1, '2026-04-05', 'X-1', null, 50_000, 0), B(2, '2026-04-05', 'Q', 'X-1', 0, 50_000)])
    expect(r.counts).toEqual({ matched: 1, amount_diff: 0, only_supplier: 1, only_books: 1 })
    const matched = r.pairs.find((p) => p.status === 'matched')!
    expect(matched.book!.voucherId).toBe(2)
  })
  it('amount-only matches respect the date window and the tolerance', () => {
    const r = reconcileSupplier([S(1, '2026-04-01', '', 0, 10_000)], [B(1, '2026-04-20', 'PMT', null, 10_000, 0)], { amountPaise: 0, dateDays: 7 })
    expect(r.counts.matched).toBe(0)
    const r2 = reconcileSupplier([S(1, '2026-04-01', '', 0, 10_050)], [B(1, '2026-04-03', 'PMT', null, 10_000, 0)], { amountPaise: 100, dateDays: 7 })
    expect(r2.counts.matched).toBe(1)
  })
})
