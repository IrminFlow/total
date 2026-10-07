// WP 1.10c — print templates: storage + defaults + the real print path, and the DB-level proof that
// a company's saved legacy invoice config renders through the Classic template exactly as the
// pre-1.10c renderer did (whitespace-normalised equal; see normaliseHtml).
import { beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { CompanyInfo, DrCr } from '@shared/domain'
import { DEFAULT_INVOICE_CONFIG, type InvoiceConfig } from '@shared/invoiceConfig'
import { PRINT_DOC_KINDS, printTemplateSchema } from '@shared/printTemplates'
import { legacyBuildInvoiceHtml } from '@shared/print/legacyInvoiceHtml.fixture'
import { normaliseHtml } from '@shared/print/render'
import { seededDb, TEST_INFO } from '../db/testdb'
import { ensureCompanyTree } from '../paths'
import { createLedger } from './masters'
import { saveVoucher } from './vouchers'
import { extractEdocInvoices } from './edocs'
import { getInvoiceConfig, setInvoiceConfig } from './config'
import { invoiceHtml, invoicePreviewHtml } from './invoice'
import * as pt from './printTemplates'

const INFO: CompanyInfo = { ...TEST_INFO, name: 'Print Co', gstin: '27AAPFU0939F1ZV', address: '12 MG Road, Pune 411001', phone: '020 1234', email: 'a@b.in', pan: 'AAPFU0939F' }
const SLUG = 'print-templates-test'

beforeAll(() => {
  process.env.TOTAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'total-print-test-'))
  ensureCompanyTree(SLUG)
})

function setup() {
  const db = seededDb()
  const groupId = (name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
  const vtId = (kind: string): number => (db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }).id
  const buyer = createLedger(db, { name: 'Buyer & Sons', groupId: groupId('Sundry Debtors'), gstin: '27AAPFU0939F1ZV', stateCode: '27', address: 'Shop 4, Mumbai 400001' }).id
  const sales = createLedger(db, { name: 'Sales 18', groupId: groupId('Sales Accounts'), gstRate: 18 }).id
  const cgstL = createLedger(db, { name: 'CGST', groupId: groupId('Duties & Taxes'), taxType: 'cgst' }).id
  const sgstL = createLedger(db, { name: 'SGST', groupId: groupId('Duties & Taxes'), taxType: 'sgst' }).id
  const bank = createLedger(db, { name: 'HDFC Bank', groupId: groupId('Bank Accounts') }).id
  const unitId = (db.prepare("SELECT id FROM units WHERE symbol = 'Pcs'").get() as { id: number }).id
  const itemId = Number(db.prepare("INSERT INTO stock_items (name, unit_id, hsn, gst_rate, barcode) VALUES ('Laptop', ?, '8471', 18, 'BC-1')").run(unitId).lastInsertRowid)
  const item2 = Number(db.prepare("INSERT INTO stock_items (name, unit_id, hsn, gst_rate) VALUES ('Mouse', ?, '8471', 18)").run(unitId).lastInsertRowid)

  const post = (
    kind: string, date: string, partyId: number | null,
    lines: { ledgerId: number; drCr: DrCr; amount: number }[],
    inventory: { stockItemId: number; qtyMilli: number; ratePaise: number; amount: number; discountPaise?: number; direction: 'in' | 'out' }[] = []
  ) =>
    saveVoucher(db, {
      voucherTypeId: vtId(kind), date, partyLedgerId: partyId, reference: null, narration: 'Printed in a test',
      lines: lines.map((l) => ({ ...l, costAllocations: [] })),
      inventory: inventory.map((l) => ({ ...l, godownId: null })),
      billRefs: [], tds: null
    })

  // 2 × ₹50,000 laptops less ₹1,000 discount + 1 mouse ₹1,000 → taxable ₹1,00,000, GST 18%.
  const inv = post('sales', '2026-07-05', buyer, [
    { ledgerId: buyer, drCr: 'dr', amount: 11800000 },
    { ledgerId: sales, drCr: 'cr', amount: 10000000 },
    { ledgerId: cgstL, drCr: 'cr', amount: 900000 },
    { ledgerId: sgstL, drCr: 'cr', amount: 900000 }
  ], [
    { stockItemId: itemId, qtyMilli: 2000, ratePaise: 5000000, discountPaise: 100000, amount: 9900000, direction: 'out' },
    { stockItemId: item2, qtyMilli: 1000, ratePaise: 100000, amount: 100000, direction: 'out' }
  ])
  const receipt = post('receipt', '2026-07-10', null, [
    { ledgerId: bank, drCr: 'dr', amount: 5000000 },
    { ledgerId: buyer, drCr: 'cr', amount: 5000000 }
  ])
  return { db, inv, receipt }
}

/** Today's (pre-1.10c) HTML for a voucher: the frozen renderer fed exactly what the old
 *  invoiceHtml fed it (extracted invoice + discounts + audit trail + saved legacy config). */
function legacyHtml(db: ReturnType<typeof seededDb>, voucherId: number, cfg: InvoiceConfig): string {
  const [inv] = extractEdocInvoices(db, INFO, '0000-01-01', '9999-12-31', voucherId)
  pt.attachDiscounts(db, voucherId, inv!.items)
  return legacyBuildInvoiceHtml(INFO, cfg, inv!, pt.auditTrailFor(db, voucherId))
}

describe('Classic migration is lossless on a real voucher (config → template → HTML)', () => {
  const variants: [string, InvoiceConfig][] = [
    ['never configured (defaults)', DEFAULT_INVOICE_CONFIG],
    ['customised', {
      ...DEFAULT_INVOICE_CONFIG, title: 'INVOICE', showDiscount: true, showItemBarcode: true, showEnteredBy: true,
      bankDetails: { name: 'HDFC', account: '0001', ifsc: 'HDFC0000001', branch: 'Pune' }, terms: 'Net 30',
      copyLabels: ['Original for Recipient', 'Duplicate for Transporter'], logoDataUrl: 'data:image/png;base64,aGVsbG8='
    }],
    ['HSN off, QR off', { ...DEFAULT_INVOICE_CONFIG, showHsn: false, showQr: false }]
  ]
  for (const [name, cfg] of variants) {
    it(name, () => {
      const s = setup()
      if (cfg !== DEFAULT_INVOICE_CONFIG) setInvoiceConfig(s.db, cfg)
      expect(normaliseHtml(invoiceHtml(s.db, INFO, s.inv.id).html)).toBe(normaliseHtml(legacyHtml(s.db, s.inv.id, cfg)))
      // …and the legacy preview channel still renders the same thing.
      expect(normaliseHtml(invoicePreviewHtml(s.db, INFO, s.inv.id).html)).toBe(normaliseHtml(legacyHtml(s.db, s.inv.id, cfg)))
    })
  }
})

describe('print templates service', () => {
  it('lists the three built-ins with Classic as every kind default', () => {
    const { db } = setup()
    const l = pt.listTemplates(db)
    expect(l.templates.map((t) => t.id)).toEqual(['classic', 'compact', 'modern'])
    expect(l.templates.every((t) => t.builtIn && !t.customised)).toBe(true)
    expect(Object.values(l.defaults)).toEqual(PRINT_DOC_KINDS.map(() => 'classic'))
  })

  it('duplicate → edit → set default → the real print uses it; delete falls back to Classic', () => {
    const s = setup()
    const copy = pt.duplicateTemplate(s.db, 'modern')
    expect(copy.builtIn).toBe(false)
    expect(copy.name).toBe('Modern copy')
    const edited = pt.saveTemplate(s.db, { ...copy, name: 'Shop', typography: { ...copy.typography, accent: '#aa0033' } })
    expect(pt.getTemplate(s.db, copy.id).name).toBe('Shop')
    pt.setDefaultTemplate(s.db, 'sales', edited.id)
    expect(pt.listTemplates(s.db).defaults.sales).toBe(edited.id)
    expect(invoiceHtml(s.db, INFO, s.inv.id).html).toContain('#aa0033')
    pt.deleteTemplate(s.db, edited.id)
    expect(pt.listTemplates(s.db).defaults.sales).toBe('classic')
    expect(invoiceHtml(s.db, INFO, s.inv.id).html).not.toContain('#aa0033')
  })

  it('refuses to delete built-ins, to save unknown ids, and to default a template to a kind it is not enabled for', () => {
    const s = setup()
    expect(() => pt.deleteTemplate(s.db, 'classic')).toThrow(/Built-in/)
    expect(() => pt.saveTemplate(s.db, { id: 'ghost', name: 'Ghost' })).toThrow(/not found/)
    const copy = pt.duplicateTemplate(s.db, 'classic')
    pt.saveTemplate(s.db, { ...copy, kinds: ['sales'] })
    expect(() => pt.setDefaultTemplate(s.db, 'receipt', copy.id)).toThrow(/not enabled/)
  })

  it('customising Classic keeps the legacy config in sync both ways; reset restores defaults', () => {
    const s = setup()
    const classic = pt.getTemplate(s.db, 'classic')
    pt.saveTemplate(s.db, { ...classic, header: { ...classic.header, titles: { ...classic.header.titles, sales: 'BILL OF SUPPLY' } }, typography: { ...classic.typography, accent: '#003366' } })
    expect(getInvoiceConfig(s.db).title).toBe('BILL OF SUPPLY')
    expect(pt.listTemplates(s.db).templates[0]!.customised).toBe(true)
    // Old channel write: lands in the customised Classic, keeping its accent.
    setInvoiceConfig(s.db, { ...getInvoiceConfig(s.db), terms: 'Net 7' })
    const after = pt.getTemplate(s.db, 'classic')
    expect(after.footer.terms).toBe('Net 7')
    expect(after.typography.accent).toBe('#003366')
    expect(after.header.titles.sales).toBe('BILL OF SUPPLY')
    pt.resetTemplate(s.db, 'classic')
    expect(getInvoiceConfig(s.db)).toEqual(DEFAULT_INVOICE_CONFIG)
    expect(pt.getTemplate(s.db, 'classic').typography.accent).toBe('#16181f')
    expect(() => pt.resetTemplate(s.db, copyId(s.db))).toThrow(/Only built-in/)
  })

  it('export → import round-trips as a new user template; bad JSON is rejected', () => {
    const s = setup()
    const path = pt.exportTemplate(s.db, SLUG, 'compact')
    expect(existsSync(path)).toBe(true)
    const imported = pt.importTemplate(s.db, readFileSync(path, 'utf8'))
    expect(imported.id).not.toBe('compact')
    expect(imported.builtIn).toBe(false)
    expect({ ...imported, id: 'compact', builtIn: true }).toEqual(pt.getTemplate(s.db, 'compact'))
    expect(() => pt.importTemplate(s.db, '{"nope":1}')).toThrow(/valid print template/)
  })

  it('survives a corrupt store (falls back to built-ins) and drops invalid stored templates', () => {
    const s = setup()
    s.db.prepare("INSERT INTO meta (key, value) VALUES ('printTemplates', '{not json')").run()
    expect(pt.listTemplates(s.db).templates).toHaveLength(3)
    s.db.prepare("UPDATE meta SET value = ? WHERE key = 'printTemplates'").run(JSON.stringify({ version: 1, templates: [{ id: 'BAD' }], defaults: { sales: 'BAD' } }))
    expect(pt.listTemplates(s.db).defaults.sales).toBe('classic')
    expect(invoiceHtml(s.db, INFO, s.inv.id).html).toContain('TAX INVOICE')
  })

  it('prints a receipt as an accounting voucher with the party and amount in words', () => {
    const s = setup()
    const doc = pt.loadPrintDocument(s.db, INFO, s.receipt.id)
    expect(doc.shape).toBe('voucher')
    const { html, kind } = pt.documentHtml(s.db, INFO, s.receipt.id)
    expect(kind).toBe('receipt')
    expect(html).toContain('RECEIPT')
    expect(html).toContain('Buyer &amp; Sons')
    expect(html).toContain('Fifty Thousand Rupees Only')
    expect(html).toContain('Printed in a test')
  })

  it('prints the e-invoice block when the voucher has IRN data, and the outstanding balance when asked', () => {
    const s = setup()
    s.db.prepare("UPDATE vouchers SET irn = 'IRN123', irn_ack_no = 'ACK9', irn_ack_date = '2026-07-05 10:00:00', ewb_no = 'EWB77' WHERE id = ?").run(s.inv.id)
    const html = invoiceHtml(s.db, INFO, s.inv.id).html
    expect(html).toContain('IRN: <span class="num">IRN123</span> · Ack No: <span class="num">ACK9</span> · Ack Date: <span class="num">05-Jul-26</span> · e-Way Bill No: <span class="num">EWB77</span>')
    const classic = pt.getTemplate(s.db, 'classic')
    pt.saveTemplate(s.db, { ...classic, totals: { ...classic.totals, showOutstanding: true } })
    // ₹1,18,000 invoiced on 5 July; the 10 July receipt is after the invoice date.
    expect(invoiceHtml(s.db, INFO, s.inv.id).html).toContain('Balance outstanding</td><td class="r num">1,18,000.00 Dr')
  })

  it('preview renders an unsaved template on the sample or on a real voucher', () => {
    const s = setup()
    const draft = printTemplateSchema.parse({ ...pt.getTemplate(s.db, 'modern'), name: 'Draft' })
    expect(pt.templatePreviewHtml(s.db, INFO, draft).html).toContain('INV-SAMPLE-1')
    expect(pt.templatePreviewHtml(s.db, INFO, draft, { voucherId: s.inv.id }).html).toContain('Laptop')
    expect(pt.templatePreviewHtml(s.db, INFO, draft, { kind: 'payment' }).html).toContain('PAYMENT VOUCHER')
  })
})

function copyId(db: ReturnType<typeof seededDb>): string {
  return pt.duplicateTemplate(db, 'classic').id
}
