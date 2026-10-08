import { describe, expect, it } from 'vitest'
import {
  BUILTIN_PAYMENT_TEMPLATES, beneficiaryProblems, formatPaymentAmount, formatPaymentDate, paymentTypeFor, renderPaymentFile, RTGS_MIN_PAISE,
  type PaymentRow
} from './bulkPayments'
import { bookFor, displayStatus, formatLeaf, leafValue, nextAvailableLeaf, overlappingBook } from './chequeRegister'
import { amountInWords } from './money'
import { chequeFields } from './cheque'

const rows: PaymentRow[] = [
  { voucherId: 1, voucherNumber: 'PMT-7', date: '2026-08-12', amount: 1234550, beneficiaryName: 'Shree Packaging', accountNo: '1111 2222 3333', ifsc: 'icic0000001', email: 'a@b.in', narration: 'July bill | packing' },
  { voucherId: 2, voucherNumber: 'PMT-8', date: '2026-08-12', amount: 25000000, beneficiaryName: 'Steel Corp', accountNo: '22222222222', ifsc: 'UTIB0000002', email: '', narration: '=SUM(A1)' }
]
const ctx = { debitAccount: '566802070000001', debitIfsc: 'UBIN0556688', corporateId: 'SMPVTLTD', batchNo: 1, date: '2026-08-12', remarks: 'TEST' }

describe('bulk payment files', () => {
  it('Union Bank sample layout: FILEHDR line then pipe records (matches the published example shape)', () => {
    const t = BUILTIN_PAYMENT_TEMPLATES.find((x) => x.key === 'unionbank-neft-rtgs')!
    const text = renderPaymentFile(t, rows, ctx)
    expect(text.split('\r\n')).toEqual([
      'FILEHDR|SMPVTLTD|1|N|TEST',
      'NEFT|UBIN0556688|566802070000001|ICIC0000001|111122223333|INR|12345.50|July bill   packing|Shree Packaging|a@b.in|',
      'RTGS|UBIN0556688|566802070000001|UTIB0000002|22222222222|INR|250000.00|SUM(A1)|Steel Corp||',
      ''
    ])
  })

  it('generic CSV with header, truncation and quoting', () => {
    const t = { ...BUILTIN_PAYMENT_TEMPLATES.find((x) => x.key === 'generic-csv')!, quoteAll: true }
    const lines = renderPaymentFile(t, rows.slice(0, 1), ctx).trim().split('\r\n')
    expect(lines[0]).toBe('"Payment Type","Beneficiary Name","Beneficiary Account No","IFSC","Amount","Value Date","Debit Account No","Customer Reference","Remarks","Beneficiary Email"')
    expect(lines[1]).toBe('"NEFT","Shree Packaging","111122223333","ICIC0000001","12345.50","12/08/2026","566802070000001","PMT-7","July bill | packing","a@b.in"')
  })

  it('formats and RTGS threshold (₹2 lakh per SBI RTGS/NEFT FAQ)', () => {
    expect(RTGS_MIN_PAISE).toBe(20000000)
    expect(paymentTypeFor(19999999, RTGS_MIN_PAISE)).toBe('NEFT')
    expect(paymentTypeFor(20000000, RTGS_MIN_PAISE)).toBe('RTGS')
    expect(formatPaymentAmount(5, 'rupees')).toBe('0.05')
    expect(formatPaymentAmount(123400, 'rupees_int')).toBe('1234')
    expect(() => formatPaymentAmount(123450, 'rupees_int')).toThrow(/whole rupees/)
    expect(formatPaymentAmount(123450, 'paise')).toBe('123450')
    expect(formatPaymentDate('2026-08-02', 'DD-MMM-YYYY')).toBe('02-AUG-2026')
    expect(formatPaymentDate('2026-08-02', 'DDMMYYYY')).toBe('02082026')
  })

  it('beneficiary validation (IFSC: 4 letters, 0, 6 alphanumerics)', () => {
    expect(beneficiaryProblems({ accountNo: '50100012345678', ifsc: 'HDFC0001234', accountName: 'Acme' })).toEqual([])
    expect(beneficiaryProblems({ accountNo: '', ifsc: 'HDFC1001234', accountName: '' })).toEqual([
      'no account number', 'IFSC must be 11 characters: 4 letters, 0, then 6 letters/digits', 'no beneficiary name'
    ])
  })
})

describe('bulk payment file safety (review)', () => {
  const t = BUILTIN_PAYMENT_TEMPLATES.find((x) => x.key === 'unionbank-neft-rtgs')!
  it('header placeholders are cleaned: no delimiter or line break can leak in', () => {
    const text = renderPaymentFile(t, rows.slice(0, 1), { ...ctx, corporateId: 'A|B', remarks: 'line1\nline2|x' })
    expect(text.split('\r\n')[0]).toBe('FILEHDR|A B|1|N|line1 line2 x')
  })
  it('an over-length account number / IFSC / amount is refused, never truncated', () => {
    const long = [{ ...rows[0]!, accountNo: '1'.repeat(30) }]
    expect(() => renderPaymentFile(t, long, ctx)).toThrow(/longer than the template's 24 characters/)
    // names are trimmed to the field size instead
    const name = renderPaymentFile(t, [{ ...rows[0]!, beneficiaryName: 'N'.repeat(60) }], ctx)
    expect(name).toContain(`|${'N'.repeat(40)}|`)
  })
})

describe('cheque register helpers', () => {
  const books = [
    { id: 1, fromNo: 457, toNo: 459, width: 6, active: true },
    { id: 2, fromNo: 100, toNo: 101, width: 6, active: false }
  ]
  it('next leaf skips used leaves and inactive books', () => {
    expect(nextAvailableLeaf(books, new Set([457]))).toEqual({ bookId: 1, leaf: 458, label: '000458' })
    expect(nextAvailableLeaf(books, new Set([457, 458, 459]))).toBeNull()
  })
  it('leaf parsing, book lookup, overlap, display status', () => {
    expect(leafValue('000457')).toBe(457)
    expect(leafValue('A12')).toBeNull()
    expect(formatLeaf(7, 6)).toBe('000007')
    expect(bookFor(books, 101)?.id).toBe(2)
    expect(overlappingBook(books, 459, 500)?.id).toBe(1)
    expect(overlappingBook(books, 459, 500, 1)).toBeNull()
    expect(displayStatus(null, null)).toBe('available')
    expect(displayStatus('issued', null)).toBe('issued')
    expect(displayStatus('issued', '2026-08-05')).toBe('cleared')
    expect(displayStatus('stopped', '2026-08-05')).toBe('stopped')
  })
})

describe('amount in words on cheques (Indian numbering)', () => {
  it('lakhs and crores, paise', () => {
    expect(amountInWords(1234550)).toBe('Twelve Thousand Three Hundred Forty Five Rupees and Fifty Paise Only')
    expect(amountInWords(25000000)).toBe('Two Lakh Fifty Thousand Rupees Only')
    expect(amountInWords(1234567800)).toBe('One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight Rupees Only')
    expect(chequeFields({ date: '2026-08-02', payee: 'X', amount: 100000 })).toEqual({
      dateBoxes: '02082026', payee: 'X', words: 'One Thousand Rupees Only', figures: '1,000.00/-'
    })
  })
})
