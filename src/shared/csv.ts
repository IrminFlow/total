/** Minimal CSV helpers shared by bank-statement import (parse) and export (write). Pure — no I/O. */

/**
 * Split one CSV physical line into cells, honoring double-quoted fields (commas inside quotes
 * don't split; a quote character toggles quoting and is itself dropped from the output, so a
 * doubled `""` inside a quoted field collapses to a single literal quote).
 *
 * Extracted verbatim from the historical `splitCsvLine` in services/banking.ts — same behavior.
 */
export function parseCsvLine(line: string): string[] {
  const cells: string[] = []
  let current = ''
  let inQuotes = false
  for (const ch of line) {
    if (ch === '"') inQuotes = !inQuotes
    else if (ch === ',' && !inQuotes) {
      cells.push(current)
      current = ''
    } else current += ch
  }
  cells.push(current)
  return cells
}

/** Quote a field per RFC 4180 if it contains a comma, quote, or line break; double embedded quotes. */
function quoteCsvField(field: string): string {
  if (/["\n\r,]/.test(field)) {
    return `"${field.replace(/"/g, '""')}"`
  }
  return field
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
