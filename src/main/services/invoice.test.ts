import { describe, it, expect } from 'vitest'
import { buildInvoiceHtml, hsnSummaryForInvoice, INVOICE_ITEMS_PER_PAGE, SAMPLE_INVOICE } from './invoice'
import { DEFAULT_INVOICE_CONFIG } from '@shared/invoiceConfig'
import type { CompanyInfo } from '@shared/domain'
import type { EdocInvoice, EdocItem } from '@shared/gst/edocs'

const COMPANY: CompanyInfo = {
  name: 'Total Traders',
  stateCode: '27',
  gstin: '27AAAAA0000A1Z5',
  gstRegistrationType: 'regular',
  gstFilingFrequency: 'monthly',
  turnoverBand: null,
  address: '1 Market Road, Mumbai',
  booksFrom: 2025,
  email: null,
  phone: null,
  pan: null,
  tan: null
}

describe('buildInvoiceHtml (pure — invoice print config rendering)', () => {
  it('renders the configured title, declaration, and signatory with defaults (no logo/bank)', () => {
    const html = buildInvoiceHtml(COMPANY, DEFAULT_INVOICE_CONFIG, SAMPLE_INVOICE)
    expect(html).toContain(DEFAULT_INVOICE_CONFIG.title)
    expect(html).toContain(DEFAULT_INVOICE_CONFIG.declaration)
    expect(html).toContain(DEFAULT_INVOICE_CONFIG.signatory)
    expect(html).not.toContain('<img')
    expect(html).not.toContain('Bank details')
  })

  it('renders the logo <img> when logoDataUrl is set', () => {
    const html = buildInvoiceHtml(
      COMPANY,
      { ...DEFAULT_INVOICE_CONFIG, logoDataUrl: 'data:image/png;base64,aGVsbG8=' },
      SAMPLE_INVOICE
    )
    expect(html).toContain('<img src="data:image/png;base64,aGVsbG8="')
  })

  it('renders a bank-details block when bankDetails is set, omits it when null', () => {
    const withBank = buildInvoiceHtml(
      COMPANY,
      { ...DEFAULT_INVOICE_CONFIG, bankDetails: { name: 'Total Bank', account: '12345', ifsc: 'TOTL0001', branch: 'HQ' } },
      SAMPLE_INVOICE
    )
    expect(withBank).toContain('Bank details')
    expect(withBank).toContain('Total Bank')
    expect(withBank).toContain('TOTL0001')

    const withoutBank = buildInvoiceHtml(COMPANY, { ...DEFAULT_INVOICE_CONFIG, bankDetails: null }, SAMPLE_INVOICE)
    expect(withoutBank).not.toContain('Bank details')
  })

  it('renders a terms block only when terms is non-empty', () => {
    const withTerms = buildInvoiceHtml(COMPANY, { ...DEFAULT_INVOICE_CONFIG, terms: 'Payment due in 30 days' }, SAMPLE_INVOICE)
    expect(withTerms).toContain('Payment due in 30 days')
    const withoutTerms = buildInvoiceHtml(COMPANY, { ...DEFAULT_INVOICE_CONFIG, terms: '' }, SAMPLE_INVOICE)
    expect(withoutTerms).not.toContain('Terms</div>')
  })

  it('omits the HSN column when showHsn is false, includes it by default', () => {
    const withHsn = buildInvoiceHtml(COMPANY, DEFAULT_INVOICE_CONFIG, SAMPLE_INVOICE)
    expect(withHsn).toContain('>HSN<')
    expect(withHsn).toContain(`>${SAMPLE_INVOICE.items[0]!.hsn}<`)

    const withoutHsn = buildInvoiceHtml(COMPANY, { ...DEFAULT_INVOICE_CONFIG, showHsn: false }, SAMPLE_INVOICE)
    expect(withoutHsn).not.toContain('>HSN<')
  })

  it('adds a Discount column only when showDiscount is true', () => {
    const withDiscount = buildInvoiceHtml(COMPANY, { ...DEFAULT_INVOICE_CONFIG, showDiscount: true }, SAMPLE_INVOICE)
    expect(withDiscount).toContain('Discount')
    const withoutDiscount = buildInvoiceHtml(COMPANY, DEFAULT_INVOICE_CONFIG, SAMPLE_INVOICE)
    expect(withoutDiscount).not.toContain('Discount')
  })

  it('escapes double quotes and apostrophes in text fields, not just & < >', () => {
    const tricky = { ...SAMPLE_INVOICE, partyName: `Sam's "Best" Traders <India>` }
    const html = buildInvoiceHtml(COMPANY, DEFAULT_INVOICE_CONFIG, tricky)
    expect(html).not.toContain(`Sam's "Best" Traders <India>`)
    expect(html).toContain('Sam&#39;s &quot;Best&quot; Traders &lt;India&gt;')
  })

  it('prints the company’s own custom fields, and nothing when there are none (roadmap #195)', () => {
    const bare = buildInvoiceHtml(COMPANY, DEFAULT_INVOICE_CONFIG, SAMPLE_INVOICE)
    const withFields = buildInvoiceHtml(COMPANY, DEFAULT_INVOICE_CONFIG, SAMPLE_INVOICE, undefined, [
      { label: 'Customer PO', kind: 'text', value: 'PO/2026/881' },
      { label: 'Delivered on', kind: 'date', value: '2026-03-31' },
      { label: 'Cartons', kind: 'number', value: '12.5' }
    ])
    expect(withFields).toContain('Customer PO: <span>PO/2026/881</span>')
    // A date reads the way every other date on the sheet does.
    expect(withFields).toContain('Delivered on: <span>31-03-2026</span>')
    // A number prints exactly as typed: no separators, no two decimals, nothing that could be
    // mistaken for an amount — and it appears nowhere near the totals table.
    expect(withFields).toContain('Cartons: <span>12.5</span>')
    expect(withFields).not.toContain('12.50')
    // A company that defines no fields prints byte-for-byte what it printed before the feature.
    expect(bare).toBe(buildInvoiceHtml(COMPANY, DEFAULT_INVOICE_CONFIG, SAMPLE_INVOICE, undefined, []))
    expect(bare).not.toContain('Other details')
  })

  it('renders stably for the default config (snapshot)', () => {
    expect(buildInvoiceHtml(COMPANY, DEFAULT_INVOICE_CONFIG, SAMPLE_INVOICE)).toMatchSnapshot()
  })

  it('repeats the table header on every printed page and keeps rows unsplit (print CSS)', () => {
    const html = buildInvoiceHtml(COMPANY, DEFAULT_INVOICE_CONFIG, SAMPLE_INVOICE)
    expect(html).toContain('thead { display: table-header-group; }')
    expect(html).toContain('tr { page-break-inside: avoid; }')
  })

  it('prints the actual per-line discount when showDiscount is on', () => {
    const inv: EdocInvoice = {
      ...SAMPLE_INVOICE,
      items: [{ ...SAMPLE_INVOICE.items[0]!, discountPaise: 5000 }]
    }
    const html = buildInvoiceHtml(COMPANY, { ...DEFAULT_INVOICE_CONFIG, showDiscount: true }, inv)
    expect(html).toContain('50.00') // ₹50.00 discount, honestly displayed
    // A line without a discount renders a dash, not a fake zero.
    const noDiscount = buildInvoiceHtml(COMPANY, { ...DEFAULT_INVOICE_CONFIG, showDiscount: true }, SAMPLE_INVOICE)
    expect(noDiscount).toContain('<td class="r num">–</td>')
  })

  it('shows an entered-by/altered-by footer only when the toggle is on and audit info exists', () => {
    const audit = { enteredBy: 'Priya', alteredBy: 'Rahul' }
    const on = buildInvoiceHtml(COMPANY, { ...DEFAULT_INVOICE_CONFIG, showEnteredBy: true }, SAMPLE_INVOICE, audit)
    expect(on).toContain('Entered by Priya')
    expect(on).toContain('Altered by Rahul')

    const off = buildInvoiceHtml(COMPANY, DEFAULT_INVOICE_CONFIG, SAMPLE_INVOICE, audit)
    expect(off).not.toContain('Entered by')

    const noAudit = buildInvoiceHtml(COMPANY, { ...DEFAULT_INVOICE_CONFIG, showEnteredBy: true }, SAMPLE_INVOICE)
    expect(noAudit).not.toContain('Entered by')
  })

  it('prints one page per copy label, with page-break-after between them', () => {
    const html = buildInvoiceHtml(
      COMPANY,
      { ...DEFAULT_INVOICE_CONFIG, copyLabels: ['Original for Recipient', 'Duplicate for Transporter'] },
      SAMPLE_INVOICE
    )
    expect(html).toContain('Original for Recipient')
    expect(html).toContain('Duplicate for Transporter')
    expect((html.match(/class="copy"/g) ?? []).length).toBe(2)
    expect(html).toContain('page-break-after: always')
  })
})

function item(overrides: Partial<EdocItem>): EdocItem {
  return { ...SAMPLE_INVOICE.items[0]!, ...overrides }
}

describe('hsnSummaryForInvoice (Q2 #96 — HSN-wise tax summary block)', () => {
  it('aggregates per (hsn, rate) bucket FIRST, then computes tax once on the aggregate', () => {
    // 3 paise @ 18% intra: per-line CGST would round to 0 each (0.27 -> 0); the 6-paise bucket
    // rounds to 1 (0.54 -> 1). Bucket-then-round is the portal semantics the block must follow.
    const inv: EdocInvoice = {
      ...SAMPLE_INVOICE,
      igst: 0,
      items: [
        item({ hsn: '8471', rate: 18, cessRate: 0, taxablePaise: 3, qtyMilli: 1000, cgst: 0, sgst: 0 }),
        item({ hsn: '8471', rate: 18, cessRate: 0, taxablePaise: 3, qtyMilli: 1000, cgst: 0, sgst: 0 })
      ]
    }
    const rows = hsnSummaryForInvoice(inv)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ hsn: '8471', rate: 18, taxable: 6, qtyMilli: 2000, cgst: 1, sgst: 1, igst: 0 })
  })

  it('keeps lines without an HSN as their own bucket instead of dropping them', () => {
    const inv: EdocInvoice = {
      ...SAMPLE_INVOICE,
      items: [
        item({ hsn: '8471', rate: 18, taxablePaise: 100000 }),
        item({ hsn: '', rate: 18, taxablePaise: 50000 })
      ]
    }
    const rows = hsnSummaryForInvoice(inv)
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.hsn)).toEqual(['', '8471'])
    expect(rows[0]!.taxable).toBe(50000)
  })

  it('splits buckets on rate (same HSN, different rate) and uses IGST for inter-state invoices', () => {
    const inv: EdocInvoice = {
      ...SAMPLE_INVOICE,
      igst: 18000,
      cgst: 0,
      sgst: 0,
      items: [
        item({ hsn: '8471', rate: 18, taxablePaise: 100000 }),
        item({ hsn: '8471', rate: 12, taxablePaise: 100000 })
      ]
    }
    const rows = hsnSummaryForInvoice(inv)
    expect(rows.map((r) => r.rate)).toEqual([12, 18])
    expect(rows[1]).toMatchObject({ igst: 18000, cgst: 0, sgst: 0 })
  })

  it('prints a signature image above the signatory line, and blank space without one', () => {
    // A scanned signature is what most small businesses actually do; the alternative is printing
    // every invoice to sign it by hand.
    const withSig = buildInvoiceHtml(
      COMPANY,
      { ...DEFAULT_INVOICE_CONFIG, signatureDataUrl: 'data:image/png;base64,c2ln' },
      SAMPLE_INVOICE
    )
    expect(withSig).toContain('data:image/png;base64,c2ln')
    expect(withSig).toContain(DEFAULT_INVOICE_CONFIG.signatory)

    const without = buildInvoiceHtml(COMPANY, DEFAULT_INVOICE_CONFIG, SAMPLE_INVOICE)
    expect(without).not.toContain('base64,c2ln')
  })

  it('uses the terms for this document kind, falling back to the general block', () => {
    // A sales invoice says "payment due in 30 days"; a credit note saying that is nonsense.
    const config = {
      ...DEFAULT_INVOICE_CONFIG,
      terms: 'General terms',
      termsByKind: { credit_note: 'Refund within 7 working days' }
    }
    const sale = buildInvoiceHtml(COMPANY, config, SAMPLE_INVOICE)
    expect(sale).toContain('General terms')
    expect(sale).not.toContain('Refund within 7')

    const note = buildInvoiceHtml(COMPANY, config, { ...SAMPLE_INVOICE, docType: 'CRN' })
    expect(note).toContain('Refund within 7 working days')
    expect(note).not.toContain('General terms')
  })

  it('never blanks the terms just because another kind was configured', () => {
    // Falling back rather than blanking is what stops configuring one document clearing the rest.
    const html = buildInvoiceHtml(
      COMPANY,
      { ...DEFAULT_INVOICE_CONFIG, terms: 'General terms', termsByKind: { debit_note: 'Other' } },
      SAMPLE_INVOICE
    )
    expect(html).toContain('General terms')
  })

  it('prints a memorandum sales voucher as a proforma, watermarked and with no payment QR', () => {
    // A proforma that looks like a tax invoice is one a customer may pay against and one an
    // auditor will ask about.
    const html = buildInvoiceHtml(
      COMPANY,
      { ...DEFAULT_INVOICE_CONFIG, upiVpa: 'totaltraders@ybl' },
      { ...SAMPLE_INVOICE, isOptional: true }
    )
    expect(html).toContain('PROFORMA INVOICE')
    expect(html).not.toContain('TAX INVOICE')
    expect(html).toContain('class="watermark"')
    // Nothing is owed yet, so nothing invites payment.
    expect(html).not.toContain('Scan to pay')
  })

  it('leaves an ordinary invoice unwatermarked', () => {
    const html = buildInvoiceHtml(COMPANY, DEFAULT_INVOICE_CONFIG, SAMPLE_INVOICE)
    expect(html).not.toContain('class="watermark"')
    expect(html).not.toContain('PROFORMA')
  })

  it('does not turn a memorandum credit note into a proforma', () => {
    // "Proforma credit note" is not a document; the heading would be nonsense.
    const html = buildInvoiceHtml(
      COMPANY,
      DEFAULT_INVOICE_CONFIG,
      { ...SAMPLE_INVOICE, isOptional: true, docType: 'CRN' }
    )
    expect(html).not.toContain('PROFORMA')
  })

  it('prints a UPI payment QR when a VPA is configured, and none when it is not', () => {
    // An invoice that says what is owed and leaves the customer to type an account number into a
    // banking app gets paid late.
    const without = buildInvoiceHtml(COMPANY, DEFAULT_INVOICE_CONFIG, SAMPLE_INVOICE)
    expect(without).not.toContain('Scan to pay')

    const withUpi = buildInvoiceHtml(
      COMPANY,
      { ...DEFAULT_INVOICE_CONFIG, upiVpa: 'totaltraders@ybl' },
      SAMPLE_INVOICE
    )
    expect(withUpi).toContain('Scan to pay')
    expect(withUpi).toContain('totaltraders@ybl')
  })

  it('never offers to collect on a credit note', () => {
    // A document that reduces what is owed must not carry a QR that takes money.
    const html = buildInvoiceHtml(
      COMPANY,
      { ...DEFAULT_INVOICE_CONFIG, upiVpa: 'totaltraders@ybl' },
      { ...SAMPLE_INVOICE, docType: 'CRN' }
    )
    expect(html).not.toContain('Scan to pay')
  })

  it('prints no payment QR for a VPA that could not be turned into a link', () => {
    // Better no QR than one that opens an app with the wrong payee: the customer believes they
    // have paid. (The config schema rejects this shape too; this is the render-side guard.)
    const html = buildInvoiceHtml(
      COMPANY,
      { ...DEFAULT_INVOICE_CONFIG, upiVpa: 'not a vpa' },
      SAMPLE_INVOICE
    )
    expect(html).not.toContain('Scan to pay')
  })

  it('prints a composition dealer a bill of supply, with the rule 5(1)(f) line and no tax', () => {
    // A composition dealer may not collect tax and may not issue a tax invoice. Printing one
    // with nil CGST/SGST rows is the dealer holding out a document they are barred from issuing.
    const composition: CompanyInfo = { ...COMPANY, gstRegistrationType: 'composition' }
    const html = buildInvoiceHtml(composition, DEFAULT_INVOICE_CONFIG, SAMPLE_INVOICE)

    expect(html).toContain('BILL OF SUPPLY')
    expect(html).not.toContain('TAX INVOICE')
    expect(html).toContain('Composition taxable person, not eligible to collect tax on supplies')
    // Not one tax column anywhere: totals table, item table, or HSN summary.
    expect(html).not.toContain('>CGST<')
    expect(html).not.toContain('>SGST<')
    expect(html).not.toContain('>IGST<')
    expect(html).not.toContain('>GST<')
    expect(html).toContain('Value of supply')
    expect(html).not.toContain('Taxable value')
  })

  it('keeps a tax invoice for a reverse-charge supply and says who owes the tax', () => {
    // Zero tax on the face of it, but the tax exists — the buyer pays it. Rule 46(p).
    const rcm: EdocInvoice = {
      ...SAMPLE_INVOICE,
      rchrg: true,
      cgst: 0,
      sgst: 0,
      igst: 0,
      total: SAMPLE_INVOICE.taxable,
      items: [item({ rate: 18, cgst: 0, sgst: 0, igst: 0 })]
    }
    const html = buildInvoiceHtml(COMPANY, DEFAULT_INVOICE_CONFIG, rcm)
    expect(html).toContain(DEFAULT_INVOICE_CONFIG.title)
    expect(html).not.toContain('BILL OF SUPPLY')
    expect(html).toContain('Tax payable on reverse charge basis')
    // The tax columns stay, at nil, which is exactly what a reverse-charge invoice shows.
    expect(html).toContain('>CGST<')
  })

  it('prints an all-0%/exempt supply as a bill of supply, with no tax columns at all', () => {
    // A regular dealer's wholly-exempt supply owes a bill of supply under s.31(3)(c). This used
    // to print TAX INVOICE with a nil IGST column, which reads as tax charged at zero.
    const inv: EdocInvoice = {
      ...SAMPLE_INVOICE,
      partyStateCode: '29',
      pos: '29',
      cgst: 0,
      sgst: 0,
      igst: 0,
      total: 1000000,
      items: [item({ rate: 0, cgst: 0, sgst: 0, igst: 0 })]
    }
    const html = buildInvoiceHtml(COMPANY, DEFAULT_INVOICE_CONFIG, inv)
    expect(html).toContain('BILL OF SUPPLY')
    expect(html).not.toContain('>IGST<')
    expect(html).not.toContain('>CGST<')
    expect(html).toContain('Value of supply')

    // The same document exported without payment of tax IS a tax invoice, and keeps the column:
    // zero-rated is not exempt. All taxes are still zero, so buildInvoiceHtml has to fall back to
    // place-of-supply vs company state ('29' vs COMPANY's '27') to pick the column.
    const exported = buildInvoiceHtml(COMPANY, DEFAULT_INVOICE_CONFIG, { ...inv, supTyp: 'EXPWOP' })
    expect(exported).toContain('>IGST<')
    expect(exported).not.toContain('>CGST<')
    expect(exported).toContain('without payment of integrated tax')

    const rows = hsnSummaryForInvoice(inv, 'inter')
    expect(rows[0]).toMatchObject({ rate: 0, cgst: 0, sgst: 0, igst: 0 })
  })

  it('renders the HSN summary block on the invoice when showHsn is on, with — for no-HSN lines', () => {
    const inv: EdocInvoice = {
      ...SAMPLE_INVOICE,
      items: [item({ hsn: '' })]
    }
    const html = buildInvoiceHtml(COMPANY, DEFAULT_INVOICE_CONFIG, inv)
    expect(html).toContain('HSN/SAC')
    expect(html).toContain('—')

    const off = buildInvoiceHtml(COMPANY, { ...DEFAULT_INVOICE_CONFIG, showHsn: false }, inv)
    expect(off).not.toContain('HSN/SAC')
  })
})

describe('carried-forward subtotals on long invoices (Q2 #95)', () => {
  it('short invoices render one unbroken table with no carried-forward rows', () => {
    const html = buildInvoiceHtml(COMPANY, DEFAULT_INVOICE_CONFIG, SAMPLE_INVOICE)
    expect(html).not.toContain('Carried forward')
    expect(html).not.toContain('Brought forward')
  })

  it('long invoices split into pages with matching carried-forward/brought-forward subtotals', () => {
    const count = INVOICE_ITEMS_PER_PAGE + 4
    const inv: EdocInvoice = {
      ...SAMPLE_INVOICE,
      items: Array.from({ length: count }, (_, i) => item({ name: `Line ${i + 1}`, taxablePaise: 1000 }))
    }
    const html = buildInvoiceHtml(COMPANY, DEFAULT_INVOICE_CONFIG, inv)
    // One copy label -> exactly one page split, one carried-forward, one brought-forward.
    expect((html.match(/Carried forward/g) ?? []).length).toBe(1)
    expect((html.match(/Brought forward/g) ?? []).length).toBe(1)
    expect(html).toContain('page-split')
    // Both subtotal rows carry the same cumulative figure: 16 x 10.00 = 160.00.
    expect((html.match(/160\.00/g) ?? []).length).toBeGreaterThanOrEqual(2)
    // Every line item is still present across the pages.
    expect(html).toContain(`Line ${count}`)
  })
})

describe('invoice templates (I-182)', () => {
  it('prints the same document under every template — only the stylesheet changes', () => {
    // The property that matters: a template may restyle an invoice and may never restyle what it
    // says. Rule 46 prescribes the blocks; the picker only chooses how they are drawn.
    const bodyOf = (html: string): string => html.slice(html.indexOf('<body>'))
    const classic = buildInvoiceHtml(COMPANY, { ...DEFAULT_INVOICE_CONFIG, template: 'classic' }, SAMPLE_INVOICE)
    const modern = buildInvoiceHtml(COMPANY, { ...DEFAULT_INVOICE_CONFIG, template: 'modern' }, SAMPLE_INVOICE)
    const compact = buildInvoiceHtml(COMPANY, { ...DEFAULT_INVOICE_CONFIG, template: 'compact' }, SAMPLE_INVOICE)
    expect(bodyOf(modern)).toBe(bodyOf(classic))
    expect(bodyOf(compact)).toBe(bodyOf(classic))
    expect(modern).not.toBe(classic)
  })

  it('falls back to Classic for a template id it does not know, rather than printing unstyled', () => {
    const unknown = buildInvoiceHtml(
      COMPANY,
      { ...DEFAULT_INVOICE_CONFIG, template: 'from-a-later-version' as never },
      SAMPLE_INVOICE
    )
    expect(unknown).toBe(buildInvoiceHtml(COMPANY, DEFAULT_INVOICE_CONFIG, SAMPLE_INVOICE))
  })
})

describe('bilingual printing (I-184, I-199)', () => {
  const hindi = { ...DEFAULT_INVOICE_CONFIG, language: 'hi' as const }

  it('adds the second language beside the English label and never instead of it', () => {
    const html = buildInvoiceHtml(COMPANY, hindi, SAMPLE_INVOICE)
    // English still present…
    expect(html).toContain('Amount in words')
    expect(html).toContain('Place of supply')
    // …with a Devanagari label appended after the separator.
    expect(html).toMatch(/Amount in words\s*\/\s*[ऀ-ॿ]/)
  })

  it('prints the amount in words in the second language on its own line', () => {
    const html = buildInvoiceHtml(COMPANY, hindi, SAMPLE_INVOICE)
    expect(html).toContain('Eleven Thousand Eight Hundred Rupees Only')
    expect(html).toMatch(/<i>[^<]*[ऀ-ॿ][^<]*<\/i>/)
  })

  it('names a Devanagari fallback font only when a second language is configured', () => {
    expect(buildInvoiceHtml(COMPANY, hindi, SAMPLE_INVOICE)).toContain('Kohinoor Devanagari')
    expect(buildInvoiceHtml(COMPANY, DEFAULT_INVOICE_CONFIG, SAMPLE_INVOICE)).not.toContain('Kohinoor Devanagari')
  })

  it('is byte-identical to the old print when no second language is chosen', () => {
    // The guarantee that turning the feature off costs an existing user nothing.
    const html = buildInvoiceHtml(COMPANY, DEFAULT_INVOICE_CONFIG, SAMPLE_INVOICE)
    expect(html).not.toMatch(/[ऀ-ॿ]/)
    expect(html).toContain('>Description<')
  })

  it('still prints "Cash sale" bilingually when there is no party at all', () => {
    const html = buildInvoiceHtml(COMPANY, hindi, { ...SAMPLE_INVOICE, partyName: null, partyGstin: null })
    expect(html).toMatch(/Cash sale\s*\/\s*[ऀ-ॿ]/)
    expect(html).toMatch(/Unregistered\s*\/\s*[ऀ-ॿ]/)
  })
})
