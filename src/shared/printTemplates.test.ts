import { describe, expect, it } from 'vitest'
import { DEFAULT_INVOICE_CONFIG, type InvoiceConfig } from './invoiceConfig'
import {
  applyLegacyConfig,
  BUILT_IN_DEFAULTS,
  CLASSIC_DEFAULT,
  exportTemplateJson,
  legacyConfigToTemplate,
  normaliseColumns,
  parseStore,
  parseTemplateImport,
  pdfOptionsFor,
  PRINT_COLUMN_KEYS,
  PRINT_DOC_KINDS,
  printTemplateSchema,
  templateToLegacyConfig
} from './printTemplates'

const CUSTOM: InvoiceConfig = {
  title: 'INVOICE',
  logoDataUrl: 'data:image/png;base64,aGVsbG8=',
  declaration: 'Custom declaration',
  bankDetails: { name: 'Total Bank', account: '1234567890', ifsc: 'TOTL0000001', branch: 'Main' },
  signatory: 'Director',
  terms: 'Payment due in 30 days',
  showHsn: false,
  showDiscount: true,
  copyLabels: ['Original for Recipient', 'Duplicate for Transporter'],
  showQr: false,
  showItemBarcode: true,
  showEnteredBy: true
}

describe('print template model', () => {
  it('every built-in validates, is builtIn, and lists every column key exactly once', () => {
    for (const t of Object.values(BUILT_IN_DEFAULTS)) {
      expect(printTemplateSchema.parse(t)).toEqual(t)
      expect(t.builtIn).toBe(true)
      expect(t.columns.map((c) => c.key).sort()).toEqual([...PRINT_COLUMN_KEYS].sort())
    }
  })

  it('fills every missing field with defaults (older stored templates keep parsing)', () => {
    const t = printTemplateSchema.parse({ id: 'mine', name: 'Mine' })
    expect(t.page.size).toBe('A4')
    expect(t.header.titles.sales).toBe('TAX INVOICE')
    expect(t.header.titles.quotation).toBe('QUOTATION')
    expect(t.columns).toHaveLength(PRINT_COLUMN_KEYS.length)
    expect(t.typography.accent).toBe('#16181f')
  })

  it('rejects bad accents, ids, empty kinds, out-of-range sizes and oversize logos', () => {
    const ok = { id: 'x', name: 'X' }
    expect(() => printTemplateSchema.parse({ ...ok, typography: { accent: 'red' } })).toThrow(/hex/)
    expect(() => printTemplateSchema.parse({ ...ok, typography: { accent: '#12345' } })).toThrow()
    expect(() => printTemplateSchema.parse({ ...ok, id: 'Has Spaces' })).toThrow()
    expect(() => printTemplateSchema.parse({ ...ok, kinds: [] })).toThrow()
    expect(() => printTemplateSchema.parse({ ...ok, kinds: ['invoice?'] })).toThrow()
    expect(() => printTemplateSchema.parse({ ...ok, typography: { baseFontPx: 30 } })).toThrow()
    expect(() => printTemplateSchema.parse({ ...ok, page: { marginsMm: { top: 80 } } })).toThrow()
    expect(() => printTemplateSchema.parse({ ...ok, header: { logoDataUrl: 'data:image/png;base64,' + 'A'.repeat(300_000) } })).toThrow()
    expect(() => printTemplateSchema.parse({ ...ok, header: { logoDataUrl: 'data:image/png;base64,aGk="><script>' } })).toThrow()
    expect(() => printTemplateSchema.parse({ ...ok, header: { copyLabels: [] } })).toThrow()
  })

  it('normaliseColumns drops duplicates and appends missing keys hidden', () => {
    const cols = normaliseColumns([
      { key: 'qty', label: 'Q', width: 50, visible: true },
      { key: 'qty', label: 'dup', width: 50, visible: true }
    ])
    expect(cols[0]).toEqual({ key: 'qty', label: 'Q', width: 50, visible: true })
    expect(cols).toHaveLength(PRINT_COLUMN_KEYS.length)
    expect(cols.filter((c) => c.visible)).toHaveLength(1)
  })

  it('pdfOptionsFor maps page settings onto the PDF engine options', () => {
    const t = printTemplateSchema.parse({ id: 'x', name: 'X', page: { size: 'A5', orientation: 'landscape', marginsMm: { top: 5 }, pageNumbers: false } })
    expect(pdfOptionsFor(t)).toEqual({ pageSize: 'A5', landscape: true, marginsMm: { top: 5, right: 10, bottom: 10, left: 10 }, pageNumbers: false })
  })
})

describe('legacy invoiceConfig ⇄ Classic template (lossless)', () => {
  it('round-trips the defaults and a fully customised config', () => {
    expect(templateToLegacyConfig(legacyConfigToTemplate(DEFAULT_INVOICE_CONFIG))).toEqual(DEFAULT_INVOICE_CONFIG)
    expect(templateToLegacyConfig(legacyConfigToTemplate(CUSTOM))).toEqual(CUSTOM)
  })

  it('the default config IS the Classic built-in', () => {
    expect(legacyConfigToTemplate(DEFAULT_INVOICE_CONFIG)).toEqual(CLASSIC_DEFAULT)
    expect(CLASSIC_DEFAULT.kinds).toEqual([...PRINT_DOC_KINDS])
  })

  it('applyLegacyConfig (old config:invoice:set) keeps template-only settings', () => {
    const tuned = printTemplateSchema.parse({
      ...CLASSIC_DEFAULT,
      typography: { ...CLASSIC_DEFAULT.typography, accent: '#003366' },
      party: { ...CLASSIC_DEFAULT.party, showShipTo: true },
      header: { ...CLASSIC_DEFAULT.header, titles: { ...CLASSIC_DEFAULT.header.titles, receipt: 'MONEY RECEIPT' } }
    })
    const next = applyLegacyConfig(tuned, CUSTOM)
    expect(templateToLegacyConfig(next)).toEqual(CUSTOM)
    expect(next.typography.accent).toBe('#003366')
    expect(next.party.showShipTo).toBe(true)
    expect(next.header.titles.receipt).toBe('MONEY RECEIPT')
    expect(next.totals.taxSummary).toBe('none') // showHsn false → HSN summary off, as before
  })
})

describe('store + import/export', () => {
  it('parseStore tolerates garbage and drops invalid templates / unknown kinds', () => {
    expect(parseStore(null)).toEqual({ version: 1, templates: [], defaults: {} })
    const s = parseStore({ templates: [{ id: 'ok', name: 'OK' }, { id: 'BAD ID' }], defaults: { sales: 'ok', bogus: 'x' } })
    expect(s.templates.map((t) => t.id)).toEqual(['ok'])
    expect(s.defaults).toEqual({ sales: 'ok' })
  })

  it('export → import round-trips; a bare template object imports too; junk is rejected', () => {
    const t = BUILT_IN_DEFAULTS.modern
    expect(parseTemplateImport(exportTemplateJson(t))).toEqual(t)
    expect(parseTemplateImport(JSON.stringify(t))).toEqual(t)
    expect(() => parseTemplateImport('not json')).toThrow(/JSON/)
    expect(() => parseTemplateImport('{"format":"total-print-template","version":1,"template":{"id":"x"}}')).toThrow(/name/)
  })
})
