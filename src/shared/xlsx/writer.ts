/**
 * XLSX writer — pure. Produces the parts of a minimal, valid SpreadsheetML workbook as XML
 * strings (`buildWorkbookParts`); `writeXlsx` zips them (compression injected, see zip.ts).
 *
 * Cells are TYPED, and the conversions are integer math (floats never touch amounts):
 *  - money: integer paise → `<v>1234.50</v>` with a "₹#,##0.00" number format;
 *  - date: ISO 'YYYY-MM-DD' → the 1900-system serial with a dd-mm-yyyy format;
 *  - qty: integer thousandths → `<v>12.5</v>` with 0–3 decimals (per column or per row);
 *  - number / integer / percent: plain numbers;
 *  - text: shared strings (de-duplicated).
 * Rows may be bold (group / total rows from the table export). Headers are bold, frozen, and
 * carry an autofilter.
 */
import { writeZip, type Deflate } from './zip'

/** money: paise with a ₹ format; amount: paise as a plain 2-decimal number (no currency claim). */
export type XlsxKind = 'text' | 'money' | 'amount' | 'date' | 'qty' | 'number' | 'integer' | 'percent'

export interface XlsxColumn {
  header: string
  kind: XlsxKind
  /** qty: decimals 0–3 (default 3). */
  decimals?: number
  /** Character width; default by kind. */
  width?: number
}

/** money / amount: paise; qty: thousandths; date: ISO string; number/integer/percent: number; text: string. */
export type XlsxCell = string | number | null | undefined

export interface XlsxRow {
  cells: XlsxCell[]
  bold?: boolean
  /** Per-row qty decimals (mixed-unit columns), by column index. */
  qtyDecimals?: Record<number, number>
}

export interface XlsxSheet {
  name: string
  columns: XlsxColumn[]
  rows: (XlsxRow | XlsxCell[])[]
  /** Optional free-text lines written ABOVE the header (title, period). */
  preamble?: string[]
}

const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g

export function escapeXml(s: string): string {
  return s.replace(INVALID_XML, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Excel's sheet-name rules: ≤ 31 chars, none of : \ / ? * [ ], unique (case-insensitive). */
export function safeSheetNames(names: string[]): string[] {
  const used = new Set<string>()
  return names.map((raw, i) => {
    let base = raw.replace(/[:\\/?*[\]]/g, ' ').replace(/^'+|'+$/g, '').trim().slice(0, 31) || `Sheet${i + 1}`
    let name = base
    for (let n = 2; used.has(name.toLowerCase()); n++) {
      const suffix = ` (${n})`
      name = base.slice(0, 31 - suffix.length) + suffix
    }
    used.add(name.toLowerCase())
    base = name
    return base
  })
}

export function colName(index: number): string {
  let n = index + 1
  let s = ''
  while (n > 0) {
    const r = (n - 1) % 26
    s = String.fromCharCode(65 + r) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

/** ISO date → 1900-system serial (integer). */
export function isoToSerial(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return null
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (!Number.isFinite(ms)) return null
  const days = Math.round((ms - Date.UTC(1899, 11, 30)) / 86400000)
  // Before 1 Mar 1900 the 1900 system is one day behind (no phantom 29 Feb yet).
  return days >= 61 ? days : days - 1
}

function paiseText(paise: number): string {
  const sign = paise < 0 ? '-' : ''
  const abs = Math.abs(Math.trunc(paise))
  const whole = Math.trunc(abs / 100)
  const frac = abs % 100
  return frac === 0 ? `${sign}${whole}` : `${sign}${whole}.${frac.toString().padStart(2, '0').replace(/0$/, '')}`
}

function milliText(milli: number): string {
  const sign = milli < 0 ? '-' : ''
  const abs = Math.abs(Math.trunc(milli))
  const whole = Math.trunc(abs / 1000)
  const frac = abs % 1000
  return frac === 0 ? `${sign}${whole}` : `${sign}${whole}.${frac.toString().padStart(3, '0').replace(/0+$/, '')}`
}

// ---------- styles ----------

/** Number formats: id → code (custom ids start at 164). */
const FMT = {
  money: { id: 164, code: '"₹"#,##0.00;-"₹"#,##0.00' },
  amount: { id: 171, code: '#,##0.00' },
  date: { id: 165, code: 'dd-mm-yyyy' },
  qty0: { id: 166, code: '#,##0' },
  qty1: { id: 167, code: '#,##0.0' },
  qty2: { id: 168, code: '#,##0.00' },
  qty3: { id: 169, code: '#,##0.000' },
  percent: { id: 170, code: '0.00' }
} as const

type StyleKey = 'text' | 'money' | 'date' | 'qty0' | 'qty1' | 'qty2' | 'qty3' | 'number' | 'percent' | 'amount'
const STYLE_KEYS: StyleKey[] = ['text', 'money', 'date', 'qty0', 'qty1', 'qty2', 'qty3', 'number', 'percent', 'amount']
/** xf index: 0 = default; then each key normal (1..9) and bold (10..18); 19 = header. */
function styleIndex(key: StyleKey, bold: boolean): number {
  return 1 + STYLE_KEYS.indexOf(key) + (bold ? STYLE_KEYS.length : 0)
}
const HEADER_STYLE = 1 + STYLE_KEYS.length * 2

function numFmtFor(key: StyleKey): number {
  switch (key) {
    case 'text':
      return 49 // "@"
    case 'number':
      return 0
    case 'money':
      return FMT.money.id
    case 'amount':
      return FMT.amount.id
    case 'date':
      return FMT.date.id
    case 'percent':
      return FMT.percent.id
    default:
      return FMT[key].id
  }
}

function stylesXml(): string {
  const fmts = Object.values(FMT)
  const xf = (fmt: number, font: number, extra = ''): string =>
    `<xf numFmtId="${fmt}" fontId="${font}" fillId="0" borderId="0" xfId="0"${fmt ? ' applyNumberFormat="1"' : ''}${font ? ' applyFont="1"' : ''}${extra}/>`
  const xfs = [
    xf(0, 0),
    ...STYLE_KEYS.map((k) => xf(numFmtFor(k), 0)),
    ...STYLE_KEYS.map((k) => xf(numFmtFor(k), 1)),
    `<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>`
  ]
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<numFmts count="${fmts.length}">${fmts.map((f) => `<numFmt numFmtId="${f.id}" formatCode="${escapeXml(f.code)}"/>`).join('')}</numFmts>` +
    `<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>` +
    `<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>` +
    `<fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/><bgColor indexed="64"/></patternFill></fill></fills>` +
    `<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>` +
    `<border><left/><right/><top/><bottom style="thin"><color auto="1"/></bottom><diagonal/></border></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>` +
    `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
    `</styleSheet>`
  )
}

// ---------- sheets ----------

const DEFAULT_WIDTH: Record<XlsxKind, number> = { text: 24, money: 16, amount: 16, date: 12, qty: 12, number: 10, integer: 10, percent: 9 }

class SharedStrings {
  list: string[] = []
  index = new Map<string, number>()
  count = 0
  add(s: string): number {
    this.count++
    let i = this.index.get(s)
    if (i === undefined) {
      i = this.list.length
      this.list.push(s)
      this.index.set(s, i)
    }
    return i
  }
  xml(): string {
    return (
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${this.count}" uniqueCount="${this.list.length}">` +
      this.list.map((s) => `<si><t${/^\s|\s$|\n/.test(s) ? ' xml:space="preserve"' : ''}>${escapeXml(s)}</t></si>`).join('') +
      `</sst>`
    )
  }
}

function sheetXml(sheet: XlsxSheet, sst: SharedStrings): string {
  const out: string[] = []
  const cols = sheet.columns
  const pre = sheet.preamble ?? []
  const headerRow = pre.length + (pre.length ? 2 : 1)
  let r = 0
  const strCell = (ref: string, s: string, style: number): string => `<c r="${ref}" s="${style}" t="s"><v>${sst.add(s)}</v></c>`
  for (const line of pre) {
    r++
    out.push(`<row r="${r}">${strCell(`A${r}`, line, styleIndex('text', r === 1))}</row>`)
  }
  if (pre.length) r++ // blank spacer row
  r++
  out.push(`<row r="${r}">${cols.map((c, i) => strCell(`${colName(i)}${r}`, c.header, HEADER_STYLE)).join('')}</row>`)
  for (const raw of sheet.rows) {
    const row: XlsxRow = Array.isArray(raw) ? { cells: raw } : raw
    r++
    const bold = !!row.bold
    const cells: string[] = []
    for (let i = 0; i < cols.length; i++) {
      const v = row.cells[i]
      if (v === null || v === undefined || v === '') continue
      const col = cols[i]!
      const ref = `${colName(i)}${r}`
      if (typeof v === 'string' && col.kind !== 'text' && col.kind !== 'date') {
        // A non-numeric string in a numeric column (e.g. "–" or a label on a totals row).
        cells.push(strCell(ref, v, styleIndex('text', bold)))
        continue
      }
      switch (col.kind) {
        case 'text':
          cells.push(strCell(ref, String(v), styleIndex('text', bold)))
          break
        case 'money':
        case 'amount':
          cells.push(`<c r="${ref}" s="${styleIndex(col.kind, bold)}"><v>${paiseText(Number(v))}</v></c>`)
          break
        case 'date': {
          const serial = typeof v === 'string' ? isoToSerial(v) : null
          if (serial === null) cells.push(strCell(ref, String(v), styleIndex('text', bold)))
          else cells.push(`<c r="${ref}" s="${styleIndex('date', bold)}"><v>${serial}</v></c>`)
          break
        }
        case 'qty': {
          const d = Math.min(3, Math.max(0, row.qtyDecimals?.[i] ?? col.decimals ?? 3))
          cells.push(`<c r="${ref}" s="${styleIndex(`qty${d}` as StyleKey, bold)}"><v>${milliText(Number(v))}</v></c>`)
          break
        }
        case 'percent':
          cells.push(`<c r="${ref}" s="${styleIndex('percent', bold)}"><v>${Number(v)}</v></c>`)
          break
        default:
          cells.push(`<c r="${ref}" s="${styleIndex('number', bold)}"><v>${Number.isFinite(Number(v)) ? Number(v) : 0}</v></c>`)
      }
    }
    out.push(`<row r="${r}">${cells.join('')}</row>`)
  }
  const lastCol = colName(Math.max(0, cols.length - 1))
  const widths = cols
    .map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width ?? DEFAULT_WIDTH[c.kind]}" customWidth="1"/>`)
    .join('')
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<dimension ref="A1:${lastCol}${Math.max(r, 1)}"/>` +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"/>` +
    (cols.length ? `<cols>${widths}</cols>` : '') +
    `<sheetData>${out.join('')}</sheetData>` +
    (cols.length && r > headerRow ? `<autoFilter ref="A${headerRow}:${lastCol}${r}"/>` : '') +
    `</worksheet>`
  )
}

/** The workbook's parts as [path, xml] pairs, in a stable order. */
export function buildWorkbookParts(sheets: XlsxSheet[]): [string, string][] {
  if (sheets.length === 0) throw new Error('A workbook needs at least one sheet')
  const names = safeSheetNames(sheets.map((s) => s.name))
  const sst = new SharedStrings()
  const sheetParts = sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s, sst)] as [string, string])
  const ct =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    sheets.map((_s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    `<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>` +
    `</Types>`
  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`
  const workbook =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<workbookPr/><bookViews><workbookView/></bookViews>` +
    `<sheets>${names.map((n, i) => `<sheet name="${escapeXml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>` +
    `</workbook>`
  const n = sheets.length
  const wbRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    sheets.map((_s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
    `<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `<Relationship Id="rId${n + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>` +
    `</Relationships>`
  return [
    ['[Content_Types].xml', ct],
    ['_rels/.rels', rootRels],
    ['xl/workbook.xml', workbook],
    ['xl/_rels/workbook.xml.rels', wbRels],
    ['xl/styles.xml', stylesXml()],
    ...sheetParts,
    ['xl/sharedStrings.xml', sst.xml()]
  ]
}

/** Builds the .xlsx bytes. Pass `deflate` (zlib.deflateRawSync) to compress; stored otherwise. */
export function writeXlsx(sheets: XlsxSheet[], deflate?: Deflate): Uint8Array {
  const enc = new TextEncoder()
  return writeZip(
    buildWorkbookParts(sheets).map(([name, xml]) => ({ name, data: enc.encode(xml) })),
    deflate
  )
}
