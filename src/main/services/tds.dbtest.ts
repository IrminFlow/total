import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { seededDb } from '../db/testdb'
import type { DB } from '../db/connection'
import { createLedger, getLedger, updateLedger } from './masters'
import { getVoucher, saveVoucher, deleteVoucher } from './vouchers'
import {
  allocateEntries, deleteChallan, ensureTdsPayableLedger, export26qCsv, findPayableLedger, listCertificates, listChallans,
  listRates, listSections, saveCertificate, saveChallan, saveRate, saveSection, tdsSuggestion, tdsSummary, unallocateEntries,
  unallocatedEntries
} from './tds'
import type { CompanyInfo } from '@shared/domain'
import type { VoucherInput } from '@shared/schemas'
import { companyExportsDir, ensureCompanyTree } from '../paths'

const INFO: CompanyInfo = {
  name: 'Test Co', stateCode: '27', gstin: null, gstRegistrationType: 'regular', address: '',
  booksFrom: 2025, email: null, phone: null, pan: null, tan: null
}

beforeAll(() => {
  // dataRoot() reads TOTAL_DATA_DIR verbatim — keeps the 26Q export hermetic.
  process.env.TOTAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'total-tds-test-'))
})

const sectionId = (db: DB, code: string): number => (db.prepare('SELECT id FROM tds_sections WHERE code = ?').get(code) as { id: number }).id
const groupId = (db: DB, name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
const ledgerId = (db: DB, name: string): number => (db.prepare('SELECT id FROM ledgers WHERE name = ?').get(name) as { id: number }).id

function party(db: DB, name: string, opts: { section?: string | null; pan?: string | null; deducteeType?: 'individual_huf' | 'company' | 'firm' | 'other' | null } = {}) {
  return createLedger(db, {
    name, groupId: groupId(db, 'Sundry Creditors'), openingBalance: 0, gstin: null, stateCode: null, address: null,
    taxType: null, gstRate: null, hsn: null, tdsSectionId: opts.section ? sectionId(db, opts.section) : null,
    pan: opts.pan === undefined ? 'ABCCE1234F' : opts.pan, creditDays: null, exportType: null, deducteeType: opts.deducteeType ?? null
  }).id
}

function expense(db: DB, name: string, defaultSection: string | null = null) {
  return createLedger(db, {
    name, groupId: groupId(db, 'Indirect Expenses'), openingBalance: 0, gstin: null, stateCode: null, address: null,
    taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null,
    tdsDefaultSectionId: defaultSection ? sectionId(db, defaultSection) : null
  }).id
}

const vtId = (db: DB, kind: string): number => (db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }).id

/** Journal "Dr Expense base / Cr Party base − tds" with the payable credit left to the server. */
function journalWithTds(
  db: DB,
  opts: { date: string; party: number; base: number; tds: number; section: string; expenseId?: number; isManual?: boolean; postDated?: boolean; isOptional?: boolean }
): VoucherInput {
  const exp = opts.expenseId ?? expense(db, `Exp ${Math.random()}`)
  return {
    voucherTypeId: vtId(db, 'journal'), date: opts.date, partyLedgerId: opts.party, narration: null, reference: null,
    postDated: opts.postDated, isOptional: opts.isOptional,
    lines: [
      { ledgerId: exp, drCr: 'dr', amount: opts.base },
      { ledgerId: opts.party, drCr: 'cr', amount: opts.base - opts.tds }
    ],
    tds: { sectionId: sectionId(db, opts.section), baseAmount: opts.base, tdsAmount: opts.tds, isManual: opts.isManual ?? false, autoPayable: true }
  }
}

describe('sections and rates after migration 020', () => {
  it('lists the five original sections plus 194J(a), 194-I(a) and 194Q, with both Act references', () => {
    const db = seededDb()
    const sections = listSections(db)
    expect(sections.map((s) => s.code).sort()).toEqual(['194A', '194C', '194H', '194I', '194I(A)', '194J', '194J(A)', '194Q'])
    expect(sections.find((s) => s.code === '194C')).toMatchObject({ legacyCode: '194C', newReference: '393(1) Sl. 6(i)', act: 'it_act_1961' })
    // Every cited row names its source; carried rows say they weren't re-verified.
    for (const r of listRates(db)) expect(r.source).toBeTruthy()
  })

  it('saveRate adds an effective-dated row, audits it, and keeps the legacy mirror in sync', () => {
    const db = seededDb()
    const id = sectionId(db, '194H')
    const created = saveRate(db, {
      sectionId: id, effectiveFrom: '2000-01-01', effectiveTo: null, deducteeType: 'any', rateBp: 300,
      thresholdSinglePaise: 0, thresholdAnnualPaise: 2000000
    })
    expect(created).toMatchObject({ rateBp: 300, source: null, thresholdBasis: 'fy', noPanRateBp: 2000 })
    // The new open-ended row starts earlier than the cited 2026 row, so the cited one still wins today.
    expect(listSections(db).find((s) => s.id === id)!.rate).toBe(2)
    const audit = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'tdsRate' AND entity_id = ?").get(created.id) as { n: number }
    expect(audit.n).toBe(1)
  })

  it('legacy saveSection on a new section opens an any-deductee rate row', () => {
    const db = seededDb()
    const s = saveSection(db, { code: '194X', description: 'Test', rate: 5, thresholdSingle: 0, thresholdAnnual: 100 })
    expect(listRates(db, s.id)).toMatchObject([{ rateBp: 500, effectiveFrom: '1961-04-01', effectiveTo: null, deducteeType: 'any' }])
  })
})

describe('tdsSuggestion', () => {
  it('is null for a party with no section and no expense default', () => {
    const db = seededDb()
    expect(tdsSuggestion(db, party(db, 'Plain'), 5000000, '2025-05-01')).toBeNull()
  })

  it('uses the effective-dated rate for the deductee type (194C: 1% individual, 2% company)', () => {
    const db = seededDb()
    const indiv = party(db, 'Contractor P', { section: '194C', pan: 'ABCPE1234F' })
    const company = party(db, 'Contractor C', { section: '194C', pan: 'ABCCE1234F' })
    expect(tdsSuggestion(db, indiv, 5000000, '2025-05-01')).toMatchObject({ rateBp: 100, tdsPaise: 50000, deducteeType: 'individual_huf', reference: '194C' })
    expect(tdsSuggestion(db, company, 5000000, '2025-05-01')).toMatchObject({ rateBp: 200, tdsPaise: 100000, deducteeType: 'company' })
    // From 1 Apr 2026 the same rate, quoted under the 2025 Act.
    expect(tdsSuggestion(db, indiv, 5000000, '2026-05-01')).toMatchObject({ rateBp: 100, reference: '393(1) Sl. 6(i)' })
    // An explicit deductee type beats the PAN.
    updateLedger(db, indiv, { ...getLedger(db, indiv)!, deducteeType: 'company' })
    expect(tdsSuggestion(db, indiv, 5000000, '2025-05-01')!.rateBp).toBe(200)
  })

  it('without a PAN: 20% (and 5% for 194Q)', () => {
    const db = seededDb()
    const p = party(db, 'No PAN', { section: '194C', pan: null })
    expect(tdsSuggestion(db, p, 5000000, '2025-05-01')).toMatchObject({ basis: 'no_pan', rateBp: 2000, tdsPaise: 1000000, panAvailable: false })
  })

  it('a lower-deduction certificate applies inside its dates and cap', () => {
    const db = seededDb()
    const p = party(db, 'LDC Vendor', { section: '194J', pan: 'ABCCE1234F' })
    const cert = saveCertificate(db, {
      ledgerId: p, sectionId: sectionId(db, '194J'), certificateNo: 'LDC/2025/1', rateBp: 200,
      validFrom: '2025-04-01', validTo: '2025-12-31', capPaise: 10000000
    })
    expect(listCertificates(db, p)).toHaveLength(1)
    expect(tdsSuggestion(db, p, 6000000, '2025-06-01')).toMatchObject({ basis: 'certificate', rateBp: 200, tdsPaise: 120000, certificate: { id: cert.id } })
    // Consume ₹60,000 of the ₹1,00,000 cap; the next ₹60,000 is ₹40,000 at 2% + ₹20,000 at 10%.
    saveVoucher(db, journalWithTds(db, { date: '2025-06-01', party: p, base: 6000000, tds: 120000, section: '194J' }))
    expect(tdsSuggestion(db, p, 6000000, '2025-07-01')!.tdsPaise).toBe(80000 + 200000)
    // Outside its dates: the table rate.
    expect(tdsSuggestion(db, p, 6000000, '2026-01-10')).toMatchObject({ basis: 'section', rateBp: 1000 })
  })

  it('threshold history: aggregate crossing mid-year counts prior entries in the FY, month for rent', () => {
    const db = seededDb()
    const p = party(db, 'Contractor', { section: '194C' })
    // ₹25,000 bills: under the ₹30,000 single limit; four reach exactly ₹1,00,000 (not "exceeding").
    for (let i = 0; i < 4; i++) {
      const s = tdsSuggestion(db, p, 2500000, `2025-0${5 + i}-01`)!
      expect(s.thresholdCrossed).toBe(false)
      saveVoucher(db, journalWithTds(db, { date: `2025-0${5 + i}-01`, party: p, base: 2500000, tds: s.tdsPaise, section: '194C' }))
    }
    expect(tdsSuggestion(db, p, 2500000, '2025-10-01')).toMatchObject({ thresholdCrossed: true, threshold: { reason: 'aggregate', priorPaise: 10000000 } })
    expect(tdsSuggestion(db, p, 2500000, '2026-04-10')!.threshold.priorPaise).toBe(0) // new FY
    const landlord = party(db, 'Landlord', { section: '194I' })
    saveVoucher(db, journalWithTds(db, { date: '2025-05-02', party: landlord, base: 4000000, tds: 400000, section: '194I' }))
    expect(tdsSuggestion(db, landlord, 2000000, '2025-05-20')).toMatchObject({ thresholdCrossed: true, threshold: { basis: 'month', priorPaise: 4000000 } })
    expect(tdsSuggestion(db, landlord, 2000000, '2025-06-20')).toMatchObject({ thresholdCrossed: false, threshold: { priorPaise: 0 } })
  })

  it('an expense ledger default section applies when the party has a deductee type', () => {
    const db = seededDb()
    const rent = expense(db, 'Rent', '194I')
    const withPan = party(db, 'Landlord', { section: null, pan: 'ABCPE1234F' })
    const noType = party(db, 'Unknown', { section: null, pan: null })
    expect(tdsSuggestion(db, withPan, 6000000, '2025-05-01', { expenseLedgerId: rent })).toMatchObject({ code: '194I', sectionFrom: 'ledger', tdsPaise: 600000 })
    expect(tdsSuggestion(db, noType, 6000000, '2025-05-01', { expenseLedgerId: rent })).toBeNull()
  })

  it('never writes', () => {
    const db = seededDb()
    const p = party(db, 'Contractor', { section: '194C' })
    const count = (): number => (db.prepare('SELECT (SELECT COUNT(*) FROM ledgers) + (SELECT COUNT(*) FROM audit_log) AS n').get() as { n: number }).n
    const before = count()
    const s = tdsSuggestion(db, p, 5000000, '2025-05-01')!
    expect(s.payableLedgerId).toBeNull()
    expect(s.payableLedgerName).toBe('TDS Payable 194C')
    expect(count()).toBe(before)
  })
})

describe('saveVoucher with TDS', () => {
  it('creates the tagged payable ledger inside the save and appends the credit (autoPayable)', () => {
    const db = seededDb()
    const p = party(db, 'Contractor', { section: '194C' })
    expect(findPayableLedger(db, sectionId(db, '194C'))).toBeNull()
    const v = saveVoucher(db, journalWithTds(db, { date: '2025-05-01', party: p, base: 5000000, tds: 100000, section: '194C' }))
    const payable = findPayableLedger(db, sectionId(db, '194C'))!
    expect(payable.name).toBe('TDS Payable 194C')
    expect(getLedger(db, payable.id)!.groupId).toBe(groupId(db, 'Duties & Taxes'))
    expect(v.lines[v.lines.length - 1]).toMatchObject({ ledgerId: payable.id, drCr: 'cr', amount: 100000 })
    expect(v.tds).toMatchObject({ rateBp: 200, deducteeType: 'company', isManual: false })
    // Second voucher reuses it.
    saveVoucher(db, journalWithTds(db, { date: '2025-05-02', party: p, base: 5000000, tds: 100000, section: '194C' }))
    expect((db.prepare('SELECT COUNT(*) AS n FROM ledgers WHERE tds_payable_section_id IS NOT NULL').get() as { n: number }).n).toBe(1)
  })

  it('a payment (Dr vendor / Cr cash net) with TDS saves, the payable credit appended by the server', () => {
    const db = seededDb()
    const p = party(db, 'Consultant', { section: '194J' })
    const v = saveVoucher(db, {
      voucherTypeId: vtId(db, 'payment'), date: '2025-05-01', partyLedgerId: p, narration: null, reference: null,
      lines: [{ ledgerId: p, drCr: 'dr', amount: 6000000 }, { ledgerId: ledgerId(db, 'Cash'), drCr: 'cr', amount: 5400000 }],
      tds: { sectionId: sectionId(db, '194J'), baseAmount: 6000000, tdsAmount: 600000, autoPayable: true }
    })
    expect(v.lines.map((l) => [l.drCr, l.amount])).toEqual([['dr', 6000000], ['cr', 5400000], ['cr', 600000]])
    expect(getLedger(db, v.lines[2]!.ledgerId)!.tdsPayableSectionId).toBe(sectionId(db, '194J'))
  })

  it('a rejected save leaves no payable ledger behind', () => {
    const db = seededDb()
    const p = party(db, 'Contractor', { section: '194C' })
    expect(() => saveVoucher(db, journalWithTds(db, { date: '2025-05-01', party: p, base: 5000000, tds: 90000, section: '194C' }))).toThrow(
      /should be ₹1,000\.00/
    )
    expect(findPayableLedger(db, sectionId(db, '194C'))).toBeNull()
  })

  it('rejects a missing payable credit, a credit to an untagged ledger, and no party', () => {
    const db = seededDb()
    const p = party(db, 'Contractor', { section: '194C' })
    const exp = expense(db, 'Work')
    const untagged = createLedger(db, { name: 'My TDS', groupId: groupId(db, 'Duties & Taxes'), openingBalance: 0 }).id
    const base: VoucherInput = {
      voucherTypeId: vtId(db, 'journal'), date: '2025-05-01', partyLedgerId: p, narration: null, reference: null,
      lines: [
        { ledgerId: exp, drCr: 'dr', amount: 5000000 },
        { ledgerId: p, drCr: 'cr', amount: 4900000 },
        { ledgerId: untagged, drCr: 'cr', amount: 100000 }
      ],
      tds: { sectionId: sectionId(db, '194C'), baseAmount: 5000000, tdsAmount: 100000 }
    }
    expect(() => saveVoucher(db, base)).toThrow(/needs a credit of ₹1,000\.00 to that section's TDS payable ledger/)
    expect(() => saveVoucher(db, { ...base, partyLedgerId: null })).toThrow(/needs a party/)
    // Tag it, and the same voucher saves.
    updateLedger(db, untagged, { ...getLedger(db, untagged)!, tdsPayableSectionId: sectionId(db, '194C') })
    expect(saveVoucher(db, base).tds!.tdsAmount).toBe(100000)
  })

  it('manual entries skip the rate check but still need the payable credit', () => {
    const db = seededDb()
    const p = party(db, 'Contractor', { section: '194C' })
    const v = saveVoucher(db, journalWithTds(db, { date: '2025-05-01', party: p, base: 5000000, tds: 75000, section: '194C', isManual: true }))
    expect(v.tds).toMatchObject({ isManual: true, rateBp: null, tdsAmount: 75000 })
  })

  it('an edit keeps the entry id (and its challan allocation); removing TDS deletes it', () => {
    const db = seededDb()
    const p = party(db, 'Contractor', { section: '194C' })
    const v = saveVoucher(db, journalWithTds(db, { date: '2025-05-01', party: p, base: 5000000, tds: 100000, section: '194C' }))
    const entryId = v.tds!.entryId!
    const challan = saveChallan(db, { date: '2025-06-07', bsrCode: '0510308', challanNo: '00042', amountPaise: 100000, quarter: 1, fyStartYear: 2025 })
    allocateEntries(db, challan.id, [entryId])
    const payable = findPayableLedger(db, sectionId(db, '194C'))!.id
    const edited = saveVoucher(db, {
      ...journalWithTds(db, { date: '2025-05-03', party: p, base: 5000000, tds: 100000, section: '194C' }),
      tds: { sectionId: sectionId(db, '194C'), baseAmount: 5000000, tdsAmount: 100000 },
      lines: [...v.lines.map((l) => ({ ledgerId: l.ledgerId, drCr: l.drCr, amount: l.amount }))]
    }, v.id)
    expect(edited.tds!.entryId).toBe(entryId)
    expect(edited.lines.filter((l) => l.ledgerId === payable)).toHaveLength(1)
    expect(listChallans(db, 2025)[0]).toMatchObject({ allocatedPaise: 100000, entryCount: 1 })
    saveVoucher(db, {
      voucherTypeId: vtId(db, 'journal'), date: '2025-05-03', partyLedgerId: p, narration: null, reference: null,
      lines: [{ ledgerId: v.lines[0]!.ledgerId, drCr: 'dr', amount: 5000000 }, { ledgerId: p, drCr: 'cr', amount: 5000000 }], tds: null
    }, v.id)
    expect(getVoucher(db, v.id)!.tds).toBeNull()
    expect(listChallans(db, 2025)[0]).toMatchObject({ allocatedPaise: 0, entryCount: 0 })
  })
})

describe('challans', () => {
  it('CRUD, allocation within the challan amount, unallocated query', () => {
    const db = seededDb()
    const p = party(db, 'Contractor', { section: '194C' })
    const e1 = saveVoucher(db, journalWithTds(db, { date: '2025-05-01', party: p, base: 5000000, tds: 100000, section: '194C' })).tds!.entryId!
    const e2 = saveVoucher(db, journalWithTds(db, { date: '2025-05-15', party: p, base: 5000000, tds: 100000, section: '194C' })).tds!.entryId!
    const e3 = saveVoucher(db, journalWithTds(db, { date: '2025-08-15', party: p, base: 5000000, tds: 100000, section: '194C' })).tds!.entryId!
    expect(unallocatedEntries(db, 2025, 1).map((e) => e.entryId)).toEqual([e1, e2])
    expect(unallocatedEntries(db, 2025).map((e) => e.entryId)).toEqual([e1, e2, e3])

    const c = saveChallan(db, { date: '2025-06-07', bsrCode: '0510308', challanNo: '42', amountPaise: 150000, quarter: 1, fyStartYear: 2025 })
    allocateEntries(db, c.id, [e1])
    expect(() => allocateEntries(db, c.id, [e2])).toThrow(/would exceed challan 42/)
    expect(() => saveChallan(db, { id: c.id, date: '2025-06-07', bsrCode: '0510308', challanNo: '42', amountPaise: 50000, quarter: 1, fyStartYear: 2025 })).toThrow(
      /can't be below/
    )
    const bigger = saveChallan(db, { id: c.id, date: '2025-06-07', bsrCode: '0510308', challanNo: '42', amountPaise: 200000, quarter: 1, fyStartYear: 2025 })
    expect(allocateEntries(db, bigger.id, [e2])).toMatchObject({ allocatedPaise: 200000, entryCount: 2 })
    expect(unallocatedEntries(db, 2025, 1)).toEqual([])
    unallocateEntries(db, [e2])
    expect(unallocatedEntries(db, 2025, 1).map((e) => e.entryId)).toEqual([e2])
    expect(() => saveChallan(db, { date: '2025-06-07', bsrCode: '12', challanNo: '1', amountPaise: 1, quarter: 1, fyStartYear: 2025 })).toThrow()
    deleteChallan(db, c.id)
    expect(listChallans(db, 2025)).toEqual([])
    expect(unallocatedEntries(db, 2025, 1)).toHaveLength(2)
    // Binned vouchers drop out, and can't be allocated.
    const binned = saveVoucher(db, journalWithTds(db, { date: '2025-05-20', party: p, base: 5000000, tds: 100000, section: '194C' }))
    deleteVoucher(db, binned.id)
    expect(unallocatedEntries(db, 2025, 1).map((e) => e.entryId)).not.toContain(binned.tds!.entryId)
    const c2 = saveChallan(db, { date: '2025-06-07', bsrCode: '0510308', challanNo: '43', amountPaise: 900000, quarter: 1, fyStartYear: 2025 })
    expect(() => allocateEntries(db, c2.id, [binned.tds!.entryId!])).toThrow(/not found/)
  })
})

describe('summary and 26Q export', () => {
  it('summary groups section x quarter, counts deductees, and finds payable movement by tag', () => {
    const db = seededDb()
    const a = party(db, 'Contractor A', { section: '194C' })
    const b = party(db, 'Contractor B', { section: '194C' })
    saveVoucher(db, journalWithTds(db, { date: '2025-05-10', party: a, base: 5000000, tds: 100000, section: '194C' }))
    saveVoucher(db, journalWithTds(db, { date: '2025-05-20', party: b, base: 4000000, tds: 80000, section: '194C' }))
    saveVoucher(db, journalWithTds(db, { date: '2025-08-01', party: a, base: 4000000, tds: 80000, section: '194C' }))
    // Deposit Q1's TDS: Dr TDS Payable (by tag — renamed, the summary must still find it) / Cr Bank.
    const payable = findPayableLedger(db, sectionId(db, '194C'))!.id
    updateLedger(db, payable, { ...getLedger(db, payable)!, name: 'Contractor TDS (renamed)' })
    saveVoucher(db, {
      voucherTypeId: vtId(db, 'payment'), date: '2025-06-07', partyLedgerId: null, narration: null, reference: null,
      lines: [{ ledgerId: payable, drCr: 'dr', amount: 180000 }, { ledgerId: ledgerId(db, 'Cash'), drCr: 'cr', amount: 180000 }]
    })
    const summary = tdsSummary(db, 2025)
    expect(summary.find((r) => r.quarter === 'Q1 FY2025-26')).toMatchObject({
      sectionCode: '194C', deductees: 2, base: 9000000, tds: 180000, payableCredited: 180000, payableDebited: 180000
    })
    expect(summary.find((r) => r.quarter === 'Q2 FY2025-26')).toMatchObject({ deductees: 1, base: 4000000, tds: 80000, payableDebited: 0 })
  })

  it('26Q CSV keeps its first seven columns and adds deductee code, rate and the allocated challan', () => {
    const db = seededDb()
    const slug = 'tds-export-test'
    ensureCompanyTree(slug)
    const p = party(db, 'Contractor A', { section: '194C', pan: 'ABCPE1234F' })
    const entry = saveVoucher(db, journalWithTds(db, { date: '2025-05-10', party: p, base: 5000000, tds: 50000, section: '194C' })).tds!.entryId!
    const c = saveChallan(db, { date: '2025-06-07', bsrCode: '0510308', challanNo: '42', amountPaise: 50000, quarter: 1, fyStartYear: 2025 })
    allocateEntries(db, c.id, [entry])
    const path = export26qCsv(db, INFO, slug, 2025, 1)
    expect(path).toBe(join(companyExportsDir(slug), 'tds-26q-2025-26-Q1.csv'))
    const [head, row] = readFileSync(path, 'utf8').trim().split(/\r?\n/)
    expect(head).toBe('Deductee,PAN,Section,Voucher Date,Voucher No,Base (Rs),TDS (Rs),Deductee Code,Rate (%),Challan BSR,Challan Date,Challan Serial,Return Code,Date of Deduction,Reason Code,Challan Amount (Rs)')
    expect(row).toContain('Contractor A,ABCPE1234F,194C,2025-05-10')
    expect(row).toContain('50000.00,500.00,02,1.00,0510308,2025-06-07,42')
  })

  it('optional and unmatured post-dated vouchers stay out of the summary, the export and the threshold base', () => {
    const db = seededDb()
    const slug = 'tds-inbooks-test'
    ensureCompanyTree(slug)
    const p = party(db, 'Landlord', { section: '194I' })
    saveVoucher(db, journalWithTds(db, { date: '2025-05-01', party: p, base: 3000000, tds: 300000, section: '194I' }))
    saveVoucher(db, journalWithTds(db, { date: '2025-05-10', party: p, base: 3000000, tds: 300000, section: '194I', isOptional: true }))
    saveVoucher(db, journalWithTds(db, { date: '2025-05-20', party: p, base: 3000000, tds: 300000, section: '194I', postDated: true }))
    expect(tdsSummary(db, 2025)).toMatchObject([{ quarter: 'Q1 FY2025-26', base: 3000000, tds: 300000 }])
    const rows = readFileSync(export26qCsv(db, INFO, slug, 2025, 1), 'utf8').trim().split(/\r?\n/).slice(1)
    expect(rows).toHaveLength(1)
    // ₹30,000 in the books this month + ₹15,000 = ₹45,000 ≤ ₹50,000 a month.
    expect(tdsSuggestion(db, p, 1500000, '2025-05-25')!.thresholdCrossed).toBe(false)
  })
})

describe('ensureTdsPayableLedger (thin wrapper)', () => {
  it('adopts an untagged "TDS Payable <code>" ledger instead of duplicating it, and rejects unknown sections', () => {
    const db = seededDb()
    const byHand = createLedger(db, { name: 'TDS Payable 194J', groupId: groupId(db, 'Duties & Taxes'), openingBalance: 0 }).id
    expect(ensureTdsPayableLedger(db, sectionId(db, '194J'))).toBe(byHand)
    expect(getLedger(db, byHand)!.tdsPayableSectionId).toBe(sectionId(db, '194J'))
    expect(ensureTdsPayableLedger(db, sectionId(db, '194J'))).toBe(byHand)
    expect(() => ensureTdsPayableLedger(db, 99999)).toThrow(/section not found/)
  })
})
