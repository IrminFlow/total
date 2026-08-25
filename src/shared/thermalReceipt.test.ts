import { describe, it, expect } from 'vitest'
import {
  buildThermalReceiptHtml,
  estimateThermalHeightMm,
  type ThermalCompany,
  type ThermalOptions,
  type ThermalReceipt
} from './thermalReceipt'

const COMPANY: ThermalCompany = {
  name: 'Counter Traders',
  address: '12 Market Road, Pune',
  gstin: '27AAAAA0000A1Z5',
  phone: '020 1234 5678'
}

const OPTS: ThermalOptions = { widthMm: 80, showTax: true, language: 'none' }

function receipt(over: Partial<ThermalReceipt> = {}): ThermalReceipt {
  return {
    number: 'CTR/1',
    date: '2026-04-01',
    partyName: null,
    partyGstin: null,
    items: [
      { name: 'Sugar 1kg', qtyMilli: 2000, uqc: 'KGS', unitPricePaise: 5000, amountPaise: 10000, ratePercent: 5 }
    ],
    taxablePaise: 10000,
    cgstPaise: 250,
    sgstPaise: 250,
    igstPaise: 0,
    cessPaise: 0,
    roundOffPaise: 0,
    totalPaise: 10500,
    ...over
  }
}

describe('buildThermalReceiptHtml (I-183 — the 3-inch counter receipt)', () => {
  it('carries the rule 46 essentials: shop name, GSTIN, number, date, description and total', () => {
    const html = buildThermalReceiptHtml(COMPANY, receipt(), OPTS)
    expect(html).toContain('Counter Traders')
    expect(html).toContain('27AAAAA0000A1Z5')
    expect(html).toContain('CTR/1')
    expect(html).toContain('01-Apr-26')
    expect(html).toContain('Sugar 1kg')
    expect(html).toContain('105.00')
  })

  it('prints the CGST/SGST split for an intra-state sale and no IGST line', () => {
    const html = buildThermalReceiptHtml(COMPANY, receipt(), OPTS)
    expect(html).toContain('CGST')
    expect(html).toContain('SGST')
    expect(html).not.toContain('>IGST<')
  })

  it('prints IGST alone for an inter-state sale', () => {
    const html = buildThermalReceiptHtml(
      COMPANY,
      receipt({ cgstPaise: 0, sgstPaise: 0, igstPaise: 500 }),
      OPTS
    )
    expect(html).toContain('IGST')
    expect(html).not.toContain('>CGST<')
  })

  it('shows no tax block at all for a wholly exempt sale, rather than an empty one', () => {
    const html = buildThermalReceiptHtml(
      COMPANY,
      receipt({ cgstPaise: 0, sgstPaise: 0, totalPaise: 10000, items: [{ ...receipt().items[0]!, ratePercent: 0 }] }),
      OPTS
    )
    expect(html).not.toContain('CGST')
    expect(html).not.toContain('Taxable')
  })

  it('says outright that a receipt with the tax split suppressed is not a tax invoice', () => {
    const html = buildThermalReceiptHtml(COMPANY, receipt(), { ...OPTS, showTax: false })
    expect(html).toContain('Not a tax invoice')
  })

  it('does not print that warning for an unregistered shop, which has no tax to show', () => {
    const html = buildThermalReceiptHtml(
      { ...COMPANY, gstin: null },
      receipt({ cgstPaise: 0, sgstPaise: 0, totalPaise: 10000 }),
      { ...OPTS, showTax: false }
    )
    expect(html).not.toContain('Not a tax invoice')
  })

  it('omits the customer block entirely for a walk-in rather than printing "Cash sale"', () => {
    const html = buildThermalReceiptHtml(COMPANY, receipt(), OPTS)
    expect(html).not.toContain('Billed to')
  })

  it('prints the customer and their GSTIN when the sale is to a named registered buyer', () => {
    const html = buildThermalReceiptHtml(
      COMPANY,
      receipt({ partyName: 'Ravi Stores', partyGstin: '27BBBBB1111B1Z5' }),
      OPTS
    )
    expect(html).toContain('Ravi Stores')
    expect(html).toContain('27BBBBB1111B1Z5')
  })

  it('prints a round-off line only when there is one', () => {
    expect(buildThermalReceiptHtml(COMPANY, receipt(), OPTS)).not.toContain('Round off')
    expect(
      buildThermalReceiptHtml(COMPANY, receipt({ roundOffPaise: -50, totalPaise: 10450 }), OPTS)
    ).toContain('Round off')
  })

  it('drops trailing zeros from a whole quantity but keeps a real fraction', () => {
    const html = buildThermalReceiptHtml(COMPANY, receipt(), OPTS)
    expect(html).toContain('2 KGS')
    const frac = buildThermalReceiptHtml(
      COMPANY,
      receipt({ items: [{ ...receipt().items[0]!, qtyMilli: 1500 }] }),
      OPTS
    )
    expect(frac).toContain('1.5 KGS')
  })

  it('sizes the body to the roll, less the non-printing margin', () => {
    expect(buildThermalReceiptHtml(COMPANY, receipt(), OPTS)).toContain('width: 72mm')
    expect(buildThermalReceiptHtml(COMPANY, receipt(), { ...OPTS, widthMm: 58 })).toContain('width: 50mm')
  })

  it('escapes HTML in an item name, so a shop selling "M&S <special>" cannot break the receipt', () => {
    const html = buildThermalReceiptHtml(
      COMPANY,
      receipt({ items: [{ ...receipt().items[0]!, name: 'M&S <special>' }] }),
      OPTS
    )
    expect(html).toContain('M&amp;S &lt;special&gt;')
  })

  it('prints the second language beside the English labels when one is configured', () => {
    const html = buildThermalReceiptHtml(COMPANY, receipt(), { ...OPTS, language: 'hi' })
    expect(html).toMatch(/Total\s*\/\s*\S/)
  })

  it('renders a receipt with no items at all without throwing', () => {
    const html = buildThermalReceiptHtml(
      COMPANY,
      receipt({ items: [], taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, totalPaise: 0 }),
      OPTS
    )
    expect(html).toContain('Total')
  })

  it('includes the UPI QR only when one is supplied', () => {
    expect(buildThermalReceiptHtml(COMPANY, receipt(), OPTS)).not.toContain('Scan to pay')
    const withQr = buildThermalReceiptHtml(COMPANY, receipt(), {
      ...OPTS,
      upiQrSvg: '<svg id="qr"></svg>',
      upiVpa: 'shop@upi'
    })
    expect(withQr).toContain('Scan to pay')
    expect(withQr).toContain('shop@upi')
  })
})

describe('estimateThermalHeightMm', () => {
  it('grows with the number of items, because a roll has no page to overflow onto', () => {
    const one = estimateThermalHeightMm(receipt(), OPTS)
    const many = estimateThermalHeightMm(
      receipt({ items: Array.from({ length: 20 }, () => receipt().items[0]!) }),
      OPTS
    )
    expect(many).toBeGreaterThan(one)
  })

  it('leaves room for the QR when there is one', () => {
    expect(
      estimateThermalHeightMm(receipt(), { ...OPTS, upiQrSvg: '<svg/>' })
    ).toBeGreaterThan(estimateThermalHeightMm(receipt(), OPTS))
  })
})
