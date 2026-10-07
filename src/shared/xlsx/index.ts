/**
 * In-house XLSX support (WP 6.3) — no dependency. Pure: the ZIP container (zip.ts), the
 * SpreadsheetML reader (reader.ts) and writer (writer.ts). zlib is injected by the caller
 * (src/main/services/xlsxFile.ts in the app, node:zlib in tests).
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
