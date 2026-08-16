import { describe, it, expect } from 'vitest'
import { buildInvoiceHtml, SAMPLE_INVOICE } from './invoice'
import { DEFAULT_INVOICE_CONFIG } from '@shared/invoiceConfig'
import type { CompanyInfo } from '@shared/domain'

const COMPANY: CompanyInfo = {
  name: 'Total Traders',
  stateCode: '27',
  gstin: '27AAAAA0000A1Z5',
  gstRegistrationType: 'regular',
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
