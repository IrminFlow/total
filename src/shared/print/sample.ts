import type { CompanyInfo } from '../domain'
import type { EdocInvoice, EdocItem } from '../gst/edocs'
import { computeGst } from '../gst/calc'
import { roundToRupee } from '../money'
import { INVOICE_SHAPED_KINDS, type PrintDocKind } from '../printTemplates'
import type { PrintDocument } from './render'

/**
 * The designer's sample invoice (live preview + "Print test page"): intra-state, two GST rates,
 * a line discount, a cess line, a non-zero round-off, ship-to, and sample IRN / Ack / e-way bill
 * data — so every block of a template is visible. Totals are computed with the real engine
 * helpers (computeGst per line, roundToRupee), not typed in.
 */
function line(
  name: string, hsn: string, qtyMilli: number, uqc: string, unitPricePaise: number, rate: number,
  extra: Partial<EdocItem> = {}
): EdocItem {
  const gross = Math.round((qtyMilli * unitPricePaise) / 1000)
  const discount = extra.discountPaise ?? 0
  const taxable = gross - discount
  const cessRate = extra.cessRate ?? 0
  const g = computeGst(taxable, rate, 'intra', cessRate)
  return {
    name, hsn, qtyMilli, uqc, unitPricePaise, taxablePaise: taxable, rate, cessRate,
    cgst: g.cgst, sgst: g.sgst, igst: g.igst, cess: g.cess, isService: false, barcode: null,
    ...extra
  }
}

const ITEMS: EdocItem[] = [
  line('Steel almirah, 4-door', '9403', 2000, 'NOS', 1450000, 18, { description: 'Grey powder-coat, with locker', discountPaise: 145000 }),
  line('Office chair, mesh back', '9401', 6000, 'NOS', 389900, 18, { description: 'Adjustable arms, 5-year warranty' }),
  line('A4 copier paper, 75 gsm', '4802', 25000, 'PAC', 24500, 12, { description: 'Ream of 500 sheets' }),
  line('Packaged drinking water, 20 L', '2201', 12000, 'NOS', 9000, 18, { cessRate: 12, description: 'Refundable jar deposit extra' }),
  line('Installation and setup', '9954', 1000, 'OTH', 250000, 18, { isService: true, description: 'On-site, within city limits' })
]

function sampleInvoice(company: CompanyInfo, kind: PrintDocKind): EdocInvoice {
  const taxable = ITEMS.reduce((s, i) => s + i.taxablePaise, 0)
  const cgst = ITEMS.reduce((s, i) => s + i.cgst, 0)
  const sgst = ITEMS.reduce((s, i) => s + i.sgst, 0)
  const cess = ITEMS.reduce((s, i) => s + i.cess, 0)
  const exact = taxable + cgst + sgst + cess
  const total = roundToRupee(exact)
  return {
    number: kind === 'credit_note' ? 'CN-SAMPLE-1' : kind === 'debit_note' ? 'DN-SAMPLE-1' : 'INV-SAMPLE-1',
    date: '2026-08-14',
    docType: kind === 'credit_note' ? 'CRN' : kind === 'debit_note' ? 'DBN' : 'INV',
    partyName: 'Sample Buyer Pvt Ltd',
    partyGstin: `${company.stateCode}AAACS1234K1Z5`,
    partyAddress: '2nd Floor, Sample House, 14 Market Road',
    partyStateCode: company.stateCode,
    pos: company.stateCode,
    items: ITEMS,
    taxable,
    cgst,
    sgst,
    igst: 0,
    cess,
    roundOff: total - exact,
    total,
    transporterId: null,
    vehicleNo: 'MH12AB1234',
    distanceKm: 18,
    shipTo: { name: 'Sample Buyer — Warehouse', gstin: null, addr1: 'Gala 7, Industrial Estate', addr2: null, place: 'Bhiwandi', pincode: '421302', state: company.stateCode },
    precedingDoc: kind === 'credit_note' || kind === 'debit_note' ? { invNo: 'INV-SAMPLE-1', invDate: '2026-08-01' } : null,
    irn: '8f3c2a7d9b1e4f60a5c3d2e1f0b9a8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1'
  }
}

/** Sample document for `kind` — invoice-shaped kinds get the sample invoice, voucher-shaped ones a
 *  sample receipt/payment-style voucher. */
export function sampleDocument(company: CompanyInfo, kind: PrintDocKind = 'sales'): PrintDocument {
  if (INVOICE_SHAPED_KINDS.includes(kind)) {
    const invoice = sampleInvoice(company, kind)
    // Quotations / orders (WP 2.5c): their own number, validity / expected date and terms.
    const tradeNo: Partial<Record<PrintDocKind, string>> = { quotation: 'QT-SAMPLE-1', sales_order: 'SO-SAMPLE-1', purchase_order: 'PO-SAMPLE-1' }
    if (tradeNo[kind]) {
      return {
        shape: 'invoice', kind, company, invoice: { ...invoice, number: tradeNo[kind]!, irn: null, vehicleNo: null },
        audit: { enteredBy: 'Priya', alteredBy: null },
        trade: {
          validUntil: kind === 'quotation' ? '2026-08-28' : null,
          dueDate: kind === 'quotation' ? null : '2026-08-21',
          reference: kind === 'quotation' ? null : 'PO/2026/118',
          terms: '50% advance, balance against delivery. Prices ex-works; freight extra.',
          narration: null
        }
      }
    }
    return {
      shape: 'invoice',
      kind,
      company,
      invoice,
      audit: { enteredBy: 'Priya', alteredBy: null },
      outstandingPaise: invoice.total + 2500000,
      einvoice: { irn: invoice.irn ?? null, ackNo: '112610000123456', ackDate: '2026-08-14', ewbNo: '321009876543' }
    }
  }
  const amount = 7500000
  return {
    shape: 'voucher',
    kind,
    company,
    voucher: {
      number: 'SAMPLE-1',
      date: '2026-08-14',
      partyName: 'Sample Buyer Pvt Ltd',
      partyAddress: '2nd Floor, Sample House, 14 Market Road',
      partyGstin: `${company.stateCode}AAACS1234K1Z5`,
      lines:
        kind === 'payment'
          ? [{ ledgerName: 'Sample Buyer Pvt Ltd', drCr: 'dr', amount }, { ledgerName: 'HDFC Bank', drCr: 'cr', amount }]
          : [{ ledgerName: 'HDFC Bank', drCr: 'dr', amount }, { ledgerName: 'Sample Buyer Pvt Ltd', drCr: 'cr', amount }],
      narration: 'Against invoice INV-SAMPLE-1',
      reference: 'INV-SAMPLE-1',
      instrumentNo: 'UTR 4402981',
      instrumentDate: '2026-08-14',
      total: amount
    },
    audit: { enteredBy: 'Priya', alteredBy: null },
    outstandingPaise: 2500000
  }
}
