import { describe, it, expect } from 'vitest'
import {
  INVOICE_LABELS,
  INVOICE_LANGUAGES,
  bilingualLabel,
  type InvoiceLabelKeys,
  type InvoiceLanguage
} from './invoiceLabels'

/** The full key list, written out rather than derived, so deleting a key fails a test. */
const KEYS: (keyof InvoiceLabelKeys)[] = [
  'taxInvoice', 'billOfSupply', 'proformaInvoice', 'deliveryChallan', 'billedTo', 'invoiceNo',
  'date', 'placeOfSupply', 'description', 'hsn', 'qty', 'rate', 'discount', 'gst', 'amount',
  'taxableValue', 'valueOfSupply', 'cgst', 'sgst', 'igst', 'cess', 'roundOff', 'total',
  'amountInWords', 'declaration', 'bankDetails', 'terms', 'receiversSignature',
  'authorisedSignatory', 'for', 'broughtForward', 'carriedForward', 'subtotal', 'scanToPay',
  'vehicle', 'gstin', 'unregistered', 'verificationQr', 'hsnSummary', 'barcode', 'page', 'of',
  'cashSale', 'otherDetails'
]

const PACKS = ['hi', 'mr'] as const

describe('INVOICE_LABELS', () => {
  it('defines every label key in every language, with no missing or empty string', () => {
    for (const lang of PACKS) {
      for (const key of KEYS) {
        const value = INVOICE_LABELS[lang][key]
        expect(value, `${lang}.${key}`).toBeTypeOf('string')
        expect(value.trim(), `${lang}.${key}`).not.toBe('')
      }
    }
  })

  it('carries no key beyond the declared interface, so a stray label cannot be printed', () => {
    for (const lang of PACKS) {
      expect(Object.keys(INVOICE_LABELS[lang]).sort()).toEqual([...KEYS].sort())
    }
  })

  it('writes every translation in Devanagari or ASCII digits, never in Latin letters', () => {
    // A Latin word in a pack means an untranslated placeholder shipped, which on paper reads as
    // the English label printed twice.
    for (const lang of PACKS) {
      for (const key of KEYS) {
        expect(INVOICE_LABELS[lang][key], `${lang}.${key}`).not.toMatch(/[A-Za-z]/)
      }
    }
  })

  it('uses the settled GST vocabulary for the terms officers look for', () => {
    expect(INVOICE_LABELS.hi.taxInvoice).toBe('कर बीजक')
    expect(INVOICE_LABELS.hi.gstin).toBe('जीएसटीआईएन')
    expect(INVOICE_LABELS.hi.amountInWords).toBe('शब्दों में राशि')
    expect(INVOICE_LABELS.mr.taxInvoice).toBe('कर बीजक')
    expect(INVOICE_LABELS.mr.amountInWords).toBe('अक्षरी रक्कम')
  })
})

describe('bilingualLabel', () => {
  it("returns the English label untouched when the language is 'none'", () => {
    expect(bilingualLabel('taxInvoice', 'none', 'TAX INVOICE')).toBe('TAX INVOICE')
    expect(bilingualLabel('total', 'none', 'Total')).toBe('Total')
  })

  it('appends the translation after the English label, never replacing it', () => {
    const out = bilingualLabel('total', 'hi', 'Total')
    expect(out.startsWith('Total')).toBe(true)
    expect(out).toBe('Total / कुल')
  })

  it('uses one separator for every language, so a print never mixes styles', () => {
    for (const lang of PACKS) {
      expect(bilingualLabel('date', lang, 'Date')).toBe(`Date / ${INVOICE_LABELS[lang].date}`)
    }
  })

  it('passes the caller\'s English through verbatim, since several labels are user-configured', () => {
    // The invoice title and signatory come from InvoiceConfig, not from a fixed English table.
    expect(bilingualLabel('taxInvoice', 'mr', 'ACME TAX INVOICE')).toBe('ACME TAX INVOICE / कर बीजक')
  })

  it('falls back to English alone rather than leaving a dangling separator', () => {
    const unknown = 'zz' as unknown as InvoiceLanguage
    expect(bilingualLabel('total', unknown, 'Total')).toBe('Total')
    const missingKey = 'notALabel' as unknown as keyof InvoiceLabelKeys
    expect(bilingualLabel(missingKey, 'hi', 'Total')).toBe('Total')
  })
})

describe('INVOICE_LANGUAGES', () => {
  it("offers 'none' first, labelled as English only", () => {
    expect(INVOICE_LANGUAGES[0]).toEqual({ id: 'none', label: 'English only' })
  })

  it('lists exactly the languages the type allows, each with a label pack where one is expected', () => {
    expect(INVOICE_LANGUAGES.map((l) => l.id)).toEqual(['none', 'hi', 'mr'])
    for (const opt of INVOICE_LANGUAGES) {
      expect(opt.label.trim()).not.toBe('')
      if (opt.id !== 'none') expect(INVOICE_LABELS[opt.id]).toBeDefined()
    }
  })
})
