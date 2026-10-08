/**
 * In-house XLSX support (WP 6.3) — no dependency. Pure: the ZIP container (zip.ts), the
 * SpreadsheetML reader (reader.ts) and writer (writer.ts). zlib is injected by the caller
 * (src/main/services/xlsxFile.ts in the app, node:zlib in tests).
 *
 * Why WP 4.1's reader (src/shared/bankFormats/xlsx.ts) is not reused: the two are not equivalent.
 * That one turns ONE sheet of a bank statement into a string grid (built-in date formats only, a
 * 200 000-row cap, its own pure inflate). This one reads every sheet of a workbook with sparse
 * row numbers (the import wizard reports errors by spreadsheet row), custom date formats and the
 * 1904 system, and carries the WRITER (typed ₹ / date / quantity cells) the exports need. Merging
 * would mean growing the bank reader into this one; left for a later clean-up rather than changing
 * WP 4.1's tested import path here.
 */
import { looksLikeZip, readZip, type Inflate } from './zip'
import { readWorkbook, type Workbook } from './reader'

export * from './zip'
export * from './reader'
export * from './writer'

/** Unzip + parse an .xlsx. */
export function readXlsx(bytes: Uint8Array, inflate: Inflate, opts: { onlySheets?: string[] } = {}): Workbook {
  if (!looksLikeZip(bytes)) {
    // Old binary .xls (OLE2 compound file: D0 CF 11 E0).
    if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
      throw new Error('This is an Excel 97–2003 (.xls) file — open it in Excel or LibreOffice and save it as .xlsx (or CSV)')
    }
    throw new Error('Not an .xlsx file')
  }
  const files = readZip(bytes, inflate)
  const dec = new TextDecoder('utf-8')
  const cache = new Map<string, string>()
  return readWorkbook(
    (path) => {
      if (cache.has(path)) return cache.get(path)
      const f = files.get(path)
      if (!f) return undefined
      const s = dec.decode(f)
      cache.set(path, s)
      return s
    },
    opts
  )
}
