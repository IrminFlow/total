import { describe, it, expect } from 'vitest'
import {
  matchByName,
  parseAcctPaste,
  parseAmountCell,
  parseItemPaste,
  parsePastedGrid
} from './gridPaste'

describe('parsePastedGrid', () => {
  it('splits on tabs, which is what a spreadsheet puts on the clipboard', () => {
    expect(parsePastedGrid('a\tb\nc\td')).toEqual([
      ['a', 'b'],
      ['c', 'd']
    ])
  })

  it('falls back to CSV only when there is no tab anywhere', () => {
    expect(parsePastedGrid('a,b\nc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd']
    ])
    // A comma inside a tabbed cell is part of the cell, not a separator.
    expect(parsePastedGrid('Rent, office\t1200')).toEqual([['Rent, office', '1200']])
  })

  it('honours quoted CSV fields', () => {
    expect(parsePastedGrid('"Smith, John",500')).toEqual([['Smith, John', '500']])
  })

  it('survives Windows line endings and drops blank rows', () => {
    expect(parsePastedGrid('a\t1\r\n\r\nb\t2\r\n')).toEqual([
      ['a', '1'],
      ['b', '2']
    ])
  })
})

describe('parseAmountCell', () => {
  it('reads Indian grouping and a currency symbol', () => {
    expect(parseAmountCell('₹1,23,456.78')).toEqual({ paise: 12345678, side: null })
  })

  it('reads a Dr/Cr suffix as the side', () => {
    expect(parseAmountCell('1,200 Cr')).toEqual({ paise: 120000, side: 'cr' })
    expect(parseAmountCell('1200 Dr.')).toEqual({ paise: 120000, side: 'dr' })
  })

  it('reads brackets as negative, the accountant’s convention', () => {
    expect(parseAmountCell('(1,200.50)')).toEqual({ paise: -120050, side: null })
  })

  it('rejects text', () => {
    expect(parseAmountCell('Particulars')).toBeNull()
    expect(parseAmountCell('')).toBeNull()
  })
})

describe('parseAcctPaste', () => {
  it('reads a two-money-column journal, position deciding the side', () => {
    const { lines, skipped } = parseAcctPaste('Office Rent\t12000\t\nBank\t\t12000')
    expect(skipped).toEqual([])
    expect(lines).toEqual([
      { name: 'Office Rent', drCr: 'dr', amount: 1200000 },
      { name: 'Bank', drCr: 'cr', amount: 1200000 }
    ])
  })

  it('reads an explicit Dr/Cr column', () => {
    const { lines } = parseAcctPaste('Salaries\tDr\t50000\nCash\tCr\t50000')
    expect(lines).toEqual([
      { name: 'Salaries', drCr: 'dr', amount: 5000000 },
      { name: 'Cash', drCr: 'cr', amount: 5000000 }
    ])
  })

  it('leaves the side to the caller when there is only one money column', () => {
    const { lines } = parseAcctPaste('Freight\t900')
    expect(lines).toEqual([{ name: 'Freight', drCr: null, amount: 90000 }])
  })

  it('does not read a trailing narration column as a credit column', () => {
    const { lines } = parseAcctPaste('Freight\t900\tpaid to hauler')
    expect(lines).toEqual([{ name: 'Freight', drCr: null, amount: 90000 }])
  })

  it('flips the side when the amount is bracketed or negative', () => {
    expect(parseAcctPaste('Bank\tDr\t(500)').lines).toEqual([{ name: 'Bank', drCr: 'cr', amount: 50000 }])
  })

  it('drops a header row', () => {
    const { lines, skipped } = parseAcctPaste('Particulars\tDebit\tCredit\nCash\t100\t')
    expect(skipped).toEqual([])
    expect(lines).toEqual([{ name: 'Cash', drCr: 'dr', amount: 10000 }])
  })

  it('keeps a real ledger whose name happens to start with a header word', () => {
    // "Balance with SBI" is a ledger, not the sheet's total row — the money columns decide.
    const { lines } = parseAcctPaste('Balance with SBI\t100\t')
    expect(lines).toEqual([{ name: 'Balance with SBI', drCr: 'dr', amount: 10000 }])
  })

  it('reports a total row rather than posting it', () => {
    const { lines, skipped } = parseAcctPaste('Cash\t100\t\nTotal\t100\t')
    expect(lines).toHaveLength(1)
    expect(skipped).toEqual([{ row: 2, text: 'Total · 100 · ', reason: 'looks like the sheet’s own total' }])
  })

  it('refuses a row carrying both a debit and a credit rather than guessing', () => {
    const { lines, skipped } = parseAcctPaste('Cash\t100\t50')
    expect(lines).toEqual([])
    expect(skipped[0]!.reason).toBe('more than one amount on the row')
  })

  it('reports a nameless or amountless row instead of dropping it silently', () => {
    const { skipped } = parseAcctPaste('\t100\nCash\tnot a number')
    expect(skipped.map((s) => s.reason)).toEqual(['no account name', 'no amount'])
  })
})

describe('parseItemPaste', () => {
  it('reads item, qty, rate and discount', () => {
    const { lines, skipped } = parseItemPaste('Widget\t10\t250.50\t100\nGadget\t2\t1,000')
    expect(skipped).toEqual([])
    expect(lines).toEqual([
      { name: 'Widget', qtyText: '10', rate: 25050, discount: 10000 },
      { name: 'Gadget', qtyText: '2', rate: 100000, discount: null }
    ])
  })

  it('accepts a picking list with no price at all', () => {
    expect(parseItemPaste('Widget\t10').lines).toEqual([
      { name: 'Widget', qtyText: '10', rate: null, discount: null }
    ])
  })

  it('drops the header and reports a row with no quantity', () => {
    const { lines, skipped } = parseItemPaste('Item\tQty\tRate\nWidget\t\t250')
    expect(lines).toEqual([])
    expect(skipped).toEqual([{ row: 2, text: 'Widget ·  · 250', reason: 'no quantity' }])
  })

  it('refuses a zero or negative quantity', () => {
    expect(parseItemPaste('Widget\t0\t250').skipped[0]!.reason).toBe('quantity is not positive')
  })
})

describe('matchByName', () => {
  const ledgers = [
    { id: 1, name: 'Office Rent' },
    { id: 2, name: 'Bank of Baroda' },
    { id: 3, name: 'Bank  of  Baroda' }
  ]

  it('matches case- and space-insensitively', () => {
    expect(matchByName('  office   rent ', ledgers)?.id).toBe(1)
  })

  it('refuses an ambiguous match rather than picking one', () => {
    // Two masters normalise to the same name — posting money to whichever sorted first is not a
    // guess the app is entitled to make.
    expect(matchByName('bank of baroda', ledgers)).toBeNull()
  })

  it('never matches loosely', () => {
    expect(matchByName('Office Rents', ledgers)).toBeNull()
    expect(matchByName('', ledgers)).toBeNull()
  })
})
