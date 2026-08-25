import { describe, expect, it } from 'vitest'
import {
  challanTotal,
  FILE_FORMAT,
  FILE_FORMAT_FIELD_COUNTS,
  form16aDueDate,
  returnSectionCode,
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
  paidOn: '2025-07-07',
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
  paidOn: '2025-06-10',
  deductedOn: '2025-06-10',
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
  // FY 2025-26: the last year the 24Q/26Q file format covers. FY 2026-27 is Form 138/140, and
  // `validateReturn` blocks it — see the test below.
  fyStartYear: 2025,
  quarter: 1,
  label: 'Q1 FY2025-26',
  from: '2025-04-01',
  to: '2025-06-30',
  dueDate: '2025-07-31',
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
    const issues = validateReturn(
      working({ deductions: [deduction({ sectionCode: '194C', sectionUnverified: true })] }),
      header()
    )
    expect(issues.some((i) => i.message.includes('Income-tax Act 2025'))).toBe(true)
  })

  it('blocks a quarter for a year the 24Q/26Q format does not cover', () => {
    // Protean's own page: the 24Q/26Q formats apply up to FY 2025-26. From tax year 2026-27 the
    // statements are Form Number 138 and Form Number 140.
    const issues = validateReturn(working({ fyStartYear: 2026 }), header())
    const forms = issues.find((i) => i.message.includes('Form Number 140'))
    expect(forms?.severity).toBe('blocking')
  })

  it('blocks a 24Q for the fourth quarter, which needs Annexure II', () => {
    const issues = validateReturn(working({ form: '24Q', quarter: 4 }), header())
    expect(issues.some((i) => i.severity === 'blocking' && i.message.includes('Annexure II'))).toBe(true)
  })

  it('blocks a section the return has no Annexure 2 code for', () => {
    // Bare 194J has no code of its own: the return wants 4JA or 4JB, and the amount does not say
    // which. Guessing would report the deduction under a provision it was not made under.
    const issues = validateReturn(working({ deductions: [deduction({ sectionCode: '194J' })] }), header())
    const s = issues.find((i) => i.message.includes('194J'))
    expect(s?.severity).toBe('blocking')
    expect(s?.message).toContain('Annexure 2')
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

describe('FILE_FORMAT', () => {
  it('has the field counts the published workbooks have', () => {
    // Protean File Format Form 26Q v7.8 / 24Q v6.3, 27 May 2025. These four numbers are the whole
    // reason a caret-delimited file is accepted or rejected: General Note 10 says the delimiter
    // count must be one less than the field count of the record.
    expect(FILE_FORMAT.fileHeader).toHaveLength(FILE_FORMAT_FIELD_COUNTS.fileHeader)
    expect(FILE_FORMAT.batchHeader).toHaveLength(FILE_FORMAT_FIELD_COUNTS.batchHeader)
    expect(FILE_FORMAT.challan).toHaveLength(FILE_FORMAT_FIELD_COUNTS.challan)
    expect(FILE_FORMAT.deductee).toHaveLength(FILE_FORMAT_FIELD_COUNTS.deductee)
  })

  it('no longer calls itself version 0', () => {
    expect(FILE_FORMAT.version.startsWith('0-')).toBe(false)
    expect(FILE_FORMAT.source).toContain('Protean')
  })

  it('puts the named fields at the Sr. No. the workbook gives them', () => {
    // Spot-checks by ABSOLUTE POSITION, because `indexOf` elsewhere in these tests only proves the
    // file agrees with the array — not that the array agrees with Protean. Sr. No. is 1-based.
    const at = (layout: readonly string[], srNo: number): string => layout[srNo - 1]!
    expect(at(FILE_FORMAT.fileHeader, 2)).toBe('recordType')
    expect(at(FILE_FORMAT.fileHeader, 3)).toBe('fileType')
    expect(at(FILE_FORMAT.fileHeader, 8)).toBe('tan')
    expect(at(FILE_FORMAT.batchHeader, 5)).toBe('formNumber')
    expect(at(FILE_FORMAT.batchHeader, 13)).toBe('tan')
    expect(at(FILE_FORMAT.batchHeader, 18)).toBe('period')
    expect(at(FILE_FORMAT.batchHeader, 32)).toBe('deductorType')
    expect(at(FILE_FORMAT.batchHeader, 51)).toBe('aoApproval')
    expect(at(FILE_FORMAT.batchHeader, 59)).toBe('responsiblePan')
    expect(at(FILE_FORMAT.batchHeader, 69)).toBe('gstin')
    expect(at(FILE_FORMAT.challan, 6)).toBe('nilChallanIndicator')
    expect(at(FILE_FORMAT.challan, 16)).toBe('bsrCodeOr24gReceipt')
    expect(at(FILE_FORMAT.challan, 18)).toBe('challanDate')
    expect(at(FILE_FORMAT.challan, 39)).toBe('fee')
    expect(at(FILE_FORMAT.challan, 40)).toBe('minorHead')
    expect(at(FILE_FORMAT.deductee, 8)).toBe('deducteeCode')
    expect(at(FILE_FORMAT.deductee, 10)).toBe('deducteePan')
    expect(at(FILE_FORMAT.deductee, 13)).toBe('deducteeName')
    expect(at(FILE_FORMAT.deductee, 22)).toBe('amountPaid')
    expect(at(FILE_FORMAT.deductee, 26)).toBe('rate')
    expect(at(FILE_FORMAT.deductee, 30)).toBe('remarks1')
    expect(at(FILE_FORMAT.deductee, 33)).toBe('sectionCode')
    expect(at(FILE_FORMAT.deductee, 43)).toBe('cash194n')
  })

  it('names every field slot at most once, so nothing can be written twice', () => {
    for (const layout of [FILE_FORMAT.fileHeader, FILE_FORMAT.batchHeader, FILE_FORMAT.challan, FILE_FORMAT.deductee]) {
      const named = layout.filter((f) => f !== '')
      expect(new Set(named).size).toBe(named.length)
    }
  })
})

describe('returnSectionCode', () => {
  it('writes the three-character Annexure 2 code, not the section number', () => {
    expect(returnSectionCode('194C')).toBe('94C')
    expect(returnSectionCode('194H')).toBe('94H')
    expect(returnSectionCode('194Q')).toBe('94Q')
    expect(returnSectionCode('192A')).toBe('2AA')
  })

  it('keeps 194I(a) and 194IA apart, which stripping brackets would not', () => {
    // 194IA is transfer of immovable property and goes in as '9IA'. 194I(a) is rent on plant and
    // machinery and goes in as '4IA'. Both normalise to '194IA' if the brackets are thrown away.
    expect(returnSectionCode('194IA')).toBe('9IA')
    expect(returnSectionCode('194I(a)')).toBe('4IA')
    expect(returnSectionCode('194I(b)')).toBe('4IB')
  })

  it('refuses bare 194I and bare 194J rather than picking a limb', () => {
    expect(returnSectionCode('194I')).toBeNull()
    expect(returnSectionCode('194J')).toBeNull()
    expect(returnSectionCode('194J(b)')).toBe('4JB')
  })

  it('accepts the ways a master actually spells a section', () => {
    expect(returnSectionCode('sec 194C')).toBe('94C')
    expect(returnSectionCode(' 194 c ')).toBe('94C')
    expect(returnSectionCode('Section 194-C')).toBe('94C')
    expect(returnSectionCode('194 I (b)')).toBe('4IB')
  })

  it('returns null for a section with no Annexure 2 entry rather than inventing one', () => {
    expect(returnSectionCode('195')).toBeNull()
    expect(returnSectionCode('206AA')).toBeNull()
  })
})

describe('toFlatFile', () => {
  const rec = (text: string, type: string): string | undefined =>
    text.split('\r\n').find((l) => l.split('^')[1] === type)

  it('writes a header, a batch, a challan and a deductee', () => {
    const out = toFlatFile(working(), header(), '2026-07-20')
    const lines = out.text.split('\r\n').filter(Boolean)
    // Field 1 is the line number and field 2 is the record type — the record type is NOT first.
    expect(lines.map((l) => l.split('^')[1])).toEqual(['FH', 'BH', 'CD', 'DD'])
    expect(lines.map((l) => l.split('^')[0])).toEqual(['1', '2', '3', '4'])
    expect(out.lineCount).toBe(4)
  })

  it('writes one delimiter fewer than the field count, in every record', () => {
    // General Note 10. This is the check the FVU makes first, and the layout this file used to
    // carry failed it on every line.
    const out = toFlatFile(working(), header(), '2026-07-20')
    const counts: Record<string, number> = {
      FH: FILE_FORMAT_FIELD_COUNTS.fileHeader,
      BH: FILE_FORMAT_FIELD_COUNTS.batchHeader,
      CD: FILE_FORMAT_FIELD_COUNTS.challan,
      DD: FILE_FORMAT_FIELD_COUNTS.deductee
    }
    for (const line of out.text.split('\r\n').filter(Boolean)) {
      const type = line.split('^')[1]!
      expect(line.split('^')).toHaveLength(counts[type]!)
      expect(line.split('^').length - 1).toBe(counts[type]! - 1)
    }
  })

  it('ends every record with CRLF, including the last', () => {
    // General Note 2: Hex Values "0D" and "0A". This used to be a bare LF.
    const out = toFlatFile(working(), header(), '2026-07-20')
    expect(out.text.endsWith('\r\n')).toBe(true)
    expect(out.text.split('\n').length - 1).toBe(out.text.split('\r\n').length - 1)
  })

  it('marks a 26Q NS1 and a 24Q SL1', () => {
    expect(rec(toFlatFile(working(), header(), '2026-07-20').text, 'FH')!.split('^')[2]).toBe('NS1')
    expect(rec(toFlatFile(working({ form: '24Q' }), header(), '2026-07-20').text, 'FH')!.split('^')[2]).toBe('SL1')
  })

  it('names what it left blank instead of filling it in', () => {
    const out = toFlatFile(working(), header(), '2026-07-20')
    expect(out.unverifiedFormat).toBe(true)
    expect(out.blankMandatoryFields).toContain('PAN of Responsible Person')
    expect(out.blankMandatoryFields).toContain('Mobile number')
    // And it really is blank in the file, not filled with something plausible.
    const bh = rec(out.text, 'BH')!.split('^')
    expect(bh[FILE_FORMAT.batchHeader.indexOf('responsiblePan')]).toBe('')
    expect(bh[FILE_FORMAT.batchHeader.indexOf('deductorStateCode')]).toBe('')
  })

  it('writes rupees with two decimals from integer paise', () => {
    const dd = rec(toFlatFile(working(), header(), '2026-07-20').text, 'DD')!.split('^')
    expect(dd[FILE_FORMAT.deductee.indexOf('amountPaid')]).toBe('500000.00')
    expect(dd[FILE_FORMAT.deductee.indexOf('tax')]).toBe('5000.00')
  })

  it('writes the rate to four decimals, as the format asks', () => {
    const dd = rec(toFlatFile(working(), header(), '2026-07-20').text, 'DD')!.split('^')
    expect(dd[FILE_FORMAT.deductee.indexOf('rate')]).toBe('1.0000')
  })

  it('writes dates as DDMMYYYY', () => {
    const cd = rec(toFlatFile(working(), header(), '2026-07-20').text, 'CD')!.split('^')
    expect(cd[FILE_FORMAT.challan.indexOf('challanDate')]).toBe('07072025')
  })

  it('writes the section as its Annexure 2 code', () => {
    const dd = rec(toFlatFile(working(), header(), '2026-07-20').text, 'DD')!.split('^')
    expect(dd[FILE_FORMAT.deductee.indexOf('sectionCode')]).toBe('94C')
    expect(dd).not.toContain('194C')
  })

  it('writes PANNOTAVBL, a deductee reference and the Annexure 6 "C" remark when there is no PAN', () => {
    const dd = rec(toFlatFile(working({ deductions: [deduction({ pan: null })] }), header(), '2026-07-20').text, 'DD')!.split('^')
    expect(dd[FILE_FORMAT.deductee.indexOf('deducteePan')]).toBe('PANNOTAVBL')
    expect(dd[FILE_FORMAT.deductee.indexOf('deducteeRefNo')]).toBe('1')
    expect(dd[FILE_FORMAT.deductee.indexOf('remarks1')]).toBe('C')
  })

  it('leaves the remark empty when the PAN is good, rather than guessing another code', () => {
    const dd = rec(toFlatFile(working(), header(), '2026-07-20').text, 'DD')!.split('^')
    expect(dd[FILE_FORMAT.deductee.indexOf('remarks1')]).toBe('')
  })

  it('drops a deduction with no challan rather than inventing one', () => {
    // Writing it under a made-up challan is how an unfileable return gets filed.
    const out = toFlatFile(working({ deductions: [deduction({ challanId: null })] }), header(), '2026-07-20')
    expect(rec(out.text, 'DD')).toBeUndefined()
  })

  it('opens one challan record per section under a challan', () => {
    const out = toFlatFile(
      working({ deductions: [deduction(), deduction({ entryId: 2, sectionCode: '194H' })] }),
      header(),
      '2026-07-20'
    )
    expect(out.text.split('\r\n').filter((l) => l.split('^')[1] === 'CD')).toHaveLength(2)
  })

  it('writes a header and batch even for an empty quarter', () => {
    const out = toFlatFile(working({ challans: [], deductions: [] }), header(), '2026-07-20')
    expect(out.lineCount).toBe(2)
  })
})
