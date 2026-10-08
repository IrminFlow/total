/** Shared shapes for the bank-statement importer registry (WP 4.1). Pure — no I/O. */

export type BankFormatId = 'csv' | 'xlsx' | 'mt940' | 'camt053' | 'pasted'

/** One normalised statement line, whatever the source format. Money is integer paise. */
export interface StatementLine {
  /** Booking / transaction date, ISO 'YYYY-MM-DD'. */
  date: string
  valueDate: string | null
  description: string
  /** Cheque number / UTR / bank reference, '' when the source has none. */
  reference: string
  /** Positive paise: money into the account. */
  deposit: number
  /** Positive paise: money out. */
  withdrawal: number
  /** Running balance after the line when the statement shows one (credit balance positive). */
  balance: number | null
}

export interface ParsedStatement {
  format: BankFormatId
  lines: StatementLine[]
  /** Plain-language notes about rows skipped or guessed (shown in the preview). */
  warnings: string[]
  account: string | null
  currency: string | null
  openingBalance: number | null
  closingBalance: number | null
}

export const DATE_FORMATS = ['auto', 'DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'DD-MMM-YYYY', 'DD/MM/YY'] as const
export type DateFormat = (typeof DATE_FORMATS)[number]

export const DELIMITERS = ['auto', ',', ';', '\t', '|'] as const
export type Delimiter = (typeof DELIMITERS)[number]

export const ENCODINGS = ['utf-8', 'utf-16le', 'windows-1252'] as const
export type TextEncodingName = (typeof ENCODINGS)[number]

/**
 * Column mapping for tabular statements (CSV / TXT / XLSX). Column numbers are 0-based indexes
 * into the grid; `headerRow` is 1-based (0 = the file has no header row — data starts at row 1).
 * `amountMode`:
 *  - 'split'  — separate withdrawal (debit) and deposit (credit) columns;
 *  - 'signed' — one amount column, positive = deposit (negative = withdrawal) unless
 *               `signedNegativeIsDeposit` flips it (some banks export withdrawals as positive);
 *  - 'flag'   — one amount column plus a Dr/Cr indicator column.
 */
export interface ImportProfile {
  delimiter: Delimiter
  encoding: TextEncodingName
  headerRow: number
  dateFormat: DateFormat
  dateCol: number
  valueDateCol: number | null
  descCols: number[]
  refCol: number | null
  amountMode: 'split' | 'signed' | 'flag'
  debitCol: number | null
  creditCol: number | null
  amountCol: number | null
  flagCol: number | null
  balanceCol: number | null
  signedNegativeIsDeposit: boolean
}
