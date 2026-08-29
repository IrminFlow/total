import { describe, expect, it } from 'vitest'
import { parseVoucherClipboard } from './voucherClipboard'

describe('parseVoucherClipboard', () => {
  it('parses headered TSV into integer paise', () => {
    expect(parseVoucherClipboard('Ledger\tDebit\tCredit\nRent\t1,234.50\t\nBank\t\t1,234.50').lines).toEqual([
      { ledgerName: 'Rent', drCr: 'dr', amount: 123450, row: 2 },
      { ledgerName: 'Bank', drCr: 'cr', amount: 123450, row: 3 },
    ])
  })
  it('rejects ambiguous and fractional-paise values', () => {
    const result = parseVoucherClipboard('Rent\t100\t100\nTax\t1.001\t')
    expect(result.lines).toHaveLength(0)
    expect(result.issues).toHaveLength(2)
  })
})
