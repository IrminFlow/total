import qrcode from 'qrcode-generator'
import { mkdirSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import type { EdocInvoice } from '@shared/gst/edocs'
import { amountInWords, formatPaise } from '@shared/money'
import { toDisplayDate } from '@shared/dates'
import { GST_STATES } from '@shared/gst/states'
import { computeGst } from '@shared/gst/calc'
import {
  showsTax,
  supplyDocumentKind,
  supplyDocumentTitle,
  supplyEndorsements
} from '@shared/gst/billOfSupply'
import { mergeInvoiceConfig, type InvoiceConfig } from '@shared/invoiceConfig'
import { invoiceTemplateCss } from '@shared/invoiceTemplates'
import { bilingualLabel, type InvoiceLabelKeys } from '@shared/i18n/invoiceLabels'
import { amountInWordsIn } from '@shared/i18n/wordsIntl'
import {
  buildThermalReceiptHtml,
  estimateThermalHeightMm,
  type ThermalOptions,
  type ThermalReceipt,
  type ThermalWidthMm
} from '@shared/thermalReceipt'
import { buildInvoiceShare, type InvoiceShare } from '@shared/invoiceShare'
import { einvoiceQrPayload } from '@shared/einvoiceQr'
import { formatCustomValue, type CustomFieldKind } from '@shared/customFields'
import { valuesFor as customFieldValuesFor } from './customFields'
import { upiIntentUrl } from '@shared/upi'
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
 * NOTE (integration, v0.3 wave 1): lane G's GSTR-1 HSN bucketing (hsnRows in
 * src/shared/gst/returns.ts) is a local closure over NormalizedDoc, not an exported helper
 * with a compatible (EdocInvoice) signature — per the ledger ruling on Q2 #96 this local
 * helper stays. Both sides bucket by (hsn, rate, cess) and compute tax on the aggregate,
 * so the printed block and the filed table agree by construction; if either side's bucket
 * key or rounding path ever changes, change the other in lockstep.
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
/**
 * A company-defined field as it appears on the document (roadmap #195).
 *
 * Label and text, nothing else. The print does not know what kind the field is beyond how to
 * write the value down, and it certainly does not add it to anything.
 */
export interface PrintedCustomField {
  label: string
  kind: CustomFieldKind
  value: string
}

export function buildInvoiceHtml(
  company: CompanyInfo,
  config: InvoiceConfig,
  inv: EdocInvoice,
  audit?: InvoiceAuditTrail,
  customFields: PrintedCustomField[] = []
): string {
  /**
   * Every printed label goes through here (roadmap I-184).
   *
   * With no second language configured this returns the English string unchanged, which is why
   * turning the feature off is byte-identical to the invoice the app printed before it existed.
   * Escaping happens after the join, not inside `bilingualLabel`, so the label pack stays a pure
   * data table with no opinion about HTML.
   */
  const L = (key: keyof InvoiceLabelKeys, english: string): string =>
    esc(bilingualLabel(key, config.language, english))

  /**
   * A Devanagari fallback appended to the body font, only when a second language is configured.
   *
   * The app ships no Devanagari font — bundling one would mean shipping a licence with it — so
   * this names the faces that are already on the machine: macOS has Kohinoor and Devanagari Sangam
   * MN, Windows has Nirmala UI and Mangal. Chromium picks per glyph, so the Latin text still comes
   * out in the template's own face and only the Devanagari falls through. If none of them are
   * installed the labels render as boxes, which is visible and fixable, rather than as English —
   * silently ignoring the setting would be worse.
   */
  const devanagariCss =
    config.language === 'none'
      ? ''
      : `\n    body { font-family: 'Helvetica Neue', Arial, 'Kohinoor Devanagari', 'Devanagari Sangam MN', 'Nirmala UI', 'Noto Sans Devanagari', Mangal, sans-serif; }\n`

  // Supply type for the tax columns: any IGST → inter; any CGST/SGST → intra; when every line is
  // 0%/exempt (all taxes zero) the amounts can't tell us, so fall back to supply type + place of
  // supply vs company state (SEZ/export supplies are inter-state by law even within one state).
  const isIntra =
    inv.igst > 0
      ? false
      : inv.cgst > 0 || inv.sgst > 0
        ? true
        : (inv.supTyp == null || inv.supTyp === 'B2B') && inv.pos === company.stateCode
  // Tax invoice, bill of supply, or a plain invoice from an unregistered business. A composition
  // dealer may not issue a tax invoice at all, and a regular dealer's wholly-exempt supply owes a
  // bill of supply -- both of which the print used to label TAX INVOICE regardless.
  /**
   * A memorandum sales voucher is a proforma: a document sent to agree a price before anything is
   * owed. It must not look like a tax invoice — one that does is a document a customer may pay
   * against and an auditor will ask about — so it takes its own heading, a watermark, and no
   * payment QR.
   */
  const isProforma = !!inv.isOptional && inv.docType !== 'CRN' && inv.docType !== 'DBN'

  const docKind = supplyDocumentKind({
    gstRegistrationType: company.gstRegistrationType,
    taxPaise: inv.cgst + inv.sgst + inv.igst + inv.cess,
    supTyp: inv.supTyp,
    reverseCharge: inv.rchrg
  })
  const withTax = showsTax(docKind)
  const endorsements = supplyEndorsements({
    gstRegistrationType: company.gstRegistrationType,
    taxPaise: inv.cgst + inv.sgst + inv.igst + inv.cess,
    supTyp: inv.supTyp,
    reverseCharge: inv.rchrg
  })

  const showHsn = config.showHsn
  const showDiscount = config.showDiscount
  const showBarcode = config.showItemBarcode && inv.items.some((i) => i.barcode)
  // The GST-rate column goes with the tax: a rate printed on a bill of supply is a rate charged.
  const columnCount = 5 + (withTax ? 1 : 0) + (showHsn ? 1 : 0) + (showBarcode ? 1 : 0) + (showDiscount ? 1 : 0)

  const itemRow = (item: EdocInvoice['items'][number], i: number): string => `
      <tr>
        <td class="c">${i + 1}</td>
        <td>${esc(item.name)}</td>
        ${showHsn ? `<td class="c num">${esc(item.hsn)}</td>` : ''}
        ${showBarcode ? `<td class="c num">${esc(item.barcode ?? '')}</td>` : ''}
        <td class="r num">${item.qtyMilli / 1000} ${esc(item.uqc)}</td>
        <td class="r num">${money(item.unitPricePaise)}</td>
        ${showDiscount ? `<td class="r num">${item.discountPaise ? money(item.discountPaise) : '–'}</td>` : ''}
        ${withTax ? `<td class="c num">${item.rate}%</td>` : ''}
        <td class="r num">${money(item.taxablePaise)}</td>
      </tr>`

  const headRow = `<tr>
          <th class="c" style="width:34px">#</th><th>${L('description', 'Description')}</th>
          ${showHsn ? `<th class="c" style="width:80px">${L('hsn', 'HSN')}</th>` : ''}
          ${showBarcode ? `<th class="c" style="width:100px">${L('barcode', 'Barcode')}</th>` : ''}
          <th class="r" style="width:90px">${L('qty', 'Qty')}</th><th class="r" style="width:100px">${L('rate', 'Rate')}</th>
          ${showDiscount ? `<th class="r" style="width:80px">${L('discount', 'Discount')}</th>` : ''}
          ${withTax ? `<th class="c" style="width:60px">${L('gst', 'GST')}</th>` : ''}<th class="r" style="width:110px">${L('amount', 'Amount')}</th>
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
          ? `<tr class="cf"><td colspan="${columnCount - 1}" class="r">${L('broughtForward', 'Brought forward')}</td><td class="r num">${money(cumulative)}</td></tr>`
          : ''
      cumulative += slice.reduce((s, it) => s + it.taxablePaise, 0)
      const carriedForward = !isLast
        ? `<tr class="cf"><td colspan="${columnCount - 1}" class="r">${L('carriedForward', 'Carried forward')}</td><td class="r num">${money(cumulative)}</td></tr>`
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
          <th>${L('hsn', 'HSN/SAC')}</th>${withTax ? `<th class="c" style="width:60px">${L('rate', 'Rate')}</th>` : ''}<th class="r" style="width:110px">${withTax ? L('taxableValue', 'Taxable') : L('valueOfSupply', 'Value')}</th>
          ${withTax ? (isIntra ? `<th class="r" style="width:100px">${L('cgst', 'CGST')}</th><th class="r" style="width:100px">${L('sgst', 'SGST')}</th>` : `<th class="r" style="width:100px">${L('igst', 'IGST')}</th>`) : ''}
          ${withTax && anyCess ? `<th class="r" style="width:100px">${L('cess', 'Cess')}</th>` : ''}
        </tr></thead>
        <tbody>
        ${hsnRows
          .map(
            (r) => `<tr>
          <td class="num">${r.hsn ? esc(r.hsn) : '—'}</td>${withTax ? `<td class="c num">${r.rate}%</td>` : ''}<td class="r num">${money(r.taxable)}</td>
          ${withTax ? (isIntra ? `<td class="r num">${money(r.cgst)}</td><td class="r num">${money(r.sgst)}</td>` : `<td class="r num">${money(r.igst)}</td>`) : ''}
          ${withTax && anyCess ? `<td class="r num">${money(r.cess)}</td>` : ''}
        </tr>`
          )
          .join('')}
        </tbody>
      </table>`
    : ''

  const taxRows = [
    withTax && isIntra ? `<tr><td>${L('cgst', 'CGST')}</td><td class="r num">${money(inv.cgst)}</td></tr>` : '',
    withTax && isIntra ? `<tr><td>${L('sgst', 'SGST')}</td><td class="r num">${money(inv.sgst)}</td></tr>` : '',
    withTax && !isIntra ? `<tr><td>${L('igst', 'IGST')}</td><td class="r num">${money(inv.igst)}</td></tr>` : '',
    withTax && inv.cess > 0 ? `<tr><td>${L('cess', 'Cess')}</td><td class="r num">${money(inv.cess)}</td></tr>` : '',
    inv.roundOff !== 0 ? `<tr><td>${L('roundOff', 'Round off')}</td><td class="r num">${money(inv.roundOff)}</td></tr>` : ''
  ].join('')

  const logoBlock = config.logoDataUrl
    ? `<img src="${esc(config.logoDataUrl)}" style="max-height:60px;max-width:220px;object-fit:contain;margin-bottom:6px" />`
    : ''

  const bankBlock = config.bankDetails
    ? `<div style="margin-top:10px" class="lbl">${L('bankDetails', 'Bank details')}</div>
       <div style="font-size:10.5px">${esc(config.bankDetails.name)}<br/>A/c ${esc(config.bankDetails.account)} · IFSC ${esc(config.bankDetails.ifsc)}<br/>${esc(config.bankDetails.branch)}</div>`
    : ''

  /**
   * Terms for this document's kind, falling back to the general block.
   *
   * A sales invoice says "payment due in 30 days"; a credit note saying that is nonsense. Falling
   * back rather than blanking means configuring one kind never silently clears the others.
   */
  const kindKey =
    inv.docType === 'CRN' ? 'credit_note' : inv.docType === 'DBN' ? 'debit_note' : 'sales'
  const terms = (config.termsByKind?.[kindKey] ?? config.terms).trim()
  /**
   * The company's own fields, printed under the party block.
   *
   * Above the terms and below the addresses because that is where a reader looks for "which
   * order was this against" — and firmly outside the totals table, where a value that looked
   * like a figure in a column of figures would invite somebody to add it up.
   */
  const customBlock = customFields.length
    ? `<div style="margin-top:8px" class="lbl">${L('otherDetails', 'Other details')}</div>
       <div style="font-size:10.5px" data-testid="invoice-custom-fields">${customFields
         .map((f) => `<div>${esc(f.label)}: <span>${esc(formatCustomValue(f.kind, f.value))}</span></div>`)
         .join('')}</div>`
    : ''

  const termsBlock = terms
    ? `<div style="margin-top:10px" class="lbl">${L('terms', 'Terms')}</div><div style="font-size:10.5px">${esc(terms).replace(/\n/g, '<br/>')}</div>`
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
         <div style="font-size:8.5px;color:#555;text-align:center;margin-top:2px">${L('verificationQr', 'Verification QR')}</div>
       </div>`
    : ''

  /**
   * A UPI payment QR next to the total, when a VPA is configured.
   *
   * Placed by the amount rather than by the header QR: one is how the document is verified, the
   * other is how it gets paid, and putting them together invites scanning the wrong one. Carries
   * the invoice total and number, so a payment arrives already tied to the bill.
   *
   * Never on a credit note — a document that reduces what is owed must not offer to collect it.
   */
  const upiUrl =
    // Never on a proforma: nothing is owed yet, and a QR on it invites payment against a document
    // that is not a demand for money.
    config.upiVpa && inv.docType !== 'CRN' && !isProforma
      ? upiIntentUrl({
          vpa: config.upiVpa,
          payeeName: company.name,
          amountPaise: inv.total,
          note: inv.number
        })
      : null
  const upiBlock = upiUrl
    ? `<div class="upi">
         ${qrSvg(upiUrl, 24)}
         <div class="upi-cap">${L('scanToPay', 'Scan to pay · UPI')}</div>
         <div class="upi-vpa num">${esc(config.upiVpa)}</div>
       </div>`
    : ''

  const sheet = `
    <div class="sheet">
      ${isProforma ? '<div class="watermark" aria-hidden="true">PROFORMA</div>' : ''}
      <div class="head">
        <div>
          ${logoBlock}
          <h1>${esc(company.name)}</h1>
          <div>${esc(company.address)}</div>
          <div class="num">${L('gstin', 'GSTIN')}: ${esc(company.gstin ?? '')}${company.gstin ? '' : L('unregistered', 'Unregistered')} · ${esc(GST_STATES[company.stateCode] ?? company.stateCode)}</div>
        </div>
        <div class="tag">
          <b>${esc(isProforma ? 'PROFORMA INVOICE' : supplyDocumentTitle(docKind, config.title))}</b>
          ${qrBlock}
        </div>
      </div>
      ${
        endorsements.length
          ? `<div class="endorse">${endorsements.map((e) => `<div>${esc(e)}</div>`).join('')}</div>`
          : ''
      }
      <div class="meta">
        <div>
          <div class="lbl">${L('billedTo', 'Billed to')}</div>
          <div><b>${inv.partyName ? esc(inv.partyName) : L('cashSale', 'Cash sale')}</b></div>
          <div>${esc(inv.partyAddress)}</div>
          <div class="num">${inv.partyGstin ? L('gstin', 'GSTIN') + ': ' + esc(inv.partyGstin) : L('unregistered', 'Unregistered')}</div>
        </div>
        <div>
          <div class="lbl">${L('taxInvoice', 'Invoice')}</div>
          <div>${L('invoiceNo', 'No')}: <b class="num">${esc(inv.number)}</b></div>
          <div>${L('date', 'Date')}: <span class="num">${toDisplayDate(inv.date)}</span></div>
          <div>${L('placeOfSupply', 'Place of supply')}: <span class="num">${esc(inv.pos)}-${esc(GST_STATES[inv.pos] ?? '')}</span></div>
          ${inv.vehicleNo ? `<div>${L('vehicle', 'Vehicle')}: <span class="num">${esc(inv.vehicleNo)}</span></div>` : ''}
        </div>
      </div>
      ${itemsBlock}
      ${hsnBlock}
      <div class="bottom">
        <div class="words">
          <div class="lbl">${L('amountInWords', 'Amount in words')}</div>
          <div><i>${esc(amountInWords(inv.total))}</i></div>
          ${
            // The words in the second language go on their OWN line, not after a slash: this is a
            // sentence, and "Rupees one thousand only / एक हज़ार रुपये मात्र" run together is the
            // one place the bilingual separator stops being readable (roadmap I-199).
            config.language !== 'none'
              ? `<div><i>${esc(amountInWordsIn(inv.total, config.language))}</i></div>`
              : ''
          }
          <div style="margin-top:10px" class="lbl">${L('declaration', 'Declaration')}</div>
          <div style="font-size:10.5px">${esc(config.declaration)}</div>
          ${bankBlock}${customBlock}
          ${termsBlock}
        </div>
        <div class="tot-wrap">
        ${upiBlock}
        <table class="tot">
          <tr><td>${withTax ? L('taxableValue', 'Taxable value') : L('valueOfSupply', 'Value of supply')}</td><td class="r num">${money(inv.taxable)}</td></tr>
          ${taxRows}
          <tr class="grand"><td>${L('total', 'Total')}</td><td class="r num">₹ ${money(inv.total)}</td></tr>
        </table>
        </div>
      </div>
      <div class="sig">
        <div>${L('receiversSignature', "Receiver's signature")}</div>
        <div class="for">
          ${L('for', 'For')} <b>${esc(company.name)}</b>
          ${
            config.signatureDataUrl
              ? `<div><img src="${esc(config.signatureDataUrl)}" alt="" style="max-height:46px;max-width:170px;object-fit:contain;margin:2px 0" /></div>`
              : '<br/><br/><br/>'
          }
          ${esc(config.signatory)}
        </div>
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
  <style>${invoiceTemplateCss(config.template)}${devanagariCss}</style></head><body>${copies}</body></html>`
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

/** Printable custom-field values for a voucher — retired definitions included, because the
 *  document said what it said. */
export function printedCustomFields(db: DB, voucherId: number): PrintedCustomField[] {
  return customFieldValuesFor(db, voucherId)
    .filter((v) => v.printed && v.value !== '')
    .map((v) => ({ label: v.label, kind: v.kind, value: v.value }))
}

export function invoiceHtml(db: DB, company: CompanyInfo, voucherId: number): { html: string; number: string } {
  const [inv] = extractEdocInvoices(db, company, '0000-01-01', '9999-12-31', voucherId)
  if (!inv) throw new Error('Invoice not found (only sales vouchers can be printed)')
  attachDiscounts(db, voucherId, inv)
  const config = getInvoiceConfig(db)
  return {
    html: buildInvoiceHtml(company, config, inv, auditTrailFor(db, voucherId), printedCustomFields(db, voucherId)),
    number: inv.number
  }
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
    return {
      html: buildInvoiceHtml(company, config, inv, auditTrailFor(db, voucherId), printedCustomFields(db, voucherId))
    }
  }
  return { html: buildInvoiceHtml(company, config, SAMPLE_INVOICE) }
}

/**
 * The 3-inch thermal receipt for a sales voucher (roadmap I-183).
 *
 * The layout lives in `@shared/thermalReceipt` (pure, unit-tested); this is the part that needs a
 * database. The receipt is built from the SAME extracted e-doc invoice the A4 print and the GSTR-1
 * export are built from, so the roll and the return can never disagree about what was sold.
 */
export function thermalReceiptHtml(
  db: DB,
  company: CompanyInfo,
  voucherId: number
): { html: string; number: string; heightMm: number; widthMm: ThermalWidthMm } {
  const [inv] = extractEdocInvoices(db, company, '0000-01-01', '9999-12-31', voucherId)
  if (!inv) throw new Error('Receipt not found (only sales vouchers can be printed)')
  const config = getInvoiceConfig(db)

  // Never on a credit note: a document that reduces what is owed must not offer to collect it —
  // the same rule the A4 print follows.
  const upiUrl =
    config.upiVpa && inv.docType !== 'CRN' && !inv.isOptional
      ? upiIntentUrl({ vpa: config.upiVpa, payeeName: company.name, amountPaise: inv.total, note: inv.number })
      : null

  const receipt: ThermalReceipt = {
    number: inv.number,
    date: inv.date,
    partyName: inv.partyName,
    partyGstin: inv.partyGstin,
    items: inv.items.map((i) => ({
      name: i.name,
      qtyMilli: i.qtyMilli,
      uqc: i.uqc,
      unitPricePaise: i.unitPricePaise,
      amountPaise: i.taxablePaise,
      ratePercent: i.rate
    })),
    taxablePaise: inv.taxable,
    cgstPaise: inv.cgst,
    sgstPaise: inv.sgst,
    igstPaise: inv.igst,
    cessPaise: inv.cess,
    roundOffPaise: inv.roundOff,
    totalPaise: inv.total
  }
  const opts: ThermalOptions = {
    widthMm: config.thermalWidthMm,
    showTax: config.thermalShowTax,
    language: config.language,
    upiQrSvg: upiUrl ? qrSvg(upiUrl, 26) : null,
    upiVpa: config.upiVpa
  }
  return {
    html: buildThermalReceiptHtml(company, receipt, opts),
    number: inv.number,
    heightMm: estimateThermalHeightMm(receipt, opts),
    widthMm: config.thermalWidthMm
  }
}

/** Millimetres to inches — printToPDF's pageSize is in inches, the roll is sold in millimetres. */
const MM_PER_INCH = 25.4

/** Render the thermal receipt to a PDF sized to the roll rather than to a page. */
export async function thermalReceiptPdf(
  db: DB,
  company: CompanyInfo,
  slug: string,
  voucherId: number
): Promise<string> {
  const { html, number, heightMm, widthMm } = thermalReceiptHtml(db, company, voucherId)
  const safe = number.replace(/[^a-zA-Z0-9-_]/g, '_')
  // No page numbers and no margins: a roll has neither, and a footer would print onto the cut.
  return writeExportPdf(slug, `receipt-${safe}.pdf`, html, {
    pageSize: { width: widthMm / MM_PER_INCH, height: heightMm / MM_PER_INCH }
  })
}

/**
 * Everything needed to send an invoice on WhatsApp or by email (roadmap I-193, I-192).
 *
 * Renders the PDF first and returns its path, because neither channel can be handed a document
 * the app has not written yet: a `wa.me` link carries text only, and a `mailto:` cannot attach.
 * The caller puts the file on the clipboard and opens the link; the person sending it pastes.
 */
export function invoiceShareDetails(
  db: DB,
  company: CompanyInfo,
  voucherId: number,
  pdfFileName?: string
): InvoiceShare & { partyName: string } {
  const [inv] = extractEdocInvoices(db, company, '0000-01-01', '9999-12-31', voucherId)
  if (!inv) throw new Error('Invoice not found (only sales vouchers can be shared)')

  // The party's contact details come off the ledger, not off the extracted document: an e-doc
  // carries the statutory particulars, and a phone number is not one of them.
  //
  // `deleted_at IS NULL` is written out rather than assumed. The extraction above would already
  // have thrown for a binned voucher, so this cannot fire today — but "some other query upstream
  // checks" is exactly the reasoning that stops being true after one refactor, and the house rule
  // is that the scope is visible in the SQL a reader is looking at.
  const party = db
    .prepare(
      'SELECT l.name AS name, l.phone AS phone, l.email AS email FROM vouchers v LEFT JOIN ledgers l ON l.id = v.party_ledger_id WHERE v.id = ? AND v.deleted_at IS NULL'
    )
    .get(voucherId) as { name: string | null; phone: string | null; email: string | null } | undefined

  const kind = inv.isOptional && inv.docType !== 'CRN' && inv.docType !== 'DBN'
    ? 'proforma'
    : inv.docType === 'CRN'
      ? 'credit_note'
      : 'invoice'
  const share = buildInvoiceShare(
    company.name,
    { number: inv.number, date: inv.date, totalPaise: inv.total, kind },
    {
      name: party?.name ?? inv.partyName ?? 'Sir/Madam',
      phone: party?.phone ?? null,
      email: party?.email ?? null
    },
    { pdfFileName }
  )
  return { ...share, partyName: party?.name ?? inv.partyName ?? '' }
}

/**
 * The same thing with the PDF actually written.
 *
 * Split from `invoiceShareDetails` so the message and the links can be built — and tested —
 * without an Electron BrowserWindow: the PDF renderer needs one, and a `.dbtest.ts` runs under
 * Electron-as-Node with no window to render into.
 */
export async function invoiceShareLinks(
  db: DB,
  company: CompanyInfo,
  slug: string,
  voucherId: number
): Promise<InvoiceShare & { pdfPath: string; partyName: string }> {
  const pdfPath = await invoicePdf(db, company, slug, voucherId)
  return { ...invoiceShareDetails(db, company, voucherId, basename(pdfPath)), pdfPath }
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
    // The voucher id keeps sanitised numbers unique: 'INV/25-26/001' vs 'INV-25-26/001', or a
    // sales invoice and another type sharing the same number, must never overwrite each other
    // (the folder would silently hold N-1 PDFs while the batch reports N).
    const path = join(dir, `invoice-${safe}-v${voucherId}.pdf`)
    writeFileSync(path, pdf)
    paths.push(path)
  }
  return { dir, paths }
}
