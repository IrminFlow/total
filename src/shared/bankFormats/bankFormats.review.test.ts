// WP 4.1 review fixes: symmetric signs, both-columns rows, file-level date order, unstyled Excel
// serials, CAMT reversals and zoned date-times, pasted narration across page breaks.
import { describe, expect, it } from 'vitest'
import { camtDate, parseCamt053 } from './camt053'
import { parsePastedStatement } from './pasted'
import { gridToStatement, parseStatementFile } from './index'

const split = (rows: string[]) => parseStatementFile({ fileName: 's.csv', text: ['Date,Narration,Debit,Credit', ...rows].join('\n') })

describe('tabular review fixes', () => {
  it('a negative in the Credit column is money out, a negative Debit money in (symmetric)', () => {
    const r = split(['15/08/2026,REV CR,,-100.00', '16/08/2026,REV DR,-50.00,'])
    expect(r.lines.map((l) => [l.description, l.deposit, l.withdrawal])).toEqual([
      ['REV CR', 0, 10000],
      ['REV DR', 5000, 0]
    ])
  })

  it('a row with both Debit and Credit filled is left out with a visible reason, the rest import', () => {
    const r = split(['15/08/2026,BOTH,10.00,20.00', '16/08/2026,FINE,,5.00'])
    expect(r.lines.map((l) => l.description)).toEqual(['FINE'])
    expect(r.warnings.join(' ')).toMatch(/row 2 \(15\/08\/2026 BOTH\): both a withdrawal and a deposit/)
  })

  it("'auto' dates: a day above 12 → day-first, a month part above 12 → month-first, else warn", () => {
    expect(split(['08/15/2026,US,1.00,', '08/01/2026,US2,1.00,']).lines.map((l) => l.date)).toEqual(['2026-08-15', '2026-08-01'])
    expect(split(['15/08/2026,IN,1.00,', '01/08/2026,IN2,1.00,']).lines.map((l) => l.date)).toEqual(['2026-08-15', '2026-08-01'])
    const amb = split(['01/08/2026,A,1.00,'])
    expect(amb.lines[0]!.date).toBe('2026-08-01')
    expect(amb.warnings.join(' ')).toMatch(/no day above 12/)
  })

  it('XLSX: an unstyled serial number in the mapped date column is a date', () => {
    const r = gridToStatement(
      [
        ['Date', 'Narration', 'Debit', 'Credit'],
        ['46236', 'X', '', '10']
      ],
      {
        delimiter: 'auto', encoding: 'utf-8', headerRow: 1, dateFormat: 'auto', dateCol: 0, valueDateCol: null, descCols: [1], refCol: null,
        amountMode: 'split', debitCol: 2, creditCol: 3, amountCol: null, flagCol: null, balanceCol: null, signedNegativeIsDeposit: false
      },
      'xlsx'
    )
    expect(r.lines[0]!.date).toBe('2026-08-02')
  })
})

describe('CAMT review fixes', () => {
  it('a reversal (RvslInd) takes its CdtDbtInd as booked; a DtTm without a zone is the bank date', () => {
    const xml = `<Document><BkToCstmrStmt><Stmt>
      <Ntry><Amt Ccy="INR">500.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><RvslInd>true</RvslInd><Sts>BOOK</Sts><BookgDt><Dt>2026-08-09</Dt></BookgDt><AddtlNtryInf>REVERSAL OF CHARGES</AddtlNtryInf></Ntry>
      <Ntry><Amt Ccy="INR">10.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts>BOOK</Sts><BookgDt><DtTm>2026-08-10T10:00:00</DtTm></BookgDt></Ntry>
    </Stmt></BkToCstmrStmt></Document>`
    const r = parseCamt053(xml)
    expect(r.lines.map((l) => [l.date, l.deposit, l.withdrawal, l.description])).toEqual([
      ['2026-08-09', 50000, 0, 'REVERSAL OF CHARGES'],
      ['2026-08-10', 0, 1000, '']
    ])
  })

  it('a zoned DtTm is converted to the local date, not sliced', () => {
    const local = (iso: string): string => {
      const d = new Date(iso)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }
    expect(camtDate('2026-08-10T20:00:00Z')).toBe(local('2026-08-10T20:00:00Z'))
    expect(camtDate('2026-08-10T23:30:00+05:30')).toBe(local('2026-08-10T23:30:00+05:30'))
    expect(camtDate('2026-08-10')).toBe('2026-08-10')
  })
})

describe('pasted review fixes', () => {
  it('narration continued after a page break is joined, not dropped', () => {
    const r = parsePastedStatement(
      'Opening Balance 1,000.00\n05/08/2026 NEFT ACME 500.00 1,500.00\nPage 1 of 2\nDate Narration Withdrawal Deposit Balance\nINV 1021 PART\n06/08/2026 FEE 10.00 1,490.00'
    )
    expect(r.lines.map((l) => l.description)).toEqual(['NEFT ACME INV 1021 PART', 'FEE'])
  })
})
