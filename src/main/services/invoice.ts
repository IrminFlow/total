import qrcode from 'qrcode-generator'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import type { EdocInvoice } from '@shared/gst/edocs'
import { amountInWords, formatPaise } from '@shared/money'
import { toDisplayDate } from '@shared/dates'
import { GST_STATES } from '@shared/gst/states'
import { computeGst } from '@shared/gst/calc'
import { mergeInvoiceConfig, type InvoiceConfig } from '@shared/invoiceConfig'
import { einvoiceQrPayload } from '@shared/einvoiceQr'
import { extractEdocInvoices } from './edocs'
import { getInvoiceConfig } from './config'
import { companyExportsDir } from '../paths'
import { htmlToPdf, writeExportPdf } from './pdf'

const esc = (s: string | null): string =>
  (s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const money = (paise: number): string => formatPaise(paise)

/** Hardcoded so the print-config preview (invoice:previewHtml with no voucherId) works with zero
 *  vouchers in the books — mirrors the shape extractEdocInvoices produces for a real one. Exported
 *  for invoice.test.ts (buildInvoiceHtml is pure — no DB — so it's tested directly there). */
export const SAMPLE_INVOICE: EdocInvoice = {
  number: 'SAMPLE-1',
  date: '2025-04-01',
  partyName: 'Sample Buyer Pvt Ltd',
  partyGstin: '27AAAAA0000A1Z5',
  partyAddress: '123 Sample Street, Sample City',
  partyStateCode: '27',
  pos: '27',
  items: [
    {
      name: 'Sample product', hsn: '8471', qtyMilli: 2000, uqc: 'NOS',
      unitPricePaise: 500000, taxablePaise: 1000000, rate: 18, cessRate: 0,
      cgst: 90000, sgst: 90000, igst: 0, cess: 0, isService: false, barcode: 'SAMPLE-BC-001'
    }
  ],
  taxable: 1000000,
  cgst: 90000,
  sgst: 90000,
  igst: 0,
  cess: 0,
  roundOff: 0,
  total: 1180000,
  transporterId: null,
  vehicleNo: null,
  distanceKm: null,
  irn: null
}

/** Renders `text` as an inline SVG QR code (auto type number, 'M' error correction) sized to
 *  roughly `sizeMm` on a 96dpi-ish print scale — the lib's own SVG units are cell-count based, so
 *  we just wrap its markup in a fixed-size container. */
function qrSvg(text: string, sizeMm = 28): string {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  const inner = qr.createSvgTag({ scalable: true })
  return `<div style="width:${sizeMm}mm;height:${sizeMm}mm">${inner}</div>`
}

/** One aggregated row of the invoice's HSN-wise tax summary (task Q2 #96). */
export interface HsnSummaryRow {
  /** '' for lines whose stock item has no HSN — rendered as '—', never silently dropped. */
  hsn: string
  rate: number
  cessRate: number
  qtyMilli: number
  taxable: number
  cgst: number
  sgst: number
  igst: number
  cess: number
}

/**
 * HSN-wise tax summary for one invoice: aggregate taxable value per (hsn, rate, cessRate) bucket,
 * then run computeGst ONCE on each aggregate (portal semantics — mirrors the GSTR-1 HSN table's
 * bucket-then-round path, so the printed block can never disagree with the filed table on
 * anything but sub-paisa rounding of the individual line split). Pure — exported for tests.
 * NOTE (integrator): if lane G exports a shared bucketing helper with a compatible signature,
 * swap this local one for it (ledger ruling on Q2 #96).
 *
 * `supply` should be passed explicitly when known (buildInvoiceHtml derives it from the invoice
 * totals + place-of-supply vs company state); the `igst > 0` fallback misclassifies an inter-state
 * invoice whose lines are all 0%/exempt.
 */
export function hsnSummaryForInvoice(inv: EdocInvoice, supplyHint?: 'inter' | 'intra'): HsnSummaryRow[] {
  const supply: 'inter' | 'intra' = supplyHint ?? (inv.igst > 0 ? 'inter' : 'intra')
  const buckets = new Map<string, { hsn: string; rate: number; cessRate: number; qtyMilli: number; taxable: number }>()
  for (const item of inv.items) {
    const hsn = item.hsn ?? ''
    const key = `${hsn}|${item.rate}|${item.cessRate}`
    const bucket = buckets.get(key) ?? { hsn, rate: item.rate, cessRate: item.cessRate, qtyMilli: 0, taxable: 0 }
    bucket.qtyMilli += item.qtyMilli
    bucket.taxable += item.taxablePaise
    buckets.set(key, bucket)
  }
  return [...buckets.values()]
    .sort((a, b) => (a.hsn === b.hsn ? a.rate - b.rate : a.hsn < b.hsn ? -1 : 1))
    .map((b) => {
      const g = computeGst(b.taxable, b.rate, supply, b.cessRate)
      return { hsn: b.hsn, rate: b.rate, cessRate: b.cessRate, qtyMilli: b.qtyMilli, taxable: b.taxable, cgst: g.cgst, sgst: g.sgst, igst: g.igst, cess: g.cess }
    })
}

/** Voucher audit-trail names for the printed footer (task Q1 #91) — resolved by invoiceHtml from
 *  audit_log; null/absent when unknown (e.g. print-config preview, imported vouchers). */
export interface InvoiceAuditTrail {
  enteredBy: string | null
  alteredBy: string | null
}

/** Items per printed page before the table is split with carried-forward/brought-forward
 *  subtotal rows (task Q2 #95). Below this count the invoice renders as one unbroken table. */
export const INVOICE_ITEMS_PER_PAGE = 16

/** Pure HTML builder — no DB access — so the live preview and the real/sample invoice paths share
 *  one renderer. Prints one page per `config.copyLabels` entry. */
export function buildInvoiceHtml(
  company: CompanyInfo,
  config: InvoiceConfig,
  inv: EdocInvoice,
  audit?: InvoiceAuditTrail
): string {
  // Supply type for the tax columns: any IGST → inter; any CGST/SGST → intra; when every line is
  // 0%/exempt (all taxes zero) the amounts can't tell us, so fall back to supply type + place of
  // supply vs company state (SEZ/export supplies are inter-state by law even within one state).
  const isIntra =
    inv.igst > 0
      ? false
      : inv.cgst > 0 || inv.sgst > 0
        ? true
        : (inv.supTyp == null || inv.supTyp === 'B2B') && inv.pos === company.stateCode
  const showHsn = config.showHsn
  const showDiscount = config.showDiscount
  const showBarcode = config.showItemBarcode && inv.items.some((i) => i.barcode)
  const columnCount = 6 + (showHsn ? 1 : 0) + (showBarcode ? 1 : 0) + (showDiscount ? 1 : 0)

  const itemRow = (item: EdocInvoice['items'][number], i: number): string => `
      <tr>
        <td class="c">${i + 1}</td>
        <td>${esc(item.name)}</td>
        ${showHsn ? `<td class="c num">${esc(item.hsn)}</td>` : ''}
        ${showBarcode ? `<td class="c num">${esc(item.barcode ?? '')}</td>` : ''}
        <td class="r num">${item.qtyMilli / 1000} ${esc(item.uqc)}</td>
        <td class="r num">${money(item.unitPricePaise)}</td>
        ${showDiscount ? `<td class="r num">${item.discountPaise ? money(item.discountPaise) : '–'}</td>` : ''}
        <td class="c num">${item.rate}%</td>
        <td class="r num">${money(item.taxablePaise)}</td>
      </tr>`

  const headRow = `<tr>
          <th class="c" style="width:34px">#</th><th>Description</th>
          ${showHsn ? '<th class="c" style="width:80px">HSN</th>' : ''}
          ${showBarcode ? '<th class="c" style="width:100px">Barcode</th>' : ''}
          <th class="r" style="width:90px">Qty</th><th class="r" style="width:100px">Rate</th>
          ${showDiscount ? '<th class="r" style="width:80px">Discount</th>' : ''}
          <th class="c" style="width:60px">GST</th><th class="r" style="width:110px">Amount</th>
        </tr>`

  // Long invoices split into pages of INVOICE_ITEMS_PER_PAGE items, with a "Carried forward"
  // subtotal closing each page and a matching "Brought forward" row opening the next (#95).
  let itemsBlock: string
  if (inv.items.length <= INVOICE_ITEMS_PER_PAGE) {
    itemsBlock = `
      <table class="items">
        <thead>${headRow}</thead>
        <tbody>${inv.items.map(itemRow).join('')}</tbody>
      </table>`
  } else {
    const chunks: string[] = []
    let cumulative = 0
    for (let start = 0; start < inv.items.length; start += INVOICE_ITEMS_PER_PAGE) {
      const slice = inv.items.slice(start, start + INVOICE_ITEMS_PER_PAGE)
      const isLast = start + INVOICE_ITEMS_PER_PAGE >= inv.items.length
      const broughtForward =
        start > 0
          ? `<tr class="cf"><td colspan="${columnCount - 1}" class="r">Brought forward</td><td class="r num">${money(cumulative)}</td></tr>`
          : ''
      cumulative += slice.reduce((s, it) => s + it.taxablePaise, 0)
      const carriedForward = !isLast
        ? `<tr class="cf"><td colspan="${columnCount - 1}" class="r">Carried forward</td><td class="r num">${money(cumulative)}</td></tr>`
        : ''
      chunks.push(`
      <table class="items${isLast ? '' : ' page-split'}">
        <thead>${headRow}</thead>
        <tbody>${broughtForward}${slice.map((it, j) => itemRow(it, start + j)).join('')}${carriedForward}</tbody>
      </table>`)
    }
    itemsBlock = chunks.join('')
  }

  // HSN-wise tax summary block (#96), printed above the totals whenever HSN display is on.
  const hsnRows = showHsn ? hsnSummaryForInvoice(inv, isIntra ? 'intra' : 'inter') : []
  const anyCess = hsnRows.some((r) => r.cess > 0)
  const hsnBlock = hsnRows.length
    ? `
      <table class="hsn">
        <thead><tr>
          <th>HSN/SAC</th><th class="c" style="width:60px">Rate</th><th class="r" style="width:110px">Taxable</th>
          ${isIntra ? '<th class="r" style="width:100px">CGST</th><th class="r" style="width:100px">SGST</th>' : '<th class="r" style="width:100px">IGST</th>'}
          ${anyCess ? '<th class="r" style="width:100px">Cess</th>' : ''}
        </tr></thead>
        <tbody>
        ${hsnRows
          .map(
            (r) => `<tr>
          <td class="num">${r.hsn ? esc(r.hsn) : '—'}</td><td class="c num">${r.rate}%</td><td class="r num">${money(r.taxable)}</td>
          ${isIntra ? `<td class="r num">${money(r.cgst)}</td><td class="r num">${money(r.sgst)}</td>` : `<td class="r num">${money(r.igst)}</td>`}
          ${anyCess ? `<td class="r num">${money(r.cess)}</td>` : ''}
        </tr>`
          )
          .join('')}
        </tbody>
      </table>`
    : ''

  const taxRows = [
    isIntra ? `<tr><td>CGST</td><td class="r num">${money(inv.cgst)}</td></tr>` : '',
    isIntra ? `<tr><td>SGST</td><td class="r num">${money(inv.sgst)}</td></tr>` : '',
    !isIntra ? `<tr><td>IGST</td><td class="r num">${money(inv.igst)}</td></tr>` : '',
    inv.cess > 0 ? `<tr><td>Cess</td><td class="r num">${money(inv.cess)}</td></tr>` : '',
    inv.roundOff !== 0 ? `<tr><td>Round off</td><td class="r num">${money(inv.roundOff)}</td></tr>` : ''
  ].join('')

  const logoBlock = config.logoDataUrl
    ? `<img src="${esc(config.logoDataUrl)}" style="max-height:60px;max-width:220px;object-fit:contain;margin-bottom:6px" />`
    : ''

  const bankBlock = config.bankDetails
    ? `<div style="margin-top:10px" class="lbl">Bank details</div>
       <div style="font-size:10.5px">${esc(config.bankDetails.name)}<br/>A/c ${esc(config.bankDetails.account)} · IFSC ${esc(config.bankDetails.ifsc)}<br/>${esc(config.bankDetails.branch)}</div>`
    : ''

  const termsBlock = config.terms.trim()
    ? `<div style="margin-top:10px" class="lbl">Terms</div><div style="font-size:10.5px">${esc(config.terms).replace(/\n/g, '<br/>')}</div>`
    : ''

  // Verification QR — see src/shared/einvoiceQr.ts for why this is never labelled "IRN QR": it's
  // our own unsigned JSON summary, not the NIC-signed IRP QR (which we have no key to forge). When
  // an IRN exists it rides along inside the JSON so the invoice still surfaces it, just honestly.
  const qrBlock = config.showQr
    ? `<div style="margin-top:8px">
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
             irn: inv.irn ?? null
           })
         )}
         <div style="font-size:8.5px;color:#555;text-align:center;margin-top:2px">Verification QR</div>
       </div>`
    : ''

  const sheet = `
    <div class="sheet">
      <div class="head">
        <div>
          ${logoBlock}
          <h1>${esc(company.name)}</h1>
          <div>${esc(company.address)}</div>
          <div class="num">GSTIN: ${esc(company.gstin ?? 'Unregistered')} · ${esc(GST_STATES[company.stateCode] ?? company.stateCode)}</div>
        </div>
        <div class="tag">
          <b>${esc(config.title)}</b>
          ${qrBlock}
        </div>
      </div>
      <div class="meta">
        <div>
          <div class="lbl">Billed to</div>
          <div><b>${esc(inv.partyName ?? 'Cash sale')}</b></div>
          <div>${esc(inv.partyAddress)}</div>
          <div class="num">${inv.partyGstin ? 'GSTIN: ' + esc(inv.partyGstin) : 'Unregistered'}</div>
        </div>
        <div>
          <div class="lbl">Invoice</div>
          <div>No: <b class="num">${esc(inv.number)}</b></div>
          <div>Date: <span class="num">${toDisplayDate(inv.date)}</span></div>
          <div>Place of supply: <span class="num">${esc(inv.pos)}-${esc(GST_STATES[inv.pos] ?? '')}</span></div>
          ${inv.vehicleNo ? `<div>Vehicle: <span class="num">${esc(inv.vehicleNo)}</span></div>` : ''}
        </div>
      </div>
      ${itemsBlock}
      ${hsnBlock}
      <div class="bottom">
        <div class="words">
          <div class="lbl">Amount in words</div>
          <div><i>${esc(amountInWords(inv.total))}</i></div>
          <div style="margin-top:10px" class="lbl">Declaration</div>
          <div style="font-size:10.5px">${esc(config.declaration)}</div>
          ${bankBlock}
          ${termsBlock}
        </div>
        <table class="tot">
          <tr><td>Taxable value</td><td class="r num">${money(inv.taxable)}</td></tr>
          ${taxRows}
          <tr class="grand"><td>Total</td><td class="r num">₹ ${money(inv.total)}</td></tr>
        </table>
      </div>
      <div class="sig">
        <div>Receiver's signature</div>
        <div class="for">For <b>${esc(company.name)}</b><br/><br/><br/>${esc(config.signatory)}</div>
      </div>
      ${
        config.showEnteredBy && audit && (audit.enteredBy || audit.alteredBy)
          ? `<div class="audit-foot">${[
              audit.enteredBy ? `Entered by ${esc(audit.enteredBy)}` : '',
              audit.alteredBy ? `Altered by ${esc(audit.alteredBy)}` : ''
            ]
              .filter(Boolean)
              .join(' · ')}</div>`
          : ''
      }
    </div>`

  const copies = config.copyLabels
    .map(
      (label) => `
      <div class="copy">
        <div class="copy-label">${esc(label)}</div>
        ${sheet}
      </div>`
    )
    .join('')

  return `<!doctype html><html><head><meta charset="utf-8"><title>Invoice ${esc(inv.number)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font: 12px/1.45 'Helvetica Neue', Arial, sans-serif; color: #16181f; }
    .num { font-variant-numeric: tabular-nums; font-family: 'SF Mono', Menlo, monospace; font-size: 11.5px; }
    .copy { padding: 28px; page-break-after: always; }
    .copy:last-child { page-break-after: auto; }
    .copy-label { text-align: right; font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; color: #555; margin-bottom: 6px; }
    .sheet { border: 1.5px solid #16181f; }
    .head { display: flex; justify-content: space-between; border-bottom: 1.5px solid #16181f; padding: 14px 16px; }
    h1 { font-size: 20px; letter-spacing: 0.02em; }
    .tag { text-align: right; font-size: 11px; }
    .tag b { font-size: 14px; letter-spacing: 0.12em; }
    .meta { display: flex; border-bottom: 1.5px solid #16181f; }
    .meta > div { flex: 1; padding: 10px 16px; }
    .meta > div + div { border-left: 1px solid #16181f; }
    .lbl { font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.1em; color: #555; margin-bottom: 2px; }
    table.items { width: 100%; border-collapse: collapse; }
    table.items th { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; border-bottom: 1px solid #16181f; padding: 7px 8px; text-align: left; background: #f2f2ee; }
    table.items td { padding: 6px 8px; border-bottom: 1px dotted #999; vertical-align: top; }
    table.items.page-split { page-break-after: always; }
    table.items tr.cf td { font-weight: 700; border-bottom: 1px solid #16181f; }
    table.hsn { width: 100%; border-collapse: collapse; border-top: 1.5px solid #16181f; }
    table.hsn th { font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.06em; border-bottom: 1px solid #16181f; padding: 5px 8px; text-align: left; background: #f2f2ee; }
    table.hsn td { padding: 4px 8px; border-bottom: 1px dotted #999; }
    .audit-foot { padding: 4px 16px; border-top: 1px solid #16181f; font-size: 9px; color: #555; }
    thead { display: table-header-group; }
    tr { page-break-inside: avoid; }
    .r { text-align: right; } .c { text-align: center; }
    .bottom { display: flex; border-top: 1.5px solid #16181f; }
    .words { flex: 1; padding: 10px 16px; border-right: 1px solid #16181f; }
    table.tot { width: 260px; border-collapse: collapse; }
    table.tot td { padding: 5px 12px; }
    table.tot tr.grand td { border-top: 1px solid #16181f; border-bottom: 3px double #16181f; font-weight: 700; font-size: 13px; }
    .sig { display: flex; justify-content: space-between; padding: 26px 16px 12px; border-top: 1.5px solid #16181f; font-size: 11px; }
    .sig .for { text-align: right; }
  </style></head><body>${copies}</body></html>`
}

/** Zip inventory_lines.discount_paise onto the extracted e-doc items — same ORDER BY
 *  (line_order, id) as edocs.ts's item query, so index i lines up with index i. Kept here (not in
 *  edocs.ts) because discounts are a print concern: e-doc JSON taxable values are already
 *  post-discount by construction. */
function attachDiscounts(db: DB, voucherId: number, inv: EdocInvoice): void {
  const rows = db
    .prepare('SELECT discount_paise AS d FROM inventory_lines WHERE voucher_id = ? ORDER BY line_order, id')
    .all(voucherId) as { d: number }[]
  inv.items.forEach((item, i) => {
    item.discountPaise = rows[i]?.d ?? 0
  })
}

/** First-create + latest-update user names from the voucher's audit trail (task Q1 #91). */
function auditTrailFor(db: DB, voucherId: number): InvoiceAuditTrail {
  const entered = db
    .prepare("SELECT user_name AS u FROM audit_log WHERE entity = 'voucher' AND entity_id = ? AND action = 'create' ORDER BY id LIMIT 1")
    .get(voucherId) as { u: string | null } | undefined
  const altered = db
    .prepare("SELECT user_name AS u FROM audit_log WHERE entity = 'voucher' AND entity_id = ? AND action = 'update' ORDER BY id DESC LIMIT 1")
    .get(voucherId) as { u: string | null } | undefined
  return { enteredBy: entered?.u ?? null, alteredBy: altered?.u ?? null }
}

export function invoiceHtml(db: DB, company: CompanyInfo, voucherId: number): { html: string; number: string } {
  const [inv] = extractEdocInvoices(db, company, '0000-01-01', '9999-12-31', voucherId)
  if (!inv) throw new Error('Invoice not found (only sales vouchers can be printed)')
  attachDiscounts(db, voucherId, inv)
  const config = getInvoiceConfig(db)
  return { html: buildInvoiceHtml(company, config, inv, auditTrailFor(db, voucherId)), number: inv.number }
}

/** invoice:previewHtml — renders the current (unsaved) print config against a real voucher when
 *  `voucherId` is given, or the built-in sample invoice otherwise, so Settings → Invoice can show
 *  a live preview with zero vouchers in the books. `configOverride` (partial — only the fields the
 *  caller wants to preview) is merged over the *saved* config, so the renderer can debounce its
 *  unsaved draft straight into the preview without a Save round-trip. */
export function invoicePreviewHtml(
  db: DB,
  company: CompanyInfo,
  voucherId?: number,
  configOverride?: Partial<InvoiceConfig>
): { html: string } {
  const saved = getInvoiceConfig(db)
  const config = configOverride ? mergeInvoiceConfig({ ...saved, ...configOverride }) : saved
  if (voucherId != null) {
    const [inv] = extractEdocInvoices(db, company, '0000-01-01', '9999-12-31', voucherId)
    if (!inv) throw new Error('Invoice not found (only sales vouchers can be printed)')
    attachDiscounts(db, voucherId, inv)
    return { html: buildInvoiceHtml(company, config, inv, auditTrailFor(db, voucherId)) }
  }
  return { html: buildInvoiceHtml(company, config, SAMPLE_INVOICE) }
}

/** Render the invoice to a PDF in the company's exports folder. Returns the file path. */
export async function invoicePdf(db: DB, company: CompanyInfo, slug: string, voucherId: number): Promise<string> {
  const { html, number } = invoiceHtml(db, company, voucherId)
  const safe = number.replace(/[^a-zA-Z0-9-_]/g, '_')
  return writeExportPdf(slug, `invoice-${safe}.pdf`, html, { pageSize: 'A4', pageNumbers: true })
}

/**
 * Batch invoice printing (task Q2 #98): renders each voucher's invoice sequentially (the pdf.ts
 * queue serializes the shared hidden window anyway) into ONE new exports subfolder. Deliberately
 * a folder of per-invoice PDFs, not a single merged file — merging would need a PDF library we
 * don't ship; a folder prints just as well and keeps each invoice individually shareable.
 * A voucher that fails to render (e.g. not a sales invoice) fails the whole batch with a message
 * naming the offender, so a half-finished folder is never mistaken for a complete run.
 */
export async function invoicePdfBatch(
  db: DB,
  company: CompanyInfo,
  slug: string,
  voucherIds: number[]
): Promise<{ dir: string; paths: string[] }> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const dir = join(companyExportsDir(slug), `invoices-${stamp}`)
  mkdirSync(dir, { recursive: true })
  const paths: string[] = []
  for (const voucherId of voucherIds) {
    let rendered: { html: string; number: string }
    try {
      rendered = invoiceHtml(db, company, voucherId)
    } catch (err) {
      throw new Error(`Voucher #${voucherId}: ${err instanceof Error ? err.message : String(err)}`)
    }
    const safe = rendered.number.replace(/[^a-zA-Z0-9-_]/g, '_')
    const pdf = await htmlToPdf(rendered.html, { pageSize: 'A4', pageNumbers: true })
    const path = join(dir, `invoice-${safe}.pdf`)
    writeFileSync(path, pdf)
    paths.push(path)
  }
  return { dir, paths }
}
