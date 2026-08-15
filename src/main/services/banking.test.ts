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
    expect(rows[0]).toEqual({ date: '2026-08-15', description: 'NEFT UMBRELLA', deposit: 5000000, withdrawal: 0 })
    expect(rows[1]).toEqual({ date: '2026-08-16', description: 'CHQ 123', deposit: 0, withdrawal: 2500050 })
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
})
