import { describe, it, expect } from 'vitest'
import { parseStatementCsv } from './banking'

describe('bank statement CSV parser', () => {
  it('parses debit/credit column statements with Indian dates', () => {
    const csv = [
      'Date,Narration,Debit,Credit,Balance',
      '15/08/2026,"NEFT UMBRELLA",,"50,000.00","1,00,000.00"',
      '16-08-2026,CHQ 123,25000.50,,75000',
      'junk line without date,,,,'
    ].join('\n')
    const rows = parseStatementCsv(csv)
    expect(rows).toHaveLength(2)
    // toMatchObject, not toEqual: rows now also carry the CSV line they came from (#131), so a
    // skipped-row report can point at something.
    expect(rows[0]).toMatchObject({ date: '2026-08-15', description: 'NEFT UMBRELLA', reference: '', deposit: 5000000, withdrawal: 0 })
    expect(rows[1]).toMatchObject({ date: '2026-08-16', description: 'CHQ 123', reference: '', deposit: 0, withdrawal: 2500050 })
  })

  it('parses signed single-amount statements', () => {
    const csv = ['Txn Date,Description,Amount', '2026-08-15,UPI IN,1500.25', '2026-08-16,UPI OUT,-200'].join('\n')
    const rows = parseStatementCsv(csv)
    expect(rows[0]).toMatchObject({ deposit: 150025, withdrawal: 0 })
    expect(rows[1]).toMatchObject({ deposit: 0, withdrawal: 20000 })
  })

  it('rejects headerless files clearly', () => {
    expect(() => parseStatementCsv('a,b\n1,2')).toThrow(/date column/i)
  })

  it('parses 15-Aug-2025, DD.MM.YYYY, DD.MM.YY and short-year slash dates', () => {
    const csv = [
      'Date,Description,Debit,Credit',
      '15-Aug-2025,MONTH NAME DASH,100.00,',
      '15 Aug 25,MONTH NAME SHORT,200.00,',
      '15.08.2025,DOTTED FULL,300.00,',
      '15.08.25,DOTTED SHORT,400.00,',
      '15/08/25,SLASH SHORT,500.00,'
    ].join('\n')
    const rows = parseStatementCsv(csv)
    expect(rows.map((r) => r.date)).toEqual([
      '2025-08-15', '2025-08-15', '2025-08-15', '2025-08-15', '2025-08-15'
    ])
  })

  it('captures a reference column (ref/cheque/UTR headers) as row.reference', () => {
    const csv = [
      'Date,Narration,Chq/Ref No,Debit,Credit',
      '2026-08-15,NEFT PAYMENT,UTR12345,1500.00,'
    ].join('\n')
    const rows = parseStatementCsv(csv)
    expect(rows[0]!.reference).toBe('UTR12345')

    // No reference column → empty string, never undefined
    const noRef = parseStatementCsv('Date,Narration,Debit,Credit\n2026-08-15,X,10.00,')
    expect(noRef[0]!.reference).toBe('')
  })
})
