import { readFileSync, writeFileSync } from 'fs'
import { deflateRawSync, inflateRawSync } from 'zlib'
import { readXlsx, writeXlsx, type Workbook, type XlsxSheet } from '@shared/xlsx'

/** zlib for the pure XLSX layer (src/shared/xlsx): raw DEFLATE, as ZIP stores it. */
export const zInflate = (b: Uint8Array): Uint8Array => new Uint8Array(inflateRawSync(b))
export const zDeflate = (b: Uint8Array): Uint8Array => new Uint8Array(deflateRawSync(b, { level: 6 }))

export function readXlsxBytes(bytes: Uint8Array, opts: { onlySheets?: string[] } = {}): Workbook {
  return readXlsx(bytes, zInflate, opts)
}

export function readXlsxFile(path: string): Workbook {
  return readXlsxBytes(new Uint8Array(readFileSync(path)))
}

export function xlsxBytes(sheets: XlsxSheet[]): Uint8Array {
  return writeXlsx(sheets, zDeflate)
}

export function writeXlsxFile(path: string, sheets: XlsxSheet[]): void {
  writeFileSync(path, xlsxBytes(sheets))
}
