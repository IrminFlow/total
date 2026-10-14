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
import { seededDb, TEST_INFO } from '../db/testdb'
import { ensureCompanyTree } from '../paths'
import { createLedger } from './masters'
import { saveVoucher } from './vouchers'
import { plexFontFaceCss, resetDevanagariFontForTests } from './printFonts'
import { printLocale } from './printLocale'
import * as pt from './printTemplates'
import { statementHtml } from './receivables'

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
    // ₹1,41,600 → एक लाख इकतालीस हज़ार छह सौ रुपये केवल
    expect(html).toContain('एक लाख इकतालीस हज़ार छह सौ रुपये केवल')
    expect(html).toContain('TAX INVOICE') // the legal title stays
    expect(html).not.toContain('Amount in words')
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

  it('when the Devanagari face cannot be loaded a Hindi company gets the English print, never boxes', () => {
    resetDevanagariFontForTests([join(tmpdir(), 'no-such-font-dir')])
    const { db, voucherId } = setup({ mode: 'simple', language: 'hi' })
    expect(printLocale(db).lang).toBe('en')
    const html = pt.documentHtml(db, INFO, voucherId).html
    expect(html).toBe(englishHtml(db, voucherId))
    expect(/[ऀ-ॿ]/.test(html)).toBe(false)
  })
})
