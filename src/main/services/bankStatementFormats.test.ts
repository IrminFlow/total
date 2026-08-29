import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import { parseCsv } from '@shared/csv'
import { detectBankStatementFormat, normalizeBankStatement, normalizeMt940, normalizeOfx, normalizeQif } from './bankStatementFormats'

function records(csv: string): string[][] {
  return parseCsv(csv.replace(/^\uFEFF/, '')).map((record) => record.cells)
}

describe('bank statement formats', () => {
  it('detects supported extensions and keeps CSV as the permanent fallback', () => {
    expect(detectBankStatementFormat('hdfc.xlsx')).toBe('xlsx')
    expect(detectBankStatementFormat('account.ofx')).toBe('ofx')
    expect(detectBankStatementFormat('cash.qif')).toBe('qif')
    expect(detectBankStatementFormat('statement.sta')).toBe('mt940')
    expect(detectBankStatementFormat('unknown.dat')).toBe('csv')
  })

  it('normalizes OFX and reconstructs running balances from the closing balance', () => {
    const csv = normalizeOfx(`<OFX><BANKTRANLIST>
      <STMTTRN><DTPOSTED>20260802<TRNAMT>-25.50<FITID>A2<NAME>BANK FEE</STMTTRN>
      <STMTTRN><DTPOSTED>20260801<TRNAMT>100.00<FITID>A1<NAME>CUSTOMER</STMTTRN>
      </BANKTRANLIST><LEDGERBAL><BALAMT>1074.50</LEDGERBAL></OFX>`)
    expect(records(csv)).toEqual([
      ['Date', 'Description', 'Reference', 'Debit', 'Credit', 'Balance'],
      ['2026-08-01', 'CUSTOMER', 'A1', '', '100.00', '1100.00'],
      ['2026-08-02', 'BANK FEE', 'A2', '25.50', '', '1074.50']
    ])
  })

  it('normalizes QIF deposits and withdrawals', () => {
    const csv = normalizeQif(`!Type:Bank
D1/8/2026
T250.00
PCustomer
NUPI1
^
D2/8/2026
T-40.00
PBank fee
^`)
    expect(records(csv).slice(1)).toEqual([
      ['2026-08-01', 'Customer', 'UPI1', '', '250.00', ''],
      ['2026-08-02', 'Bank fee', '', '40.00', '', '']
    ])
  })

  it('normalizes MT940 opening balance and transaction descriptions', () => {
    const csv = normalizeMt940(`:20:REF
:60F:C260801INR1000,00
:61:260802D25,50NCHGNONREF
:86:MONTHLY CHARGE
:61:260803C100,00NTRFUTR123
:86:CUSTOMER RECEIPT
:62F:C260803INR1074,50`)
    expect(records(csv).slice(1)).toEqual([
      ['2026-08-02', 'MONTHLY CHARGE', 'NCHGNONREF', '25.50', '', '974.50'],
      ['2026-08-03', 'CUSTOMER RECEIPT', 'NTRFUTR123', '', '100.00', '1074.50']
    ])
  })

  it('reads the first XLSX worksheet into the same canonical CSV pipeline', async () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Statement')
    sheet.addRow(['Date', 'Narration', 'Debit', 'Credit', 'Balance'])
    sheet.addRow([new Date('2026-08-01T00:00:00.000Z'), 'Opening receipt', '', 500, 1500])
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer())
    const normalized = await normalizeBankStatement('august.xlsx', buffer)
    expect(normalized.format).toBe('xlsx')
    expect(records(normalized.csvText)).toEqual([
      ['Date', 'Narration', 'Debit', 'Credit', 'Balance'],
      ['2026-08-01', 'Opening receipt', '', '500', '1500']
    ])
  })
})
