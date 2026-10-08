/**
 * Bank statement importer registry (WP 4.1). Every format is a pure parser from file bytes (or
 * pasted text) to a normalised ParsedStatement; `detectFormat` picks one from the file name and
 * content, `parseStatementFile` runs it. Tabular formats (CSV/TXT, XLSX) also expose their raw
 * grid so the mapping UI can show columns, and take an ImportProfile (remembered per bank
 * ledger in bank_import_profiles).
 *
 * Formats and their sources:
 *  - csv     delimited text, any of , ; TAB | (RFC 4180 quoting) — ./tabular.ts
 *  - xlsx    Office Open XML workbook, first sheet (ECMA-376) — ./xlsx.ts + ./zip.ts
 *  - mt940   SWIFT MT940 customer statement — ./mt940.ts
 *  - camt053 ISO 20022 camt.053 BankToCustomerStatement — ./camt053.ts
 *  - pasted  text copied out of a PDF statement (no OCR) — ./pasted.ts
 */
import { parseCamt053, looksLikeCamt053 } from './camt053'
import { looksLikeMt940, parseMt940 } from './mt940'
import { parsePastedStatement } from './pasted'
import { decodeBytes } from './quirks'
import { detectProfile, gridToStatement, parseDelimited, sniffDelimiter } from './tabular'
import type { BankFormatId, ImportProfile, ParsedStatement } from './types'
import { readXlsx } from './xlsx'

export * from './types'
export { importHashes, parseBankAmount, parseBankDate, normaliseNarration, decodeBytes, base64ToBytes } from './quirks'
export { detectProfile, gridToStatement, parseDelimited, sniffDelimiter } from './tabular'

export interface BankFormatInfo {
  id: BankFormatId
  label: string
  extensions: string[]
  /** Needs a column mapping (tabular). */
  tabular: boolean
  hint: string
}

export const BANK_FORMATS: BankFormatInfo[] = [
  { id: 'csv', label: 'CSV / TXT (delimited)', extensions: ['csv', 'txt', 'tsv'], tabular: true, hint: 'Any bank’s spreadsheet-style download — map the columns once per bank account.' },
  { id: 'xlsx', label: 'Excel (.xlsx)', extensions: ['xlsx'], tabular: true, hint: 'First sheet of the workbook; same column mapping as CSV. Old .xls files: save as .xlsx first.' },
  { id: 'mt940', label: 'MT940 (SWIFT)', extensions: ['sta', 'mt940', '940', 'txt'], tabular: false, hint: 'Corporate banking statement export in SWIFT MT940.' },
  { id: 'camt053', label: 'CAMT.053 (ISO 20022 XML)', extensions: ['xml', 'camt'], tabular: false, hint: 'ISO 20022 BankToCustomerStatement XML.' },
  { id: 'pasted', label: 'Copied from a PDF', extensions: [], tabular: false, hint: 'Select the transactions in your PDF viewer, copy, and paste. Scanned (image) PDFs have no text to copy.' }
]

const isZip = (b: Uint8Array): boolean => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04

/** Pick a format from the file name and content. */
export function detectFormat(fileName: string, bytes: Uint8Array): BankFormatId {
  const ext = fileName.toLowerCase().split('.').pop() ?? ''
  if (isZip(bytes) || ext === 'xlsx') return 'xlsx'
  if (ext === 'xls') throw new Error('Old Excel .xls files are not supported — open it in Excel or Numbers and save as .xlsx (or CSV)')
  if (ext === 'pdf' || (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)) {
    throw new Error('PDF files can’t be read directly — open the PDF, select the transactions, copy, and use “Paste text from a PDF”')
  }
  const head = decodeBytes(bytes.subarray(0, 64 * 1024))
  if (looksLikeCamt053(head)) return 'camt053'
  if (looksLikeMt940(head)) return 'mt940'
  return 'csv'
}

/** The raw grid of a tabular file (for the mapping UI). */
export function tabularGrid(format: 'csv' | 'xlsx', bytes: Uint8Array, profile?: Partial<ImportProfile>): { grid: string[][]; delimiter: ImportProfile['delimiter'] } {
  if (format === 'xlsx') return { grid: readXlsx(bytes).rows, delimiter: 'auto' }
  const text = decodeBytes(bytes, profile?.encoding ?? 'utf-8')
  const delimiter = !profile?.delimiter || profile.delimiter === 'auto' ? sniffDelimiter(text) : profile.delimiter
  return { grid: parseDelimited(text, delimiter), delimiter }
}

export interface StatementFileInput {
  fileName: string
  bytes?: Uint8Array
  /** Pasted text (format 'pasted', or text formats given inline). */
  text?: string
  format?: BankFormatId
  profile?: ImportProfile | null
}

export interface StatementFileResult extends ParsedStatement {
  /** Tabular formats: the grid shown in the mapping UI (first rows) and the profile used. */
  grid: string[][] | null
  profile: ImportProfile | null
}

/** Parse a statement file end to end. Tabular files without a usable profile get a detected one;
 *  when detection fails the result has no lines and a warning asking for a manual mapping. */
export function parseStatementFile(input: StatementFileInput): StatementFileResult {
  const bytes = input.bytes ?? new TextEncoder().encode(input.text ?? '')
  const format: BankFormatId = input.format ?? (input.text != null && !input.bytes ? (looksLikeCamt053(input.text) ? 'camt053' : looksLikeMt940(input.text) ? 'mt940' : 'csv') : detectFormat(input.fileName, bytes))
  if (format === 'pasted') return { ...parsePastedStatement(input.text ?? decodeBytes(bytes), input.profile?.dateFormat ?? 'auto'), grid: null, profile: null }
  if (format === 'mt940') return { ...parseMt940(input.text ?? decodeBytes(bytes, input.profile?.encoding)), grid: null, profile: null }
  if (format === 'camt053') return { ...parseCamt053(input.text ?? decodeBytes(bytes, input.profile?.encoding)), grid: null, profile: null }
  const { grid, delimiter } = tabularGrid(format, bytes, input.profile ?? undefined)
  const profile = input.profile ? { ...input.profile } : detectProfile(grid, { delimiter })
  if (!profile) {
    return {
      format, lines: [], grid, profile: null, account: null, currency: null, openingBalance: null, closingBalance: null,
      warnings: ['Couldn’t find a header row with a date and an amount column — map the columns below']
    }
  }
  return { ...gridToStatement(grid, profile, format), grid, profile }
}
