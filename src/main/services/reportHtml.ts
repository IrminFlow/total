import type { CompanyInfo } from '@shared/domain'
import { GST_STATES } from '@shared/gst/states'

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

export interface ReportColumnSpec {
  label: string
  align: 'l' | 'r' | 'c'
  width?: number
}

export interface ReportRowSpec {
  cells: string[]
  /** Whole row in bold — used for subtotal/group rows and the grand total. */
  bold?: boolean
  /** Indents the first cell by this many levels (tree-shaped reports flattened via flattenNodes). */
  indent?: number
  /** Draws a top rule above the row; combined with `bold` this becomes the invoice-style double
   *  rule under a grand total (see .bold.rule below). */
  rule?: boolean
}

export interface ReportHtmlOptions {
  title: string
  company: CompanyInfo
  periodLabel: string
  columns: ReportColumnSpec[]
  rows: ReportRowSpec[]
  footNote?: string
}

/**
 * How many columns still read at A4 portrait width (~186mm inside the margins).
 *
 * Seven columns of 11.5px monospace numbers is about where a trial balance with opening,
 * movement and closing stops fitting, and the failure mode is the worst kind: Chromium does not
 * wrap the table, it prints the overflow on a second sheet nobody notices is missing.
 */
export const PORTRAIT_COLUMN_LIMIT = 6

/** Whether a report of this shape should be printed landscape. Exported so the IPC layer can
 *  default `landscape` rather than leaving every screen to remember. */
export function needsLandscape(columnCount: number): boolean {
  return columnCount > PORTRAIT_COLUMN_LIMIT
}

const alignClass = (a: 'l' | 'r' | 'c'): string => (a === 'l' ? '' : a)

/** One shared A4 report template used by every "print/export" button across the report screens —
 *  mirrors invoice.ts's visual language (double rule under a grand total, uppercase small
 *  headers, tabular-nums on the numeric columns, company header block) so every printed document
 *  in the app reads as one family. Every cell arrives pre-formatted by the caller (money via
 *  formatPaise, dates via toDisplayDate, ...) — this template only lays it out and escapes it. */
export function reportHtml(opts: ReportHtmlOptions): string {
  const { title, company, periodLabel, columns, rows, footNote } = opts
  // Wide reports lose a point of type rather than a column. A number too small to read is a
  // recoverable complaint; a column that silently did not print is not.
  const dense = columns.length > PORTRAIT_COLUMN_LIMIT

  const headRow = columns
    .map((c) => `<th class="${alignClass(c.align)}"${c.width ? ` style="width:${c.width}px"` : ''}>${esc(c.label)}</th>`)
    .join('')

  const bodyRows = rows
    .map((r) => {
      const cells = r.cells
        .map((cell, i) => {
          const align = columns[i] ? alignClass(columns[i]!.align) : ''
          const indentStyle = i === 0 && r.indent ? ` style="padding-left:${8 + r.indent * 16}px"` : ''
          return `<td class="${align}"${indentStyle}>${esc(cell)}</td>`
        })
        .join('')
      const cls = [r.bold ? 'bold' : '', r.rule ? 'rule' : ''].filter(Boolean).join(' ')
      return `<tr${cls ? ` class="${cls}"` : ''}>${cells}</tr>`
    })
    .join('')

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font: 12px/1.45 'Helvetica Neue', Arial, sans-serif; color: #16181f; }
    .sheet { padding: 28px; }
    .head { display: flex; justify-content: space-between; border-bottom: 1.5px solid #16181f; padding-bottom: 12px; }
    h1 { font-size: 20px; letter-spacing: 0.02em; }
    .head .num { font-family: 'SF Mono', Menlo, monospace; font-size: 11.5px; }
    .tag { text-align: right; font-size: 11px; }
    .tag b { font-size: 15px; letter-spacing: 0.08em; text-transform: uppercase; }
    .tag .period { margin-top: 3px; color: #555; }
    /* A4, with the margin the running head/foot is drawn into by printToPDF. */
    @page { size: A4; margin: 12mm; }
    table.rpt { width: 100%; border-collapse: collapse; margin-top: 14px; table-layout: fixed; }
    /* A long ledger name or narration wraps instead of pushing the numeric columns off the page.
       table-layout:fixed above is what makes this bite: without it the widest cell in a column
       sets that column's width and a 90-character narration silently cuts the amount off the
       right edge of the sheet. */
    table.rpt td, table.rpt th { overflow-wrap: anywhere; }
    table.rpt th { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; border-bottom: 1.5px solid #16181f; padding: 7px 8px; text-align: left; background: #f2f2ee; }
    table.rpt td { padding: 6px 8px; border-bottom: 1px dotted #999; vertical-align: top; }
    table.rpt td.r, table.rpt td.c { font-family: 'SF Mono', Menlo, monospace; font-size: 11.5px; }
    /* Print hardening (task Q2 #95): repeat the header row on every page and never split a row
       across a page boundary. Page numbers come from printToPDF's footerTemplate (Chromium
       ignores CSS @page margin-box counters) — see services/pdf.ts. */
    thead { display: table-header-group; }
    tr { page-break-inside: avoid; }
    .r { text-align: right; } .c { text-align: center; }
    tr.bold td { font-weight: 700; }
    tr.rule td { border-top: 1px solid #16181f; }
    tr.bold.rule td { border-top: 1px solid #16181f; border-bottom: 3px double #16181f; }
    .foot { margin-top: 14px; font-size: 11px; color: #555; }
    .foot .provenance { margin-top: 4px; padding-top: 4px; border-top: 1px dotted #999; font-size: 9.5px; }
    /* Last in the sheet so it actually wins: later rules of equal specificity override. */
    ${dense ? 'body { font-size: 10px; } table.rpt td, table.rpt th { padding: 4px 5px; } table.rpt td.r, table.rpt td.c { font-size: 9.5px; }' : ''}
  </style></head><body>
    <div class="sheet">
      <div class="head">
        <div>
          <h1>${esc(company.name)}</h1>
          <div>${esc(company.address)}</div>
          <div class="num">GSTIN: ${esc(company.gstin ?? 'Unregistered')} · ${esc(GST_STATES[company.stateCode] ?? company.stateCode)}</div>
        </div>
        <div class="tag">
          <b>${esc(title)}</b>
          <div class="period">${esc(periodLabel)}</div>
        </div>
      </div>
      <table class="rpt">
        <thead><tr>${headRow}</tr></thead>
        <tbody>${bodyRows}</tbody>
      </table>
      <div class="foot">
        ${footNote ? `<div>${esc(footNote)}</div>` : ''}
        <!-- Always stated, never optional: a screenshot or a photocopy of a report is worthless
             evidence if the range it covers has to be taken on trust. -->
        <div class="provenance">${esc(title)} · ${esc(periodLabel)} · ${esc(company.name)}${
          company.gstin ? ' · GSTIN ' + esc(company.gstin) : ''
        }</div>
      </div>
    </div>
  </body></html>`
}

// ---------- the CA pack, as one document ----------

export interface ReportPackSection {
  title: string
  periodLabel: string
  columns: ReportColumnSpec[]
  rows: ReportRowSpec[]
  /** Shown under the section heading — usually what the section is for. */
  note?: string
}

export interface ReportPackOptions {
  title: string
  company: CompanyInfo
  periodLabel: string
  sections: ReportPackSection[]
  /** Rendered as a contents page: what is in the pack and, more importantly, what is not. */
  preparedOn: string
}

/**
 * Several reports as one PDF, each starting on its own page.
 *
 * The CA pack has existed as a folder of CSVs, which is the right thing to hand a machine and
 * the wrong thing to hand a person: an accountant opening it has to import seven files before
 * seeing anything. This is the same figures as one document, in the same visual language as
 * every other printed report in the app, with a contents page that says what it covers.
 *
 * It does not replace the CSVs. They are still written beside it, because the accountant who
 * wants to re-total something wants the columns, not a picture of them.
 */
export function reportPackHtml(opts: ReportPackOptions): string {
  const { company, sections } = opts

  const contents = sections
    .map((s, i) => `<li><span class="n">${i + 1}.</span> ${esc(s.title)} <span class="muted">${esc(s.periodLabel)}</span></li>`)
    .join('')

  const body = sections
    .map((section) => {
      const headRow = section.columns
        .map((c) => `<th class="${alignClass(c.align)}">${esc(c.label)}</th>`)
        .join('')
      const rows = section.rows
        .map((r) => {
          const cells = r.cells
            .map((cell, i) => {
              const align = section.columns[i] ? alignClass(section.columns[i]!.align) : ''
              const indentStyle = i === 0 && r.indent ? ` style="padding-left:${8 + r.indent * 16}px"` : ''
              return `<td class="${align}"${indentStyle}>${esc(cell)}</td>`
            })
            .join('')
          const cls = [r.bold ? 'bold' : '', r.rule ? 'rule' : ''].filter(Boolean).join(' ')
          return `<tr${cls ? ` class="${cls}"` : ''}>${cells}</tr>`
        })
        .join('')
      const dense = section.columns.length > PORTRAIT_COLUMN_LIMIT
      return `<section class="rpt-section${dense ? ' dense' : ''}">
        <h2>${esc(section.title)}</h2>
        <div class="sub">${esc(section.periodLabel)}${section.note ? ' · ' + esc(section.note) : ''}</div>
        <table class="rpt"><thead><tr>${headRow}</tr></thead><tbody>${rows}</tbody></table>
      </section>`
    })
    .join('')

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(opts.title)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font: 12px/1.45 'Helvetica Neue', Arial, sans-serif; color: #16181f; padding: 28px; }
    @page { size: A4; margin: 12mm; }
    .cover { border-bottom: 1.5px solid #16181f; padding-bottom: 12px; }
    h1 { font-size: 22px; letter-spacing: 0.02em; }
    .cover .meta { margin-top: 4px; font-size: 11.5px; color: #555; }
    .cover .num { font-family: 'SF Mono', Menlo, monospace; font-size: 11.5px; }
    ol.contents { margin: 18px 0 0 0; list-style: none; }
    ol.contents li { padding: 4px 0; border-bottom: 1px dotted #bbb; font-size: 12.5px; }
    ol.contents .n { display: inline-block; width: 22px; color: #777; }
    ol.contents .muted { color: #777; font-size: 11px; }
    .caveat { margin-top: 18px; font-size: 11px; color: #555; border-left: 2px solid #ccc; padding-left: 10px; }
    /* Every section starts a fresh sheet: a pack whose balance sheet begins four lines below the
       end of the P&L is a pack nobody can photocopy a single statement out of. */
    section.rpt-section { page-break-before: always; }
    section.rpt-section h2 { font-size: 16px; letter-spacing: 0.02em; border-bottom: 1.5px solid #16181f; padding-bottom: 6px; }
    section.rpt-section .sub { margin-top: 4px; font-size: 11px; color: #555; }
    table.rpt { width: 100%; border-collapse: collapse; margin-top: 12px; table-layout: fixed; }
    table.rpt td, table.rpt th { overflow-wrap: anywhere; }
    table.rpt th { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; border-bottom: 1.5px solid #16181f; padding: 7px 8px; text-align: left; background: #f2f2ee; }
    table.rpt td { padding: 6px 8px; border-bottom: 1px dotted #999; vertical-align: top; }
    table.rpt td.r, table.rpt td.c { font-family: 'SF Mono', Menlo, monospace; font-size: 11.5px; }
    thead { display: table-header-group; }
    tr { page-break-inside: avoid; }
    .r { text-align: right; } .c { text-align: center; }
    tr.bold td { font-weight: 700; }
    tr.rule td { border-top: 1px solid #16181f; }
    tr.bold.rule td { border-top: 1px solid #16181f; border-bottom: 3px double #16181f; }
    section.dense table.rpt td, section.dense table.rpt th { font-size: 10px; padding: 4px 5px; }
  </style></head><body>
    <div class="cover">
      <h1>${esc(company.name)}</h1>
      <div>${esc(company.address)}</div>
      <div class="num">GSTIN: ${esc(company.gstin ?? 'Unregistered')} · ${esc(GST_STATES[company.stateCode] ?? company.stateCode)}</div>
      <div class="meta">${esc(opts.title)} · ${esc(opts.periodLabel)} · prepared ${esc(opts.preparedOn)}</div>
    </div>
    <ol class="contents">${contents}</ol>
    <p class="caveat">
      Prepared from the books as they stand on ${esc(opts.preparedOn)}. Every figure is computed
      from posted vouchers at the moment of printing; nothing here is a stored balance. Vouchers
      in the bin, memorandum entries and unmatured post-dated entries are excluded, which is the
      same basis every on-screen report in this application uses.
    </p>
    ${body}
  </body></html>`
}
