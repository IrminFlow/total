import qrcode from 'qrcode-generator'
import type { CompanyInfo } from '../domain'
import type { EdocInvoice, EdocItem } from '../gst/edocs'
import { amountInWords, formatPaise, formatQtyMilli, plainRupees } from '../money'
import { formatDateAs } from '../dates'
import { GST_STATES } from '../gst/states'
import { einvoiceQrPayload } from '../einvoiceQr'
import {
  CHALLAN_COPY_LABELS,
  PRINT_COLUMN_DEFS,
  STOCK_NOTE_PRINT_KINDS,
  type PrintColumn,
  type PrintColumnKey,
  type PrintDocKind,
  type PrintTemplate
} from '../printTemplates'
import { taxSummaryForInvoice } from './taxSummary'
import { purposeLabel } from '../voucherEdit/stockNote'

/**
 * THE document renderer (WP 1.10c): template + document data → one self-contained HTML string
 * (inline CSS, logo as data URL, QR as inline SVG, optional embedded @font-face). Pure — no DB, no
 * Node APIs — so the real PDF path (src/main/services/printTemplates.ts → pdf.ts) and the
 * designer's live preview render through exactly this function.
 *
 * Print behaviour relied on (Chromium printToPDF, the engine behind pdf.ts):
 *  - `thead { display: table-header-group }` repeats the column header row on every page;
 *  - `tr { page-break-inside: avoid }` never splits a row across pages;
 *  - "Page x of y" is NOT drawn here: Chromium ignores CSS @page margin-box counters, so pdf.ts
 *    draws it with printToPDF's native footerTemplate (pageNumber/totalPages) in the bottom margin.
 *    The count runs across the whole PDF, i.e. across every copy label.
 *
 * Classic-style output for a template built by legacyConfigToTemplate reproduces the pre-1.10c
 * buildInvoiceHtml markup and CSS (whitespace-normalised equal — see render.test.ts). Every rule a
 * legacy invoice never needed (ship-to, IRN line, contact lines, …) is emitted only when used, so
 * that equality holds.
 */

export interface InvoiceAuditTrail {
  enteredBy: string | null
  alteredBy: string | null
}

/** Live-filing results printed in the e-invoice block. */
export interface PrintEinvoiceInfo {
  irn: string | null
  ackNo: string | null
  /** ISO date or date-time as returned by the IRP. */
  ackDate: string | null
  ewbNo: string | null
}

export interface InvoiceDocument {
  shape: 'invoice'
  kind: PrintDocKind
  company: CompanyInfo
  invoice: EdocInvoice
  audit?: InvoiceAuditTrail
  /** Party ledger balance as on the document date (dr-positive), for totals.showOutstanding. */
  outstandingPaise?: number | null
  einvoice?: PrintEinvoiceInfo | null
}

export interface VoucherDocLine {
  ledgerName: string
  drCr: 'dr' | 'cr'
  amount: number
}

export interface VoucherDocument {
  shape: 'voucher'
  kind: PrintDocKind
  company: CompanyInfo
  voucher: {
    number: string
    date: string
    partyName: string | null
    partyAddress: string | null
    partyGstin: string | null
    lines: VoucherDocLine[]
    narration: string | null
    reference: string | null
    instrumentNo: string | null
    instrumentDate: string | null
    /** Sum of the debit side (paise). */
    total: number
  }
  audit?: InvoiceAuditTrail
  outstandingPaise?: number | null
}

export type PrintDocument = InvoiceDocument | VoucherDocument

export type PlexFamily = 'plex-sans' | 'plex-serif' | 'plex-mono'

export interface RenderOptions {
  /** @font-face CSS for a bundled IBM Plex family (main embeds the woff2 as a data URL). When
   *  absent the stack falls back to the system faces listed after it. */
  fontFaceCss?: (family: PlexFamily) => string
}

const esc = (s: string | null | undefined): string =>
  (s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

/** Text-node escape that leaves apostrophes alone (safe outside attributes) — keeps the Classic
 *  "Receiver's signature" label byte-identical to the old renderer's literal. */
const escText = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Inline SVG QR ('M' error correction) in a fixed-size mm box. */
function qrSvg(textValue: string, sizeMm: number): string {
  const qr = qrcode(0, 'M')
  qr.addData(textValue)
  qr.make()
  const inner = qr.createSvgTag({ scalable: true })
  return `<div style="width:${sizeMm}mm;height:${sizeMm}mm">${inner}</div>`
}

const FONT_STACKS: Record<PrintTemplate['typography']['fontFamily'], string> = {
  helvetica: "'Helvetica Neue', Arial, sans-serif",
  'plex-sans': "'IBM Plex Sans', 'Helvetica Neue', Arial, sans-serif",
  'plex-serif': "'IBM Plex Serif', Georgia, 'Times New Roman', serif",
  'system-sans': "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif",
  'system-serif': "Georgia, 'Times New Roman', serif"
}
const NUMBER_STACKS: Record<'mono' | 'plex-mono', string> = {
  mono: "'SF Mono', Menlo, monospace",
  'plex-mono': "'IBM Plex Mono', 'SF Mono', Menlo, monospace"
}

/** Meta-block label (and <title> prefix) per kind. */
const DOC_LABEL: Record<PrintDocKind, string> = {
  sales: 'Invoice',
  credit_note: 'Credit note',
  debit_note: 'Debit note',
  purchase: 'Voucher',
  receipt: 'Receipt',
  payment: 'Payment',
  journal: 'Voucher',
  contra: 'Voucher',
  delivery_challan: 'Challan',
  quotation: 'Quotation',
  goods_receipt: 'Receipt note'
}
const PARTY_LABEL: Partial<Record<PrintDocKind, string>> = {
  receipt: 'Received from',
  payment: 'Paid to',
  purchase: 'Supplier'
}

/** `#rrggbb` + alpha → rgba() (accent tints). */
function tint(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

/** Strip float noise: 8.750000001 → "8.75". */
const num2 = (n: number): string => String(Math.round(n * 100) / 100)

interface Ctx {
  t: PrintTemplate
  /** Scale a Classic-at-12px size to the template's base size → "Npx". */
  px: (n: number) => string
  money: (paise: number) => string
  date: (iso: string) => string
  /** Extra CSS rules needed by optional elements actually rendered. */
  extra: Set<string>
}

function makeCtx(t: PrintTemplate): Ctx {
  const k = t.typography.baseFontPx / 12
  return {
    t,
    px: (n) => `${num2(n * k)}px`,
    money: (p) => (t.formats.number === 'plain' ? plainRupees(p) : formatPaise(p)),
    date: (iso) => formatDateAs(iso.slice(0, 10), t.formats.date),
    extra: new Set()
  }
}

// ---------------------------------------------------------------- CSS

function baseCss(c: Ctx): string {
  const { t, px } = c
  const fam = FONT_STACKS[t.typography.fontFamily]
  const acc = t.typography.accent
  const numCss =
    t.typography.numberFont === 'body'
      ? '.num { font-variant-numeric: tabular-nums; }'
      : `.num { font-variant-numeric: tabular-nums; font-family: ${NUMBER_STACKS[t.typography.numberFont]}; font-size: ${px(11.5)}; }`
  if (t.style === 'classic') {
    // Byte-for-byte the pre-1.10c stylesheet at the Classic defaults (12px, Helvetica, #16181f).
    return `
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font: ${px(12)}/1.45 ${fam}; color: #16181f; }
    ${numCss}
    .copy { padding: 28px; page-break-after: always; }
    .copy:last-child { page-break-after: auto; }
    .copy-label { text-align: right; font-size: ${px(10)}; text-transform: uppercase; letter-spacing: 0.1em; color: #555; margin-bottom: 6px; }
    .sheet { border: 1.5px solid ${acc}; }
    .head { display: flex; justify-content: space-between; border-bottom: 1.5px solid ${acc}; padding: 14px 16px; }
    h1 { font-size: ${px(20)}; letter-spacing: 0.02em; }
    .tag { text-align: right; font-size: ${px(11)}; }
    .tag b { font-size: ${px(14)}; letter-spacing: 0.12em; }
    .meta { display: flex; border-bottom: 1.5px solid ${acc}; }
    .meta > div { flex: 1; padding: 10px 16px; }
    .meta > div + div { border-left: 1px solid ${acc}; }
    .lbl { font-size: ${px(9.5)}; text-transform: uppercase; letter-spacing: 0.1em; color: #555; margin-bottom: 2px; }
    table.items { width: 100%; border-collapse: collapse; }
    table.items th { font-size: ${px(10)}; text-transform: uppercase; letter-spacing: 0.06em; border-bottom: 1px solid ${acc}; padding: 7px 8px; text-align: left; background: #f2f2ee; }
    table.items td { padding: 6px 8px; border-bottom: 1px dotted #999; vertical-align: top; }
    table.items.page-split { page-break-after: always; }
    table.items tr.cf td { font-weight: 700; border-bottom: 1px solid ${acc}; }
    table.hsn { width: 100%; border-collapse: collapse; border-top: 1.5px solid ${acc}; }
    table.hsn th { font-size: ${px(9.5)}; text-transform: uppercase; letter-spacing: 0.06em; border-bottom: 1px solid ${acc}; padding: 5px 8px; text-align: left; background: #f2f2ee; }
    table.hsn td { padding: 4px 8px; border-bottom: 1px dotted #999; }
    .audit-foot { padding: 4px 16px; border-top: 1px solid ${acc}; font-size: ${px(9)}; color: #555; }
    thead { display: table-header-group; }
    tr { page-break-inside: avoid; }
    .r { text-align: right; } .c { text-align: center; }
    .bottom { display: flex; border-top: 1.5px solid ${acc}; }
    .words { flex: 1; padding: 10px 16px; border-right: 1px solid ${acc}; }
    table.tot { width: 260px; border-collapse: collapse; }
    table.tot td { padding: 5px 12px; }
    table.tot tr.grand td { border-top: 1px solid ${acc}; border-bottom: 3px double ${acc}; font-weight: 700; font-size: ${px(13)}; }
    .sig { display: flex; justify-content: space-between; padding: 26px 16px 12px; border-top: 1.5px solid ${acc}; font-size: ${px(11)}; }
    .sig .for { text-align: right; }
  `
  }
  if (t.style === 'compact') {
    return `
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font: ${px(12)}/1.35 ${fam}; color: #1a1a1a; }
    ${numCss}
    .copy { page-break-after: always; }
    .copy:last-child { page-break-after: auto; }
    .copy-label { text-align: right; font-size: ${px(10)}; text-transform: uppercase; letter-spacing: 0.08em; color: #666; margin-bottom: 3px; }
    .sheet { border: 1px solid ${acc}; }
    .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; border-bottom: 1px solid ${acc}; padding: 8px 10px; }
    h1 { font-size: ${px(17)}; letter-spacing: 0.01em; }
    .tag { text-align: right; font-size: ${px(11)}; }
    .tag b { font-size: ${px(13.5)}; letter-spacing: 0.1em; }
    .meta { display: flex; border-bottom: 1px solid ${acc}; }
    .meta > div { flex: 1; padding: 6px 10px; }
    .meta > div + div { border-left: 1px solid #bbb; }
    .lbl { font-size: ${px(9)}; text-transform: uppercase; letter-spacing: 0.08em; color: #666; margin-bottom: 1px; }
    table.items { width: 100%; border-collapse: collapse; }
    table.items th { font-size: ${px(9.5)}; text-transform: uppercase; letter-spacing: 0.04em; border-bottom: 1px solid ${acc}; padding: 4px 5px; text-align: left; background: #f3f3f3; }
    table.items td { padding: 3px 5px; border-bottom: 0.5px solid #ccc; vertical-align: top; }
    table.items.page-split { page-break-after: always; }
    table.items tr.cf td { font-weight: 700; border-bottom: 1px solid ${acc}; }
    table.hsn { width: 100%; border-collapse: collapse; border-top: 1px solid ${acc}; }
    table.hsn th { font-size: ${px(9)}; text-transform: uppercase; letter-spacing: 0.04em; border-bottom: 0.5px solid ${acc}; padding: 3px 5px; text-align: left; background: #f3f3f3; }
    table.hsn td { padding: 2px 5px; border-bottom: 0.5px solid #ddd; }
    .audit-foot { padding: 3px 10px; border-top: 1px solid #bbb; font-size: ${px(9)}; color: #666; }
    thead { display: table-header-group; }
    tr { page-break-inside: avoid; }
    .r { text-align: right; } .c { text-align: center; }
    .bottom { display: flex; border-top: 1px solid ${acc}; page-break-inside: avoid; }
    .words { flex: 1; padding: 6px 10px; border-right: 1px solid #bbb; }
    table.tot { width: 230px; border-collapse: collapse; }
    table.tot td { padding: 3px 10px; }
    table.tot tr.grand td { border-top: 1px solid ${acc}; font-weight: 700; font-size: ${px(13)}; }
    .sig { display: flex; justify-content: space-between; align-items: flex-end; padding: 16px 10px 8px; border-top: 1px solid ${acc}; font-size: ${px(11)}; page-break-inside: avoid; }
    .sig .for { text-align: right; }
  `
  }
  // modern
  return `
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font: ${px(12)}/1.5 ${fam}; color: #1b1f24; }
    ${numCss}
    .copy { page-break-after: always; }
    .copy:last-child { page-break-after: auto; }
    .copy-label { text-align: right; font-size: ${px(9.5)}; text-transform: uppercase; letter-spacing: 0.12em; color: ${acc}; margin-bottom: 8px; }
    .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; padding-bottom: 14px; border-bottom: 3px solid ${acc}; }
    h1 { font-size: ${px(21)}; font-weight: 600; letter-spacing: -0.005em; color: ${acc}; margin-bottom: 2px; }
    .tag { text-align: right; font-size: ${px(11)}; color: #4a5560; }
    .tag b { display: block; font-size: ${px(19)}; font-weight: 600; letter-spacing: 0.16em; color: ${acc}; }
    .meta { display: flex; gap: 12px; margin: 14px 0; }
    .meta > div { flex: 1; padding: 10px 12px; background: ${tint(acc, 0.06)}; border-radius: 4px; }
    .lbl { font-size: ${px(9)}; font-weight: 600; text-transform: uppercase; letter-spacing: 0.12em; color: ${acc}; margin-bottom: 3px; }
    table.items { width: 100%; border-collapse: collapse; }
    table.items th { font-size: ${px(9.5)}; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: ${acc}; border-bottom: 2px solid ${acc}; padding: 7px 8px; text-align: left; }
    table.items td { padding: 7px 8px; border-bottom: 1px solid #e3e6ea; vertical-align: top; }
    table.items tbody tr:nth-child(even) td { background: #f8f9fb; }
    table.items.page-split { page-break-after: always; }
    table.items tr.cf td { font-weight: 600; border-bottom: 2px solid ${acc}; background: none; }
    table.hsn { width: 100%; border-collapse: collapse; margin-top: 14px; }
    table.hsn th { font-size: ${px(9)}; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: #4a5560; border-bottom: 1px solid #c9ced4; padding: 5px 8px; text-align: left; }
    table.hsn td { padding: 4px 8px; border-bottom: 1px solid #eef0f2; }
    .audit-foot { margin-top: 10px; font-size: ${px(9)}; color: #6b7480; }
    thead { display: table-header-group; }
    tr { page-break-inside: avoid; }
    .r { text-align: right; } .c { text-align: center; }
    .bottom { display: flex; gap: 20px; margin-top: 16px; page-break-inside: avoid; }
    .words { flex: 1; }
    table.tot { width: 270px; border-collapse: collapse; align-self: flex-start; }
    table.tot td { padding: 5px 10px; }
    table.tot tr.grand td { background: ${acc}; color: #fff; font-weight: 700; font-size: ${px(13.5)}; padding: 8px 10px; }
    .sig { display: flex; justify-content: space-between; align-items: flex-end; margin-top: 30px; padding-top: 10px; border-top: 1px solid #e3e6ea; font-size: ${px(11)}; page-break-inside: avoid; }
    .sig .for { text-align: right; }
  `
}

/** CSS for optional elements, added only when rendered (keeps Classic legacy-equal). */
function extraCss(c: Ctx): string {
  const acc = c.t.typography.accent
  const rules: Record<string, string> = {
    'logo-c': '.logo-c { text-align: center; padding-top: 10px; }',
    einv: `.einv { padding: 5px 16px; border-bottom: 1px solid ${c.t.style === 'modern' ? '#e3e6ea' : acc}; font-size: ${c.px(10)}; overflow-wrap: anywhere; }`,
    due: `table.tot tr.due td { font-size: ${c.px(11)}; color: #444; }`,
    'qr-foot': '.qr-foot { text-align: center; }',
    'cg-note': `.cg-note { padding: 4px 16px 0; text-align: center; font-size: ${c.px(9)}; color: #666; }`,
    vtotal: 'table.items tr.vt td { font-weight: 700; }'
  }
  return [...c.extra].map((k) => rules[k] ?? '').filter(Boolean).join('\n    ')
}

function pageCss(t: PrintTemplate): string {
  if (t.page.size === 'A4' && t.page.orientation === 'portrait') return ''
  const size = t.page.size === 'Letter' ? 'letter' : t.page.size
  return `@page { size: ${size} ${t.page.orientation}; }`
}

function fontFaces(t: PrintTemplate, opts: RenderOptions): string {
  if (!opts.fontFaceCss) return ''
  const fams = new Set<PlexFamily>()
  if (t.typography.fontFamily === 'plex-sans' || t.typography.fontFamily === 'plex-serif') fams.add(t.typography.fontFamily)
  if (t.typography.numberFont === 'plex-mono') fams.add('plex-mono')
  return [...fams].map((f) => opts.fontFaceCss!(f)).join('\n')
}

// ---------------------------------------------------------------- shared blocks

function logoImg(c: Ctx): string {
  const h = c.t.header
  if (!h.showLogo || !h.logoDataUrl) return ''
  return `<img src="${esc(h.logoDataUrl)}" style="max-height:${h.logoMaxHeightPx}px;max-width:${h.logoMaxWidthPx}px;object-fit:contain;margin-bottom:6px" />`
}

function companyBlock(c: Ctx, company: CompanyInfo): string {
  const h = c.t.header
  const left = h.logoPosition === 'left' ? logoImg(c) : ''
  const gstLine = [
    h.showGstin ? `GSTIN: ${esc(company.gstin ?? 'Unregistered')}` : null,
    h.showState ? esc(GST_STATES[company.stateCode] ?? company.stateCode) : null
  ].filter(Boolean)
  const ids = [
    h.showPan && company.pan ? `PAN: ${esc(company.pan)}` : null,
    h.showCin && h.cin ? `CIN: ${esc(h.cin)}` : null
  ].filter(Boolean)
  const contact = [
    h.showPhone && company.phone ? `Ph: ${esc(company.phone)}` : null,
    h.showEmail && company.email ? esc(company.email) : null,
    h.showWebsite && h.website ? esc(h.website) : null
  ].filter(Boolean)
  return `
        <div>
          ${left}
          <h1>${esc(company.name)}</h1>
          ${h.showAddress ? `<div>${esc(company.address)}</div>` : ''}
          ${gstLine.length ? `<div class="num">${gstLine.join(' · ')}</div>` : ''}
          ${ids.length ? `<div class="num">${ids.join(' · ')}</div>` : ''}
          ${contact.length ? `<div>${contact.join(' · ')}</div>` : ''}
        </div>`
}

function sigBlock(c: Ctx, company: CompanyInfo, middle: string): string {
  const f = c.t.footer
  if (!f.showSignature && !f.showReceiverSignature && !middle) return ''
  return `
      <div class="sig">
        ${f.showReceiverSignature ? `<div>${escText(f.receiverLabel)}</div>` : '<div></div>'}
        ${middle}
        ${f.showSignature ? `<div class="for">For <b>${esc(company.name)}</b><br/><br/><br/>${esc(f.signatureLabel)}</div>` : '<div></div>'}
      </div>`
}

function auditFoot(c: Ctx, audit: InvoiceAuditTrail | undefined): string {
  if (!(c.t.footer.showEnteredBy && audit && (audit.enteredBy || audit.alteredBy))) return ''
  return `<div class="audit-foot">${[
    audit.enteredBy ? `Entered by ${esc(audit.enteredBy)}` : '',
    audit.alteredBy ? `Altered by ${esc(audit.alteredBy)}` : ''
  ]
    .filter(Boolean)
    .join(' · ')}</div>`
}

function cgNote(c: Ctx): string {
  if (!c.t.footer.showComputerGenerated || !c.t.footer.computerGeneratedText) return ''
  c.extra.add('cg-note')
  return `<div class="cg-note">${esc(c.t.footer.computerGeneratedText)}</div>`
}

function outstandingRow(c: Ctx, outstanding: number | null | undefined): string {
  if (!c.t.totals.showOutstanding || outstanding == null) return ''
  c.extra.add('due')
  const side = outstanding === 0 ? '' : outstanding > 0 ? ' Dr' : ' Cr'
  return `<tr class="due"><td>Balance outstanding</td><td class="r num">${c.money(Math.abs(outstanding))}${side}</td></tr>`
}

function wrapDocument(c: Ctx, title: string, sheet: string, opts: RenderOptions, copyLabels?: readonly string[]): string {
  const copies = (copyLabels ?? c.t.header.copyLabels)
    .map(
      (label) => `
      <div class="copy">
        <div class="copy-label">${esc(label)}</div>
        ${sheet}
      </div>`
    )
    .join('')
  const pre = [fontFaces(c.t, opts), pageCss(c.t)].filter(Boolean).join('\n    ')
  const post = extraCss(c)
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
  <style>${pre ? `\n    ${pre}` : ''}${baseCss(c)}${post ? `  ${post}\n  ` : ''}</style></head><body>${copies}</body></html>`
}

// ---------------------------------------------------------------- invoice shape

interface ColumnSpec {
  key: PrintColumnKey
  th: string
  cell: (item: EdocItem, i: number) => string
  /** Money value used for a carried-forward subtotal when this is the last column. */
  value?: (item: EdocItem) => number
}

function visibleColumns(c: Ctx, inv: EdocInvoice, isIntra: boolean): ColumnSpec[] {
  const anyBarcode = inv.items.some((i) => i.barcode)
  const anyDescription = inv.items.some((i) => i.description)
  const anyCess = inv.cess > 0 || inv.items.some((i) => i.cess > 0)
  const unitShown = c.t.columns.some((col) => col.key === 'unit' && col.visible)
  const lineTotal = (it: EdocItem): number => it.taxablePaise + it.cgst + it.sgst + it.igst + it.cess
  const content: Record<PrintColumnKey, { cell: (it: EdocItem, i: number) => string; value?: (it: EdocItem) => number }> = {
    sl: { cell: (_it, i) => String(i + 1) },
    item: { cell: (it) => esc(it.name) },
    description: { cell: (it) => esc(it.description ?? '') },
    hsn: { cell: (it) => esc(it.hsn) },
    barcode: { cell: (it) => esc(it.barcode ?? '') },
    qty: { cell: (it) => (unitShown ? formatQtyMilli(it.qtyMilli) : `${formatQtyMilli(it.qtyMilli)} ${esc(it.uqc)}`) },
    unit: { cell: (it) => esc(it.uqc) },
    rate: { cell: (it) => c.money(it.unitPricePaise) },
    discount: { cell: (it) => (it.discountPaise ? c.money(it.discountPaise) : '–'), value: (it) => it.discountPaise ?? 0 },
    taxable: { cell: (it) => c.money(it.taxablePaise), value: (it) => it.taxablePaise },
    gstRate: { cell: (it) => `${it.rate}%` },
    cgst: { cell: (it) => c.money(it.cgst), value: (it) => it.cgst },
    sgst: { cell: (it) => c.money(it.sgst), value: (it) => it.sgst },
    igst: { cell: (it) => c.money(it.igst), value: (it) => it.igst },
    cess: { cell: (it) => c.money(it.cess), value: (it) => it.cess },
    amount: { cell: (it) => c.money(lineTotal(it)), value: lineTotal }
  }
  const hidden = (col: PrintColumn): boolean =>
    !col.visible ||
    (col.key === 'barcode' && !anyBarcode) ||
    (col.key === 'description' && !anyDescription) ||
    ((col.key === 'cgst' || col.key === 'sgst') && !isIntra) ||
    (col.key === 'igst' && isIntra) ||
    (col.key === 'cess' && !anyCess)
  return c.t.columns
    .filter((col) => !hidden(col))
    .map((col) => {
      const def = PRINT_COLUMN_DEFS[col.key]
      const thCls = def.align !== 'l' ? ` class="${def.align}"` : ''
      const style = col.width ? ` style="width:${col.width}px"` : ''
      const tdCls = [def.align !== 'l' ? def.align : '', def.num ? 'num' : ''].filter(Boolean).join(' ')
      const cfg = content[col.key]
      return {
        key: col.key,
        th: `<th${thCls}${style}>${esc(col.label)}</th>`,
        cell: (it: EdocItem, i: number) => `<td${tdCls ? ` class="${tdCls}"` : ''}>${cfg.cell(it, i)}</td>`,
        value: cfg.value
      }
    })
}

function itemsTable(c: Ctx, inv: EdocInvoice, isIntra: boolean): string {
  const columns = visibleColumns(c, inv, isIntra)
  const columnCount = columns.length
  const itemRow = (item: EdocItem, i: number): string => `
      <tr>
        ${columns.map((col) => col.cell(item, i)).join('\n        ')}
      </tr>`
  const headRow = `<tr>
          ${columns.map((col) => col.th).join('\n          ')}
        </tr>`
  const per = c.t.table.carryForwardEvery
  if (per === 0 || inv.items.length <= per) {
    return `
      <table class="items">
        <thead>${headRow}</thead>
        <tbody>${inv.items.map(itemRow).join('')}</tbody>
      </table>`
  }
  // Carried-forward subtotal of the LAST column when it is a money column, else taxable value.
  const last = columns[columns.length - 1]
  const value = last?.value ?? ((it: EdocItem) => it.taxablePaise)
  const cf = (label: string, amount: number): string =>
    columnCount > 1
      ? `<tr class="cf"><td colspan="${columnCount - 1}" class="r">${label}</td><td class="r num">${c.money(amount)}</td></tr>`
      : `<tr class="cf"><td class="r">${label} ${c.money(amount)}</td></tr>`
  const chunks: string[] = []
  let cumulative = 0
  for (let start = 0; start < inv.items.length; start += per) {
    const slice = inv.items.slice(start, start + per)
    const isLast = start + per >= inv.items.length
    const broughtForward = start > 0 ? cf('Brought forward', cumulative) : ''
    cumulative += slice.reduce((s, it) => s + value(it), 0)
    const carriedForward = !isLast ? cf('Carried forward', cumulative) : ''
    chunks.push(`
      <table class="items${isLast ? '' : ' page-split'}">
        <thead>${headRow}</thead>
        <tbody>${broughtForward}${slice.map((it, j) => itemRow(it, start + j)).join('')}${carriedForward}</tbody>
      </table>`)
  }
  return chunks.join('')
}

function taxSummaryBlock(c: Ctx, inv: EdocInvoice, isIntra: boolean): string {
  const mode = c.t.totals.taxSummary
  if (mode === 'none') return ''
  const rows = taxSummaryForInvoice(inv, mode, isIntra ? 'intra' : 'inter')
  if (!rows.length) return ''
  const anyCess = rows.some((r) => r.cess > 0)
  const m = c.money
  const first = mode === 'hsn' ? '<th>HSN/SAC</th><th class="c" style="width:60px">Rate</th>' : '<th>GST rate</th>'
  const firstCells = (r: (typeof rows)[number]): string =>
    mode === 'hsn'
      ? `<td class="num">${r.hsn ? esc(r.hsn) : '—'}</td><td class="c num">${r.rate}%</td>`
      : `<td class="num">${r.rate}%${r.cessRate ? ` + ${r.cessRate}% cess` : ''}</td>`
  return `
      <table class="hsn">
        <thead><tr>
          ${first}<th class="r" style="width:110px">Taxable</th>
          ${isIntra ? '<th class="r" style="width:100px">CGST</th><th class="r" style="width:100px">SGST</th>' : '<th class="r" style="width:100px">IGST</th>'}
          ${anyCess ? '<th class="r" style="width:100px">Cess</th>' : ''}
        </tr></thead>
        <tbody>
        ${rows
          .map(
            (r) => `<tr>
          ${firstCells(r)}<td class="r num">${m(r.taxable)}</td>
          ${isIntra ? `<td class="r num">${m(r.cgst)}</td><td class="r num">${m(r.sgst)}</td>` : `<td class="r num">${m(r.igst)}</td>`}
          ${anyCess ? `<td class="r num">${m(r.cess)}</td>` : ''}
        </tr>`
          )
          .join('')}
        </tbody>
      </table>`
}

function qrBlock(c: Ctx, company: CompanyInfo, inv: EdocInvoice, irn: string | null): string {
  // Verification QR — see src/shared/einvoiceQr.ts for why this is never labelled "IRN QR": it's
  // our own unsigned JSON summary, not the NIC-signed IRP QR. An IRN rides along inside the JSON.
  return `<div style="margin-top:8px">
         ${qrSvg(
           einvoiceQrPayload({
             sellerGstin: company.gstin,
             buyerGstin: inv.partyGstin,
             docNo: inv.number,
             docType: inv.docType ?? 'INV',
             docDate: inv.date,
             totalPaise: inv.total,
             itemCount: inv.items.length,
             mainHsn: inv.items[0]?.hsn ?? null,
             irn: irn ?? null
           }),
           c.t.einvoice.qrSizeMm
         )}
         <div style="font-size:${c.px(8.5)};color:#555;text-align:center;margin-top:2px">Verification QR</div>
       </div>`
}

function einvoiceLine(c: Ctx, info: PrintEinvoiceInfo): string {
  const e = c.t.einvoice
  const parts: string[] = []
  if (e.showIrn && info.irn) {
    parts.push(`IRN: <span class="num">${esc(info.irn)}</span>`)
    if (info.ackNo) parts.push(`Ack No: <span class="num">${esc(info.ackNo)}</span>`)
    if (info.ackDate) parts.push(`Ack Date: <span class="num">${esc(c.date(info.ackDate))}</span>`)
  }
  if (e.showEwb && info.ewbNo) parts.push(`e-Way Bill No: <span class="num">${esc(info.ewbNo)}</span>`)
  if (!parts.length) return ''
  c.extra.add('einv')
  return `<div class="einv">${parts.join(' · ')}</div>`
}

function renderInvoice(c: Ctx, doc: InvoiceDocument, opts: RenderOptions): string {
  const { t } = c
  const { company, invoice: inv } = doc
  // Supply type for the tax columns: any IGST → inter; any CGST/SGST → intra; when every line is
  // 0%/exempt the amounts can't tell us, so fall back to supply type + place of supply vs company
  // state (SEZ/export supplies are inter-state by law even within one state).
  const isIntra =
    inv.igst > 0
      ? false
      : inv.cgst > 0 || inv.sgst > 0
        ? true
        : (inv.supTyp == null || inv.supTyp === 'B2B') && inv.pos === company.stateCode
  const m = c.money
  const legacy = t.style === 'classic'
  const irn = doc.einvoice?.irn ?? inv.irn ?? null
  // Delivery challan / GRN (WP 2.5b): a goods document, not an invoice — no IRN / payment QR, no
  // bank details or outstanding; the taxable value (and the tax where the movement is a supply)
  // still prints, as rule 55(1) CGST Rules requires of a challan.
  const stockNote = STOCK_NOTE_PRINT_KINDS.includes(doc.kind)

  const taxRows = [
    isIntra ? `<tr><td>CGST</td><td class="r num">${m(inv.cgst)}</td></tr>` : '',
    isIntra ? `<tr><td>SGST</td><td class="r num">${m(inv.sgst)}</td></tr>` : '',
    !isIntra ? `<tr><td>IGST</td><td class="r num">${m(inv.igst)}</td></tr>` : '',
    inv.cess > 0 ? `<tr><td>Cess</td><td class="r num">${m(inv.cess)}</td></tr>` : '',
    t.totals.showRoundOff && inv.roundOff !== 0 ? `<tr><td>Round off</td><td class="r num">${m(inv.roundOff)}</td></tr>` : ''
  ].join('')

  const f = t.footer
  const bankBlock = f.bankDetails && !stockNote
    ? `<div style="margin-top:10px" class="lbl">Bank details</div>
       <div style="font-size:${c.px(10.5)}">${esc(f.bankDetails.name)}<br/>A/c ${esc(f.bankDetails.account)} · IFSC ${esc(f.bankDetails.ifsc)}<br/>${esc(f.bankDetails.branch)}</div>`
    : ''
  const termsBlock = f.terms.trim()
    ? `<div style="margin-top:10px" class="lbl">Terms</div><div style="font-size:${c.px(10.5)}">${esc(f.terms).replace(/\n/g, '<br/>')}</div>`
    : ''
  // Classic keeps the old renderer's always-printed Declaration heading; other styles drop an
  // empty one.
  // A stock note never carries the invoice declaration ("…this invoice shows the actual price…").
  const declarationBlock =
    stockNote && /invoice/i.test(f.declaration)
      ? ''
      : legacy || f.declaration.trim()
      ? `<div style="margin-top:10px" class="lbl">Declaration</div>
          <div style="font-size:${c.px(10.5)}">${esc(f.declaration)}</div>`
      : ''
  const wordsBlock = t.totals.showAmountInWords
    ? `<div class="lbl">${stockNote ? 'Value in words' : 'Amount in words'}</div>
          <div><i>${esc(amountInWords(inv.total))}</i></div>`
    : ''

  const showQr = t.einvoice.showQr && !stockNote
  const headerQr = showQr && t.einvoice.qrPlacement === 'header' ? qrBlock(c, company, inv, irn) : ''
  const footerQr = showQr && t.einvoice.qrPlacement === 'footer' ? `<div class="qr-foot">${qrBlock(c, company, inv, irn)}</div>` : ''
  if (footerQr) c.extra.add('qr-foot')

  const logoRight = t.header.logoPosition === 'right' ? logoImg(c) : ''
  const logoCenter = t.header.logoPosition === 'center' ? logoImg(c) : ''
  if (logoCenter) c.extra.add('logo-c')

  const p = t.party
  const label = DOC_LABEL[doc.kind]
  const partyLabel = doc.kind === 'delivery_challan' ? 'Consignee' : doc.kind === 'goods_receipt' ? 'Received from' : p.billToLabel
  const purposeLine = stockNote && inv.purpose ? `<div>Purpose: ${esc(purposeLabel(inv.purpose))}</div>` : ''
  const ruleNote =
    doc.kind === 'delivery_challan'
      ? `<div style="margin-top:10px;font-size:${c.px(10)}">Delivery challan issued under rule 55 of the CGST Rules, 2017.</div>`
      : ''
  const shipTo = p.showShipTo && inv.shipTo && (inv.shipTo.name || inv.shipTo.addr1) ? inv.shipTo : null
  const shipBlock = shipTo
    ? `
        <div>
          <div class="lbl">${esc(p.shipToLabel)}</div>
          <div><b>${esc(shipTo.name ?? inv.partyName ?? '')}</b></div>
          <div>${esc([shipTo.addr1, shipTo.addr2, shipTo.place, shipTo.pincode].filter(Boolean).join(', '))}</div>
          ${shipTo.gstin ? `<div class="num">GSTIN: ${esc(shipTo.gstin)}</div>` : ''}
        </div>`
    : ''
  const partyState = GST_STATES[inv.partyStateCode]

  const sheet = `
    <div class="sheet">${logoCenter ? `
      <div class="logo-c">${logoCenter}</div>` : ''}
      <div class="head">${companyBlock(c, company)}
        <div class="tag">
          ${logoRight}<b>${esc(t.header.titles[doc.kind])}</b>
          ${headerQr}
        </div>
      </div>
      <div class="meta">
        <div>
          <div class="lbl">${esc(partyLabel)}</div>
          <div><b>${esc(inv.partyName ?? 'Cash sale')}</b></div>
          ${p.showAddress ? `<div>${esc(inv.partyAddress)}</div>` : ''}
          ${p.showGstin ? `<div class="num">${inv.partyGstin ? 'GSTIN: ' + esc(inv.partyGstin) : 'Unregistered'}</div>` : ''}
          ${p.showState ? `<div>State: <span class="num">${esc(inv.partyStateCode)}</span>${partyState ? `-${esc(partyState)}` : ''}</div>` : ''}
        </div>${shipBlock}
        <div>
          <div class="lbl">${label}</div>
          <div>No: <b class="num">${esc(inv.number)}</b></div>
          <div>Date: <span class="num">${c.date(inv.date)}</span></div>
          ${inv.precedingDoc ? `<div>Against: <span class="num">${esc(inv.precedingDoc.invNo)}</span> dt <span class="num">${c.date(inv.precedingDoc.invDate)}</span></div>` : ''}
          ${p.showPlaceOfSupply ? `<div>Place of supply: <span class="num">${esc(inv.pos)}-${esc(GST_STATES[inv.pos] ?? '')}</span></div>` : ''}
          ${p.showVehicle && inv.vehicleNo ? `<div>Vehicle: <span class="num">${esc(inv.vehicleNo)}</span></div>` : ''}${purposeLine}
        </div>
      </div>${einvoiceLine(c, { irn, ackNo: doc.einvoice?.ackNo ?? null, ackDate: doc.einvoice?.ackDate ?? null, ewbNo: doc.einvoice?.ewbNo ?? null })}
      ${itemsTable(c, inv, isIntra)}
      ${taxSummaryBlock(c, inv, isIntra)}
      <div class="bottom">
        <div class="words">
          ${wordsBlock}
          ${declarationBlock}
          ${bankBlock}
          ${termsBlock}${ruleNote}
        </div>
        <table class="tot">
          <tr><td>Taxable value</td><td class="r num">${m(inv.taxable)}</td></tr>
          ${taxRows}
          <tr class="grand"><td>${stockNote ? 'Value of goods' : 'Total'}</td><td class="r num">${t.formats.currencySymbolOnTotal ? '₹ ' : ''}${m(inv.total)}</td></tr>
          ${stockNote ? '' : outstandingRow(c, doc.outstandingPaise)}
        </table>
      </div>${sigBlock(c, company, footerQr)}
      ${auditFoot(c, doc.audit)}${cgNote(c)}
    </div>`

  // Rule 55(2): a challan goes in triplicate — unless the template names its own copies.
  const challanCopies =
    doc.kind === 'delivery_challan' && t.header.copyLabels.length === 1 && t.header.copyLabels[0] === 'Original for Recipient'
      ? [...CHALLAN_COPY_LABELS]
      : undefined
  return wrapDocument(c, `${label} ${inv.number}`, sheet, opts, challanCopies)
}

// ---------------------------------------------------------------- voucher shape

function renderVoucher(c: Ctx, doc: VoucherDocument, opts: RenderOptions): string {
  const { t } = c
  const { company, voucher: v } = doc
  const m = c.money
  const label = DOC_LABEL[doc.kind]
  const p = t.party
  const logoRight = t.header.logoPosition === 'right' ? logoImg(c) : ''
  const logoCenter = t.header.logoPosition === 'center' ? logoImg(c) : ''
  if (logoCenter) c.extra.add('logo-c')
  c.extra.add('vtotal')
  const dr = v.lines.filter((l) => l.drCr === 'dr').reduce((s, l) => s + l.amount, 0)
  const cr = v.lines.filter((l) => l.drCr === 'cr').reduce((s, l) => s + l.amount, 0)
  const partyBlock = v.partyName
    ? `
        <div>
          <div class="lbl">${esc(PARTY_LABEL[doc.kind] ?? 'Party')}</div>
          <div><b>${esc(v.partyName)}</b></div>
          ${p.showAddress && v.partyAddress ? `<div>${esc(v.partyAddress)}</div>` : ''}
          ${p.showGstin && v.partyGstin ? `<div class="num">GSTIN: ${esc(v.partyGstin)}</div>` : ''}
        </div>`
    : ''
  const sheet = `
    <div class="sheet">${logoCenter ? `
      <div class="logo-c">${logoCenter}</div>` : ''}
      <div class="head">${companyBlock(c, company)}
        <div class="tag">
          ${logoRight}<b>${esc(t.header.titles[doc.kind])}</b>
        </div>
      </div>
      <div class="meta">${partyBlock}
        <div>
          <div class="lbl">${label}</div>
          <div>No: <b class="num">${esc(v.number)}</b></div>
          <div>Date: <span class="num">${c.date(v.date)}</span></div>
          ${v.reference ? `<div>Ref: <span class="num">${esc(v.reference)}</span></div>` : ''}
          ${v.instrumentNo ? `<div>Cheque/UTR: <span class="num">${esc(v.instrumentNo)}</span>${v.instrumentDate ? ` dt <span class="num">${c.date(v.instrumentDate)}</span>` : ''}</div>` : ''}
        </div>
      </div>
      <table class="items">
        <thead><tr>
          <th>Particulars</th><th class="r" style="width:130px">Debit</th><th class="r" style="width:130px">Credit</th>
        </tr></thead>
        <tbody>${v.lines
          .map(
            (l) => `
      <tr>
        <td>${esc(l.ledgerName)}</td>
        <td class="r num">${l.drCr === 'dr' ? m(l.amount) : ''}</td>
        <td class="r num">${l.drCr === 'cr' ? m(l.amount) : ''}</td>
      </tr>`
          )
          .join('')}
      <tr class="vt"><td class="r">Total</td><td class="r num">${m(dr)}</td><td class="r num">${m(cr)}</td></tr>
        </tbody>
      </table>
      <div class="bottom">
        <div class="words">
          ${t.totals.showAmountInWords ? `<div class="lbl">Amount in words</div>
          <div><i>${esc(amountInWords(v.total))}</i></div>` : ''}
          ${v.narration ? `<div style="margin-top:10px" class="lbl">Narration</div><div style="font-size:${c.px(10.5)}">${esc(v.narration)}</div>` : ''}
        </div>
        <table class="tot">
          <tr class="grand"><td>Amount</td><td class="r num">${t.formats.currencySymbolOnTotal ? '₹ ' : ''}${m(v.total)}</td></tr>
          ${outstandingRow(c, doc.outstandingPaise)}
        </table>
      </div>${sigBlock(c, company, '')}
      ${auditFoot(c, doc.audit)}${cgNote(c)}
    </div>`
  return wrapDocument(c, `${label} ${v.number}`, sheet, opts)
}

/** Render a document with a template → self-contained HTML. */
export function renderDocument(template: PrintTemplate, doc: PrintDocument, opts: RenderOptions = {}): string {
  const c = makeCtx(template)
  return doc.shape === 'invoice' ? renderInvoice(c, doc, opts) : renderVoucher(c, doc, opts)
}

/** Whitespace normalisation used by the Classic-equivalence proofs: collapse whitespace runs to
 *  one space and drop whitespace between tags (insignificant in this markup — no inline element
 *  boundary carries meaningful inter-tag spacing). */
export function normaliseHtml(html: string): string {
  return html.replace(/\s+/g, ' ').replace(/>\s+</g, '><').trim()
}
