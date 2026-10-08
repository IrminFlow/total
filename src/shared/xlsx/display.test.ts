import { describe, expect, it } from 'vitest'
import { displayAmount, displayTableToSheet } from './display'

describe('display table → typed sheet (report packs)', () => {
  it('parses formatPaise amounts exactly, Dr positive', () => {
    expect(displayAmount('1,23,456.78')).toBe(12345678)
    expect(displayAmount('500.00 Cr')).toBe(-50000)
    expect(displayAmount('500.00 Dr')).toBe(50000)
    expect(displayAmount('-0.05')).toBe(-5)
    expect(displayAmount('–')).toBe(0)
    expect(displayAmount('1.25')).toBe(125)
    expect(displayAmount('12.5%')).toBeNull()
    expect(displayAmount('2025-04-01')).toBeNull()
  })

  it('types only right-aligned columns made entirely of amounts; ratios and labels stay text', () => {
    const sheet = displayTableToSheet(
      {
        title: 'Trial balance',
        columns: [{ label: 'Ledger', align: 'l' }, { label: 'Balance', align: 'r' }, { label: 'Ratio', align: 'r' }],
        rows: [
          { cells: ['Cash', '1,000.00 Dr', '1.5x'] },
          { cells: ['Capital', '1,000.00 Cr', '–'] },
          { cells: ['Total', '–', ''], bold: true }
        ]
      },
      ['Demo Traders', 'Trial balance']
    )
    expect(sheet.columns.map((c) => `${c.header}:${c.kind}`)).toEqual(['Ledger:text', 'Balance (Dr + / Cr −):amount', 'Ratio:text'])
    expect(sheet.rows).toEqual([
      { bold: undefined, cells: ['Cash', 100000, '1.5x'] },
      { bold: undefined, cells: ['Capital', -100000, '–'] },
      { bold: true, cells: ['Total', 0, null] }
    ])
    expect(sheet.preamble).toEqual(['Demo Traders', 'Trial balance'])
  })
})
