/**
 * XLSX (SpreadsheetML, ECMA-376 Part 1) reader — pure. Takes the workbook's parts as already
 * inflated XML strings (`getPart(path)`), so it runs anywhere; the ZIP + zlib side lives in
 * zip.ts and the main process. What it understands:
 *
 *  - xl/workbook.xml (+ its .rels): sheet names in tab order, the 1904 date system flag;
 *  - xl/sharedStrings.xml: plain and rich-text (`<r>`) strings; phonetic runs (`<rPh>`) skipped;
 *  - xl/styles.xml: cellXfs → numFmtId, built-in (14–22, 27–36, 45–47, 50–58) and custom date
 *    formats, so a numeric cell styled as a date comes back as `{ date: 'YYYY-MM-DD' }`;
 *  - sheet XML: `t="s" | "str" | "inlineStr" | "b" | "e" | "n" | "d"`, sparse rows and cells
 *    (missing `r` refs fall back to position), self-closing cells.
 *
 * Formulas are NOT evaluated: the cached value (`<v>`) written by the last application that
 * saved the file is used, and a formula with no cached value reads as empty.
 * Times are dropped from date-time cells (accounting imports need the date).
 */

export type CellValue = null | string | number | boolean | { date: string }

export interface SheetRow {
  /** 1-based spreadsheet row number. */
  r: number
  cells: CellValue[]
}

export interface Sheet {
  name: string
  rows: SheetRow[]
}

export interface Workbook {
  sheets: Sheet[]
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

export function decodeXml(s: string): string {
  if (s.indexOf('&') < 0 && s.indexOf('_x') < 0) return s
  return s
    .replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, body: string) => {
      if (body[0] === '#') {
        const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
        return Number.isFinite(cp) ? String.fromCodePoint(cp) : m
      }
      return ENT[body] ?? m
    })
    // ECMA-376 §22.4.2.4 escaped characters (`_x000D_` for a carriage return, ...).
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
}

const ATTR_RE = new Map<string, RegExp>()

function attr(attrs: string, name: string): string | null {
  let re = ATTR_RE.get(name)
  if (!re) {
    re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`)
    ATTR_RE.set(name, re)
  }
  const m = re.exec(attrs)
  if (!m) return null
  return decodeXml(m[1] ?? m[2] ?? '')
}

/** Concatenated `<t>` text of a string item, skipping phonetic `<rPh>` runs. */
function stringItemText(xml: string): string {
  const body = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '')
  let out = ''
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) out += m[1] ? decodeXml(m[1]) : ''
  return out
}

export function parseSharedStrings(xml: string | undefined): string[] {
  if (!xml) return []
  const out: string[] = []
  const re = /<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) out.push(m[1] ? stringItemText(m[1]) : '')
  return out
}

const BUILTIN_DATE_FMTS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58])

/** A custom number format is a date when, outside quotes/brackets/escapes, it has d, m, y (or h/s). */
export function isDateFormatCode(code: string): boolean {
  const stripped = code
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[[^\]]*\]/g, '') // colours, conditions, locale tags ([$-409], [Red])
    .split(';')[0]!
  if (/^general$/i.test(stripped.trim())) return false
  return /[dy]/i.test(stripped) || (/m/i.test(stripped) && !/[0#?]/.test(stripped))
}

/** Per cellXfs index: does the style format a number as a date? */
export function parseDateStyles(xml: string | undefined): boolean[] {
  if (!xml) return []
  const custom = new Map<number, string>()
  const fmtRe = /<numFmt\b([^>]*)\/?>/g
  let m: RegExpExecArray | null
  while ((m = fmtRe.exec(xml))) {
    const id = Number(attr(m[1]!, 'numFmtId'))
    const code = attr(m[1]!, 'formatCode') ?? ''
    custom.set(id, code)
  }
  const xfsBlock = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? ''
  const out: boolean[] = []
  const xfRe = /<xf\b([^>]*?)(?:\/>|>)/g
  while ((m = xfRe.exec(xfsBlock))) {
    const id = Number(attr(m[1]!, 'numFmtId') ?? '0')
    const code = custom.get(id)
    out.push(code !== undefined ? isDateFormatCode(code) : BUILTIN_DATE_FMTS.has(id))
  }
  return out
}

/** Spreadsheet serial day → ISO date. 1900 system: day 1 = 1900-01-01, with Lotus's phantom
 *  1900-02-29 (serial 60) — so serials ≥ 61 count from 1899-12-30. 1904 system: day 0 = 1904-01-01. */
export function serialToISO(serial: number, date1904 = false): string | null {
  if (!Number.isFinite(serial) || serial < 0 || serial > 2958465) return null
  const day = Math.floor(serial)
  let ms: number
  if (date1904) ms = Date.UTC(1904, 0, 1) + day * 86400000
  else if (day >= 61) ms = Date.UTC(1899, 11, 30) + day * 86400000
  else if (day === 60) return '1900-02-28' // Lotus's phantom 29 Feb; the nearest real date
  else ms = Date.UTC(1899, 11, 31) + day * 86400000
  return new Date(ms).toISOString().slice(0, 10)
}

/** "AB12" → 27 (0-based column index 27). */
export function colIndex(ref: string): number {
  let n = 0
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i)
    if (c >= 65 && c <= 90) n = n * 26 + (c - 64)
    else if (c >= 97 && c <= 122) n = n * 26 + (c - 96)
    else break
  }
  return n - 1
}

export function parseSheetXml(xml: string, shared: string[], dateStyles: boolean[], date1904: boolean): SheetRow[] {
  const rows: SheetRow[] = []
  const sheetData = /<sheetData\b[^>]*>([\s\S]*)<\/sheetData>/.exec(xml)?.[1] ?? ''
  const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g
  const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g
  let rm: RegExpExecArray | null
  let nextRow = 1
  while ((rm = rowRe.exec(sheetData))) {
    const rAttr = attr(rm[1]!, 'r')
    const r = rAttr ? Number(rAttr) : nextRow
    nextRow = r + 1
    const body = rm[2] ?? ''
    const cells: CellValue[] = []
    let nextCol = 0
    let cm: RegExpExecArray | null
    cellRe.lastIndex = 0
    while ((cm = cellRe.exec(body))) {
      const a = cm[1]!
      const ref = attr(a, 'r')
      const col = ref ? colIndex(ref) : nextCol
      nextCol = col + 1
      const inner = cm[2] ?? ''
      const t = attr(a, 't') ?? 'n'
      const s = Number(attr(a, 's') ?? '0')
      const vRaw = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(inner)?.[1]
      let value: CellValue = null
      if (t === 'inlineStr') {
        const is = /<is\b[^>]*>([\s\S]*?)<\/is>/.exec(inner)?.[1]
        value = is !== undefined ? stringItemText(is) : null
      } else if (vRaw !== undefined) {
        const v = decodeXml(vRaw)
        if (t === 's') value = shared[Number(v)] ?? ''
        else if (t === 'str') value = v
        else if (t === 'b') value = v === '1' || v.toLowerCase() === 'true'
        else if (t === 'e') value = null // #N/A, #DIV/0! … — no value
        else if (t === 'd') value = /^\d{4}-\d{2}-\d{2}/.test(v) ? { date: v.slice(0, 10) } : v
        else {
          const n = Number(v)
          if (!Number.isFinite(n)) value = v
          else if (dateStyles[s]) {
            const iso = serialToISO(n, date1904)
            value = iso ? { date: iso } : n
          } else value = n
        }
      }
      if (value === '') value = null
      while (cells.length < col) cells.push(null)
      cells[col] = value
    }
    while (cells.length && cells[cells.length - 1] === null) cells.pop()
    rows.push({ r, cells })
  }
  return rows
}

function resolveTarget(target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  // Relative to xl/ (where workbook.xml lives); normalise "../".
  const parts = ['xl', ...target.split('/')]
  const out: string[] = []
  for (const p of parts) {
    if (p === '..') out.pop()
    else if (p !== '.' && p !== '') out.push(p)
  }
  return out.join('/')
}

/** Read a workbook from its parts. `onlySheets` limits parsing to the named sheets. */
/** `<x:row>` → `<row>`: some writers (OpenXML SDK, Power Query) prefix every SpreadsheetML tag
 *  with a namespace. Attributes (`r:id`) keep their prefix. */
export function stripTagPrefixes(xml: string): string {
  return /<\/?[A-Za-z_][\w.-]*:[A-Za-z]/.test(xml) ? xml.replace(/<(\/?)[A-Za-z_][\w.-]*:(?=[A-Za-z])/g, '<$1') : xml
}

export function readWorkbook(rawGetPart: (path: string) => string | undefined, opts: { onlySheets?: string[] } = {}): Workbook {
  const getPart = (path: string): string | undefined => {
    const x = rawGetPart(path)
    return x === undefined ? undefined : stripTagPrefixes(x)
  }
  const wb = getPart('xl/workbook.xml')
  if (!wb) throw new Error('Not an Excel workbook (xl/workbook.xml missing) — .xls (Excel 97–2003) files must be re-saved as .xlsx')
  const date1904 = /<workbookPr\b[^>]*date1904\s*=\s*"(1|true)"/.test(wb)
  const rels = getPart('xl/_rels/workbook.xml.rels') ?? ''
  const relTargets = new Map<string, string>()
  const relRe = /<Relationship\b([^>]*?)\/?>/g
  let m: RegExpExecArray | null
  while ((m = relRe.exec(rels))) {
    const id = attr(m[1]!, 'Id')
    const target = attr(m[1]!, 'Target')
    if (id && target) relTargets.set(id, resolveTarget(target))
  }
  const shared = parseSharedStrings(getPart('xl/sharedStrings.xml'))
  const dateStyles = parseDateStyles(getPart('xl/styles.xml'))
  const sheets: Sheet[] = []
  const sheetRe = /<sheet\b([^>]*?)\/?>/g
  let index = 0
  while ((m = sheetRe.exec(wb))) {
    index++
    const name = attr(m[1]!, 'name') ?? `Sheet${index}`
    if (opts.onlySheets && !opts.onlySheets.includes(name)) continue
    const rid = attr(m[1]!, 'r:id') ?? attr(m[1]!, 'id')
    const path = (rid && relTargets.get(rid)) || `xl/worksheets/sheet${index}.xml`
    const xml = getPart(path)
    if (xml === undefined) continue // chart sheets / dialog sheets have no worksheet part
    sheets.push({ name, rows: parseSheetXml(xml, shared, dateStyles, date1904) })
  }
  return { sheets }
}

/** A cell as the text an importer parses: dates ISO, numbers without float noise or exponent. */
export function cellText(v: CellValue): string {
  if (v === null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (typeof v === 'number') return numberText(v)
  return v.date
}

/** 0.30000000000000004 → "0.3"; 1e21 → "1000000000000000000000"; 15 significant digits like Excel. */
export function numberText(n: number): string {
  if (!Number.isFinite(n)) return ''
  if (Number.isInteger(n) && Math.abs(n) < 1e21) return n.toString()
  if (Number.isInteger(n)) return BigInt(n).toString()
  const r = Number(n.toPrecision(15))
  const s = r.toString()
  if (!/e/i.test(s)) return s
  // Tiny values (1e-7): expand without float noise.
  return r.toFixed(Math.min(20, Math.max(0, -Math.floor(Math.log10(Math.abs(r))) + 14))).replace(/\.?0+$/, '')
}
