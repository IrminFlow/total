import { describe, expect, it } from 'vitest'
import { buildTransferFile, TRANSFER_HEADERS, type TransferRow } from './salaryTransfer'

const row = (over: Partial<TransferRow> = {}): TransferRow => ({
  employeeName: 'Asha Rao',
  bankAccount: '12345678901',
  ifsc: 'HDFC0001234',
  netPaise: 5000000,
  ...over
})

const dataLines = (csv: string): string[] => csv.split('\n').slice(1)

describe('buildTransferFile', () => {
  it('writes a header and one line per payable employee', () => {
    const f = buildTransferFile([row(), row({ employeeName: 'Bharat Shah' })], 'Salary May 2026')
    expect(f.csv.split('\n')[0]).toBe(TRANSFER_HEADERS.join(','))
    expect(f.count).toBe(2)
    expect(dataLines(f.csv)).toHaveLength(2)
  })

  it('writes rupees with two decimals, from integer paise', () => {
    // Banks reject anything else, and a float would eventually produce 4999.999999999999.
    expect(dataLines(buildTransferFile([row({ netPaise: 5000000 })], 'r').csv)[0]).toContain(',50000.00,')
    expect(dataLines(buildTransferFile([row({ netPaise: 5 })], 'r').csv)[0]).toContain(',0.05,')
    expect(dataLines(buildTransferFile([row({ netPaise: 100 })], 'r').csv)[0]).toContain(',1.00,')
  })

  it('totals what it actually wrote', () => {
    const f = buildTransferFile([row({ netPaise: 100 }), row({ netPaise: 250 })], 'r')
    expect(f.totalPaise).toBe(350)
  })

  it('skips an employee with a reason rather than dropping them', () => {
    // A transfer file that silently omits someone is how a person does not get paid, and the
    // business finds out from them rather than from the file.
    const f = buildTransferFile(
      [
        row({ employeeName: 'No Account', bankAccount: null }),
        row({ employeeName: 'No IFSC', ifsc: null }),
        row({ employeeName: 'Nothing Due', netPaise: 0 }),
        row({ employeeName: 'Paid' })
      ],
      'r'
    )
    expect(f.count).toBe(1)
    expect(f.skipped.map((s) => s.employeeName)).toEqual(['No Account', 'No IFSC', 'Nothing Due'])
    expect(f.skipped[0]!.reason).toMatch(/bank account/)
    expect(f.skipped[2]!.reason).toMatch(/nothing payable/)
  })

  it('treats a blank account or IFSC as absent, not as a value', () => {
    const f = buildTransferFile([row({ bankAccount: '   ' }), row({ ifsc: '' })], 'r')
    expect(f.count).toBe(0)
    expect(f.skipped).toHaveLength(2)
  })

  it('escapes a name with a comma, so it does not become two columns', () => {
    const f = buildTransferFile([row({ employeeName: 'Rao, Asha' })], 'r')
    expect(dataLines(f.csv)[0]!.startsWith('"Rao, Asha",')).toBe(true)
  })

  it('escapes an embedded quote by doubling it', () => {
    const f = buildTransferFile([row({ employeeName: 'A "Nick" B' })], 'r')
    expect(dataLines(f.csv)[0]).toContain('"A ""Nick"" B"')
  })

  it('uppercases the IFSC, which banks match case-sensitively', () => {
    expect(dataLines(buildTransferFile([row({ ifsc: 'hdfc0001234' })], 'r').csv)[0]).toContain('HDFC0001234')
  })

  it('writes only a header when nobody can be paid', () => {
    const f = buildTransferFile([row({ bankAccount: null })], 'r')
    expect(f.csv).toBe(TRANSFER_HEADERS.join(','))
    expect(f.count).toBe(0)
    expect(f.totalPaise).toBe(0)
  })
})
