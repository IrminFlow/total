// Roadmap I-183 (thermal receipt) and I-193/I-192 (WhatsApp and email share).
//
// The HTML builders themselves are pure and tested in src/shared; what needs a database is the
// part that turns a voucher into one: the same extracted e-doc invoice feeds the A4 print, the
// roll and the GSTR-1 export, so the paper and the return can never disagree about what was sold.
import { describe, it, expect } from 'vitest'
import { seededDb, TEST_INFO } from '../db/testdb'
import { createLedger, createStockItem } from './masters'
import { saveVoucher } from './vouchers'
import { setInvoiceConfig } from './config'
import { thermalReceiptHtml, invoiceShareDetails } from './invoice'
import type { CompanyInfo } from '@shared/domain'
import { DEFAULT_INVOICE_CONFIG } from '@shared/invoiceConfig'

type DB = ReturnType<typeof seededDb>
// A REGISTERED company: the receipt's "not a tax invoice" warning only makes sense for one, and
// a composition/unregistered shop has no tax split to suppress in the first place.
const INFO: CompanyInfo = { ...TEST_INFO, gstin: '27AAAAA0000A1Z5' }

function debtor(db: DB, over: { phone?: string | null; email?: string | null } = {}): number {
  const group = db.prepare("SELECT id FROM groups WHERE name = 'Sundry Debtors'").get() as { id: number }
  const id = createLedger(db, {
    name: 'Roll Buyer', groupId: group.id, openingBalance: 0, gstin: null, stateCode: '27',
    address: '9 Market Road', taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null,
    creditDays: null, exportType: null
  }).id
  if ('phone' in over || 'email' in over) {
    db.prepare('UPDATE ledgers SET phone = ?, email = ? WHERE id = ?').run(
      over.phone ?? null,
      over.email ?? null,
      id
    )
  }
  return id
}

function salesLedger(db: DB): number {
  const existing = db.prepare("SELECT id FROM ledgers WHERE name = 'Sales Account'").get() as { id: number } | undefined
  if (existing) return existing.id
  const group = db.prepare("SELECT id FROM groups WHERE name = 'Sales Accounts'").get() as { id: number }
  return createLedger(db, {
    name: 'Sales Account', groupId: group.id, openingBalance: 0, gstin: null, stateCode: null, address: null,
    taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
  }).id
}

function taxLedger(db: DB, taxType: 'cgst' | 'sgst'): number {
  const existing = db.prepare('SELECT id FROM ledgers WHERE tax_type = ?').get(taxType) as { id: number } | undefined
  if (existing) return existing.id
  const group = db.prepare("SELECT id FROM groups WHERE name = 'Duties & Taxes'").get() as { id: number }
  return createLedger(db, {
    name: taxType.toUpperCase(), groupId: group.id, openingBalance: 0, gstin: null, stateCode: null,
    address: null, taxType, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null,
    exportType: null
  }).id
}

function widget(db: DB): number {
  const unit = db.prepare('SELECT id FROM units ORDER BY id LIMIT 1').get() as { id: number }
  return createStockItem(db, {
    name: 'Widget', groupId: null, unitId: unit.id, hsn: '8471', gstRate: 18, cessRate: null,
    openingQtyMilli: 0, openingValue: 0, barcode: null, reorderLevelMilli: null
  }).id
}

/** One intra-state sale of a single widget: 1 x ₹500 + 18% = ₹590. */
function sale(db: DB, partyId: number, number = 'SV-R1'): number {
  const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'sales'").get() as { id: number }
  const cgst = { id: taxLedger(db, 'cgst') }
  const sgst = { id: taxLedger(db, 'sgst') }
  return saveVoucher(db, {
    voucherTypeId: vt.id, date: '2026-04-01', number, partyLedgerId: partyId,
    narration: null, reference: null, instrumentNo: null, instrumentDate: null, transporterId: null,
    vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
    lines: [
      { ledgerId: partyId, drCr: 'dr', amount: 59000, costAllocations: [] },
      { ledgerId: salesLedger(db), drCr: 'cr', amount: 50000, costAllocations: [] },
      { ledgerId: cgst.id, drCr: 'cr', amount: 4500, costAllocations: [] },
      { ledgerId: sgst.id, drCr: 'cr', amount: 4500, costAllocations: [] }
    ],
    inventory: [
      { stockItemId: widget(db), godownId: null, qtyMilli: 1000, ratePaise: 50000, amount: 50000, direction: 'out' }
    ],
    billRefs: [], tds: null
  }).id
}

describe('thermalReceiptHtml (I-183)', () => {
  it('prints the same figures the A4 invoice and the GSTR-1 export are built from', () => {
    const db = seededDb()
    const voucherId = sale(db, debtor(db))
    const { html, number, widthMm } = thermalReceiptHtml(db, INFO, voucherId)
    expect(number).toBe('SV-R1')
    expect(widthMm).toBe(80)
    expect(html).toContain('590.00')
    expect(html).toContain('CGST')
    expect(html).toContain('Widget')
  })

  it('follows the configured roll width and tax setting', () => {
    const db = seededDb()
    const voucherId = sale(db, debtor(db))
    setInvoiceConfig(db, { ...DEFAULT_INVOICE_CONFIG, thermalWidthMm: 58, thermalShowTax: false })
    const { html, widthMm } = thermalReceiptHtml(db, INFO, voucherId)
    expect(widthMm).toBe(58)
    expect(html).toContain('width: 50mm')
    // A receipt with the split suppressed has to say it is not a tax invoice.
    expect(html).toContain('Not a tax invoice')
  })

  it('refuses a voucher that is not a sales invoice rather than printing a blank roll', () => {
    const db = seededDb()
    expect(() => thermalReceiptHtml(db, INFO, 999_999)).toThrow(/not found/i)
  })

  it('prints a UPI payment QR when a VPA is configured, and none when it is not', () => {
    const db = seededDb()
    const voucherId = sale(db, debtor(db))
    expect(thermalReceiptHtml(db, INFO, voucherId).html).not.toContain('Scan to pay')
    setInvoiceConfig(db, { ...DEFAULT_INVOICE_CONFIG, upiVpa: 'shop@ybl' })
    expect(thermalReceiptHtml(db, INFO, voucherId).html).toContain('Scan to pay')
  })
})

describe('invoiceShareDetails (I-193, I-192)', () => {
  it('takes the phone and email off the ledger, which the e-doc does not carry', () => {
    const db = seededDb()
    const partyId = debtor(db, { phone: '98765 43210', email: 'ravi@example.com' })
    const voucherId = sale(db, partyId)
    const share = invoiceShareDetails(db, INFO, voucherId, 'invoice-SV-R1.pdf')
    expect(share.whatsapp).toContain('919876543210')
    expect(share.mailto).toContain('mailto:ravi@example.com')
    expect(share.body).toContain('SV-R1')
    expect(share.body).toContain('590.00')
  })

  it('hands back a null WhatsApp link for a party with no number, so the UI can say why', () => {
    const db = seededDb()
    const voucherId = sale(db, debtor(db, { phone: null, email: 'x@y.z' }))
    const share = invoiceShareDetails(db, INFO, voucherId, 'invoice-SV-R1.pdf')
    expect(share.whatsapp).toBeNull()
    // The email draft still opens — one missing channel must not disable the other.
    expect(share.mailto).toContain('mailto:x@y.z')
  })

  it('names the PDF in the hint, because neither channel can attach one for us', () => {
    // The PDF itself is written by invoiceShareLinks, which needs an Electron BrowserWindow and
    // therefore cannot run here — the split exists so the message and the links stay testable.
    const db = seededDb()
    const voucherId = sale(db, debtor(db, { phone: '9876543210' }))
    const share = invoiceShareDetails(db, INFO, voucherId, 'invoice-SV-R1.pdf')
    expect(share.attachmentHint).toContain('invoice-SV-R1.pdf')
    expect(share.attachmentHint).toContain('paste')
  })
})
