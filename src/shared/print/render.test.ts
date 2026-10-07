import { describe, expect, it } from 'vitest'
import type { CompanyInfo } from '../domain'
import type { EdocInvoice, EdocItem } from '../gst/edocs'
import { DEFAULT_INVOICE_CONFIG, type InvoiceConfig } from '../invoiceConfig'
import { amountInWords, formatPaise } from '../money'
import {
  BUILT_IN_DEFAULTS,
  CLASSIC_DEFAULT,
  COMPACT_DEFAULT,
  legacyConfigToTemplate,
  MODERN_DEFAULT,
  printTemplateSchema,
  type PrintTemplate
} from '../printTemplates'
import { legacyBuildInvoiceHtml } from './legacyInvoiceHtml.fixture'
import { normaliseHtml, renderDocument, type InvoiceDocument } from './render'
import { sampleDocument } from './sample'
import { taxSummaryForInvoice } from './taxSummary'

const COMPANY: CompanyInfo = {
  name: 'Total Traders',
  stateCode: '27',
  gstin: '27AAAAA0000A1Z5',
  gstRegistrationType: 'regular',
  address: '1 Market Road, Mumbai',
  booksFrom: 2025,
  email: 'accounts@total.example',
  phone: '+91 22 4000 1234',
  pan: 'AAAAA0000A',
  tan: null
}

const BASE_ITEM: EdocItem = {
  name: 'Sample product', hsn: '8471', qtyMilli: 2000, uqc: 'NOS',
  unitPricePaise: 500000, taxablePaise: 1000000, rate: 18, cessRate: 0,
  cgst: 90000, sgst: 90000, igst: 0, cess: 0, isService: false, barcode: 'SAMPLE-BC-001'
}
const item = (o: Partial<EdocItem>): EdocItem => ({ ...BASE_ITEM, ...o })

const INV: EdocInvoice = {
  number: 'SAMPLE-1', date: '2025-04-01', partyName: 'Sample Buyer Pvt Ltd', partyGstin: '27AAAAA0000A1Z5',
  partyAddress: '123 Sample Street, Sample City', partyStateCode: '27', pos: '27', items: [BASE_ITEM],
  taxable: 1000000, cgst: 90000, sgst: 90000, igst: 0, cess: 0, roundOff: 0, total: 1180000,
  transporterId: null, vehicleNo: null, distanceKm: null, irn: null
}

const doc = (invoice: EdocInvoice, audit?: InvoiceDocument['audit']): InvoiceDocument => ({
  shape: 'invoice', kind: 'sales', company: COMPANY, invoice, audit
})

// ---------------------------------------------------------------- Classic ≡ legacy

const CONFIGS: [string, InvoiceConfig][] = [
  ['defaults', DEFAULT_INVOICE_CONFIG],
  ['logo + bank + terms', {
    ...DEFAULT_INVOICE_CONFIG,
    title: 'INVOICE', logoDataUrl: 'data:image/png;base64,aGVsbG8=',
    bankDetails: { name: 'Total Bank', account: '12345', ifsc: 'TOTL0001', branch: 'HQ' },
    terms: 'Payment due in 30 days\nInterest @18% after due date', signatory: 'Director'
  }],
  ['no HSN, discount, barcode, no QR', { ...DEFAULT_INVOICE_CONFIG, showHsn: false, showDiscount: true, showItemBarcode: true, showQr: false }],
  ['three copies + entered-by', { ...DEFAULT_INVOICE_CONFIG, copyLabels: ['Original for Recipient', 'Duplicate for Transporter', 'Triplicate for Supplier'], showEnteredBy: true }],
  ['empty declaration', { ...DEFAULT_INVOICE_CONFIG, declaration: '' }]
]

const INVOICES: [string, EdocInvoice][] = [
  ['single line', INV],
  ['tricky text + vehicle + round-off', { ...INV, partyName: `Sam's "Best" <India>`, vehicleNo: 'MH01AB1234', roundOff: -42, total: 1179958 }],
  ['inter-state, cess, discount, no-HSN line', {
    ...INV, partyStateCode: '29', pos: '29', cgst: 0, sgst: 0, igst: 180000 + 36000, cess: 12000,
    items: [item({ cgst: 0, sgst: 0, igst: 180000, discountPaise: 5000 }), item({ hsn: '', rate: 12, cgst: 0, sgst: 0, igst: 36000, cess: 12000, cessRate: 4, barcode: null })]
  }],
  ['long (20 lines, carried forward)', { ...INV, items: Array.from({ length: 20 }, (_, i) => item({ name: `Line ${i + 1}`, taxablePaise: 1000 })) }],
  ['zero-rated inter-state', { ...INV, partyStateCode: '29', pos: '29', cgst: 0, sgst: 0, igst: 0, total: 1000000, items: [item({ rate: 0, cgst: 0, sgst: 0 })] }],
  ['with IRN (QR carries it)', { ...INV, irn: 'abc123' }]
]

describe('Classic template ≡ the pre-1.10c invoice renderer (whitespace-normalised)', () => {
  const audit = { enteredBy: 'Priya', alteredBy: 'Rahul' }
  for (const [cName, cfg] of CONFIGS) {
    for (const [iName, inv] of INVOICES) {
      it(`${cName} × ${iName}`, () => {
        const legacy = legacyBuildInvoiceHtml(COMPANY, cfg, inv, audit)
        let next = renderDocument(legacyConfigToTemplate(cfg), doc(inv, audit))
        if (inv.irn) {
          // The ONE intended addition (WP 1.10c item 5): an e-invoiced voucher now prints its IRN
          // line. Prove it is the only difference: strip that block + its rule, then compare.
          expect(next).toContain('<div class="einv">IRN: <span class="num">abc123</span></div>')
          next = next.replace(/<div class="einv">.*?<\/div>/g, '').replace(/\.einv \{[^}]*\}/, '')
        }
        expect(normaliseHtml(next)).toBe(normaliseHtml(legacy))
      })
    }
  }

  it('is in fact byte-different only in whitespace (sanity: the normaliser is not hiding content)', () => {
    const legacy = legacyBuildInvoiceHtml(COMPANY, DEFAULT_INVOICE_CONFIG, INV)
    const next = renderDocument(CLASSIC_DEFAULT, doc(INV))
    expect(next.replace(/\s+/g, '')).toBe(legacy.replace(/\s+/g, ''))
  })
})

// ---------------------------------------------------------------- built-in snapshots

describe('built-in templates on the sample invoice (snapshots)', () => {
  for (const t of Object.values(BUILT_IN_DEFAULTS)) {
    it(`${t.name} renders stably`, () => {
      expect(renderDocument(t, sampleDocument(COMPANY, 'sales'))).toMatchSnapshot()
    })
    it(`${t.name} renders a receipt voucher`, () => {
      const html = renderDocument(t, sampleDocument(COMPANY, 'receipt'))
      expect(html).toContain('RECEIPT')
      expect(html).toContain('Received from')
      expect(html).toContain(amountInWords(7500000))
    })
  }
})

// ---------------------------------------------------------------- specific assertions

const headers = (html: string): string[] => {
  const table = html.match(/<table class="items">([\s\S]*?)<\/thead>/)![1]!
  return [...table.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]!)
}
const withColumns = (t: PrintTemplate, mutate: (cols: PrintTemplate['columns']) => PrintTemplate['columns']): PrintTemplate =>
  printTemplateSchema.parse({ ...t, columns: mutate(t.columns.map((c) => ({ ...c }))) })

describe('renderDocument — template options', () => {
  it('prints columns in template order and omits hidden ones', () => {
    const t = withColumns(CLASSIC_DEFAULT, (cols) => {
      const rate = cols.findIndex((c) => c.key === 'rate')
      const qty = cols.findIndex((c) => c.key === 'qty')
      ;[cols[rate], cols[qty]] = [cols[qty]!, cols[rate]!]
      return cols.map((c) => (c.key === 'gstRate' ? { ...c, visible: false } : c))
    })
    const h = headers(renderDocument(t, doc(INV)))
    expect(h).toEqual(['#', 'Description', 'HSN', 'Rate', 'Qty', 'Amount'])
  })

  it('auto-hides CGST/SGST on inter-state and IGST on intra-state invoices', () => {
    const t = withColumns(CLASSIC_DEFAULT, (cols) => cols.map((c) => (['cgst', 'sgst', 'igst'].includes(c.key) ? { ...c, visible: true } : c)))
    expect(headers(renderDocument(t, doc(INV)))).toEqual(expect.arrayContaining(['CGST', 'SGST']))
    expect(headers(renderDocument(t, doc(INV)))).not.toContain('IGST')
    const inter = { ...INV, pos: '29', cgst: 0, sgst: 0, igst: 180000, items: [item({ cgst: 0, sgst: 0, igst: 180000 })] }
    expect(headers(renderDocument(t, doc(inter)))).toContain('IGST')
    expect(headers(renderDocument(t, doc(inter)))).not.toContain('CGST')
  })

  it('a separate Unit column takes the unit out of the Qty cell', () => {
    const t = withColumns(CLASSIC_DEFAULT, (cols) => cols.map((c) => (c.key === 'unit' ? { ...c, visible: true } : c)))
    const html = renderDocument(t, doc(INV))
    expect(html).toContain('<td class="r num">2</td>')
    expect(html).toContain('<td class="c">NOS</td>')
    expect(renderDocument(CLASSIC_DEFAULT, doc(INV))).toContain('<td class="r num">2 NOS</td>')
  })

  it('prints the amount in words with Indian numbering, and can hide it', () => {
    const big = { ...INV, total: 1234567800 }
    expect(renderDocument(CLASSIC_DEFAULT, doc(big))).toContain('One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight Rupees Only')
    const off = printTemplateSchema.parse({ ...CLASSIC_DEFAULT, totals: { ...CLASSIC_DEFAULT.totals, showAmountInWords: false } })
    expect(renderDocument(off, doc(big))).not.toContain('Amount in words')
  })

  it('tax summary by rate: rows sum to the line taxable/tax totals of the sample invoice', () => {
    const sample = sampleDocument(COMPANY, 'sales')
    if (sample.shape !== 'invoice') throw new Error('expected invoice')
    const inv = sample.invoice
    const rows = taxSummaryForInvoice(inv, 'rate', 'intra')
    expect(rows.map((r) => r.rate)).toEqual([12, 18, 18])
    const sum = (f: (r: (typeof rows)[number]) => number): number => rows.reduce((s, r) => s + f(r), 0)
    expect(sum((r) => r.taxable)).toBe(inv.taxable)
    expect(sum((r) => r.cgst)).toBe(inv.cgst)
    expect(sum((r) => r.sgst)).toBe(inv.sgst)
    expect(sum((r) => r.cess)).toBe(inv.cess)
    const html = renderDocument(MODERN_DEFAULT, sample)
    expect(html).toContain('<th>GST rate</th>')
    expect(html).toContain(formatPaise(inv.taxable))
  })

  it('emits @page size CSS for non-A4-portrait pages only', () => {
    expect(renderDocument(CLASSIC_DEFAULT, doc(INV))).not.toContain('@page')
    const a5 = printTemplateSchema.parse({ ...COMPACT_DEFAULT, page: { ...COMPACT_DEFAULT.page, size: 'A5', orientation: 'landscape' } })
    expect(renderDocument(a5, doc(INV))).toContain('@page { size: A5 landscape; }')
    const letter = printTemplateSchema.parse({ ...COMPACT_DEFAULT, page: { ...COMPACT_DEFAULT.page, size: 'Letter' } })
    expect(renderDocument(letter, doc(INV))).toContain('@page { size: letter portrait; }')
  })

  it('keeps header rows repeating and rows unsplit in every built-in style', () => {
    for (const t of Object.values(BUILT_IN_DEFAULTS)) {
      const html = renderDocument(t, doc(INV))
      expect(html).toContain('thead { display: table-header-group; }')
      expect(html).toContain('tr { page-break-inside: avoid; }')
    }
  })

  it('prints the e-invoice block (IRN, ack, e-way bill) when IRN data exists, and not otherwise', () => {
    const sample = sampleDocument(COMPANY, 'sales')
    const html = renderDocument(CLASSIC_DEFAULT, sample)
    expect(html).toContain('IRN: <span class="num">8f3c2a7d')
    expect(html).toContain('Ack No: <span class="num">112610000123456')
    expect(html).toContain('e-Way Bill No: <span class="num">321009876543')
    expect(html).toContain('Verification QR')
    expect(renderDocument(CLASSIC_DEFAULT, doc(INV))).not.toContain('class="einv"')
  })

  it('applies the accent, base font size, font family and date format', () => {
    const t = printTemplateSchema.parse({
      ...MODERN_DEFAULT,
      typography: { ...MODERN_DEFAULT.typography, accent: '#aa0033', baseFontPx: 9, fontFamily: 'plex-serif' },
      formats: { ...MODERN_DEFAULT.formats, date: 'dd/mm/yyyy' }
    })
    const html = renderDocument(t, doc(INV), { fontFaceCss: (f) => `@font-face { font-family: 'X-${f}'; }` })
    expect(html).toContain('border-bottom: 3px solid #aa0033')
    expect(html).toContain("font: 9px/1.5 'IBM Plex Serif'")
    expect(html).toContain("@font-face { font-family: 'X-plex-serif'; }")
    expect(html).not.toContain('X-plex-mono')
    expect(html).toContain('01/04/2025')
  })

  it('titles follow the document kind (credit notes no longer say TAX INVOICE)', () => {
    const cn: InvoiceDocument = { ...doc({ ...INV, docType: 'CRN', precedingDoc: { invNo: 'INV-9', invDate: '2025-03-01' } }), kind: 'credit_note' }
    const html = renderDocument(CLASSIC_DEFAULT, cn)
    expect(html).toContain('<b>CREDIT NOTE</b>')
    expect(html).toContain('Against: <span class="num">INV-9</span>')
    expect(html).not.toContain('TAX INVOICE')
  })

  it('outstanding balance and computer-generated note render only when enabled', () => {
    const t = printTemplateSchema.parse({
      ...CLASSIC_DEFAULT,
      totals: { ...CLASSIC_DEFAULT.totals, showOutstanding: true },
      footer: { ...CLASSIC_DEFAULT.footer, showComputerGenerated: true }
    })
    const html = renderDocument(t, { ...doc(INV), outstandingPaise: 250000 })
    expect(html).toContain('Balance outstanding</td><td class="r num">2,500.00 Dr')
    expect(html).toContain('This is a computer-generated document.')
    expect(renderDocument(CLASSIC_DEFAULT, { ...doc(INV), outstandingPaise: 250000 })).not.toContain('Balance outstanding')
  })

  it('escapes template text (no markup injection through labels)', () => {
    const t = withColumns(CLASSIC_DEFAULT, (cols) => cols.map((c) => (c.key === 'item' ? { ...c, label: '<b>x</b>' } : c)))
    expect(renderDocument(t, doc(INV))).toContain('<th>&lt;b&gt;x&lt;/b&gt;</th>')
  })
})
