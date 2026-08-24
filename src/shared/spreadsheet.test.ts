import { describe, expect, it } from 'vitest'
import { buildSpreadsheet, date, money, num, sheetName, text } from './spreadsheet'

describe('sheetName', () => {
  it('strips the characters Excel refuses in a tab name', () => {
    expect(sheetName('P&L [2026]: draft/final')).toBe('P&L  2026   draft final')
  })

  it('truncates to 31 characters', () => {
    expect(sheetName('x'.repeat(40))).toHaveLength(31)
  })

  it('falls back rather than producing an unnamed tab', () => {
    expect(sheetName('///')).toBe('Sheet')
  })
})

describe('buildSpreadsheet', () => {
  const sheet = {
    name: 'Trial balance',
    header: ['Ledger', 'Debit'],
    rows: [
      { cells: [text('Cash'), money(123456)] },
      { cells: [text('Total'), money(123456)], bold: true }
    ]
  }

  it('writes money as an exact decimal number, never a float division', () => {
    const xml = buildSpreadsheet([sheet])
    // 123456 paise is 1234.56 exactly — the string comes from integer math in plainRupees.
    expect(xml).toContain('<Data ss:Type="Number">1234.56</Data>')
  })

  it('keeps a paisa that a float would lose', () => {
    const xml = buildSpreadsheet([{ name: 'S', header: ['A'], rows: [{ cells: [money(1)] }, { cells: [money(-1)] }] }])
    expect(xml).toContain('>0.01<')
    expect(xml).toContain('>-0.01<')
  })

  it('escapes XML metacharacters in cell text', () => {
    const xml = buildSpreadsheet([{ name: 'S', header: ['A'], rows: [{ cells: [text('Ram & Co <ltd>')] }] }])
    expect(xml).toContain('Ram &amp; Co &lt;ltd&gt;')
    expect(xml).not.toContain('<ltd>')
  })

  it('drops control characters, which make the whole workbook unopenable', () => {
    const xml = buildSpreadsheet([{ name: 'S', header: ['A'], rows: [{ cells: [text('a\u0007b')] }] }])
    expect(xml).toContain('>ab<')
  })

  it('gives two sheets of the same name distinct tabs', () => {
    const xml = buildSpreadsheet([
      { name: 'Ledger', header: ['A'], rows: [] },
      { name: 'Ledger', header: ['A'], rows: [] }
    ])
    expect(xml).toContain('ss:Name="Ledger"')
    expect(xml).toContain('ss:Name="Ledger (2)"')
  })

  it('writes dates as DateTime so the sheet can sort by them', () => {
    const xml = buildSpreadsheet([{ name: 'S', header: ['D'], rows: [{ cells: [date('2026-04-01')] }] }])
    expect(xml).toContain('<Data ss:Type="DateTime">2026-04-01T00:00:00.000</Data>')
  })

  it('survives an empty report — an empty period must still produce a valid workbook', () => {
    const xml = buildSpreadsheet([{ name: 'Empty', header: ['Ledger', 'Debit'], rows: [] }])
    expect(xml).toContain('<?mso-application progid="Excel.Sheet"?>')
    expect(xml).toContain('ss:Name="Empty"')
    expect(xml.trim().endsWith('</Workbook>')).toBe(true)
  })

  it('marks total rows bold with the money format kept', () => {
    const xml = buildSpreadsheet([sheet])
    expect(xml).toContain('ss:StyleID="boldMoney"')
  })

  it('writes a non-finite number as zero rather than as NaN, which Excel rejects', () => {
    const xml = buildSpreadsheet([{ name: 'S', header: ['N'], rows: [{ cells: [num(Number.NaN)] }] }])
    expect(xml).toContain('<Data ss:Type="Number">0</Data>')
  })
})
