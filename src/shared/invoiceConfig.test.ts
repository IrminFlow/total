import { describe, it, expect } from 'vitest'
import { DEFAULT_INVOICE_CONFIG, invoiceConfigSchema, mergeInvoiceConfig } from './invoiceConfig'

describe('invoiceConfigSchema / mergeInvoiceConfig', () => {
  it('defaults round-trip through the schema unchanged', () => {
    expect(invoiceConfigSchema.parse(DEFAULT_INVOICE_CONFIG)).toEqual(DEFAULT_INVOICE_CONFIG)
  })

  it('mergeInvoiceConfig(undefined) returns the defaults', () => {
    expect(mergeInvoiceConfig(undefined)).toEqual(DEFAULT_INVOICE_CONFIG)
    expect(mergeInvoiceConfig(null)).toEqual(DEFAULT_INVOICE_CONFIG)
    expect(mergeInvoiceConfig({})).toEqual(DEFAULT_INVOICE_CONFIG)
  })

  it('mergeInvoiceConfig fills in missing keys with defaults', () => {
    expect(mergeInvoiceConfig({ title: 'INVOICE' })).toEqual({ ...DEFAULT_INVOICE_CONFIG, title: 'INVOICE' })
  })

  it('accepts a full custom config with bank details and multiple copy labels', () => {
    const input = {
      title: 'INVOICE',
      logoDataUrl: 'data:image/png;base64,aGVsbG8=',
      declaration: 'Custom declaration text',
      bankDetails: { name: 'Total Bank', account: '1234567890', ifsc: 'TOTL0000001', branch: 'Main' },
      signatory: 'Director',
      terms: 'Payment due in 30 days',
      showHsn: false,
      showDiscount: true,
      copyLabels: ['Original for Recipient', 'Duplicate for Transporter', 'Triplicate for Supplier'],
      showQr: false,
      showItemBarcode: true,
      showEnteredBy: true
    }
    expect(invoiceConfigSchema.parse(input)).toEqual(input)
  })

  it('defaults showQr to true and showItemBarcode to false', () => {
    expect(DEFAULT_INVOICE_CONFIG.showQr).toBe(true)
    expect(DEFAULT_INVOICE_CONFIG.showItemBarcode).toBe(false)
  })

  it('rejects a logoDataUrl over ~200KB', () => {
    const oversized = 'data:image/png;base64,' + 'A'.repeat(300_000)
    expect(() => invoiceConfigSchema.parse({ ...DEFAULT_INVOICE_CONFIG, logoDataUrl: oversized })).toThrow()
    expect(mergeInvoiceConfig({ logoDataUrl: oversized })).toEqual(DEFAULT_INVOICE_CONFIG)
  })

  it('rejects a logoDataUrl that is not an image data URL', () => {
    expect(() =>
      invoiceConfigSchema.parse({ ...DEFAULT_INVOICE_CONFIG, logoDataUrl: 'not-a-data-url' })
    ).toThrow()
  })

  it('rejects a logoDataUrl carrying a quote (would break out of the src="…" attribute)', () => {
    expect(() =>
      invoiceConfigSchema.parse({
        ...DEFAULT_INVOICE_CONFIG,
        logoDataUrl: 'data:image/png;base64,aGVsbG8="><script>alert(1)</script>'
      })
    ).toThrow()
  })

  it('rejects an empty copyLabels array (at least one page must print)', () => {
    expect(() => invoiceConfigSchema.parse({ ...DEFAULT_INVOICE_CONFIG, copyLabels: [] })).toThrow()
  })

  it('rejects more than 3 copy labels', () => {
    expect(() =>
      invoiceConfigSchema.parse({ ...DEFAULT_INVOICE_CONFIG, copyLabels: ['A', 'B', 'C', 'D'] })
    ).toThrow()
  })
})
