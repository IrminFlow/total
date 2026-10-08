import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { deflateRawSync } from 'zlib'
import { inflateRaw, zipEntries } from './zip'
import { readXlsx, excelSerialToISO, columnIndex } from './xlsx'
import { parseXml, textOf, descendants } from './xml'
import { parseMt940 } from './mt940'
import { parseCamt053 } from './camt053'
import { parsePastedStatement } from './pasted'
import { detectFormat, parseStatementFile, tabularGrid, detectProfile, gridToStatement, importHashes, parseBankAmount, parseBankDate, decodeBytes } from './index'

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(join(__dirname, 'fixtures', name)))

describe('quirks: dates', () => {
  it('reads Indian and ISO date styles', () => {
    expect(parseBankDate('15/08/2026')).toBe('2026-08-15')
    expect(parseBankDate('15-08-26')).toBe('2026-08-15')
    expect(parseBankDate('15.08.2026')).toBe('2026-08-15')
    expect(parseBankDate('15-Aug-2026')).toBe('2026-08-15')
    expect(parseBankDate('1 Aug 2026')).toBe('2026-08-01')
    expect(parseBankDate('15 August 26')).toBe('2026-08-15')
    expect(parseBankDate('Sept 3, 2026')).toBe('2026-09-03')
    expect(parseBankDate('2026-08-15')).toBe('2026-08-15')
    expect(parseBankDate('2026-08-15T10:22:00')).toBe('2026-08-15')
    expect(parseBankDate('15/08/2026 10:22:31')).toBe('2026-08-15')
  })
  it('honours an explicit US order and rejects impossible dates', () => {
    expect(parseBankDate('08/15/2026', 'MM/DD/YYYY')).toBe('2026-08-15')
    expect(parseBankDate('08/15/2026')).toBeNull() // day-first: month 15
    expect(parseBankDate('31/02/2026')).toBeNull()
    expect(parseBankDate('15082026', 'DD/MM/YYYY')).toBe('2026-08-15')
    expect(parseBankDate('OPENING BALANCE')).toBeNull()
    expect(parseBankDate('')).toBeNull()
  })
})

describe('quirks: amounts', () => {
  it('handles rupee symbols, Indian grouping, Dr/Cr, parentheses and trailing minus', () => {
    expect(parseBankAmount('₹1,23,456.78')).toEqual({ paise: 12345678, flag: null })
    expect(parseBankAmount('Rs. 500')).toEqual({ paise: 50000, flag: null })
    expect(parseBankAmount('INR 1,000.5')).toEqual({ paise: 100050, flag: null })
    expect(parseBankAmount('1,000.00 Cr')).toEqual({ paise: 100000, flag: 'cr' })
    expect(parseBankAmount('2,500.00Dr')).toEqual({ paise: 250000, flag: 'dr' })
    expect(parseBankAmount('Dr 250')).toEqual({ paise: 25000, flag: 'dr' })
    expect(parseBankAmount('(1,234.50)')).toEqual({ paise: -123450, flag: null })
    expect(parseBankAmount('1234.50-')).toEqual({ paise: -123450, flag: null })
    expect(parseBankAmount('-0.75')).toEqual({ paise: -75, flag: null })
    expect(parseBankAmount('1.234,56', true)).toEqual({ paise: 123456, flag: null })
    expect(parseBankAmount('1234,', true)).toEqual({ paise: 123400, flag: null })
    expect(parseBankAmount('0.105')).toEqual({ paise: 11, flag: null })
  })
  it('treats blanks and dashes as no amount', () => {
    for (const s of ['', ' ', '-', '--', 'NIL', 'abc']) expect(parseBankAmount(s)).toBeNull()
  })
})

describe('quirks: duplicate hashes', () => {
  it('are stable across imports and keep identical same-day lines apart', () => {
    const line = { date: '2026-08-09', deposit: 0, withdrawal: 249900, description: 'ACH D- ICICI PRU' }
    const a = importHashes([line, { ...line }, { ...line, description: 'other' }])
    const b = importHashes([{ ...line, description: '  ach d-  icici pru ' }, line])
    expect(new Set(a).size).toBe(3)
    expect(b).toEqual([a[0], a[1]])
  })
  it('decodes BOMs and Windows-1252', () => {
    expect(decodeBytes(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))).toBe('A')
    expect(decodeBytes(new Uint8Array([0xff, 0xfe, 0x41, 0x00]))).toBe('A')
    expect(decodeBytes(new Uint8Array([0x80, 0x41]), 'windows-1252')).toBe('€A')
  })
})

describe('CSV / TXT', () => {
  it('HDFC-style CSV: skips the preamble, joins continuation lines, drops opening balance rows', () => {
    const r = parseStatementFile({ fileName: 'hdfc.csv', bytes: fixture('hdfc-style.csv') })
    expect(r.format).toBe('csv')
    expect(r.profile).toMatchObject({ headerRow: 6, dateCol: 0, descCols: [1], refCol: 2, valueDateCol: 3, debitCol: 4, creditCol: 5, balanceCol: 6, amountMode: 'split' })
    expect(r.lines).toHaveLength(6)
    expect(r.lines[0]).toEqual({
      date: '2026-08-02', valueDate: '2026-08-02', description: 'NEFT CR-ICIC0000104-ACME TRADERS PVT LTD-NETBANK',
      reference: 'N214262871234567', deposit: 2500000, withdrawal: 0, balance: 17500000
    })
    expect(r.lines[2]!.description).toBe('CHQ PAID-MICR CTS-CH-SHREE PACKAGING ADDITIONAL NARRATION FOR CHEQUE 000123')
    expect(r.lines[2]!.withdrawal).toBe(745050)
    expect(r.warnings.join(' ')).toMatch(/continuation/)
    // The two identical ACH debits on the same day are both kept, with different hashes.
    expect(new Set(importHashes(r.lines)).size).toBe(6)
  })

  it('SBI-style tab-delimited TXT with day-month-name dates', () => {
    const r = parseStatementFile({ fileName: 'sbi.txt', bytes: fixture('sbi-style.txt') })
    expect(r.profile?.delimiter).toBe('\t')
    expect(r.lines.map((l) => [l.date, l.deposit, l.withdrawal, l.reference])).toEqual([
      ['2026-08-01', 4000000, 0, 'TRANSFER FROM 3199'],
      ['2026-08-04', 0, 65000, 'TRANSFER TO 4897'],
      ['2026-08-06', 0, 1500000, '000457']
    ])
  })

  it('semicolon file with a Dr/Cr indicator column and a negative balance', () => {
    const r = parseStatementFile({ fileName: 'flag.csv', bytes: fixture('flag-style.csv') })
    expect(r.profile).toMatchObject({ delimiter: ';', amountMode: 'flag', amountCol: 2, flagCol: 3, balanceCol: 4 })
    expect(r.lines.map((l) => [l.deposit, l.withdrawal, l.balance])).toEqual([
      [825000, 0, 5825000],
      [0, 1770, 5823230],
      [0, 25000000, -19176770]
    ])
  })

  it('a saved profile overrides detection (signed column, negative = deposit)', () => {
    const csv = 'when,what,amt\n01-08-2026,refund,-100\n02-08-2026,fee,25'
    const bytes = new TextEncoder().encode(csv)
    const { grid } = tabularGrid('csv', bytes)
    expect(detectProfile(grid)).toBeNull() // no recognisable header
    const r = gridToStatement(grid, {
      delimiter: ',', encoding: 'utf-8', headerRow: 1, dateFormat: 'DD/MM/YYYY', dateCol: 0, valueDateCol: null, descCols: [1], refCol: null,
      amountMode: 'signed', debitCol: null, creditCol: null, amountCol: 2, flagCol: null, balanceCol: null, signedNegativeIsDeposit: true
    }, 'csv')
    expect(r.lines.map((l) => [l.description, l.deposit, l.withdrawal])).toEqual([['refund', 10000, 0], ['fee', 0, 2500]])
  })

  it('without a usable header, asks for a manual mapping instead of guessing', () => {
    const r = parseStatementFile({ fileName: 'x.csv', text: 'a,b\n1,2' })
    expect(r.lines).toEqual([])
    expect(r.profile).toBeNull()
    expect(r.warnings[0]).toMatch(/map the columns/)
  })
})

describe('XLSX (zero-dependency reader)', () => {
  it('inflates both fixed and dynamic Huffman blocks', () => {
    const text = Array.from({ length: 4000 }, (_, i) => `line ${i} ${'abcdefghij'.slice(i % 10)} ${(i * 7919) % 1000}`).join('\n')
    const raw = new TextEncoder().encode(text)
    for (const level of [0, 1, 9]) expect(new TextDecoder().decode(inflateRaw(new Uint8Array(deflateRawSync(raw, { level }))))).toBe(text)
    expect(new TextDecoder().decode(inflateRaw(new Uint8Array(deflateRawSync(new TextEncoder().encode('hi')))))).toBe('hi')
  })

  it('reads the Python-generated workbook: shared + rich + inline strings, date styles, sparse cells', () => {
    const bytes = fixture('statement.xlsx')
    expect(zipEntries(bytes).map((e) => e.name)).toContain('xl/worksheets/sheet1.xml')
    const sheet = readXlsx(bytes)
    expect(sheet.name).toBe('Statement')
    expect(sheet.rows[0]).toEqual(['ICICI Bank - Detailed Statement'])
    expect(sheet.rows[1]).toEqual([])
    expect(sheet.rows[3]).toEqual(['2026-08-02', 'NEFT-ICIC0000104-ACME TRADERS PVT LTD', '', '', '25000', '175000'])
    expect(sheet.rows[4]![0]).toBe('2026-08-03') // custom dd-mmm-yyyy format
    expect(sheet.rows[5]!.slice(0, 3)).toEqual(['05/08/2026', 'CHQ PAID SHREE & CO', '000123'])
  })

  it('maps the workbook like a CSV', () => {
    const r = parseStatementFile({ fileName: 'icici.xlsx', bytes: fixture('statement.xlsx') })
    expect(r.format).toBe('xlsx')
    expect(r.lines.map((l) => [l.date, l.deposit, l.withdrawal, l.reference, l.balance])).toEqual([
      ['2026-08-02', 2500000, 0, '', 17500000],
      ['2026-08-03', 0, 1800000, '', 15700000],
      ['2026-08-05', 0, 745050, '000123', 14954950]
    ])
  })

  it('serial dates and column letters', () => {
    expect(excelSerialToISO(46236)).toBe('2026-08-02')
    expect(excelSerialToISO(1)).toBe('1900-01-01')
    expect(excelSerialToISO(0, true)).toBe('1904-01-01')
    expect(columnIndex('A1')).toBe(0)
    expect(columnIndex('AB12')).toBe(27)
  })

  it('rejects non-zip input and legacy .xls / PDF with plain-language errors', () => {
    expect(() => readXlsx(new Uint8Array([1, 2, 3]))).toThrow(/Not a ZIP/)
    expect(() => detectFormat('old.xls', new Uint8Array([0xd0, 0xcf]))).toThrow(/save as \.xlsx/)
    expect(() => detectFormat('s.pdf', new TextEncoder().encode('%PDF-1.7'))).toThrow(/copy/)
  })
})

describe('MT940', () => {
  it('reads :61: subfields, :86: narratives (structured ?NN flattened), balances and reversals', () => {
    const bytes = fixture('statement.sta')
    expect(detectFormat('statement.sta', bytes)).toBe('mt940')
    const r = parseMt940(new TextDecoder().decode(bytes))
    expect(r.account).toBe('50100012345678')
    expect(r.currency).toBe('INR')
    expect(r.openingBalance).toBe(15000000)
    expect(r.closingBalance).toBe(15004950)
    expect(r.lines).toEqual([
      { date: '2026-08-02', valueDate: '2026-08-02', description: 'NEFT CR ACME TRADERS PVT LTD INV 1021 AND 1022 NEFT INWARD', reference: 'N214262871234', deposit: 2500000, withdrawal: 0, balance: null },
      { date: '2026-08-03', valueDate: '2026-08-03', description: 'UPI RAVI KUMAR RENT AUG', reference: 'UPI321456789012', deposit: 0, withdrawal: 1800000, balance: null },
      { date: '2026-08-05', valueDate: '2026-08-05', description: 'CHQ PAID SHREE PACKAGING', reference: '000123', deposit: 0, withdrawal: 745050, balance: null },
      { date: '2026-08-09', valueDate: '2026-08-09', description: 'REVERSAL OF CHARGES', reference: 'REV0001', deposit: 50000, withdrawal: 0, balance: null }
    ])
  })

  it('handles an entry date across the year boundary and skips unreadable :61: lines', () => {
    const r = parseMt940(':20:X\n:25:ACC\n:60F:C251231INR0,\n:61:2512310101C100,NTRFREF1\n:86:NEW YEAR\n:61:garbage\n:62F:C260101INR100,')
    expect(r.lines[0]!.date).toBe('2026-01-01')
    expect(r.lines[0]!.valueDate).toBe('2025-12-31')
    expect(r.warnings[0]).toMatch(/could not be read/)
  })
})

describe('CAMT.053', () => {
  it('reads booked entries, skips pending ones, picks party + remittance info and cheque numbers', () => {
    const bytes = fixture('camt053.xml')
    expect(detectFormat('stmt.xml', bytes)).toBe('camt053')
    const r = parseCamt053(new TextDecoder().decode(bytes))
    expect(r.account).toBe('50100012345678')
    expect(r.openingBalance).toBe(15000000)
    expect(r.closingBalance).toBe(14954950)
    expect(r.lines).toEqual([
      { date: '2026-08-02', valueDate: '2026-08-02', description: 'ACME TRADERS PVT LTD INV 1021 & 1022', reference: 'N214262871234', deposit: 2500000, withdrawal: 0, balance: null },
      { date: '2026-08-05', valueDate: '2026-08-05', description: 'SHREE PACKAGING CHQ PAID CTS', reference: '000123', deposit: 0, withdrawal: 745050, balance: null }
    ])
    expect(r.warnings[0]).toMatch(/pending/)
  })

  it('xml reader: prefixes, entities, CDATA, comments', () => {
    const doc = parseXml('<?xml version="1.0"?><!-- c --><a:Root xmlns:a="x"><a:B k="1&amp;2">t&lt;<![CDATA[<raw>]]></a:B><a:B/></a:Root>')
    expect(doc.local).toBe('Root')
    expect(descendants(doc, 'B')).toHaveLength(2)
    expect(textOf(descendants(doc, 'B')[0])).toBe('t<<raw>')
    expect(descendants(doc, 'B')[0]!.attrs['k']).toBe('1&2')
  })
})

describe('copied-from-PDF text', () => {
  it('derives direction from the running balance, joins continuations, ignores page furniture', () => {
    const r = parsePastedStatement(new TextDecoder().decode(fixture('pasted-pdf.txt')))
    expect(r.openingBalance).toBe(15000000)
    expect(r.lines.map((l) => [l.date, l.deposit, l.withdrawal])).toEqual([
      ['2026-08-02', 2500000, 0],
      ['2026-08-03', 0, 1800000],
      ['2026-08-05', 0, 745050],
      ['2026-08-07', 1250000, 0],
      ['2026-08-08', 50000, 0]
    ])
    expect(r.lines[0]!.valueDate).toBe('2026-08-02')
    expect(r.lines[2]!.description).toBe('CHQ PAID CHQ NO 000123 000123 SHREE PACKAGING JULY BILL')
    expect(r.lines[2]!.reference).toBe('000123')
    expect(r.warnings).toEqual([])
  })

  it('warns when nothing tells the direction', () => {
    const r = parsePastedStatement('02/08/2026 SOMETHING 1,000.00')
    expect(r.lines[0]!.withdrawal).toBe(100000)
    expect(r.warnings[0]).toMatch(/check them/)
  })
})
