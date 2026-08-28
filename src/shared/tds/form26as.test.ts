import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  parse26asCsv,
  reconcile26as,
  type Book26asEntry,
  type Recon26asOptions,
  type Statement26asRow
} from './form26as'

const OPTS: Recon26asOptions = { amountTolerancePaise: 100, dateWindowDays: 7 }

const HEADER =
  'Name of Deductor,TAN of Deductor,Section,Transaction Date,Amount Paid / Credited,Tax Deducted,TDS Deposited'

const PREAMBLE = [
  'Form 26AS,,,,,,',
  'Permanent Account Number (PAN),AAAPA1234A,,,,,',
  'Assessment Year,2026-27,,,,,',
  'PART A - Details of Tax Deducted at Source,,,,,,',
  '',
].join('\n')

const stmt = (over: Partial<Statement26asRow> = {}): Statement26asRow => ({
  line: 1,
  deductorName: 'Sharma Traders Pvt Ltd',
  deductorTan: 'DELS12345A',
  section: '194C',
  date: '2025-06-15',
  amountPaidPaise: 1_00_000_00,
  taxDeductedPaise: 1_000_00,
  taxDepositedPaise: 1_000_00,
  taxDepositedKnown: true,
  ...over
})

const book = (over: Partial<Book26asEntry> = {}): Book26asEntry => ({
  id: 1,
  deductorName: 'Sharma Traders',
  deductorTan: 'DELS12345A',
  section: '194C',
  date: '2025-06-15',
  amountPaise: 1_00_000_00,
  tdsPaise: 1_000_00,
  ...over
})

describe('parse26asCsv', () => {
  it('converts printed rupees to integer paise exactly once (1234.56 -> 123456)', () => {
    const { rows, problems } = parse26asCsv(
      `${HEADER}\nSharma Traders,DELS12345A,194C,15-Jun-2025,1234.56,12.35,12.35\n`
    )
    expect(problems).toEqual([])
    expect(rows[0]!.amountPaidPaise).toBe(123456)
    expect(rows[0]!.taxDeductedPaise).toBe(1235)
  })

  it('skips the TRACES preamble above the table', () => {
    const { rows } = parse26asCsv(
      `${PREAMBLE}\n${HEADER}\nSharma Traders,DELS12345A,194C,15-Jun-2025,100000.00,1000.00,1000.00\n`
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ deductorTan: 'DELS12345A', section: '194C', date: '2025-06-15' })
  })

  it('reports a preamble-only file instead of throwing', () => {
    const { rows, problems } = parse26asCsv(PREAMBLE)
    expect(rows).toEqual([])
    expect(problems.join(' ')).toMatch(/no deductor summary or transaction header/i)
  })

  it('tolerates header naming variation between TRACES and AIS exports', () => {
    const alt = 'Deductor Name,Deductor TAN,Section Code,Date of Payment/Credit,Amount of Payment,Amount of Tax Deducted,Amount of Tax Deposited'
    const { rows, problems } = parse26asCsv(`${alt}\nAcme Ltd,MUMA99999B,194J,2025-07-04,50000.00,5000.00,5000.00\n`)
    expect(problems).toEqual([])
    expect(rows[0]).toMatchObject({
      deductorTan: 'MUMA99999B',
      section: '194J',
      date: '2025-07-04',
      amountPaidPaise: 50_000_00,
      taxDeductedPaise: 5_000_00
    })
  })

  it('reports a malformed line as a problem and keeps the good rows', () => {
    const text = [
      HEADER,
      'Sharma Traders,DELS12345A,194C,15-Jun-2025,100000.00,1000.00,1000.00',
      'Ghost Ltd,,194C,15-Jun-2025,50000.00,500.00,500.00',
      'Bad Amounts Ltd,MUMA99999B,194J,15-Jun-2025,not-a-number,500.00,500.00',
      'Total,,,,150000.00,1500.00,1500.00'
    ].join('\n')
    const { rows, problems } = parse26asCsv(text)
    expect(rows).toHaveLength(1)
    expect(problems).toHaveLength(2)
    expect(problems[0]).toMatch(/no deductor TAN/)
    expect(problems[1]).toMatch(/could not read an amount/)
  })

  it('parses the sanctioned TRACES caret-delimited grouped layout and inherits TAN into transactions', () => {
    const text = readFileSync(join(__dirname, '__fixtures__/form26as-traces-part1-sanitized.txt'), 'utf8')
    const { rows, problems } = parse26asCsv(text)
    expect(problems).toEqual([])
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({
      deductorName: 'Bright Media Pvt Ltd', deductorTan: 'MUMB12345A', section: '194J',
      date: '2025-05-10', amountPaidPaise: 10000000, taxDeductedPaise: 1000000
    })
    expect(rows[1]).toMatchObject({
      deductorTan: 'MUMB12345A', amountPaidPaise: -2000000,
      taxDeductedPaise: -200000, taxDepositedPaise: -200000
    })
    expect(rows[2]).toMatchObject({ deductorName: 'Quiet Systems LLP', deductorTan: 'DELQ98765B', section: '194C' })
  })

  it('does not pretend the deposited amount is known when a flat export omits it', () => {
    const shortHeader = 'Deductor Name,Deductor TAN,Section,Transaction Date,Amount Paid / Credited,Tax Deducted'
    const { rows, problems } = parse26asCsv(`${shortHeader}\nAcme Ltd,MUMA99999B,194J,04-Jul-2025,50000.00,5000.00\n`)
    expect(rows[0]!.taxDepositedKnown).toBe(false)
    expect(problems.join(' ')).toMatch(/deposit availability was not independently checked/)
  })
})

describe('reconcile26as', () => {
  it('returns a nil reconciliation for an empty statement and empty books', () => {
    const r = reconcile26as([], [], OPTS)
    expect(r.pairs).toEqual([])
    expect(r.creditAtRiskPaise).toBe(0)
    expect(r.unrecordedCreditPaise).toBe(0)
    expect(r.buckets.matched.count).toBe(0)
  })

  it('matches a book entry to its 26AS row exactly', () => {
    const r = reconcile26as([book()], [stmt()], OPTS)
    expect(r.pairs).toHaveLength(1)
    expect(r.pairs[0]!.bucket).toBe('matched')
    expect(r.pairs[0]!.tdsDiffPaise).toBe(0)
    expect(r.creditAtRiskPaise).toBe(0)
  })

  it('still matches when the amounts differ within tolerance', () => {
    const r = reconcile26as([book({ tdsPaise: 1_000_00 })], [stmt({ taxDeductedPaise: 1_000_50, taxDepositedPaise: 1_000_50 })], OPTS)
    expect(r.pairs[0]!.bucket).toBe('matched')
    expect(r.pairs[0]!.tdsDiffPaise).toBe(50)
  })

  it('calls out an amount difference outside tolerance', () => {
    const r = reconcile26as([book({ tdsPaise: 1_000_00 })], [stmt({ taxDeductedPaise: 900_00, taxDepositedPaise: 900_00 })], OPTS)
    expect(r.pairs[0]!.bucket).toBe('amountMismatch')
    expect(r.pairs[0]!.tdsDiffPaise).toBe(-100_00)
    // ₹100 of claimed credit that 26AS does not support.
    expect(r.creditAtRiskPaise).toBe(100_00)
  })

  it('flags a date drift across a quarter boundary rather than losing the match', () => {
    const r = reconcile26as([book({ date: '2025-06-30' })], [stmt({ date: '2025-07-10' })], OPTS)
    const p = r.pairs[0]!
    expect(p.bucket).toBe('dateDrift')
    expect(p.dateDiffDays).toBe(10)
    expect(p.notes.join(' ')).toMatch(/different TDS quarter: books Q1 FY2025-26, 26AS Q2 FY2025-26/)
  })

  it('pairs a deductor recorded in the books with no TAN by name', () => {
    const r = reconcile26as([book({ deductorTan: null })], [stmt()], OPTS)
    expect(r.pairs[0]!.bucket).toBe('matched')
    expect(r.pairs[0]!.notes.join(' ')).toMatch(/no TAN/)
  })

  it('consumes duplicate statement rows one-to-one, leaving the extra unmatched', () => {
    const r = reconcile26as([book()], [stmt({ line: 1 }), stmt({ line: 2 })], OPTS)
    expect(r.buckets.matched.count).toBe(1)
    expect(r.buckets.missingInBooks.count).toBe(1)
    expect(r.unrecordedCreditPaise).toBe(1_000_00)
  })

  it('reports a book entry with no 26AS counterpart as credit at risk', () => {
    const r = reconcile26as([book({ id: 7, deductorTan: 'CHEA00000Z', deductorName: 'Nobody Ltd' })], [], OPTS)
    expect(r.pairs[0]!.bucket).toBe('missingInStatement')
    expect(r.buckets.missingInStatement.tdsPaise).toBe(1_000_00)
    expect(r.creditAtRiskPaise).toBe(1_000_00)
  })

  it('reports a 26AS row with no book counterpart as possibly unrecorded income', () => {
    const r = reconcile26as([], [stmt({ deductorTan: 'BLRX55555C', deductorName: 'Unknown Buyer' })], OPTS)
    expect(r.pairs[0]!.bucket).toBe('missingInBooks')
    expect(r.buckets.missingInBooks.amountPaise).toBe(1_00_000_00)
    expect(r.unrecordedCreditPaise).toBe(1_000_00)
    expect(r.creditAtRiskPaise).toBe(0)
  })

  it('counts tax deducted but not deposited as credit at risk on a matched pair', () => {
    const r = reconcile26as([book()], [stmt({ taxDepositedPaise: 400_00 })], OPTS)
    expect(r.pairs[0]!.bucket).toBe('matched')
    expect(r.pairs[0]!.notes.join(' ')).toMatch(/less tax deposited than deducted/)
    expect(r.creditAtRiskPaise).toBe(600_00)
  })

  it('matches a negative reversal and never turns it into positive credit at risk', () => {
    const r = reconcile26as(
      [book({ tdsPaise: -200_00, amountPaise: -20_000_00 })],
      [stmt({ taxDeductedPaise: -200_00, taxDepositedPaise: -200_00, amountPaidPaise: -20_000_00 })],
      OPTS
    )
    expect(r.pairs[0]!.bucket).toBe('matched')
    expect(r.creditAtRiskPaise).toBe(0)
    expect(r.buckets.matched.tdsPaise).toBe(-200_00)
  })

  it('does not compare GST-inclusive book gross to the Form 26AS section base', () => {
    const r = reconcile26as(
      [book({ amountPaise: 1_18_000_00, amountComparable: false })],
      [stmt({ amountPaidPaise: 1_00_000_00 })],
      OPTS
    )
    expect(r.pairs[0]!.bucket).toBe('matched')
    expect(r.pairs[0]!.notes.join(' ')).toMatch(/exclude separately stated GST/)
  })

  it('reconciles a parsed statement end to end, in paise throughout', () => {
    const { rows } = parse26asCsv(
      `${PREAMBLE}\n${HEADER}\nSharma Traders Pvt Ltd,DELS12345A,194C,15-Jun-2025,100000.00,1000.00,1000.00\n`
    )
    const r = reconcile26as([book()], rows, OPTS)
    expect(r.pairs[0]!.bucket).toBe('matched')
    expect(r.buckets.matched.amountPaise).toBe(1_00_000_00)
  })
})
