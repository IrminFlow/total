/**
 * SheetJS-free .xlsx reader: unzip (./zip.ts) → workbook.xml (first sheet + date system) →
 * workbook rels → the sheet XML, resolving shared strings (sharedStrings.xml) and inline strings,
 * and turning date-formatted numeric cells into ISO dates via styles.xml.
 *
 * Layout per ECMA-376 Part 1 (Office Open XML): §18.3.1.4 `c` (cell: `r`, `t` type s/str/
 * inlineStr/b/n/e, `s` style index), §18.4.9 `sst`/`si` (shared strings, rich-text runs `r/t`),
 * §18.8.10 `cellXfs` and §18.8.30 `numFmt`, built-in number formats §18.8.30 (ids 14–22 and
 * 45–47 are date/time). Serial dates count days from 1899-12-30 in the 1900 system (which keeps
 * Lotus' phantom 1900-02-29) or from 1904-01-01 when workbookPr@date1904 is set.
 *
 * The output is a plain grid of strings — the same shape the delimited (CSV) reader produces —
 * so one column-mapping profile drives both.
 */
import { child, childrenOf, descendants, parseXml, textOf, type XmlNode } from './xml'
import { unzipText } from './zip'

const BUILTIN_DATE_FMTS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47])

/** 'B12' → 1 (0-based column index). */
export function columnIndex(ref: string): number {
  const letters = ref.match(/^[A-Z]+/i)?.[0]?.toUpperCase() ?? 'A'
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

/** Excel serial day number → 'YYYY-MM-DD'. */
export function excelSerialToISO(serial: number, date1904 = false): string {
  const whole = Math.floor(serial)
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30)
  // 1900 system: serials before 61 sit before the phantom 1900-02-29 and are one day early.
  const days = !date1904 && whole < 61 ? whole + 1 : whole
  const d = new Date(base + days * 86_400_000)
  return d.toISOString().slice(0, 10)
}

function isDateFormatCode(code: string): boolean {
  // Strip quoted literals, escapes and [colour]/[locale] sections, then look for d/m/y tokens.
  const bare = code.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[[^\]]*\]/g, '')
  return /[dy]/i.test(bare) || /m{3,}/i.test(bare)
}

export interface XlsxSheet {
  name: string
  rows: string[][]
}

/** Read the first worksheet (or the named one) of an .xlsx file as a grid of strings. */
export function readXlsx(bytes: Uint8Array, sheetName?: string): XlsxSheet {
  const parts = unzipText(bytes, (n) => (n.startsWith('xl/') && n.endsWith('.xml')) || n.endsWith('.rels'))
  const workbookXml = parts.get('xl/workbook.xml')
  if (!workbookXml) throw new Error('Not an Excel workbook (xl/workbook.xml is missing)')
  const workbook = parseXml(workbookXml)
  const date1904 = ['1', 'true'].includes(child(workbook, 'workbookPr')?.attrs['date1904'] ?? '')
  const sheets = childrenOf(child(workbook, 'sheets'), 'sheet')
  if (sheets.length === 0) throw new Error('The workbook has no sheets')
  const sheet = (sheetName ? sheets.find((s) => s.attrs['name'] === sheetName) : undefined) ?? sheets[0]!
  const rid = Object.entries(sheet.attrs).find(([k]) => k === 'r:id' || k.endsWith(':id'))?.[1]

  let target = 'worksheets/sheet1.xml'
  const relsXml = parts.get('xl/_rels/workbook.xml.rels')
  if (relsXml && rid) {
    const rel = childrenOf(parseXml(relsXml), 'Relationship').find((r) => r.attrs['Id'] === rid)
    if (rel?.attrs['Target']) target = rel.attrs['Target']
  }
  const sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`
  const sheetXml = parts.get(sheetPath)
  if (!sheetXml) throw new Error(`Worksheet part ${sheetPath} is missing`)

  const shared: string[] = []
  const sst = parts.get('xl/sharedStrings.xml')
  if (sst) {
    for (const si of childrenOf(parseXml(sst), 'si')) {
      // Plain <t>, or rich text runs <r><t>…</t></r>; phonetic runs (rPh) are not part of the value.
      const direct = child(si, 't')
      shared.push(direct ? textOf(direct) : childrenOf(si, 'r').map((r) => textOf(child(r, 't'))).join(''))
    }
  }

  const dateStyles = new Set<number>()
  const stylesXml = parts.get('xl/styles.xml')
  if (stylesXml) {
    const styles = parseXml(stylesXml)
    const custom = new Map<number, string>()
    for (const f of childrenOf(child(styles, 'numFmts'), 'numFmt')) custom.set(Number(f.attrs['numFmtId']), f.attrs['formatCode'] ?? '')
    childrenOf(child(styles, 'cellXfs'), 'xf').forEach((xf, idx) => {
      const id = Number(xf.attrs['numFmtId'] ?? 0)
      if (BUILTIN_DATE_FMTS.has(id) || (custom.has(id) && isDateFormatCode(custom.get(id)!))) dateStyles.add(idx)
    })
  }

  const rows: string[][] = []
  const data = child(parseXml(sheetXml), 'sheetData')
  let nextRow = 0
  for (const row of childrenOf(data, 'row')) {
    const r = row.attrs['r'] ? Number(row.attrs['r']) - 1 : nextRow
    nextRow = r + 1
    const cells: string[] = []
    let nextCol = 0
    for (const c of childrenOf(row, 'c')) {
      const col = c.attrs['r'] ? columnIndex(c.attrs['r']) : nextCol
      nextCol = col + 1
      cells[col] = cellValue(c, shared, dateStyles, date1904)
    }
    for (let k = 0; k < cells.length; k++) if (cells[k] === undefined) cells[k] = ''
    rows[r] = cells
  }
  for (let k = 0; k < rows.length; k++) if (!rows[k]) rows[k] = []
  return { name: sheet.attrs['name'] ?? 'Sheet1', rows }
}

function cellValue(c: XmlNode, shared: string[], dateStyles: Set<number>, date1904: boolean): string {
  const t = c.attrs['t'] ?? 'n'
  const v = textOf(child(c, 'v'))
  if (t === 's') return shared[Number(v)] ?? ''
  if (t === 'inlineStr') return descendants(c, 't').map(textOf).join('')
  if (t === 'str' || t === 'e') return v
  if (t === 'b') return v === '1' ? 'TRUE' : 'FALSE'
  if (v === '') return ''
  const style = Number(c.attrs['s'] ?? -1)
  const num = Number(v)
  if (dateStyles.has(style) && Number.isFinite(num)) return excelSerialToISO(num, date1904)
  return v
}
