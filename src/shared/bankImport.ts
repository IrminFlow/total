/**
 * Per-bank statement import profiles (#131).
 *
 * Every Indian bank exports a different CSV. HDFC puts the narration in `Narration` and splits
 * money across `Withdrawal Amt.`/`Deposit Amt.`; ICICI calls the same thing `Transaction Remarks`
 * and `Withdrawal Amount (INR )` (trailing space and all); Kotak ships one `Amount` column with a
 * separate `Dr / Cr` flag. A single hard-coded guess gets one of those right and silently drops
 * rows from the rest — and a dropped row is a reconciliation that quietly never happens.
 *
 * So a profile is data: which header holds which field, how the dates are written, and how the
 * file expresses direction. Five banks ship as built-ins, a user can save their own, and when
 * nothing matches the caller is told exactly that instead of being handed an empty result.
 *
 * Pure engine code — no DB, no Electron. src/main/services/banking.ts stores user profiles and
 * feeds them back in.
 */

import { parseCsv } from './csv'
import { parseRupees } from './money'

/** How a statement expresses which way the money went. */
export type AmountConvention =
  /** Two columns: one for money out, one for money in (HDFC, ICICI, SBI, Axis). */
  | 'debit_credit'
  /** One column, negative means money out. */
  | 'signed'
  /** One amount column plus a Dr/Cr indicator column (Kotak). */
  | 'flagged'

/** Component order of a numeric date cell. Month-name and ISO cells parse the same either way. */
export type StatementDateFormat = 'dmy' | 'mdy' | 'ymd'

/** Header text per field. Omitted/null = the statement has no such column. */
export interface ProfileColumns {
  date: string
  narration: string
  reference?: string | null
  debit?: string | null
  credit?: string | null
  amount?: string | null
  /** The Dr/Cr indicator column, for the 'flagged' convention. */
  drCr?: string | null
  balance?: string | null
}

export interface StatementProfile {
  /** 'builtin:hdfc' for shipped profiles, 'user:<rowid>' for saved ones. */
  id: string
  name: string
  builtIn: boolean
  dateFormat: StatementDateFormat
  convention: AmountConvention
  /** Cell text that means "money out" in a 'flagged' statement, compared case-insensitively. */
  debitFlag?: string | null
  columns: ProfileColumns
}

/** Field keys a caller can map. Order is the order the mapping UI shows them in. */
export const PROFILE_FIELDS = ['date', 'narration', 'reference', 'debit', 'credit', 'amount', 'drCr', 'balance'] as const
export type ProfileField = (typeof PROFILE_FIELDS)[number]

/**
 * Built-in profiles, transcribed from the real export headers of the five banks most Indian SMBs
 * actually bank with. Header text is matched loosely (see `normaliseHeader`), so the trailing
 * spaces, dots and `(INR )` suffixes below only have to be roughly right — but they are kept
 * verbatim because the next person to compare them against a real export should see what was
 * transcribed, not what was tidied.
 */
export const BUILTIN_PROFILES: StatementProfile[] = [
  {
    id: 'builtin:hdfc',
    name: 'HDFC Bank',
    builtIn: true,
    dateFormat: 'dmy',
    convention: 'debit_credit',
    columns: {
      date: 'Date',
      narration: 'Narration',
      reference: 'Chq./Ref.No.',
      debit: 'Withdrawal Amt.',
      credit: 'Deposit Amt.',
      balance: 'Closing Balance'
    }
  },
  {
    id: 'builtin:icici',
    name: 'ICICI Bank',
    builtIn: true,
    dateFormat: 'dmy',
    convention: 'debit_credit',
    columns: {
      date: 'Transaction Date',
      narration: 'Transaction Remarks',
      reference: 'Cheque Number',
      debit: 'Withdrawal Amount (INR )',
      credit: 'Deposit Amount (INR )',
      balance: 'Balance (INR )'
    }
  },
  {
    id: 'builtin:sbi',
    name: 'State Bank of India',
    builtIn: true,
    dateFormat: 'dmy',
    convention: 'debit_credit',
    columns: {
      date: 'Txn Date',
      narration: 'Description',
      reference: 'Ref No./Cheque No.',
      debit: 'Debit',
      credit: 'Credit',
      balance: 'Balance'
    }
  },
  {
    id: 'builtin:axis',
    name: 'Axis Bank',
    builtIn: true,
    dateFormat: 'dmy',
    convention: 'debit_credit',
    columns: {
      date: 'Tran Date',
      narration: 'PARTICULARS',
      reference: 'CHQNO',
      debit: 'DR',
      credit: 'CR',
      balance: 'BAL'
    }
  },
  {
    id: 'builtin:kotak',
    name: 'Kotak Mahindra Bank',
    builtIn: true,
    dateFormat: 'dmy',
    convention: 'flagged',
    debitFlag: 'DR',
    columns: {
      date: 'Transaction Date',
      narration: 'Description',
      reference: 'Chq / Ref No.',
      amount: 'Amount',
      drCr: 'Dr / Cr',
      balance: 'Balance'
    }
  }
]

/**
 * Header comparison key: lowercase, letters and digits only.
 *
 * Banks pad headers with spaces, dots, slashes and `(INR )` — none of which carry meaning, all of
 * which change between two exports from the same bank. Stripping them is what lets one transcribed
 * profile match a file downloaded a year later.
 */
export function normaliseHeader(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Column indexes resolved against a real header row; -1 means the file has no such column. */
export interface ResolvedColumns {
  date: number
  narration: number
  reference: number
  debit: number
  credit: number
  amount: number
  drCr: number
  balance: number
}

const EMPTY_RESOLVED: ResolvedColumns = {
  date: -1, narration: -1, reference: -1, debit: -1, credit: -1, amount: -1, drCr: -1, balance: -1
}

/** Which fields a profile cannot work without, given its amount convention. */
export function requiredFields(convention: AmountConvention): ProfileField[] {
  if (convention === 'signed') return ['date', 'amount']
  if (convention === 'flagged') return ['date', 'amount', 'drCr']
  // debit_credit tolerates one side being absent: a statement of nothing but charges has no
  // credit column, and refusing to read it would be pedantry.
  return ['date']
}

/**
 * Map a profile's header names onto a real header row.
 *
 * `missing` lists the required fields whose column isn't in the file — the one honest answer to
 * "why did this profile not read your statement".
 */
export function resolveColumns(header: string[], profile: StatementProfile): { columns: ResolvedColumns; missing: ProfileField[] } {
  const keys = header.map(normaliseHeader)
  const find = (name: string | null | undefined): number => {
    if (!name) return -1
    const want = normaliseHeader(name)
    if (want === '') return -1
    const exact = keys.indexOf(want)
    if (exact >= 0) return exact
    // A bank that renames 'Debit' to 'Debit Amount' between exports should not break the profile.
    // Only for names long enough to mean something: 'DR' is a prefix of 'Dr / Cr', and treating
    // Kotak's direction flag as Axis's debit column would read every withdrawal as a deposit.
    if (want.length < 4) return -1
    return keys.findIndex((k) => k.length >= 4 && (k.startsWith(want) || want.startsWith(k)))
  }

  const columns: ResolvedColumns = {
    date: find(profile.columns.date),
    narration: find(profile.columns.narration),
    reference: find(profile.columns.reference),
    debit: find(profile.columns.debit),
    credit: find(profile.columns.credit),
    amount: find(profile.columns.amount),
    drCr: find(profile.columns.drCr),
    balance: find(profile.columns.balance)
  }

  const missing = requiredFields(profile.convention).filter((f) => columns[f] < 0)
  // debit_credit needs at least one money column, whichever side it is.
  if (profile.convention === 'debit_credit' && columns.debit < 0 && columns.credit < 0) {
    missing.push('debit')
  }
  return { columns, missing }
}

/**
 * Pick the profile whose columns the header row actually contains.
 *
 * Scored by how many of the profile's declared columns are present, so between two profiles that
 * both fit, the one that explains more of the file wins. A profile missing a required column
 * cannot win at all — half a match is a misread statement, not a lucky guess.
 */
export function detectProfile(header: string[], profiles: StatementProfile[] = BUILTIN_PROFILES): StatementProfile | null {
  let best: { profile: StatementProfile; score: number } | null = null
  for (const profile of profiles) {
    const { columns, missing } = resolveColumns(header, profile)
    if (missing.length > 0) continue
    const declared = PROFILE_FIELDS.filter((f) => profile.columns[f as keyof ProfileColumns])
    const score = declared.filter((f) => columns[f] >= 0).length
    // Narration is the field that makes rules and learning work; a profile that maps it is worth
    // more than one that scraped the same number of anonymous columns.
    const weighted = score + (columns.narration >= 0 ? 1 : 0)
    if (!best || weighted > best.score) best = { profile, score: weighted }
  }
  return best?.profile ?? null
}

/**
 * Last-resort column guess from header wording, for a statement no profile claims.
 *
 * This is the heuristic the importer used before profiles existed, kept as the fallback so an
 * unrecognised-but-obvious file still imports. Returns null when there is no date column, which
 * is the one thing no amount of guessing can substitute for.
 */
export function guessProfile(header: string[]): StatementProfile | null {
  const keys = header.map((h) => h.trim().toLowerCase())
  const at = (pred: (h: string) => boolean): string | null => {
    const i = keys.findIndex(pred)
    return i >= 0 ? header[i]! : null
  }
  const date = at((h) => h.includes('date'))
  if (!date) return null

  const debit = at((h) => h.includes('debit') || h.includes('withdraw'))
  const credit = at((h) => h.includes('credit') || h.includes('deposit'))
  const amount = at((h) => h.includes('amount'))
  const drCr = at((h) => /^(dr\s*\/?\s*cr|cr\s*\/?\s*dr|type|indicator)$/.test(h))
  const narration = at((h) => h.includes('desc') || h.includes('narrat') || h.includes('particular') || h.includes('remark'))
  const reference = at((h) => h.includes('ref') || h.includes('chq') || h.includes('cheque') || h.includes('utr'))

  // Debit/credit pairs win over a lone amount column: a file with both `Withdrawal Amount` and
  // `Deposit Amount` reads as two-sided, not as one signed column that happens to say 'amount'.
  const convention: AmountConvention =
    debit || credit ? 'debit_credit' : drCr && amount ? 'flagged' : 'signed'

  return {
    id: 'guess',
    name: 'Guessed from the header',
    builtIn: false,
    dateFormat: 'dmy',
    convention,
    debitFlag: 'DR',
    columns: {
      date,
      narration: narration ?? '',
      reference,
      debit: convention === 'debit_credit' ? debit : null,
      credit: convention === 'debit_credit' ? credit : null,
      amount: convention === 'debit_credit' ? null : amount,
      drCr: convention === 'flagged' ? drCr : null,
      balance: at((h) => h.includes('balance'))
    }
  }
}

const MONTH_NAMES: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
}

function daysInMonth(year: number, month: number): number {
  const lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (month === 2 && (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0))) return 29
  return lengths[month - 1] ?? 0
}

function iso(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12) return null
  if (day < 1 || day > daysInMonth(year, month)) return null
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * Parse a statement date cell to ISO, reading numeric cells in the profile's declared order.
 *
 * 03/04/2026 is 3 April to an Indian bank and 4 March to an American one, and nothing in the cell
 * says which. Guessing per row is worse than useless — it produces a statement whose dates are
 * right in January and wrong in June. So the order comes from the profile and a cell that doesn't
 * fit it (13 as a month under 'dmy') is rejected rather than quietly swapped.
 *
 * Unambiguous forms bypass the setting entirely: ISO `2026-04-03` and month-name `03-Apr-2026`
 * mean the same thing to every bank.
 */
export function parseStatementDate(cell: string, format: StatementDateFormat = 'dmy'): string | null {
  const t = cell.trim().replace(/"/g, '')
  if (t === '') return null

  // ISO, possibly with a time suffix the bank tacked on.
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/)
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]))

  // 15-Aug-2025 / 15 Aug 25 / 15-August-2025 — the month is spelled, so there is nothing to guess.
  m = t.match(/^(\d{1,2})[-/. ]([A-Za-z]{3,9})[-/. ](\d{2}|\d{4})$/)
  if (m) {
    const month = MONTH_NAMES[m[2]!.slice(0, 3).toLowerCase()]
    if (!month) return null
    const year = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3])
    return iso(year, Number(month), Number(m[1]))
  }

  m = t.match(/^(\d{1,4})[/.-](\d{1,2})[/.-](\d{2,4})(?:[T ].*)?$/)
  if (!m) return null
  const a = Number(m[1])
  const b = Number(m[2])
  const c = Number(m[3])
  const expand = (y: number): number => (y < 100 ? 2000 + y : y)

  // A four-digit leading component is a year whatever the profile says — 2026/04/03 cannot be a
  // day, and rejecting it would fail a file that is not actually ambiguous.
  if (m[1]!.length === 4) return iso(a, b, c)
  if (format === 'ymd') return iso(expand(a), b, c)
  if (format === 'mdy') return iso(expand(c), a, b)
  return iso(expand(c), b, a)
}

/**
 * Parse a statement amount cell to integer paise.
 *
 * Bank exports write the same number as `1,234.56`, `₹1,234.56`, `1234.56 Cr`, `(1,234.56)` for a
 * negative, and `-` for nothing at all. Everything goes through `parseRupees`, which does the
 * decimal split in integer arithmetic — a float never touches the amount.
 */
export function parseBankAmount(cell: string): number | null {
  let t = cell.trim().replace(/["₹]/g, '').replace(/\s+/g, '')
  if (t === '' || t === '-' || t === '.') return null

  // Trailing/leading Dr/Cr markers on the amount itself: 'Cr' is money in, 'Dr' money out.
  let sign = 1
  const marker = t.match(/^(dr|cr)|(dr|cr)$/i)
  if (marker) {
    if (/dr/i.test(marker[0])) sign = -1
    t = t.replace(/^(dr|cr)|(dr|cr)$/gi, '')
  }
  // Accounting parentheses mean negative.
  if (/^\(.*\)$/.test(t)) {
    sign = -sign
    t = t.slice(1, -1)
  }
  const paise = parseRupees(t)
  if (paise === null) return null
  return sign * paise
}

export interface ParsedStatementRow {
  date: string
  description: string
  /** Cheque/UTR/reference cell, '' when the statement has no such column. */
  reference: string
  /** Positive paise: money into the account. */
  deposit: number
  /** Positive paise: money out. */
  withdrawal: number
  /** 1-based physical CSV line, so a skipped-row report can point at something. */
  line: number
}

export type SkipReason = 'no_date' | 'no_amount' | 'zero_amount'

export interface StatementParseResult {
  header: string[]
  profile: StatementProfile
  columns: ResolvedColumns
  rows: ParsedStatementRow[]
  /** Rows the profile could not read, with the reason — a wrong profile shows up here as a pile
   *  of 'no_date' or 'no_amount', which is how the UI knows to offer remapping. */
  skipped: { line: number; reason: SkipReason }[]
}

export class StatementProfileError extends Error {
  constructor(
    message: string,
    readonly header: string[],
    readonly missing: ProfileField[]
  ) {
    super(message)
    this.name = 'StatementProfileError'
  }
}

/** Header cells of a statement CSV, for the column-mapping UI. Empty when the file has no rows. */
export function statementHeader(csv: string): string[] {
  const records = parseCsv(csv)
  return records[0]?.cells.map((c) => c.trim()) ?? []
}

/**
 * Read a statement CSV under a profile.
 *
 * `profile` omitted = detect a built-in from the header, else fall back to the wording heuristic.
 * A statement nothing can read throws `StatementProfileError` carrying the header row, so the
 * caller can put the user in front of a column mapper instead of an error toast.
 */
export function parseStatement(csv: string, profile?: StatementProfile | null): StatementParseResult {
  const records = parseCsv(csv)
  const header = records[0]?.cells.map((c) => c.trim()) ?? []
  if (records.length < 2) {
    return {
      header,
      profile: profile ?? { id: 'none', name: 'None', builtIn: false, dateFormat: 'dmy', convention: 'debit_credit', columns: { date: '', narration: '' } },
      columns: EMPTY_RESOLVED,
      rows: [],
      skipped: []
    }
  }

  const chosen = profile ?? detectProfile(header) ?? guessProfile(header)
  if (!chosen) {
    throw new StatementProfileError(
      'No date column found in the CSV header — pick the columns by hand to import this statement',
      header,
      ['date']
    )
  }
  const { columns, missing } = resolveColumns(header, chosen)
  if (missing.length > 0) {
    throw new StatementProfileError(
      `The "${chosen.name}" profile expects ${missing.map((f) => `a ${f} column`).join(' and ')}, which this file does not have`,
      header,
      missing
    )
  }

  const debitFlag = normaliseHeader(chosen.debitFlag ?? 'DR')
  const rows: ParsedStatementRow[] = []
  const skipped: { line: number; reason: SkipReason }[] = []

  for (const record of records.slice(1)) {
    const cell = (i: number): string => (i >= 0 ? (record.cells[i] ?? '') : '')
    const date = parseStatementDate(cell(columns.date), chosen.dateFormat)
    if (!date) {
      // Trailing junk (totals, disclaimers, blank separators) has no date either — reported, not
      // fatal, because every bank puts some of it at the bottom of the file.
      skipped.push({ line: record.line, reason: 'no_date' })
      continue
    }

    let deposit = 0
    let withdrawal = 0
    if (chosen.convention === 'debit_credit') {
      withdrawal = Math.abs(parseBankAmount(cell(columns.debit)) ?? 0)
      deposit = Math.abs(parseBankAmount(cell(columns.credit)) ?? 0)
    } else {
      const raw = parseBankAmount(cell(columns.amount))
      if (raw === null) {
        skipped.push({ line: record.line, reason: 'no_amount' })
        continue
      }
      if (chosen.convention === 'flagged') {
        const isDebit = normaliseHeader(cell(columns.drCr)).startsWith(debitFlag)
        const magnitude = Math.abs(raw)
        if (isDebit) withdrawal = magnitude
        else deposit = magnitude
      } else if (raw >= 0) {
        deposit = raw
      } else {
        withdrawal = -raw
      }
    }

    if (deposit === 0 && withdrawal === 0) {
      // A zero-amount line is a bank's own bookkeeping (a reversed charge, a balance marker). It
      // can never match a voucher and would only ever be noise in the unmatched list.
      skipped.push({ line: record.line, reason: 'zero_amount' })
      continue
    }

    rows.push({
      date,
      description: cell(columns.narration).trim(),
      reference: cell(columns.reference).trim(),
      deposit,
      withdrawal,
      line: record.line
    })
  }

  return { header, profile: chosen, columns, rows, skipped }
}
