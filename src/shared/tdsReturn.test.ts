import { describe, expect, it } from 'vitest'
import {
  challanTotal,
  form16aDueDate,
  statementDueDate,
  toFlatFile,
  validateReturn,
  type ReturnHeader,
  type TdsChallan,
  type TdsDeduction,
  type TdsReturnWorking
} from './tdsReturn'

const challan = (over: Partial<TdsChallan> = {}): TdsChallan => ({
  id: 1,
  bsrCode: '0004329',
  paidOn: '2026-07-07',
  serial: '00021',
  tax: 10_000_00,
  surcharge: 0,
  cess: 0,
  interest: 0,
  fee: 0,
  bookEntry: false,
  ...over
})

const deduction = (over: Partial<TdsDeduction> = {}): TdsDeduction => ({
  entryId: 1,
  challanId: 1,
  deducteeName: 'Ram Contractors',
  pan: 'AAAPA0000A',
  deducteeCode: '02',
  sectionCode: '194C',
  sectionUnverified: false,
  paidOn: '2026-06-10',
  deductedOn: '2026-06-10',
  amountPaid: 5_00_000_00,
  tds: 5_000_00,
  surcharge: 0,
  cess: 0,
  rate: 1,
  voucherNumber: 'PMT-3',
  ...over
})

const working = (over: Partial<TdsReturnWorking> = {}): TdsReturnWorking => ({
  form: '26Q',
  fyStartYear: 2026,
  quarter: 1,
  label: 'Q1 FY2026-27',
  from: '2026-04-01',
  to: '2026-06-30',
  dueDate: '2026-07-31',
  challans: [challan()],
  deductions: [deduction()],
  totalPaid: 5_00_000_00,
  totalTds: 5_000_00,
  unlinkedTds: 0,
  issues: [],
  ...over
})

const header = (over: Partial<ReturnHeader> = {}): ReturnHeader => ({
  tan: 'PNET12345B',
  pan: 'AAAPA1111A',
  deductorName: 'Demo Traders',
  deductorType: 'S',
  responsiblePerson: 'A. Kumar',
  responsibleDesignation: 'Partner',
  address: 'Pune',
  email: null,
  phone: null,
  ...over
})

describe('statementDueDate', () => {
  it('is the last day of the month after Q1, Q2 and Q3', () => {
    expect(statementDueDate(2026, 1)).toBe('2026-07-31')
    expect(statementDueDate(2026, 2)).toBe('2026-10-31')
    expect(statementDueDate(2026, 3)).toBe('2027-01-31')
  })

  it('is 31 May for Q4, which is the one people miss', () => {
    expect(statementDueDate(2026, 4)).toBe('2027-05-31')
  })
})

describe('form16aDueDate', () => {
  it('is fifteen days after the statement is due, not after it was filed', () => {
    // Filing late does not buy time to issue the certificate.
    expect(form16aDueDate(2026, 1)).toBe('2026-08-15')
    expect(form16aDueDate(2026, 4)).toBe('2027-06-15')
  })
})

describe('validateReturn', () => {
  it('passes a complete quarter with only nothing to say', () => {
    expect(validateReturn(working(), header())).toEqual([])
  })

  it('blocks on a missing TAN', () => {
    const issues = validateReturn(working(), header({ tan: null }))
    expect(issues[0]!.severity).toBe('blocking')
    expect(issues[0]!.message).toContain('TAN')
  })

  it('blocks a deduction with no challan behind it', () => {
    const issues = validateReturn(working({ deductions: [deduction({ challanId: null })] }), header())
    expect(issues.some((i) => i.severity === 'blocking' && i.message.includes('not linked to a challan'))).toBe(true)
  })

  it('blocks when more tax is claimed against a challan than was paid with it', () => {
    const issues = validateReturn(
      working({ challans: [challan({ tax: 1_000_00 })], deductions: [deduction({ tds: 5_000_00 })] }),
      header()
    )
    expect(issues.some((i) => i.message.includes('cannot cover more tax'))).toBe(true)
  })

  it('blocks a challan with no BSR code, but not a book entry', () => {
    expect(validateReturn(working({ challans: [challan({ bsrCode: '123' })] }), header()).some((i) => i.message.includes('BSR'))).toBe(true)
    expect(
      validateReturn(working({ challans: [challan({ bsrCode: '', serial: '', bookEntry: true })] }), header()).some((i) =>
        i.message.includes('BSR')
      )
    ).toBe(false)
  })

  it('warns rather than blocks on a missing PAN', () => {
    // A return can be filed with PANNOTAVBL; the price is the 206AA rate, not a rejection.
    const issues = validateReturn(working({ deductions: [deduction({ pan: null })] }), header())
    expect(issues).toHaveLength(1)
    expect(issues[0]!.severity).toBe('warning')
    expect(issues[0]!.message).toContain('206AA')
  })

  it('warns about unverified Income-tax Act 2025 section references', () => {
    const issues = validateReturn(working({ deductions: [deduction({ sectionCode: '393', sectionUnverified: true })] }), header())
    expect(issues.some((i) => i.message.includes('Income-tax Act 2025'))).toBe(true)
  })

  it('says something useful about a quarter with no deductions at all', () => {
    const issues = validateReturn(working({ challans: [], deductions: [] }), header())
    expect(issues[0]!.message).toContain('declaration on the TRACES portal')
  })

  it('puts blocking issues before warnings, which is the order they get fixed in', () => {
    const issues = validateReturn(working({ deductions: [deduction({ challanId: null, pan: null })] }), header())
    expect(issues[0]!.severity).toBe('blocking')
    expect(issues[issues.length - 1]!.severity).toBe('warning')
  })
})

describe('toFlatFile', () => {
  it('writes a header, a batch, a challan and a deductee', () => {
    const out = toFlatFile(working(), header(), '2026-07-20')
    const lines = out.text.trim().split('\n')
    expect(lines.map((l) => l.split('^')[0])).toEqual(['FH', 'BH', 'CD', 'DD'])
    expect(out.lineCount).toBe(4)
  })

  it('never lets a caller forget the layout is unverified', () => {
    expect(toFlatFile(working(), header(), '2026-07-20').unverifiedFormat).toBe(true)
  })

  it('writes rupees with two decimals from integer paise', () => {
    const dd = toFlatFile(working(), header(), '2026-07-20').text.split('\n').find((l) => l.startsWith('DD'))!
    expect(dd).toContain('500000.00')
    expect(dd).toContain('5000.00')
  })

  it('writes dates as DDMMYYYY', () => {
    const cd = toFlatFile(working(), header(), '2026-07-20').text.split('\n').find((l) => l.startsWith('CD'))!
    expect(cd).toContain('07072026')
  })

  it('writes PANNOTAVBL and the 206AA reason code when there is no PAN', () => {
    const dd = toFlatFile(working({ deductions: [deduction({ pan: null })] }), header(), '2026-07-20')
      .text.split('\n')
      .find((l) => l.startsWith('DD'))!
    expect(dd).toContain('PANNOTAVBL')
    expect(dd.split('^').pop()).toBe('C')
  })

  it('drops a deduction with no challan rather than inventing one', () => {
    // Writing it under a made-up challan is how an unfileable return gets filed.
    const out = toFlatFile(working({ deductions: [deduction({ challanId: null })] }), header(), '2026-07-20')
    expect(out.text).not.toContain('DD^')
  })

  it('opens one challan record per section under a challan', () => {
    const out = toFlatFile(
      working({ deductions: [deduction(), deduction({ entryId: 2, sectionCode: '194J' })] }),
      header(),
      '2026-07-20'
    )
    expect(out.text.split('\n').filter((l) => l.startsWith('CD'))).toHaveLength(2)
  })

  it('writes a header and batch even for an empty quarter', () => {
    const out = toFlatFile(working({ challans: [], deductions: [] }), header(), '2026-07-20')
    expect(out.lineCount).toBe(2)
  })
})

describe('challanTotal', () => {
  it('adds every head the challan carries', () => {
    expect(challanTotal(challan({ tax: 100, surcharge: 10, cess: 4, interest: 2, fee: 1 }))).toBe(117)
  })
})
