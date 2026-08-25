/**
 * The 3-inch thermal receipt (roadmap I-183).
 *
 * A retail counter does not print A4. It prints on a 58mm or 80mm roll from a thermal printer
 * with no margins, no page, and a cutter — so this is not the invoice template at a smaller size.
 * It is a different document: one column instead of eight, no boxes (a thermal head renders a
 * hairline as nothing and a heavy rule as a black smear), and everything that can be dropped is
 * dropped, because roll paper costs money by the metre and the customer reads it once.
 *
 * What CANNOT be dropped: if the shop is registered and the receipt is the only document the
 * customer gets, the receipt IS the tax invoice, and rule 46 still wants the supplier's name,
 * address and GSTIN, the invoice number and date, the description, the taxable value and the tax
 * split. Rule 46 does relax the recipient's details for a B2C supply below ₹50,000 where the
 * recipient is unregistered, which is the only reason a counter receipt can be this short.
 * (Checked against rule 46 CGST Rules, 2026-08.)
 *
 * Pure — no DOM, no Electron, no DB. Takes an already-rendered QR fragment rather than drawing
 * one, so the QR library stays on the main-process side of the wall.
 */

import { formatPaise } from './money'
import { toDisplayDate } from './dates'
import { bilingualLabel, type InvoiceLanguage, type InvoiceLabelKeys } from './i18n/invoiceLabels'

/** The two rolls actually sold. Anything else is a special order and not worth a code path. */
export type ThermalWidthMm = 58 | 80

export interface ThermalItem {
  name: string
  qtyMilli: number
  uqc: string
  unitPricePaise: number
  amountPaise: number
  ratePercent: number
}

export interface ThermalReceipt {
  number: string
  date: string
  partyName: string | null
  partyGstin: string | null
  items: ThermalItem[]
  taxablePaise: number
  cgstPaise: number
  sgstPaise: number
  igstPaise: number
  cessPaise: number
  roundOffPaise: number
  totalPaise: number
}

export interface ThermalCompany {
  name: string
  address: string
  gstin: string | null
  phone?: string | null
}

export interface ThermalOptions {
  widthMm: ThermalWidthMm
  /** Print the tax split. Off makes the receipt a plain bill and NOT a tax invoice — see below. */
  showTax: boolean
  language: InvoiceLanguage
  /** A pre-rendered `<svg>`/`<div>` fragment for the UPI payment QR, or null for none. */
  upiQrSvg?: string | null
  upiVpa?: string | null
  /** Footer line, e.g. a thank-you or a returns policy. */
  footer?: string | null
}

const esc = (s: string | null | undefined): string =>
  (s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

/**
 * Quantity for a receipt: thousandths, printed without trailing zeros.
 *
 * `2.000` on a roll is three characters of noise on a 32-character line. Integer arithmetic only —
 * the milli value is divided for DISPLAY and never fed back into a total.
 */
function qty(qtyMilli: number): string {
  const whole = Math.trunc(qtyMilli / 1000)
  const frac = Math.abs(qtyMilli % 1000)
  if (frac === 0) return String(whole)
  return `${whole}.${String(frac).padStart(3, '0').replace(/0+$/, '')}`
}

/**
 * Estimated printed height in millimetres, for the caller that has to give the PDF renderer a
 * page size.
 *
 * A roll has no page height — the printer feeds until it is told to cut — but PDF does, and a
 * page shorter than the content silently truncates the total off the bottom. So this over-
 * estimates deliberately: trailing blank roll is waste, a missing total is a dispute.
 */
export function estimateThermalHeightMm(receipt: ThermalReceipt, opts: ThermalOptions): number {
  const HEADER_MM = 34
  const PER_ITEM_MM = 7
  const TOTALS_MM = 24
  const QR_MM = opts.upiQrSvg ? 30 : 0
  const FOOTER_MM = 16
  return HEADER_MM + receipt.items.length * PER_ITEM_MM + TOTALS_MM + QR_MM + FOOTER_MM
}

/**
 * Render the receipt.
 *
 * Type sizes are in points and deliberately small but not tiny: a thermal head is 203dpi, which
 * is enough for 7pt and not enough for 6pt to survive the fading that thermal paper does within a
 * year. The one thing set larger than the rest is the total, because that is the number the
 * customer is checking against what they were told.
 */
export function buildThermalReceiptHtml(
  company: ThermalCompany,
  receipt: ThermalReceipt,
  opts: ThermalOptions
): string {
  const L = (key: keyof InvoiceLabelKeys, english: string): string =>
    esc(bilingualLabel(key, opts.language, english))
  const money = (paise: number): string => formatPaise(paise)

  // Intra-state when there is any CGST/SGST, inter when there is IGST. A wholly exempt sale shows
  // no split at all, and printing an empty CGST/SGST pair on one would be a claim about tax that
  // was not charged.
  const isIntra = receipt.cgstPaise > 0 || receipt.sgstPaise > 0
  const isInter = receipt.igstPaise > 0
  const showTax = opts.showTax && (isIntra || isInter)

  const itemRows = receipt.items
    .map(
      (item) => `
      <div class="it">
        <div class="it-name">${esc(item.name)}</div>
        <div class="it-line">
          <span>${qty(item.qtyMilli)} ${esc(item.uqc)} &times; ${money(item.unitPricePaise)}${
            opts.showTax && item.ratePercent > 0 ? ` <span class="dim">${item.ratePercent}%</span>` : ''
          }</span>
          <span class="amt">${money(item.amountPaise)}</span>
        </div>
      </div>`
    )
    .join('')

  const totalRow = (label: string, value: string, cls = ''): string =>
    `<div class="tr ${cls}"><span>${label}</span><span class="amt">${value}</span></div>`

  const taxRows = showTax
    ? [
        totalRow(L('taxableValue', 'Taxable'), money(receipt.taxablePaise)),
        isIntra ? totalRow(L('cgst', 'CGST'), money(receipt.cgstPaise)) : '',
        isIntra ? totalRow(L('sgst', 'SGST'), money(receipt.sgstPaise)) : '',
        isInter ? totalRow(L('igst', 'IGST'), money(receipt.igstPaise)) : '',
        receipt.cessPaise > 0 ? totalRow(L('cess', 'Cess'), money(receipt.cessPaise)) : ''
      ].join('')
    : ''

  const roundOffRow =
    receipt.roundOffPaise !== 0 ? totalRow(L('roundOff', 'Round off'), money(receipt.roundOffPaise)) : ''

  const qrBlock = opts.upiQrSvg
    ? `<div class="qr">${opts.upiQrSvg}<div class="dim c">${L('scanToPay', 'Scan to pay')}${
        opts.upiVpa ? ` · ${esc(opts.upiVpa)}` : ''
      }</div></div>`
    : ''

  // 58mm and 80mm rolls both lose ~4mm to the non-printing margin either side.
  const printableMm = opts.widthMm - 8
  const base = opts.widthMm === 58 ? 7.5 : 8.5

  return `<!doctype html><html><head><meta charset="utf-8"><title>Receipt ${esc(receipt.number)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    /* A monospace face keeps the amount column aligned without a table — a table on a 32-column
       roll wraps unpredictably, and a wrapped amount reads as a different number. */
    body { width: ${printableMm}mm; font: ${base}pt/1.35 'SF Mono', Menlo, 'Courier New', monospace; color: #000; padding: 2mm 0; }
    .c { text-align: center; }
    .dim { color: #444; }
    .shop { font-size: ${base + 2.5}pt; font-weight: 700; text-align: center; }
    .sub { text-align: center; font-size: ${base - 0.5}pt; }
    /* Dashed, not solid: a thermal head prints a solid 1px rule as a broken grey line anyway, and
       dashes fade legibly where a smear does not. */
    .rule { border-top: 1px dashed #000; margin: 1.5mm 0; }
    .meta { display: flex; justify-content: space-between; font-size: ${base - 0.5}pt; }
    .it { margin-bottom: 1mm; }
    .it-name { word-break: break-word; }
    .it-line { display: flex; justify-content: space-between; }
    .amt { font-variant-numeric: tabular-nums; white-space: nowrap; }
    .tr { display: flex; justify-content: space-between; }
    .tr.grand { font-size: ${base + 2}pt; font-weight: 700; margin-top: 1mm; }
    .qr { text-align: center; margin-top: 2mm; }
    .qr svg { width: 26mm; height: 26mm; }
    .foot { text-align: center; font-size: ${base - 0.5}pt; margin-top: 2mm; word-break: break-word; }
  </style></head><body>
    <div class="shop">${esc(company.name)}</div>
    <div class="sub">${esc(company.address)}</div>
    ${company.phone ? `<div class="sub">${esc(company.phone)}</div>` : ''}
    ${company.gstin ? `<div class="sub">${L('gstin', 'GSTIN')}: ${esc(company.gstin)}</div>` : ''}
    <div class="rule"></div>
    <div class="meta"><span>${L('invoiceNo', 'No')}: ${esc(receipt.number)}</span><span>${toDisplayDate(receipt.date)}</span></div>
    ${
      // A named customer is printed when there is one; a walk-in is not "Cash sale, unregistered",
      // which would waste two lines saying nothing.
      receipt.partyName ? `<div class="meta"><span>${L('billedTo', 'Billed to')}: ${esc(receipt.partyName)}</span></div>` : ''
    }
    ${receipt.partyGstin ? `<div class="meta"><span>${L('gstin', 'GSTIN')}: ${esc(receipt.partyGstin)}</span></div>` : ''}
    <div class="rule"></div>
    ${itemRows}
    <div class="rule"></div>
    ${taxRows}${roundOffRow}
    ${totalRow(L('total', 'Total'), '₹ ' + money(receipt.totalPaise), 'grand')}
    ${qrBlock}
    ${opts.footer ? `<div class="foot">${esc(opts.footer)}</div>` : ''}
    ${
      // Said out loud, because a receipt with no tax split is NOT a tax invoice and a customer who
      // files it as one loses the credit. Only printed when the shop is registered and the split
      // was deliberately suppressed — an unregistered shop has no tax to show in the first place.
      company.gstin && !showTax
        ? '<div class="foot dim">Not a tax invoice — tax split not shown</div>'
        : ''
    }
  </body></html>`
}
