// WP 10.4 — prints in the company language. A simple-mode company in Hindi prints its bill with
// Hindi labels, the Hindi amount in words and the bundled Devanagari face; every accountant
// company (whatever its language) and every English simple company prints EXACTLY the HTML it
// printed before (the PDF is a pure function of that HTML in the hidden print window), and a
// missing font falls back to the English print, never to boxes.
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { CompanyInfo } from '@shared/domain'
import { renderDocument } from '@shared/print/render'
import { pageFooterTemplate } from '@shared/print/labels'
import { seededDb, TEST_INFO } from '../db/testdb'
import { ensureCompanyTree } from '../paths'
import { createLedger } from './masters'
import { saveVoucher } from './vouchers'
import { plexFontFaceCss, resetDevanagariFontForTests } from './printFonts'
import { printLocale } from './printLocale'
import * as pt from './printTemplates'
import { statementData, statementHtml } from './receivables'
import { resolveTemplate } from './printTemplates'

const INFO: CompanyInfo = { ...TEST_INFO, name: 'Bhasha Traders', gstin: '27AAPFU0939F1ZV', address: '12 MG Road, Pune 411001' }

beforeAll(() => {
  process.env.TOTAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'total-print-locale-'))
  ensureCompanyTree('print-locale-test')
})
afterEach(() => resetDevanagariFontForTests())

function setup(ui: Record<string, unknown> | null) {
  const db = seededDb()
  const groupId = (name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
  const vtId = (kind: string): number => (db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }).id
  const buyer = createLedger(db, { name: 'Ramesh Stores', groupId: groupId('Sundry Debtors'), gstin: '27AAPFU0939F1ZV', stateCode: '27' }).id
  const sales = createLedger(db, { name: 'Sales', groupId: groupId('Sales Accounts'), gstRate: 18 }).id
  const cgst = createLedger(db, { name: 'CGST', groupId: groupId('Duties & Taxes'), taxType: 'cgst' }).id
  const sgst = createLedger(db, { name: 'SGST', groupId: groupId('Duties & Taxes'), taxType: 'sgst' }).id
  const v = saveVoucher(db, {
    voucherTypeId: vtId('sales'), date: '2026-07-05', partyLedgerId: buyer, reference: null, narration: null,
    lines: [
      { ledgerId: buyer, drCr: 'dr', amount: 14160000, costAllocations: [] },
      { ledgerId: sales, drCr: 'cr', amount: 12000000, costAllocations: [] },
      { ledgerId: cgst, drCr: 'cr', amount: 1080000, costAllocations: [] },
      { ledgerId: sgst, drCr: 'cr', amount: 1080000, costAllocations: [] }
    ],
    inventory: [], billRefs: [], tds: null
  })
  if (ui) db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('ui', ?)").run(JSON.stringify(ui))
  return { db, voucherId: v.id, buyer }
}

/** The pre-10.4 print call: the kind's template, the Plex faces, nothing else. */
function englishHtml(db: ReturnType<typeof setup>['db'], voucherId: number): string {
  const { kind, template } = pt.documentHtml(db, INFO, voucherId)
  void kind
  const doc = pt.loadPrintDocument(db, INFO, voucherId, template.totals.showOutstanding)
  return renderDocument(template, doc, { fontFaceCss: plexFontFaceCss })
}

describe('prints in the company language (WP 10.4)', () => {
  it('accountant companies print byte-identically, whatever language their owner picked', () => {
    for (const ui of [null, { mode: 'accountant' }, { mode: 'accountant', language: 'hi' }, { mode: 'accountant', language: 'hinglish' }]) {
      const { db, voucherId } = setup(ui)
      expect(printLocale(db).lang).toBe('en')
      const html = pt.documentHtml(db, INFO, voucherId).html
      expect(html, JSON.stringify(ui)).toBe(englishHtml(db, voucherId))
      expect(/[ऀ-ॿ]/.test(html)).toBe(false)
    }
  })

  it('an English simple company prints exactly as before', () => {
    const { db, voucherId } = setup({ mode: 'simple', language: 'en' })
    expect(pt.documentHtml(db, INFO, voucherId).html).toBe(englishHtml(db, voucherId))
  })

  it('a Hindi simple company prints Hindi labels, Hindi amount in words and embeds Noto Sans Devanagari', () => {
    const { db, voucherId } = setup({ mode: 'simple', language: 'hi' })
    const html = pt.documentHtml(db, INFO, voucherId).html
    expect(html).toContain("font-family: 'Noto Sans Devanagari'")
    expect(html).toMatch(/src: url\(data:font\/woff2;base64,[A-Za-z0-9+/]{1000,}/)
    expect(html).toContain('रकम शब्दों में')
    // ₹1,41,600 → एक लाख इकतालीस हज़ार छह सौ रुपये मात्र
    expect(html).toContain('एक लाख इकतालीस हज़ार छह सौ रुपये मात्र')
    expect(html).toContain('TAX INVOICE') // the legal title stays
    expect(html).not.toContain('Amount in words')
  })

  it('Hindi leftovers: the PDF footer says "पृष्ठ N / M" only in a localised print', () => {
    const english = pageFooterTemplate()
    // The footer every PDF always had, byte for byte.
    expect(english).toBe(
      '<div style="width:100%;text-align:center;font-size:9px;font-family:Helvetica,Arial,sans-serif;color:#555">' +
        'Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>'
    )
    for (const ui of [null, { mode: 'accountant', language: 'hi' }, { mode: 'simple', language: 'en' }]) {
      const { db, voucherId } = setup(ui)
      expect(pt.documentHtml(db, INFO, voucherId).pageLabel, JSON.stringify(ui)).toBeUndefined()
      expect(printLocale(db).opts.labels?.page).toBeUndefined()
    }
    const hi = setup({ mode: 'simple', language: 'hi' })
    const label = pt.documentHtml(hi.db, INFO, hi.voucherId).pageLabel
    expect(label).toEqual({ before: 'पृष्ठ ', between: ' / ', after: '' })
    expect(pageFooterTemplate(label)).toContain('पृष्ठ <span class="pageNumber"></span> / <span class="totalPages"></span>')
    const hg = setup({ mode: 'simple', language: 'hinglish' })
    expect(pageFooterTemplate(pt.documentHtml(hg.db, INFO, hg.voucherId).pageLabel)).toContain('Page <span class="pageNumber"></span> / <span class="totalPages"></span>')
  })

  it('a Hinglish simple company prints Latin-script labels and no Devanagari face', () => {
    const { db, voucherId } = setup({ mode: 'simple', language: 'hinglish' })
    const html = pt.documentHtml(db, INFO, voucherId).html
    expect(html).toContain('Ek lakh iktaalees hazaar chhah sau rupaye')
    expect(html).not.toContain('Noto Sans Devanagari')
    expect(/[ऀ-ॿ]/.test(html)).toBe(false)
  })

  it('the statement follows the company language too', () => {
    const { db, buyer } = setup({ mode: 'simple', language: 'hi' })
    const { html } = statementHtml(db, INFO, buyer, '2026-04-01', '2026-07-31')
    expect(html).toContain('विवरण')
    expect(html).toContain("font-family: 'Noto Sans Devanagari'")
  })

  it('WP 10.4 review: an accountant company\'s statement is byte-identical too', () => {
    for (const ui of [null, { mode: 'accountant', language: 'hi' }]) {
      const { db, buyer } = setup(ui)
      const data = statementData(db, INFO, buyer, '2026-04-01', '2026-07-31')
      const before = renderDocument(resolveTemplate(db, 'statement'), { shape: 'statement', kind: 'statement', company: INFO, statement: data }, { fontFaceCss: plexFontFaceCss })
      expect(statementHtml(db, INFO, buyer, '2026-04-01', '2026-07-31').html).toBe(before)
    }
  })

  it('WP 10.4 review: a Hindi statement says its rows in Hindi and the balance side from the reader\'s view', () => {
    const { db, buyer } = setup({ mode: 'simple', language: 'hi' })
    const { html } = statementHtml(db, INFO, buyer, '2026-04-01', '2026-07-31')
    // the customer owes ₹1,41,600: "देना है" (you have to pay); no English kind / bill-wise jargon
    expect(html).toContain('देना है')
    expect(html).not.toMatch(/New ref|Agst ref|Against the oldest|>Sales </)
    expect(html).toContain('बिल</') // the entry is named by its kind
    expect(html).toContain('<th class="r" style="width:110px">बिल</th>')
    expect(html).toContain('<th class="r" style="width:110px">चुकाया</th>')
    // the default payment request is said in Hindi; month names never print in English
    expect(html).toContain('कृपया बाकी रकम नीचे दिए बैंक खाते में भेजें')
    expect(html).not.toContain('Kindly remit')
    expect(html).not.toMatch(/\d{2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2}/)
  })

  it('WP 10.4 review: a Hindi bill writes its dates in digits (no English month names); Hinglish keeps the format', () => {
    const hi = setup({ mode: 'simple', language: 'hi' })
    const html = pt.documentHtml(hi.db, INFO, hi.voucherId).html
    expect(html).toContain('05/07/2026')
    expect(html).not.toMatch(/\b(?:Jul|July)\b/)
    const hg = setup({ mode: 'simple', language: 'hinglish' })
    expect(pt.documentHtml(hg.db, INFO, hg.voucherId).html).not.toContain('05/07/2026')
  })

  it('WP 10.4 review: a supplier\'s Hindi statement puts their bills in the credit column and our balance as "लेना है" for them', () => {
    const { db } = setup({ mode: 'simple', language: 'hi' })
    const groupId = (name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
    const vtId = (kind: string): number => (db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }).id
    const supplier = createLedger(db, { name: 'Mohan Supplies', groupId: groupId('Sundry Creditors') }).id
    const purchases = createLedger(db, { name: 'Purchases', groupId: groupId('Purchase Accounts') }).id
    saveVoucher(db, {
      voucherTypeId: vtId('purchase'), date: '2026-07-06', partyLedgerId: supplier, reference: 'M-1', narration: null,
      lines: [
        { ledgerId: purchases, drCr: 'dr', amount: 500000, costAllocations: [] },
        { ledgerId: supplier, drCr: 'cr', amount: 500000, costAllocations: [] }
      ],
      inventory: [], billRefs: [], tds: null
    })
    const { html } = statementHtml(db, INFO, supplier, '2026-04-01', '2026-07-31')
    const heads = [...html.matchAll(/<th class="r" style="width:110px">([^<]+)<\/th>/g)].map((m) => m[1])
    expect(heads.slice(0, 2)).toEqual(['चुकाया', 'बिल'])
    expect(html).toContain('लेना है') // we owe the supplier: from their side, "to receive"
    expect(html).toContain('खरीद बिल')
  })

  it('WP 10.4 review: a Hindi receipt print heads its lines नामे / जमा, never the statement\'s बिल / चुकाया', () => {
    const { db, buyer } = setup({ mode: 'simple', language: 'hi' })
    const groupId = (name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
    const vtId = (kind: string): number => (db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }).id
    const cash = (db.prepare("SELECT id FROM ledgers WHERE group_id = ? LIMIT 1").get(groupId('Cash-in-Hand')) as { id: number }).id
    const r = saveVoucher(db, {
      voucherTypeId: vtId('receipt'), date: '2026-07-07', partyLedgerId: buyer, reference: null, narration: null,
      lines: [
        { ledgerId: cash, drCr: 'dr', amount: 100000, costAllocations: [] },
        { ledgerId: buyer, drCr: 'cr', amount: 100000, costAllocations: [] }
      ],
      inventory: [], billRefs: [], tds: null
    })
    const html = pt.documentHtml(db, INFO, r.id).html
    expect(html).toContain('>नामे</th>')
    expect(html).toContain('>जमा</th>')
  })

  it('when the Devanagari face cannot be loaded a Hindi company gets the English print, never boxes', () => {
    resetDevanagariFontForTests([join(tmpdir(), 'no-such-font-dir')])
    const { db, voucherId } = setup({ mode: 'simple', language: 'hi' })
    expect(printLocale(db).lang).toBe('en')
    const html = pt.documentHtml(db, INFO, voucherId).html
    expect(html).toBe(englishHtml(db, voucherId))
    expect(/[ऀ-ॿ]/.test(html)).toBe(false)
  })
})
