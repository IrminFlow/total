import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { seededDb } from '../db/testdb'
import { createLedger } from './masters'
import { saveVoucher } from './vouchers'
import { listSections, saveSection, tdsSuggestion, tdsSummary, export26qCsv } from './tds'
import { findOrCreateLedger } from './masters'
import type { CompanyInfo } from '@shared/domain'
import type { VoucherInputParsed } from '@shared/schemas'
import { companyExportsDir, ensureCompanyTree } from '../paths'

const INFO: CompanyInfo = {
  name: 'Test Co', stateCode: '27', gstin: null, gstRegistrationType: 'regular', address: '',
  booksFrom: 2025, email: null, phone: null, pan: null, tan: null
}

function creditorLedger(db: ReturnType<typeof seededDb>, name: string, opts: { tdsSectionId: number | null; pan: string | null }) {
  const group = db.prepare("SELECT id FROM groups WHERE name = 'Sundry Creditors'").get() as { id: number }
  return createLedger(db, {
    name, groupId: group.id, openingBalance: 0, gstin: null, stateCode: null, address: null,
    taxType: null, gstRate: null, hsn: null,
    tdsSectionId: opts.tdsSectionId, pan: opts.pan, creditDays: null, exportType: null
  })
}

function paymentVoucherWithTds(
  db: ReturnType<typeof seededDb>,
  opts: {
    date: string; partyLedgerId: number; base: number; tds: number; sectionId: number; sectionCode: string
    postDated?: boolean; isOptional?: boolean
  }
) {
  // 'journal' avoids the payment-must-credit-cash/bank rule — we need to credit TDS Payable too.
  const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'journal'").get() as { id: number }
  const cash = db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }
  const tdsPayableId = findOrCreateLedger(db, `TDS Payable ${opts.sectionCode}`, 'Duties & Taxes')
  const input: VoucherInputParsed = {
    voucherTypeId: vt.id,
    date: opts.date,
    number: undefined,
    partyLedgerId: opts.partyLedgerId,
    narration: null,
    reference: null,
    instrumentNo: null,
    instrumentDate: null,
    transporterId: null,
    vehicleNo: null,
    transportDistanceKm: null,
    posOverride: null,
    currencyCode: null,
    exchangeRate: null,
    postDated: opts.postDated,
    isOptional: opts.isOptional,
    lines: [
      { ledgerId: opts.partyLedgerId, drCr: 'dr', amount: opts.base, costAllocations: [] },
      { ledgerId: cash.id, drCr: 'cr', amount: opts.base - opts.tds, costAllocations: [] },
      { ledgerId: tdsPayableId, drCr: 'cr', amount: opts.tds, costAllocations: [] }
    ],
    inventory: [],
    billRefs: [],
    tds: { sectionId: opts.sectionId, baseAmount: opts.base, tdsAmount: opts.tds }
  }
  return saveVoucher(db, input)
}

describe('tds service', () => {
  it('seeds the 5 standard sections', () => {
    const db = seededDb()
    const sections = listSections(db)
    expect(sections.map((s) => s.code).sort()).toEqual(['194A', '194C', '194H', '194I', '194J'])
  })

  it('tdsSuggestion is null for a ledger with no tds_section_id', () => {
    const db = seededDb()
    const party = creditorLedger(db, 'No TDS Vendor', { tdsSectionId: null, pan: null })
    expect(tdsSuggestion(db, party.id, 5000000, '2025-05-01')).toBeNull()
  })

  it('tdsSuggestion computes the section rate with a PAN on file, and finds/creates the payable ledger', () => {
    const db = seededDb()
    const section = db.prepare("SELECT id FROM tds_sections WHERE code = '194C'").get() as { id: number }
    const party = creditorLedger(db, 'Contractor A', { tdsSectionId: section.id, pan: 'ABCDE1234F' })
    const suggestion = tdsSuggestion(db, party.id, 5000000, '2025-05-01') // ₹50,000 base
    expect(suggestion).not.toBeNull()
    expect(suggestion!.code).toBe('194C')
    expect(suggestion!.panAvailable).toBe(true)
    expect(suggestion!.tdsPaise).toBe(100000) // 2% of ₹50,000 = ₹1,000
    expect(suggestion!.thresholdCrossed).toBe(true) // single threshold ₹30,000 crossed

    const payable = db.prepare('SELECT name FROM ledgers WHERE id = ?').get(suggestion!.payableLedgerId) as { name: string }
    expect(payable.name).toBe('TDS Payable 194C')
  })

  it('tdsSuggestion falls back to 20% without a PAN', () => {
    const db = seededDb()
    const section = db.prepare("SELECT id FROM tds_sections WHERE code = '194C'").get() as { id: number }
    const party = creditorLedger(db, 'Contractor B', { tdsSectionId: section.id, pan: null })
    const suggestion = tdsSuggestion(db, party.id, 5000000, '2025-05-01')
    expect(suggestion!.panAvailable).toBe(false)
    expect(suggestion!.tdsPaise).toBe(1000000) // 20% of ₹50,000
  })

  it('thresholdCrossed reflects FY-to-date accumulation across prior tds_entries', () => {
    const db = seededDb()
    const section = db.prepare("SELECT id FROM tds_sections WHERE code = '194I'").get() as { id: number } // rent: annual only, ₹2,40,000
    const party = creditorLedger(db, 'Landlord', { tdsSectionId: section.id, pan: 'ABCDE1234F' })

    // Below the annual threshold on its own.
    const first = tdsSuggestion(db, party.id, 10000000, '2025-05-01') // ₹1,00,000
    expect(first!.thresholdCrossed).toBe(false)

    paymentVoucherWithTds(db, { date: '2025-05-01', partyLedgerId: party.id, base: 10000000, tds: first!.tdsPaise, sectionId: section.id, sectionCode: '194I' })

    // A second transaction in the same FY pushes cumulative base past ₹2,40,000.
    const second = tdsSuggestion(db, party.id, 15000000, '2025-06-01') // ₹1,50,000 more -> ₹2,50,000 cumulative
    expect(second!.thresholdCrossed).toBe(true)

    // A transaction in the NEXT FY doesn't see the prior FY's accumulation.
    const nextFy = tdsSuggestion(db, party.id, 10000000, '2026-05-01')
    expect(nextFy!.thresholdCrossed).toBe(false)
  })

  it('tdsSummary groups by section x quarter and counts distinct deductees', () => {
    const db = seededDb()
    const section = db.prepare("SELECT id FROM tds_sections WHERE code = '194C'").get() as { id: number }
    const a = creditorLedger(db, 'Contractor A', { tdsSectionId: section.id, pan: 'ABCDE1234F' })
    const b = creditorLedger(db, 'Contractor B', { tdsSectionId: section.id, pan: 'ABCDE1234F' })
    paymentVoucherWithTds(db, { date: '2025-05-10', partyLedgerId: a.id, base: 5000000, tds: 100000, sectionId: section.id, sectionCode: '194C' })
    paymentVoucherWithTds(db, { date: '2025-05-20', partyLedgerId: b.id, base: 3000000, tds: 60000, sectionId: section.id, sectionCode: '194C' })
    paymentVoucherWithTds(db, { date: '2025-08-01', partyLedgerId: a.id, base: 4000000, tds: 80000, sectionId: section.id, sectionCode: '194C' })

    const summary = tdsSummary(db, 2025)
    const q1 = summary.find((r) => r.quarter === 'Q1 FY2025-26')!
    expect(q1.deductees).toBe(2)
    expect(q1.base).toBe(8000000)
    expect(q1.tds).toBe(160000)
    const q2 = summary.find((r) => r.quarter === 'Q2 FY2025-26')!
    expect(q2.deductees).toBe(1)
    expect(q2.base).toBe(4000000)
  })

  it('export26qCsv writes a Deductee/PAN/Section/... CSV for the quarter', () => {
    // dataRoot() reads TOTAL_DATA_DIR verbatim when set — the hermetic override that avoids
    // touching Electron's app.getPath('documents'), which isn't available under electron-as-node.
    process.env.TOTAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'total-tds-test-'))
    const db = seededDb()
    const slug = 'tds-export-test'
    ensureCompanyTree(slug)
    const section = db.prepare("SELECT id FROM tds_sections WHERE code = '194C'").get() as { id: number }
    const party = creditorLedger(db, 'Contractor A', { tdsSectionId: section.id, pan: 'ABCDE1234F' })
    // Exercises saveSection's update branch (id given) — edits the seeded row in place.
    const edited = saveSection(db, {
      id: section.id, code: '194C', description: 'Payments to contractors (edited)', rate: 2,
      thresholdSingle: 3000000, thresholdAnnual: 10000000
    })
    expect(edited.description).toBe('Payments to contractors (edited)')
    paymentVoucherWithTds(db, { date: '2025-05-10', partyLedgerId: party.id, base: 5000000, tds: 100000, sectionId: section.id, sectionCode: '194C' })

    const path = export26qCsv(db, INFO, slug, 2025, 1)
    expect(path).toBe(`${companyExportsDir(slug)}/tds-26q-2025-26-Q1.csv`)
    const csv = readFileSync(path, 'utf8')
    expect(csv).toContain('Deductee,PAN,Section,Voucher Date,Voucher No,Base (Rs),TDS (Rs)')
    expect(csv).toContain('Contractor A')
    expect(csv).toContain('194C')
    expect(csv).toContain('50000.00')
    expect(csv).toContain('1000.00')
  })

  it('excludes optional (memorandum) and unmatured post-dated vouchers from summary, 26Q export and the threshold base (IN_BOOKS)', () => {
    process.env.TOTAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'total-tds-inbooks-'))
    const db = seededDb()
    const slug = 'tds-inbooks-test'
    ensureCompanyTree(slug)
    const section = db.prepare("SELECT id FROM tds_sections WHERE code = '194I'").get() as { id: number } // rent: annual ₹2,40,000
    const party = creditorLedger(db, 'Landlord', { tdsSectionId: section.id, pan: 'ABCDE1234F' })

    // In-books entry: ₹1,00,000.
    paymentVoucherWithTds(db, { date: '2025-05-01', partyLedgerId: party.id, base: 10000000, tds: 1000000, sectionId: section.id, sectionCode: '194I' })
    // Optional (memorandum) entry: ₹2,00,000 — must NOT reach any filing figure.
    paymentVoucherWithTds(db, { date: '2025-05-10', partyLedgerId: party.id, base: 20000000, tds: 2000000, sectionId: section.id, sectionCode: '194I', isOptional: true })
    // Unmatured post-dated entry: ₹1,50,000 — out of the books until it matures.
    paymentVoucherWithTds(db, { date: '2025-06-10', partyLedgerId: party.id, base: 15000000, tds: 1500000, sectionId: section.id, sectionCode: '194I', postDated: true })

    // Summary only sees the in-books ₹1,00,000.
    const summary = tdsSummary(db, 2025)
    expect(summary).toHaveLength(1)
    expect(summary[0]).toMatchObject({ quarter: 'Q1 FY2025-26', base: 10000000, tds: 1000000 })

    // 26Q CSV carries exactly one deductee row.
    const path = export26qCsv(db, INFO, slug, 2025, 1)
    const csv = readFileSync(path, 'utf8')
    const dataRows = csv.trim().split('\n').slice(1)
    expect(dataRows).toHaveLength(1)
    expect(dataRows[0]).toContain('100000.00')

    // Threshold base is FY-to-date IN_BOOKS only: 100000 + 100000 < 240000 — the out-of-books
    // ₹3,50,000 must not fire the annual-threshold check early.
    const s = tdsSuggestion(db, party.id, 10000000, '2025-07-01')
    expect(s!.thresholdCrossed).toBe(false)
  })
})
