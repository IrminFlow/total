/** Minimal CSV helpers shared by bank-statement import (parse) and export (write). Pure — no I/O. */

/**
 * Split one CSV physical line into cells, honoring double-quoted fields: commas inside quotes
 * don't split, and a doubled `""` inside a quoted field is one literal `"` (RFC 4180). The
 * historical parser dropped escaped quotes entirely — fixed in v0.3 (#67).
 */
export function parseCsvLine(line: string): string[] {
  const cells: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (ch === ',' && !inQuotes) {
      cells.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  cells.push(current)
  return cells
}

export interface CsvRecord {
  /** 1-based physical line the record starts on (multi-line quoted fields span further). */
  line: number
  cells: string[]
}

/**
 * Full-text CSV parser (v0.3 #67): unlike line-splitting + `parseCsvLine`, this handles line
 * breaks INSIDE quoted fields, so a record can span physical lines. Accepts \n, \r\n and lone
 * \r line endings; blank lines produce no record. Used by bank-statement import and the CSV
 * master importers.
 */
export function parseCsv(text: string): CsvRecord[] {
  const records: CsvRecord[] = []
  let cells: string[] = []
  let current = ''
  let inQuotes = false
  let lineNo = 1
  let recordStartLine = 1

  const pushCell = (): void => {
    cells.push(current)
    current = ''
  }
  const endRecord = (): void => {
    pushCell()
    const blank = cells.length === 1 && cells[0]!.trim() === ''
    if (!blank) records.push({ line: recordStartLine, cells })
    cells = []
  }

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          current += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        if (ch === '\n') lineNo++
        current += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      pushCell()
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      endRecord()
      lineNo++
      recordStartLine = lineNo
    } else {
      current += ch
    }
  }
  if (current !== '' || cells.length > 0) endRecord()
  if (records[0]?.cells[0]?.startsWith('\uFEFF'))
    records[0].cells[0] = records[0].cells[0].slice(1)
  return records
}

/**
 * Spreadsheet formula-injection guard (v0.3 security review, lane F3): Excel/Sheets/Numbers treat
 * a cell whose text begins with `=`, `+`, `-`, or `@` (and the tab/CR-prefixed variants) as a
 * formula — or worse, a DDE command — when the CSV is opened. Names and narrations enter the books
 * from untrusted channels (Tally XML import, bank-statement CSVs, the agent inbox), and our CSVs
 * are handed to third parties (the CA pack, the agent mirror), so such cells are neutralized with
 * the standard leading single quote. Purely numeric cells (e.g. `-500` paise) are exempt: a plain
 * number can never be a formula, and amount columns must stay machine-readable.
 */
const FORMULA_TRIGGER = /^[=+\-@\t\r]/
const PLAIN_NUMBER = /^[+-]?\d+(\.\d+)?$/

export function neutralizeCsvFormula(field: string): string {
  return FORMULA_TRIGGER.test(field) && !PLAIN_NUMBER.test(field) ? `'${field}` : field
}

/** Quote a field per RFC 4180 if it contains a comma, quote, or line break; double embedded
 *  quotes. Formula-triggering cells are neutralized first (see neutralizeCsvFormula). */
function quoteCsvField(field: string): string {
  const safe = neutralizeCsvFormula(field)
  if (/["\n\r,]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`
  }
  return safe
}

/**
 * Render a header + rows as an RFC 4180 CSV string: quotes fields containing `"`, `,`, `\n`, or
 * `\r` (doubling embedded quotes), joins with CRLF line endings, and prefixes a UTF-8 BOM so
 * Excel opens it without mangling non-ASCII characters.
 */
export function rowsToCsv(header: string[], rows: string[][]): string {
  const lines = [header, ...rows].map((row) => row.map(quoteCsvField).join(','))
  return `﻿${lines.join('\r\n')}\r\n`
}
