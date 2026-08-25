import { describe, it, expect } from 'vitest'
import {
  BUILTIN_PROFILES, StatementProfileError, detectProfile, guessProfile, normaliseHeader,
  parseBankAmount, parseStatement, parseStatementDate, resolveColumns, statementHeader,
  type StatementProfile
} from './bankImport'

const profile = (id: string): StatementProfile => BUILTIN_PROFILES.find((p) => p.id === id)!

const HDFC = [
  'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance',
  '15/08/2026,NEFT DR-ACME SUPPLIES,N123456,15/08/2026,"12,500.00",,"1,00,000.00"',
  '16/08/2026,UPI-VENDOR PAYMENT,UPI/9988,16/08/2026,,"5,000.50","1,05,000.50"'
].join('\n')

const KOTAK = [
  'Sl. No.,Transaction Date,Value Date,Description,Chq / Ref No.,Amount,Dr / Cr,Balance',
  '1,03/04/2026,03/04/2026,SALARY CREDIT,REF001,"25,000.00",CR,"75,000.00"',
  '2,04/04/2026,04/04/2026,RENT,REF002,"10,000.00",DR,"65,000.00"'
].join('\n')

describe('header normalisation and column resolution', () => {
  it('strips the punctuation banks pad their headers with', () => {
    expect(normaliseHeader('Withdrawal Amount (INR )')).toBe('withdrawalamountinr')
    expect(normaliseHeader('Chq./Ref.No.')).toBe('chqrefno')
  })

  it('reports exactly which required column a profile could not find', () => {
    const header = ['Date', 'Narration', 'Balance']
    const { missing } = resolveColumns(header, profile('builtin:hdfc'))
    expect(missing).toEqual(['debit'])
  })

  it('does not let a two-letter column name prefix-match a longer one', () => {
    // Axis calls its debit column 'DR'; Kotak's direction flag is 'Dr / Cr'. Matching one to the
    // other would read every Kotak withdrawal as a deposit.
    const { columns } = resolveColumns(['Transaction Date', 'Description', 'Amount', 'Dr / Cr'], profile('builtin:axis'))
    expect(columns.debit).toBe(-1)
  })
})

describe('profile detection', () => {
  it('recognises each built-in bank from its own header row', () => {
    const headers: [string, string[]][] = [
      ['builtin:hdfc', statementHeader(HDFC)],
      ['builtin:kotak', statementHeader(KOTAK)],
      ['builtin:icici', ['Transaction Date', 'Cheque Number', 'Transaction Remarks', 'Withdrawal Amount (INR )', 'Deposit Amount (INR )', 'Balance (INR )']],
      ['builtin:sbi', ['Txn Date', 'Value Date', 'Description', 'Ref No./Cheque No.', 'Debit', 'Credit', 'Balance']],
      ['builtin:axis', ['Tran Date', 'CHQNO', 'PARTICULARS', 'DR', 'CR', 'BAL']]
    ]
    for (const [id, header] of headers) {
      expect(detectProfile(header)?.id, `${id} header`).toBe(id)
    }
  })

  it('returns null when nothing claims the header, leaving the caller to map by hand', () => {
    expect(detectProfile(['Posting Day', 'Memo', 'Value'])).toBeNull()
  })

  it('guesses debit/credit from wording when no profile matches', () => {
    const guessed = guessProfile(['Date', 'Description', 'Withdrawal', 'Deposit'])
    expect(guessed?.convention).toBe('debit_credit')
    expect(guessed?.columns.debit).toBe('Withdrawal')
  })

  it('guesses a signed single-amount file, and gives up without a date column', () => {
    expect(guessProfile(['Txn Date', 'Description', 'Amount'])?.convention).toBe('signed')
    expect(guessProfile(['Memo', 'Value'])).toBeNull()
  })
})

describe('date parsing', () => {
  it('reads an ambiguous 03/04/2026 the way the profile says, not the way it guesses', () => {
    expect(parseStatementDate('03/04/2026', 'dmy')).toBe('2026-04-03')
    expect(parseStatementDate('03/04/2026', 'mdy')).toBe('2026-03-04')
    expect(parseStatementDate('2026/04/03', 'dmy')).toBe('2026-04-03')
  })

  it('rejects a cell that cannot be the declared order rather than swapping it', () => {
    // 15 is not a month. Silently reading it as 15 March would be right in some rows of the file
    // and wrong in others, which is worse than skipping the row and saying so.
    expect(parseStatementDate('03/15/2026', 'dmy')).toBeNull()
    expect(parseStatementDate('03/15/2026', 'mdy')).toBe('2026-03-15')
  })

  it('accepts unambiguous forms whatever the profile says', () => {
    for (const fmt of ['dmy', 'mdy', 'ymd'] as const) {
      expect(parseStatementDate('2026-04-03', fmt)).toBe('2026-04-03')
      expect(parseStatementDate('15-Aug-2025', fmt)).toBe('2025-08-15')
    }
  })

  it('rejects impossible calendar dates', () => {
    expect(parseStatementDate('31/02/2026', 'dmy')).toBeNull()
    expect(parseStatementDate('29/02/2026', 'dmy')).toBeNull()
    expect(parseStatementDate('29/02/2024', 'dmy')).toBe('2024-02-29')
  })

  it('expands two-digit years and tolerates a time suffix', () => {
    expect(parseStatementDate('15/08/26', 'dmy')).toBe('2026-08-15')
    expect(parseStatementDate('2026-08-15T10:30:00', 'dmy')).toBe('2026-08-15')
  })
})

describe('amount parsing', () => {
  it('reads Indian grouping, currency marks, Dr/Cr suffixes and accounting parentheses', () => {
    expect(parseBankAmount('"1,00,000.00"')).toBe(10000000)
    expect(parseBankAmount('₹ 1,234.56')).toBe(123456)
    expect(parseBankAmount('1234.56 Cr')).toBe(123456)
    expect(parseBankAmount('1234.56 Dr')).toBe(-123456)
    expect(parseBankAmount('(1,234.56)')).toBe(-123456)
  })

  it('treats an empty or dashed cell as no amount, not as zero', () => {
    expect(parseBankAmount('')).toBeNull()
    expect(parseBankAmount('  -  ')).toBeNull()
    expect(parseBankAmount('n/a')).toBeNull()
  })
})

describe('parseStatement', () => {
  it('reads an HDFC export under the detected profile', () => {
    const result = parseStatement(HDFC)
    expect(result.profile.id).toBe('builtin:hdfc')
    expect(result.rows).toHaveLength(2)
    expect(result.rows[0]).toMatchObject({
      date: '2026-08-15', description: 'NEFT DR-ACME SUPPLIES', reference: 'N123456',
      withdrawal: 1250000, deposit: 0
    })
    expect(result.rows[1]).toMatchObject({ deposit: 500050, withdrawal: 0 })
  })

  it('reads a Kotak export, taking direction from the Dr/Cr flag', () => {
    const result = parseStatement(KOTAK)
    expect(result.profile.id).toBe('builtin:kotak')
    expect(result.rows[0]).toMatchObject({ date: '2026-04-03', deposit: 2500000, withdrawal: 0 })
    expect(result.rows[1]).toMatchObject({ date: '2026-04-04', withdrawal: 1000000, deposit: 0 })
  })

  it('reads nothing but says why when the wrong profile is forced on a file', () => {
    // Kotak's mapping on an HDFC file: the columns resolve (both have Description-ish and
    // Amount-ish names? they do not) — so this must fail loudly at resolution.
    expect(() => parseStatement(HDFC, profile('builtin:kotak'))).toThrow(StatementProfileError)
    try {
      parseStatement(HDFC, profile('builtin:kotak'))
    } catch (err) {
      expect((err as StatementProfileError).missing).toContain('amount')
      expect((err as StatementProfileError).header[0]).toBe('Date')
    }
  })

  it('reports rows it could not read instead of dropping them silently', () => {
    const csv = [
      'Date,Description,Debit,Credit',
      '15/08/2026,REAL ROW,100.00,',
      '15/08/2026,ZERO CHARGE REVERSAL,0.00,0.00',
      'Statement generated by NetBanking,,,'
    ].join('\n')
    const result = parseStatement(csv)
    expect(result.rows).toHaveLength(1)
    expect(result.skipped.map((s) => s.reason)).toEqual(['zero_amount', 'no_date'])
  })

  it('flags every row as unreadable when a signed file is read as debit/credit', () => {
    const csv = ['Date,Description,Amount,Notes', '15/08/2026,SOMETHING,-500.00,x'].join('\n')
    const asSigned = parseStatement(csv)
    expect(asSigned.rows[0]).toMatchObject({ withdrawal: 50000 })

    const wrong: StatementProfile = {
      id: 'user:1', name: 'Wrong', builtIn: false, dateFormat: 'dmy', convention: 'debit_credit',
      columns: { date: 'Date', narration: 'Description', debit: 'Notes' }
    }
    const result = parseStatement(csv, wrong)
    expect(result.rows).toHaveLength(0)
    expect(result.skipped).toEqual([{ line: 2, reason: 'zero_amount' }])
  })

  it('returns an empty result for a header-only file rather than throwing', () => {
    expect(parseStatement('Date,Description,Amount').rows).toEqual([])
  })

  it('exposes the header row for the column mapper', () => {
    expect(statementHeader(HDFC)[4]).toBe('Withdrawal Amt.')
    expect(statementHeader('')).toEqual([])
  })
})

/**
 * The edges a real statement hits and a happy-path test never does. Each of these was seen in an
 * actual export before it was written down here.
 */
describe('statement edges', () => {
  const HDFC_HEADER = 'Date,Narration,Chq./Ref.No.,Withdrawal Amt.,Deposit Amt.,Closing Balance'

  it('reads a completely empty file as empty rather than throwing', () => {
    for (const empty of ['', '\n', '   ']) {
      const result = parseStatement(empty)
      expect(result.rows).toEqual([])
      expect(result.skipped).toEqual([])
    }
  })

  it('keeps a duplicated row instead of de-duplicating it', () => {
    // A shop really does pay the same supplier twice in one day for the same amount, and a
    // parser that collapsed the pair would leave the second payment unreconciled forever with
    // nothing on screen to explain why. Uniqueness is decided at match time instead, where each
    // row consumes one open book entry and the second finds nothing left.
    const csv = [
      HDFC_HEADER,
      '10/08/2026,NEFT DR-ACME,N001,"500.00",,"9,500.00"',
      '10/08/2026,NEFT DR-ACME,N001,"500.00",,"9,000.00"'
    ].join('\n')
    const rows = parseStatement(csv).rows
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ withdrawal: 500_00 })
    expect(rows[1]).toMatchObject({ withdrawal: 500_00 })
    // Distinguishable afterwards by the physical line, which is the only thing that differs.
    expect(rows[0]!.line).not.toBe(rows[1]!.line)
  })

  it('reads a negative in the withdrawal column as money coming back IN', () => {
    // A reversed charge is written as a negative under the column it originally landed in.
    const csv = [
      HDFC_HEADER,
      '05/08/2026,SMS ALERT CHRG,,"59.00",,"9,941.00"',
      '09/08/2026,REVERSAL SMS ALERT CHRG,,"-59.00",,"10,000.00"'
    ].join('\n')
    const rows = parseStatement(csv).rows
    expect(rows[0]).toMatchObject({ withdrawal: 59_00, deposit: 0 })
    expect(rows[1]).toMatchObject({ deposit: 59_00, withdrawal: 0 })
  })

  it('reads a negative in the deposit column as money going out', () => {
    const csv = [HDFC_HEADER, '09/08/2026,RETURNED CREDIT,,,"(1,200.00)","8,800.00"'].join('\n')
    expect(parseStatement(csv).rows[0]).toMatchObject({ withdrawal: 1_200_00, deposit: 0 })
  })

  it('nets a row that carries both columns, and skips it when the two cancel', () => {
    const csv = [
      HDFC_HEADER,
      '09/08/2026,ADJUSTMENT,,"1,000.00","1,500.00","10,500.00"',
      '09/08/2026,WASH ENTRY,,"1,000.00","1,000.00","10,500.00"'
    ].join('\n')
    const result = parseStatement(csv)
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({ deposit: 500_00, withdrawal: 0 })
    expect(result.skipped).toEqual([{ line: 3, reason: 'zero_amount' }])
  })

  it('reads the same transaction identically whichever bank wrote the file', () => {
    // The point of profiles: one set of facts, five wordings, one answer.
    const hdfc = parseStatement(
      [HDFC_HEADER, '10/08/2026,ACME SUPPLIES,N001,"1,500.00",,"98,500.00"'].join('\n')
    )
    const kotak = parseStatement(
      [
        'Sl. No.,Transaction Date,Value Date,Description,Chq / Ref No.,Amount,Dr / Cr,Balance',
        '1,10/08/2026,10/08/2026,ACME SUPPLIES,N001,"1,500.00",DR,"98,500.00"'
      ].join('\n')
    )
    expect(hdfc.profile.id).toBe('builtin:hdfc')
    expect(kotak.profile.id).toBe('builtin:kotak')
    for (const key of ['date', 'description', 'reference', 'deposit', 'withdrawal'] as const) {
      expect(kotak.rows[0]![key]).toEqual(hdfc.rows[0]![key])
    }
  })

  it('refuses an ambiguous date read under the wrong profile rather than swapping it', () => {
    // 13/04/2026 is 13 April everywhere in India. Under an mdy profile there is no thirteenth
    // month, so the row is reported as unreadable instead of quietly becoming 4 January.
    const csv = [HDFC_HEADER, '13/04/2026,ACME,,"100.00",,"0.00"'].join('\n')
    const mdy = { ...BUILTIN_PROFILES[0]!, dateFormat: 'mdy' as const }
    const result = parseStatement(csv, mdy)
    expect(result.rows).toEqual([])
    expect(result.skipped).toEqual([{ line: 2, reason: 'no_date' }])
  })
})
