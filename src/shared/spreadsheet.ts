/**
 * SpreadsheetML 2003 — the ".xls" Excel, Numbers and LibreOffice all open natively.
 *
 * Why not a real XLSX: XLSX is a ZIP of a dozen XML parts, and writing one honestly means adding
 * a compression dependency to an offline accounting app whose whole export path is currently
 * plain text. SpreadsheetML is a single XML file, needs no dependency, keeps numbers as numbers
 * (so a column of amounts sums in the sheet, which is the entire reason CSV is not enough), and
 * carries multiple named sheets, column widths and bold rows. The cost is the file extension:
 * Excel shows a "the format does not match the extension" prompt if it is named .xlsx, so these
 * are written as .xls, which it opens without complaint.
 *
 * Money never becomes a float here. `plainRupees` converts integer paise to an exact decimal
 * STRING by integer division, and that string is what goes into the XML; Excel parses it back
 * into its own decimal type. No `/ 100` ever happens in JavaScript's number type.
 */

import { plainRupees } from './money'

export type XlsCell =
  | { kind: 'text'; text: string }
  | { kind: 'money'; paise: number }
  /** A plain number that is NOT money — a count, a ratio, a percentage. */
  | { kind: 'number'; value: number }
  /** ISO YYYY-MM-DD. Written as a real date so the sheet can sort and filter by it. */
  | { kind: 'date'; iso: string }

export interface XlsRow {
  cells: XlsCell[]
  /** Subtotal / total rows, rendered bold with a rule above — mirrors the PDF template. */
  bold?: boolean
}

export interface XlsSheet {
  name: string
  header: string[]
  rows: XlsRow[]
}

export const text = (s: string): XlsCell => ({ kind: 'text', text: s })
export const money = (paise: number): XlsCell => ({ kind: 'money', paise })
export const num = (value: number): XlsCell => ({ kind: 'number', value })
export const date = (iso: string): XlsCell => ({ kind: 'date', iso })

const esc = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Control characters are not legal in XML 1.0 and Excel refuses the whole file over one of
    // them. A narration pasted from a PDF is the usual source.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')

/**
 * Excel's sheet-name rules: 31 characters, and none of `[]:*?/\`. A name that breaks either
 * makes the workbook unopenable rather than merely ugly, so this is a hard sanitise, and blank
 * names fall back to Sheet rather than producing an unnamed tab.
 */
export function sheetName(raw: string, fallback = 'Sheet'): string {
  const cleaned = raw.replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31).trim()
  return cleaned || fallback
}

/** Distinct names, because Excel silently drops a workbook with two sheets called the same thing. */
function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>()
  return names.map((n) => {
    let candidate = n
    let i = 2
    while (seen.has(candidate.toLowerCase())) {
      const suffix = ` (${i++})`
      candidate = n.slice(0, 31 - suffix.length) + suffix
    }
    seen.add(candidate.toLowerCase())
    return candidate
  })
}

function cellXml(cell: XlsCell, styleId: string | null): string {
  const style = styleId ? ` ss:StyleID="${styleId}"` : ''
  switch (cell.kind) {
    case 'text':
      return `<Cell${style}><Data ss:Type="String">${esc(cell.text)}</Data></Cell>`
    case 'money':
      return `<Cell ss:StyleID="${styleId === 'bold' ? 'boldMoney' : 'money'}"><Data ss:Type="Number">${plainRupees(
        cell.paise
      )}</Data></Cell>`
    case 'number':
      return `<Cell${style}><Data ss:Type="Number">${Number.isFinite(cell.value) ? cell.value : 0}</Data></Cell>`
    case 'date':
      return `<Cell ss:StyleID="${styleId === 'bold' ? 'boldDate' : 'date'}"><Data ss:Type="DateTime">${esc(
        cell.iso
      )}T00:00:00.000</Data></Cell>`
  }
}

/** Rough column width in points, from the widest string the column carries. */
function columnWidths(sheet: XlsSheet): number[] {
  const widths = sheet.header.map((h) => h.length)
  for (const row of sheet.rows) {
    row.cells.forEach((c, i) => {
      const len =
        c.kind === 'text' ? c.text.length : c.kind === 'money' ? plainRupees(c.paise).length + 3 : c.kind === 'date' ? 10 : 8
      widths[i] = Math.max(widths[i] ?? 0, len)
    })
  }
  return widths.map((w) => Math.min(340, Math.max(48, w * 6.2)))
}

/** One workbook, one or many sheets. Returns the whole XML document as a string. */
export function buildSpreadsheet(sheets: XlsSheet[]): string {
  const names = uniqueNames(sheets.map((s) => sheetName(s.name)))
  const body = sheets
    .map((sheet, si) => {
      const widths = columnWidths(sheet)
      const cols = widths.map((w) => `<Column ss:AutoFitWidth="0" ss:Width="${w.toFixed(1)}"/>`).join('')
      const head = `<Row>${sheet.header.map((h) => `<Cell ss:StyleID="head"><Data ss:Type="String">${esc(h)}</Data></Cell>`).join('')}</Row>`
      const rows = sheet.rows
        .map((r) => `<Row>${r.cells.map((c) => cellXml(c, r.bold ? 'bold' : null)).join('')}</Row>`)
        .join('')
      // FrozenNoSplit + SplitHorizontal 1: the header row stays put when a 30,000-row trial
      // balance is scrolled, which is the first thing anyone does with an exported report.
      return `<Worksheet ss:Name="${esc(names[si]!)}"><Table>${cols}${head}${rows}</Table>
  <WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel">
   <FreezePanes/><FrozenNoSplit/><SplitHorizontal>1</SplitHorizontal><TopRowBottomPane>1</TopRowBottomPane><ActivePane>2</ActivePane>
  </WorksheetOptions></Worksheet>`
    })
    .join('')

  return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Styles>
  <Style ss:ID="Default" ss:Name="Normal"><Alignment ss:Vertical="Bottom"/><Font ss:FontName="Calibri" ss:Size="11"/></Style>
  <Style ss:ID="head"><Font ss:Bold="1"/><Interior ss:Color="#F2F2EE" ss:Pattern="Solid"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/></Borders></Style>
  <Style ss:ID="bold"><Font ss:Bold="1"/><Borders><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1"/></Borders></Style>
  <Style ss:ID="money"><NumberFormat ss:Format="#,##0.00"/></Style>
  <Style ss:ID="boldMoney"><Font ss:Bold="1"/><NumberFormat ss:Format="#,##0.00"/><Borders><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1"/></Borders></Style>
  <Style ss:ID="date"><NumberFormat ss:Format="dd/mm/yyyy"/></Style>
  <Style ss:ID="boldDate"><Font ss:Bold="1"/><NumberFormat ss:Format="dd/mm/yyyy"/></Style>
 </Styles>
${body}
</Workbook>`
}
