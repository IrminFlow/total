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
  provenance: {
    period: string
    accountingBasis: string
    dataFreshness: string
    generatedAt: string
  }
}

const alignClass = (a: 'l' | 'r' | 'c'): string => (a === 'l' ? '' : a)

/** One shared A4 report template used by every "print/export" button across the report screens —
 *  mirrors invoice.ts's visual language (double rule under a grand total, uppercase small
 *  headers, tabular-nums on the numeric columns, company header block) so every printed document
 *  in the app reads as one family. Every cell arrives pre-formatted by the caller (money via
 *  formatPaise, dates via toDisplayDate, ...) — this template only lays it out and escapes it. */
export function reportHtml(opts: ReportHtmlOptions): string {
  const { title, company, periodLabel, columns, rows, footNote, provenance } = opts
  const generated = new Date(provenance.generatedAt).toLocaleString('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Kolkata'
  })

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
    table.rpt { width: 100%; border-collapse: collapse; margin-top: 14px; }
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
    .provenance { display: grid; grid-template-columns: 1.4fr 1fr 1fr; gap: 12px; margin-top: 16px; padding-top: 9px; border-top: 1px solid #bbb; color: #555; font-size: 9.5px; }
    .provenance b { display: block; margin-bottom: 1px; color: #222; font-size: 8.5px; letter-spacing: .06em; text-transform: uppercase; }
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
      ${footNote ? `<div class="foot">${esc(footNote)}</div>` : ''}
      <div class="provenance">
        <div><b>Report context</b>${esc(provenance.period)}</div>
        <div><b>Basis and source</b>${esc(provenance.accountingBasis)}<br>${esc(provenance.dataFreshness)}</div>
        <div><b>Generated</b>${esc(generated)} IST</div>
      </div>
    </div>
  </body></html>`
}
