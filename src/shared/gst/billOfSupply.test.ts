import { describe, expect, it } from 'vitest'
import {
  COMPOSITION_DECLARATION,
  EXPORT_WITHOUT_TAX_ENDORSEMENT,
  EXPORT_WITHOUT_TAX_ENDORSEMENT_WOP,
  REVERSE_CHARGE_ENDORSEMENT,
  showsTax,
  supplyDocumentKind,
  supplyDocumentTitle,
  supplyEndorsements
} from './billOfSupply'

const taxed = { gstRegistrationType: 'regular' as const, taxPaise: 18000 }
const untaxed = { gstRegistrationType: 'regular' as const, taxPaise: 0 }

describe('supplyDocumentKind', () => {
  it('is a tax invoice when tax is charged', () => {
    expect(supplyDocumentKind(taxed)).toBe('tax-invoice')
  })

  it('is a bill of supply when a regular dealer charges no tax — an exempt supply', () => {
    expect(supplyDocumentKind(untaxed)).toBe('bill-of-supply')
  })

  it('is always a bill of supply for a composition dealer, tax on the document or not', () => {
    // The dealer may not collect tax at all, so nothing on the document can make it an invoice.
    expect(supplyDocumentKind({ gstRegistrationType: 'composition', taxPaise: 0 })).toBe('bill-of-supply')
    expect(supplyDocumentKind({ gstRegistrationType: 'composition', taxPaise: 18000 })).toBe('bill-of-supply')
    expect(supplyDocumentKind({ gstRegistrationType: 'composition', taxPaise: 0, supTyp: 'EXPWOP' })).toBe(
      'bill-of-supply'
    )
  })

  it('is a plain invoice for an unregistered business, which may issue neither GST form', () => {
    expect(supplyDocumentKind({ gstRegistrationType: 'unregistered', taxPaise: 0 })).toBe('invoice')
  })

  it('stays a tax invoice for exports and SEZ supplies without payment of tax', () => {
    // Zero-rated is not exempt: the tax exists at 0%, and the document is still a tax invoice.
    for (const supTyp of ['EXPWOP', 'SEZWOP', 'EXPWP', 'SEZWP'] as const) {
      expect(supplyDocumentKind({ ...untaxed, supTyp })).toBe('tax-invoice')
    }
  })

  it('stays a tax invoice when the recipient pays under reverse charge', () => {
    expect(supplyDocumentKind({ ...untaxed, reverseCharge: true })).toBe('tax-invoice')
  })

  it('reads the whole document, not one line: a taxed invoice with a free line stays an invoice', () => {
    // The test is the document total, so a zero-value or fully-discounted line cannot flip it.
    expect(supplyDocumentKind({ ...taxed, taxPaise: 1 })).toBe('tax-invoice')
  })
})

describe('supplyDocumentTitle', () => {
  it('lets a tax invoice keep the company’s configured heading', () => {
    expect(supplyDocumentTitle('tax-invoice', 'TAX INVOICE')).toBe('TAX INVOICE')
    expect(supplyDocumentTitle('tax-invoice', 'GST INVOICE / चालान')).toBe('GST INVOICE / चालान')
  })

  it('fixes the statutory headings, which are not the company’s to choose', () => {
    expect(supplyDocumentTitle('bill-of-supply', 'TAX INVOICE')).toBe('BILL OF SUPPLY')
    expect(supplyDocumentTitle('invoice', 'TAX INVOICE')).toBe('INVOICE')
  })
})

describe('showsTax', () => {
  it('permits tax only on a tax invoice', () => {
    expect(showsTax('tax-invoice')).toBe(true)
    // A nil tax column on a bill of supply still reads as tax collected.
    expect(showsTax('bill-of-supply')).toBe(false)
    expect(showsTax('invoice')).toBe(false)
  })
})

describe('supplyEndorsements', () => {
  it('says nothing on an ordinary tax invoice', () => {
    expect(supplyEndorsements(taxed)).toEqual([])
  })

  it('carries rule 5(1)(f) verbatim for a composition dealer', () => {
    expect(supplyEndorsements({ gstRegistrationType: 'composition', taxPaise: 0 })).toEqual([
      COMPOSITION_DECLARATION
    ])
  })

  it('distinguishes an export with payment of tax from one without', () => {
    expect(supplyEndorsements({ ...untaxed, supTyp: 'EXPWOP' })).toEqual([EXPORT_WITHOUT_TAX_ENDORSEMENT_WOP])
    expect(supplyEndorsements({ ...taxed, supTyp: 'EXPWP' })).toEqual([EXPORT_WITHOUT_TAX_ENDORSEMENT])
  })

  it('names reverse charge, which is the buyer’s cue that they owe the tax', () => {
    expect(supplyEndorsements({ ...untaxed, reverseCharge: true })).toEqual([REVERSE_CHARGE_ENDORSEMENT])
  })

  it('stacks them in print order when more than one applies', () => {
    expect(supplyEndorsements({ ...untaxed, supTyp: 'SEZWOP', reverseCharge: true })).toEqual([
      EXPORT_WITHOUT_TAX_ENDORSEMENT_WOP,
      REVERSE_CHARGE_ENDORSEMENT
    ])
  })
})
