import { describe, expect, it } from 'vitest'
import { parseItemsCsv, parseLedgersCsv, parseOpeningBalancesCsv } from './importers'

describe('parseLedgersCsv', () => {
  it('recognises header aliases (Ledger Name / Under)', () => {
    const csv = 'Ledger Name,Under,Opening Balance\nAcme Traders,Sundry Debtors,1000'
    const { rows, errors } = parseLedgersCsv(csv)
    expect(errors).toEqual([])
    expect(rows).toEqual([
      { line: 2, name: 'Acme Traders', group: 'Sundry Debtors', openingBalance: 100000, gstin: null, stateCode: null, pan: null, creditDays: null }
    ])
  })

  it('accepts the canonical name/group headers too', () => {
    const csv = 'name,group,opening\nBeta Supplies,Sundry Creditors,500'
    const { rows, errors } = parseLedgersCsv(csv)
    expect(errors).toEqual([])
    expect(rows[0]).toMatchObject({ name: 'Beta Supplies', group: 'Sundry Creditors', openingBalance: 50000 })
  })

  it('keeps a comma inside a quoted field intact', () => {
    const csv = 'Name,Group,Opening\n"Acme, Traders & Co",Sundry Debtors,1000'
    const { rows, errors } = parseLedgersCsv(csv)
    expect(errors).toEqual([])
    expect(rows[0]!.name).toBe('Acme, Traders & Co')
  })

  it('turns a "Cr" suffix into a negative (credit) opening balance', () => {
    const csv = 'Name,Group,Opening\nGamma Bank,Bank Accounts,"1,234.50 Cr"'
    const { rows, errors } = parseLedgersCsv(csv)
    expect(errors).toEqual([])
    expect(rows[0]!.openingBalance).toBe(-123450)
  })

  it('treats a "Dr" suffix as positive', () => {
    const csv = 'Name,Group,Opening\nDelta Traders,Sundry Debtors,"500.00 Dr"'
    const { rows } = parseLedgersCsv(csv)
    expect(rows[0]!.openingBalance).toBe(50000)
  })

  it('parses gstin, state, pan and credit days columns', () => {
    const csv = 'Name,Group,Opening,GSTIN,State,PAN,Credit Days\nAcme,Sundry Debtors,0,27AAPFU0939F1ZV,Maharashtra,AAAAA0000A,30'
    const { rows, errors } = parseLedgersCsv(csv)
    expect(errors).toEqual([])
    expect(rows[0]).toMatchObject({ gstin: '27AAPFU0939F1ZV', stateCode: '27', pan: 'AAAAA0000A', creditDays: 30 })
  })

  it('collects bad rows as errors while good rows survive', () => {
    const csv = [
      'Name,Group,Opening',
      'Good One,Sundry Debtors,1000',
      ',Sundry Debtors,1000', // missing name
      'Bad Amount,Sundry Debtors,not-a-number',
      'Good Two,Sundry Creditors,"2,500.00 Cr"'
    ].join('\n')
    const { rows, errors } = parseLedgersCsv(csv)
    expect(rows.map((r) => r.name)).toEqual(['Good One', 'Good Two'])
    expect(errors).toHaveLength(2)
    expect(errors[0]).toMatchObject({ line: 3 })
    expect(errors[1]).toMatchObject({ line: 4 })
  })

  it('errors when a required column is missing entirely', () => {
    const csv = 'Group,Opening\nSundry Debtors,1000'
    const { rows, errors } = parseLedgersCsv(csv)
    expect(rows).toEqual([])
    expect(errors).toHaveLength(1)
  })

  it('flags an invalid GSTIN as a row error', () => {
    const csv = 'Name,Group,Opening,GSTIN\nAcme,Sundry Debtors,0,NOTAGSTIN'
    const { rows, errors } = parseLedgersCsv(csv)
    expect(rows).toEqual([])
    expect(errors).toHaveLength(1)
  })
})

describe('parseItemsCsv', () => {
  it('recognises header aliases and converts qty decimals to milli', () => {
    const csv = 'Item Name,Stock Group,UOM,HSN,GST%,Opening Qty,Opening Value\nWidget A,Finished Goods,Nos,8471,18,12.345,2500'
    const { rows, errors } = parseItemsCsv(csv)
    expect(errors).toEqual([])
    expect(rows[0]).toEqual({
      line: 2, name: 'Widget A', group: 'Finished Goods', unit: 'Nos', hsn: '8471',
      gstRate: 18, openingQtyMilli: 12345, openingValue: 250000
    })
  })

  it('computes opening value from rate x qty when value column is absent', () => {
    const csv = 'Name,Unit,Opening Qty,Opening Rate\nWidget B,Nos,10,25.50'
    const { rows, errors } = parseItemsCsv(csv)
    expect(errors).toEqual([])
    expect(rows[0]).toMatchObject({ openingQtyMilli: 10000, openingValue: 25500 })
  })

  it('allows a blank group (unattached item)', () => {
    const csv = 'Name,Unit\nLoose Item,Nos'
    const { rows, errors } = parseItemsCsv(csv)
    expect(errors).toEqual([])
    expect(rows[0]).toMatchObject({ group: null, unit: 'Nos' })
  })

  it('errors a row with a non-numeric quantity but keeps the rest', () => {
    const csv = 'Name,Unit,Opening Qty\nGood Item,Nos,10\nBad Item,Nos,abc'
    const { rows, errors } = parseItemsCsv(csv)
    expect(rows.map((r) => r.name)).toEqual(['Good Item'])
    expect(errors).toEqual([{ line: 3, message: expect.stringContaining('quantity') }])
  })

  it('errors a row missing the required unit column value', () => {
    const csv = 'Name,Unit\nNo Unit Item,'
    const { rows, errors } = parseItemsCsv(csv)
    expect(rows).toEqual([])
    expect(errors).toHaveLength(1)
  })
})

describe('parseOpeningBalancesCsv', () => {
  it('parses ledger name + signed opening balance', () => {
    const csv = 'Ledger,Opening\nAcme Traders,"1,234.50 Cr"\nBeta Supplies,500'
    const { rows, errors } = parseOpeningBalancesCsv(csv)
    expect(errors).toEqual([])
    expect(rows).toEqual([
      { line: 2, ledgerName: 'Acme Traders', opening: -123450 },
      { line: 3, ledgerName: 'Beta Supplies', opening: 50000 }
    ])
  })

  it('collects a bad row while the rest survive', () => {
    const csv = 'Ledger,Opening\nGood,1000\nBad,not-a-number'
    const { rows, errors } = parseOpeningBalancesCsv(csv)
    expect(rows.map((r) => r.ledgerName)).toEqual(['Good'])
    expect(errors).toEqual([{ line: 3, message: expect.any(String) }])
  })
})
