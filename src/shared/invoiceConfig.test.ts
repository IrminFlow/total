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
      showEnteredBy: true,
      upiVpa: 'totaltraders@ybl',
      signatureDataUrl: 'data:image/png;base64,c2ln',
      termsByKind: { credit_note: 'Refund within 7 working days' },
      template: 'modern' as const,
      language: 'hi' as const,
      thermalWidthMm: 58 as const,
      thermalShowTax: false
    }
    expect(invoiceConfigSchema.parse(input)).toEqual(input)
  })

  it('defaults a config saved before templates existed to Classic, English and an 80mm roll', () => {
    // The upgrade must not restyle stationery that was already in use.
    const { template: _tpl, language: _l, thermalWidthMm: _w, thermalShowTax: _t, ...older } =
      DEFAULT_INVOICE_CONFIG
    const parsed = invoiceConfigSchema.parse(older)
    expect(parsed.template).toBe('classic')
    expect(parsed.language).toBe('none')
    expect(parsed.thermalWidthMm).toBe(80)
    expect(parsed.thermalShowTax).toBe(true)
  })

  it('defaults an older saved config to no signature and no per-kind terms', () => {
    const { signatureDataUrl: _s, termsByKind: _t, ...older } = DEFAULT_INVOICE_CONFIG
    const parsed = invoiceConfigSchema.parse(older)
    expect(parsed.signatureDataUrl).toBeNull()
    expect(parsed.termsByKind).toEqual({})
  })

  it('rejects a signature that is not an image data URL, or is too large', () => {
    expect(() =>
      invoiceConfigSchema.parse({ ...DEFAULT_INVOICE_CONFIG, signatureDataUrl: 'https://example.com/sig.png' })
    ).toThrow()
    expect(() =>
      invoiceConfigSchema.parse({
        ...DEFAULT_INVOICE_CONFIG,
        signatureDataUrl: 'data:image/png;base64,' + 'A'.repeat(300_000)
      })
    ).toThrow()
  })

  it('accepts a UPI address that looks like one and rejects one that does not', () => {
    // A typo in a VPA does not bounce — the money goes somewhere, or nowhere, and the sender's
    // app reports success either way. A shape check at entry is the only local check possible.
    expect(invoiceConfigSchema.parse({ ...DEFAULT_INVOICE_CONFIG, upiVpa: 'shop@ybl' }).upiVpa).toBe('shop@ybl')
    expect(() => invoiceConfigSchema.parse({ ...DEFAULT_INVOICE_CONFIG, upiVpa: 'not a vpa' })).toThrow()
  })

  it('reads a blank UPI address as none, so clearing the field turns the QR off', () => {
    expect(invoiceConfigSchema.parse({ ...DEFAULT_INVOICE_CONFIG, upiVpa: '' }).upiVpa).toBeNull()
    expect(invoiceConfigSchema.parse({ ...DEFAULT_INVOICE_CONFIG, upiVpa: null }).upiVpa).toBeNull()
  })

  it('defaults an older saved config to no UPI address rather than failing to parse', () => {
    const { upiVpa: _omitted, ...older } = DEFAULT_INVOICE_CONFIG
    expect(invoiceConfigSchema.parse(older).upiVpa).toBeNull()
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
