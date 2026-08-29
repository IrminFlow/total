import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { exportEInvoices, exportEwb, previewJson, setTransport } from './edocs'
import { ensureCompanyTree } from '../paths'
import { seededDb, TEST_INFO } from '../db/testdb'
import { createLedger } from './masters'
import { saveVoucher } from './vouchers'
import type { CompanyInfo, DrCr } from '@shared/domain'

/**
 * "Show me exactly what would be sent."
 *
 * The claim the preview makes is that it is the file, byte for byte. The only way to test that
 * claim is to build the preview, write the export, and compare the two strings — which is what
 * this does, for both payloads. Anything less tests that a preview exists, not that it is honest.
 */
const COMPANY: CompanyInfo = { ...TEST_INFO, gstin: '27AAPFU0939F1ZV', booksFrom: 2026 }
const FROM = '2026-07-01'
const TO = '2026-07-31'

function books() {
  process.env.TOTAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'total-preview-test-'))
  const slug = 'preview-test'
  ensureCompanyTree(slug)

  const db = seededDb()
  const groupId = (name: string): number =>
    (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
  const vtId = (kind: string): number =>
    (db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }).id
  const L = (input: Parameters<typeof createLedger>[1]): number => createLedger(db, input).id

  const buyer = L({
    name: 'B2B Buyer', groupId: groupId('Sundry Debtors'), gstin: '27AAPFU0939F1ZV', stateCode: '27',
    address: '4 Bund Garden Road, Pune 411001'
  })
  const sales = L({ name: 'Sales 18', groupId: groupId('Sales Accounts'), gstRate: 18, hsn: '998314' })
  const cgst = L({ name: 'CGST', groupId: groupId('Duties & Taxes'), taxType: 'cgst' })
  const sgst = L({ name: 'SGST', groupId: groupId('Duties & Taxes'), taxType: 'sgst' })

  const post = (date: string, amount: number, lines: { ledgerId: number; drCr: DrCr; amount: number }[]) =>
    saveVoucher(db, {
      voucherTypeId: vtId('sales'), date, partyLedgerId: buyer, posOverride: null,
      lines: lines.map((l) => ({ ...l, costAllocations: [] })),
      inventory: [], billRefs: [], tds: null
    })

  // Two invoices, one above the Rs 50,000 e-way threshold and one below it.
  post('2026-07-05', 0, [
    { ledgerId: buyer, drCr: 'dr', amount: 11800000 },
    { ledgerId: sales, drCr: 'cr', amount: 10000000 },
    { ledgerId: cgst, drCr: 'cr', amount: 900000 },
    { ledgerId: sgst, drCr: 'cr', amount: 900000 }
  ])
  post('2026-07-06', 0, [
    { ledgerId: buyer, drCr: 'dr', amount: 118000 },
    { ledgerId: sales, drCr: 'cr', amount: 100000 },
    { ledgerId: cgst, drCr: 'cr', amount: 9000 },
    { ledgerId: sgst, drCr: 'cr', amount: 9000 }
  ])

  // Transport details on the larger bill only, so it is genuinely e-way eligible. Without these
  // the NIC converter rejects a bill outright, which is a different exclusion from the value
  // threshold and would otherwise mask it.
  const first = db.prepare('SELECT id FROM vouchers ORDER BY id LIMIT 1').get() as { id: number }
  setTransport(db, first.id, {
    transMode: '1', transDistanceKm: 120, transporterId: null, transporterName: 'Road Runner',
    transDocNo: null, transDocDate: null, vehicleNo: 'MH12AB1234', vehicleType: 'R',
    shipToName: null, shipToGstin: null, shipToAddr1: null, shipToAddr2: null,
    shipToPlace: null, shipToPincode: null, shipToState: null
  })

  return { db, slug, eligibleVoucherId: first.id }
}

describe('edoc JSON preview', () => {
  it('is byte for byte the e-invoice file the export writes', () => {
    const { db, slug } = books()
    const preview = previewJson(db, COMPANY, 'einvoice', FROM, TO)
    const { path } = exportEInvoices(db, COMPANY, slug, FROM, TO, '072026')
    expect(JSON.stringify(preview.json, null, 2)).toBe(readFileSync(path, 'utf8'))
    expect(preview.count).toBe(2)
  })

  it('is byte for byte the e-way bill file the export writes', () => {
    const { db, slug } = books()
    const preview = previewJson(db, COMPANY, 'ewb', FROM, TO)
    const { path } = exportEwb(db, COMPANY, slug, FROM, TO, '072026')
    expect(JSON.stringify(preview.json, null, 2)).toBe(readFileSync(path, 'utf8'))
  })

  it('names what it left out, with the same reasons the export gives', () => {
    // A preview that showed nothing without saying why would read as "there is nothing to send".
    // The invariant that matters is that the preview's exclusions ARE the export's exclusions —
    // asserting a particular reason would just pin whichever rule happens to fire first.
    const { db, slug } = books()
    const preview = previewJson(db, COMPANY, 'ewb', FROM, TO)
    const exported = exportEwb(db, COMPANY, slug, FROM, TO, '072026')
    expect(preview.count).toBe(exported.count)
    expect(preview.issues).toEqual(exported.skipped.map((x) => `${x.number}: ${x.reason}`))
    expect(preview.issues.length).toBeGreaterThan(0)
  })

  it('passes the below-threshold option through, as the export does', () => {
    const { db, slug } = books()
    const preview = previewJson(db, COMPANY, 'ewb', FROM, TO, { includeBelowThreshold: true })
    const exported = exportEwb(db, COMPANY, slug, FROM, TO, '072026', { includeBelowThreshold: true })
    expect(preview.count).toBe(exported.count)
    expect(preview.issues.map((i) => i.split(': ')[1])).toEqual(exported.skipped.map((x) => x.reason))
    // And the option genuinely changes something: the value threshold stops excluding.
    expect(preview.issues.join(' ')).not.toMatch(/50,000|threshold/i)
  })

  it('shows one voucher’s payload, and its blocking issues, rather than refusing', () => {
    // Looking is often how you find out why a payload is not what you expected — refusing to
    // show it defeats the purpose. The small bill is below the threshold, so a per-bill request
    // overrides that, but it still has no transport details and the preview says so.
    const { db, eligibleVoucherId } = books()
    const small = (
      db.prepare('SELECT id FROM vouchers WHERE id <> ? ORDER BY id LIMIT 1').get(eligibleVoucherId) as { id: number }
    ).id
    const preview = previewJson(db, COMPANY, 'ewb', FROM, TO, { voucherId: small })
    expect(preview.count).toBe(1)
    expect(preview.json).not.toBeNull()
    expect(preview.issues.length).toBeGreaterThan(0)
  })

  it('answers plainly for a voucher that does not exist', () => {
    const { db } = books()
    const preview = previewJson(db, COMPANY, 'ewb', FROM, TO, { voucherId: 999999 })
    expect(preview.json).toBeNull()
    expect(preview.issues).toEqual(['Voucher not found'])
  })
})
