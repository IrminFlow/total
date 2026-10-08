import { describe, expect, it } from 'vitest'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import {
  cellText, colIndex, colName, crc32, isDateFormatCode, isoToSerial, numberText, readWorkbook, readXlsx, readZip,
  safeSheetNames, serialToISO, writeXlsx, writeZip, type XlsxSheet
} from './index'

const inflate = (b: Uint8Array): Uint8Array => new Uint8Array(inflateRawSync(b))
const deflate = (b: Uint8Array): Uint8Array => new Uint8Array(deflateRawSync(b))
const enc = new TextEncoder()

describe('zip', () => {
  it('crc32 matches the reference value', () => {
    expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926)
  })
  it('round-trips stored and deflated entries', () => {
    const big = enc.encode('hello world '.repeat(500))
    const z = writeZip([{ name: 'a.txt', data: enc.encode('tiny') }, { name: 'dir/b.xml', data: big }], deflate)
    expect(z.length).toBeLessThan(big.length) // b.xml was compressed
    const files = readZip(z, inflate)
    expect(new TextDecoder().decode(files.get('a.txt'))).toBe('tiny')
    expect(files.get('dir/b.xml')).toEqual(big)
  })
  it('rejects non-zips and damaged data', () => {
    expect(() => readZip(enc.encode('not a zip file at all, definitely'), inflate)).toThrow(/Not a ZIP/)
    const z = writeZip([{ name: 'a.txt', data: enc.encode('abcdef') }])
    z[35] = z[35]! ^ 0xff // flip a byte of the stored data
    expect(() => readZip(z, inflate)).toThrow(/CRC/)
  })
  it('refuses .xls with a helpful message', () => {
    expect(() => readXlsx(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0]), inflate)).toThrow(/97–2003/)
  })
})

describe('reader helpers', () => {
  it('column refs', () => {
    expect(colIndex('A1')).toBe(0)
    expect(colIndex('Z9')).toBe(25)
    expect(colIndex('AA10')).toBe(26)
    expect(colName(0)).toBe('A')
    expect(colName(27)).toBe('AB')
    expect(colName(16383)).toBe('XFD')
  })
  it('date serials in both systems', () => {
    expect(serialToISO(45748)).toBe('2025-04-01')
    expect(serialToISO(1)).toBe('1900-01-01')
    expect(serialToISO(61)).toBe('1900-03-01')
    expect(serialToISO(0, true)).toBe('1904-01-01')
    expect(serialToISO(45748.75)).toBe('2025-04-01') // time dropped
    expect(isoToSerial('2025-04-01')).toBe(45748)
    expect(isoToSerial('1900-01-01')).toBe(1)
  })
  it('date format detection', () => {
    expect(isDateFormatCode('dd/mm/yyyy')).toBe(true)
    expect(isDateFormatCode('[$-409]d-mmm-yy;@')).toBe(true)
    expect(isDateFormatCode('#,##0.00')).toBe(false)
    expect(isDateFormatCode('"₹"#,##0.00')).toBe(false)
    expect(isDateFormatCode('0.00" days"')).toBe(false)
    expect(isDateFormatCode('General')).toBe(false)
  })
  it('number text without float noise', () => {
    expect(numberText(0.1 + 0.2)).toBe('0.3')
    expect(numberText(1234.5)).toBe('1234.5')
    expect(numberText(-0.07)).toBe('-0.07')
    expect(numberText(1e21)).toBe('1000000000000000000000')
    expect(cellText({ date: '2025-04-01' })).toBe('2025-04-01')
    expect(cellText(true)).toBe('TRUE')
  })
  it('sheet names are made safe and unique', () => {
    expect(safeSheetNames(['A/B', 'a/b', 'x'.repeat(40)])).toEqual(['A B', 'a b (2)', 'x'.repeat(31)])
  })
})

/** A hand-written workbook in the shape Excel saves: shared strings with rich text and phonetic
 *  runs, a formula with a cached value, a formula without one, inline strings, booleans, errors,
 *  sparse cells, a custom date format, the 1904 date system, and absolute rel targets. */
function handWorkbook(opts: { date1904?: boolean } = {}): Uint8Array {
  const parts: Record<string, string> = {
    '[Content_Types].xml': '<Types/>',
    'xl/workbook.xml': `<?xml version="1.0"?><workbook xmlns="x" xmlns:r="r"><workbookPr${opts.date1904 ? ' date1904="1"' : ''}/><sheets>
      <sheet name="Ledgers &amp; Co" sheetId="1" r:id="rId1"/><sheet name="Second" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/>
      <Relationship Id="rId2" Type="ws" Target="/xl/worksheets/other.xml"/></Relationships>`,
    'xl/sharedStrings.xml': `<sst count="4" uniqueCount="4"><si><t>Name</t></si><si><t>Date</t></si>
      <si><r><rPr><b/></rPr><t>Acme </t></r><r><t xml:space="preserve">&amp; Sons</t></r><rPh><t>ignored</t></rPh></si><si><t>Amount</t></si></sst>`,
    'xl/styles.xml': `<styleSheet><numFmts count="1"><numFmt numFmtId="200" formatCode="dd\\-mmm\\-yyyy"/></numFmts>
      <cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="200"/><xf numFmtId="4"/><xf numFmtId="14"></xf></cellXfs></styleSheet>`,
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>3</v></c></row>
      <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" s="1"><v>45748</v></c><c r="C2" s="2"><f>SUM(1,2)</f><v>1234.5</v></c></row>
      <row r="4"><c r="A4" t="inlineStr"><is><t>Inline</t></is></c><c r="C4"><f>A1*2</f></c><c r="D4" t="b"><v>1</v></c><c r="E4" t="e"><v>#N/A</v></c></row>
      <row r="5"><c r="B5" s="3"><v>45749</v></c><c r="C5" t="str"><f>"x"</f><v>calc text</v></c></row>
    </sheetData></worksheet>`,
    'xl/worksheets/other.xml': `<worksheet><sheetData><row><c><v>7</v></c><c t="d"><v>2025-05-06T00:00:00</v></c></row></sheetData></worksheet>`
  }
  return writeZip(Object.entries(parts).map(([name, xml]) => ({ name, data: enc.encode(xml) })), deflate)
}

describe('readXlsx', () => {
  it('reads shared strings (rich text), dates, cached formula values, inline strings, sparse rows', () => {
    const wb = readXlsx(handWorkbook(), inflate)
    expect(wb.sheets.map((s) => s.name)).toEqual(['Ledgers & Co', 'Second'])
    const rows = wb.sheets[0]!.rows
    expect(rows.map((r) => r.r)).toEqual([1, 2, 4, 5])
    expect(rows[0]!.cells).toEqual(['Name', 'Date', 'Amount'])
    expect(rows[1]!.cells).toEqual(['Acme & Sons', { date: '2025-04-01' }, 1234.5])
    // Formula without a cached value reads empty; error cells read empty; booleans stay booleans.
    expect(rows[2]!.cells).toEqual(['Inline', null, null, true])
    expect(rows[3]!.cells).toEqual([null, { date: '2025-04-02' }, 'calc text'])
    expect(wb.sheets[1]!.rows[0]!.cells).toEqual([7, { date: '2025-05-06' }])
  })
  it('honours the 1904 date system', () => {
    const wb = readXlsx(handWorkbook({ date1904: true }), inflate)
    expect(wb.sheets[0]!.rows[1]!.cells[1]).toEqual({ date: serialToISO(45748, true) })
  })
  it('can parse only the sheets asked for', () => {
    const wb = readXlsx(handWorkbook(), inflate, { onlySheets: ['Second'] })
    expect(wb.sheets.map((s) => s.name)).toEqual(['Second'])
  })
  it('explains a missing workbook part', () => {
    expect(() => readWorkbook(() => undefined)).toThrow(/workbook\.xml missing/)
  })
})

describe('writeXlsx round trip', () => {
  const sheet: XlsxSheet = {
    name: 'Day book',
    preamble: ['Demo Traders', 'Day book · 01-04-2025 to 31-03-2026'],
    columns: [
      { header: 'Date', kind: 'date' },
      { header: 'Party', kind: 'text' },
      { header: 'Amount', kind: 'money' },
      { header: 'Qty', kind: 'qty', decimals: 2 },
      { header: 'Count', kind: 'integer' }
    ],
    rows: [
      ['2025-04-01', 'Acme & <Sons> "Ltd"', 123450, 12500, 3],
      ['2025-04-02', 'Acme & <Sons> "Ltd"', -5, 1, 0],
      { cells: ['', 'Total', 123445, null, 3], bold: true },
      ['2025-04-03', ' padded ', 1, 1000, null]
    ]
  }

  it('writes typed cells that read back exactly (shared strings de-duplicated)', () => {
    const bytes = writeXlsx([sheet, { name: 'Day book', columns: [{ header: 'X', kind: 'text' }], rows: [['y']] }], deflate)
    const wb = readXlsx(bytes, inflate)
    expect(wb.sheets.map((s) => s.name)).toEqual(['Day book', 'Day book (2)'])
    const rows = wb.sheets[0]!.rows
    expect(rows[0]!.cells).toEqual(['Demo Traders'])
    expect(rows[2]!.r).toBe(4) // header after the preamble + a spacer row
    expect(rows[2]!.cells).toEqual(['Date', 'Party', 'Amount', 'Qty', 'Count'])
    expect(rows[3]!.cells).toEqual([{ date: '2025-04-01' }, 'Acme & <Sons> "Ltd"', 1234.5, 12.5, 3])
    expect(rows[4]!.cells).toEqual([{ date: '2025-04-02' }, 'Acme & <Sons> "Ltd"', -0.05, 0.001, 0])
    expect(rows[5]!.cells).toEqual([null, 'Total', 1234.45, null, 3])
    expect(rows[6]!.cells[1]).toBe(' padded ')
  })

  it('declares the money, date and quantity formats', () => {
    const files = readZip(writeXlsx([sheet]), inflate)
    const styles = new TextDecoder().decode(files.get('xl/styles.xml'))
    expect(styles).toContain('formatCode="&quot;₹&quot;#,##0.00')
    expect(styles).toContain('formatCode="dd-mm-yyyy"')
    expect(styles).toContain('formatCode="#,##0.00"')
    const xml = new TextDecoder().decode(files.get('xl/worksheets/sheet1.xml'))
    expect(xml).toContain('state="frozen"')
    expect(xml).toContain('<autoFilter ref="A4:E8"/>')
    expect(files.has('xl/sharedStrings.xml')).toBe(true)
  })

  it('handles a large sheet (50 000 rows) in reasonable time', () => {
    const rows = Array.from({ length: 50000 }, (_, i) => [`2025-04-${String((i % 28) + 1).padStart(2, '0')}`, `Party ${i % 500}`, i * 101, i, i])
    const t0 = Date.now()
    const bytes = writeXlsx([{ name: 'Big', columns: sheet.columns, rows }], deflate)
    const wb = readXlsx(bytes, inflate)
    const elapsed = Date.now() - t0
    expect(wb.sheets[0]!.rows.length).toBe(50001)
    // 49999 % 28 + 1 = 20; 49999 × 101 paise = ₹50,498.99; 49999 thousandths = 49.999.
    expect(wb.sheets[0]!.rows[50000]!.cells).toEqual([{ date: '2025-04-20' }, 'Party 499', 50498.99, 49.999, 49999])
    expect(elapsed).toBeLessThan(20000)
  }, 30000)
})
