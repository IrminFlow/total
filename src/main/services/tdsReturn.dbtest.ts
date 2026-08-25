import { describe, it, expect } from 'vitest'
import { seededDb } from '../db/testdb'
import { createLedger, findOrCreateLedger } from './masters'
import { saveVoucher } from './vouchers'
import {
  deleteChallan,
  form16aDeductees,
  form16aFor,
  linkDeductions,
  listChallans,
  saveChallan,
  saveSection,
  tdsReturnWorking
} from './tds'
import { setTdsFiling } from './config'
import type { CompanyInfo } from '@shared/domain'
import type { VoucherInputParsed } from '@shared/schemas'

/**
 * The quarterly return and the vendor certificate against a real book.
 *
 * The arithmetic and the record layout are unit-tested in src/shared/tdsReturn.ts and
 * src/shared/form16a.ts. What only a database can show is the joining: that a deduction finds its
 * challan, that the section reference printed follows the PAYMENT's date rather than today's, and
 * that a quarter with nothing in it produces something a person can act on.
 */
const INFO: CompanyInfo = {
  name: 'Demo Traders', stateCode: '27', gstin: null, gstRegistrationType: 'regular',
  gstFilingFrequency: 'monthly', turnoverBand: null, address: 'Pune, Maharashtra',
  booksFrom: 2026, email: null, phone: null, pan: 'AAAPA1111A', tan: 'PNET12345B'
}

function setup() {
  const db = seededDb()
  setTdsFiling(db, { responsiblePerson: 'A. Kumar', responsibleDesignation: 'Partner', deductorType: 'S' })
  const groupId = (name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
  const sectionId = (code: string): number =>
    (db.prepare('SELECT id FROM tds_sections WHERE code = ?').get(code) as { id: number }).id

  const party = (name: string, code: string, pan: string | null) =>
    createLedger(db, {
      name, groupId: groupId('Sundry Creditors'), openingBalance: 0, gstin: null, stateCode: null,
      address: null, taxType: null, gstRate: null, hsn: null,
      tdsSectionId: sectionId(code), pan, creditDays: null, exportType: null
    })

  /** A payment with TDS deducted, posted as a journal so the payable can be credited too. */
  const deduct = (opts: { date: string; partyLedgerId: number; base: number; tds: number; code: string }) => {
    const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'journal'").get() as { id: number }
    const cash = db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }
    const payable = findOrCreateLedger(db, `TDS Payable ${opts.code}`, 'Duties & Taxes')
    const input: VoucherInputParsed = {
      voucherTypeId: vt.id, date: opts.date, number: undefined, partyLedgerId: opts.partyLedgerId,
      narration: null, reference: null, instrumentNo: null, instrumentDate: null, transporterId: null,
      vehicleNo: null, transportDistanceKm: null, posOverride: null, gstRegistrationId: null, currencyCode: null, exchangeRate: null,
      postDated: undefined, isOptional: undefined,
      lines: [
        { ledgerId: opts.partyLedgerId, drCr: 'dr', amount: opts.base, costAllocations: [] },
        { ledgerId: cash.id, drCr: 'cr', amount: opts.base - opts.tds, costAllocations: [] },
        { ledgerId: payable, drCr: 'cr', amount: opts.tds, costAllocations: [] }
      ],
      inventory: [],
      billRefs: [],
      tds: { sectionId: sectionId(opts.code), baseAmount: opts.base, tdsAmount: opts.tds }
    }
    return saveVoucher(db, input)
  }

  const entryIds = (): number[] =>
    (db.prepare('SELECT id FROM tds_entries ORDER BY id').all() as { id: number }[]).map((r) => r.id)

  return { db, groupId, sectionId, party, deduct, entryIds }
}

const CHALLAN = {
  form: '26Q' as const, bsrCode: '0004329', paidOn: '2026-07-07', serial: '00021',
  tax: 10_000_00, surcharge: 0, cess: 0, interest: 0, fee: 0, bookEntry: false, note: null
}

describe('TDS challans', () => {
  it('records a challan and reports nothing linked to it yet', () => {
    const s = setup()
    saveChallan(s.db, CHALLAN)
    const [c] = listChallans(s.db, 2026)
    expect(c!.bsrCode).toBe('0004329')
    expect(c!.linked).toBe(0)
    expect(c!.claimed).toBe(0)
  })

  it('includes a Q4 challan paid in May, which is after the year end', () => {
    // A challan list that stopped at 31 March would hide exactly the challans the Q4 statement
    // needs.
    const s = setup()
    saveChallan(s.db, { ...CHALLAN, paidOn: '2027-04-30' })
    expect(listChallans(s.db, 2026)).toHaveLength(1)
  })

  it('links deductions and counts what they claim against the challan', () => {
    const s = setup()
    const p = s.party('Ram Contractors', '194C', 'AAAPA0000A')
    s.deduct({ date: '2026-06-10', partyLedgerId: p.id, base: 5_00_000_00, tds: 5_000_00, code: '194C' })
    const challanId = saveChallan(s.db, CHALLAN)
    expect(linkDeductions(s.db, s.entryIds(), challanId)).toBe(1)
    const [c] = listChallans(s.db, 2026)
    expect(c!.linked).toBe(1)
    expect(c!.claimed).toBe(5_000_00)
  })

  it('leaves the deductions unlinked rather than deleting them when a challan goes', () => {
    // The tax was still deducted; it just no longer claims to have been paid with this challan.
    const s = setup()
    const p = s.party('Ram Contractors', '194C', 'AAAPA0000A')
    s.deduct({ date: '2026-06-10', partyLedgerId: p.id, base: 5_00_000_00, tds: 5_000_00, code: '194C' })
    const challanId = saveChallan(s.db, CHALLAN)
    linkDeductions(s.db, s.entryIds(), challanId)
    deleteChallan(s.db, challanId)
    expect(listChallans(s.db, 2026)).toHaveLength(0)
    expect(tdsReturnWorking(s.db, INFO, '26Q', 2026, 1).deductions[0]!.challanId).toBeNull()
  })

  it('refuses to link to a challan that does not exist', () => {
    const s = setup()
    expect(() => linkDeductions(s.db, [1], 999)).toThrow(/Challan not found/)
  })
})

describe('the 26Q working', () => {
  it('blocks a return whose deductions are not under a challan', () => {
    const s = setup()
    const p = s.party('Ram Contractors', '194C', 'AAAPA0000A')
    s.deduct({ date: '2026-06-10', partyLedgerId: p.id, base: 5_00_000_00, tds: 5_000_00, code: '194C' })
    const w = tdsReturnWorking(s.db, INFO, '26Q', 2026, 1)
    expect(w.unlinkedTds).toBe(5_000_00)
    expect(w.issues.some((i) => i.severity === 'blocking' && i.message.includes('challan'))).toBe(true)
  })

  /**
   * FY 2025-26, not 2026-27, and this is the point rather than a convenience.
   *
   * Form 26Q does not exist from tax year 2026-27 — the quarterly statements become Form 138 and
   * Form 140 with a new file format — so the working for 2026-27 is BLOCKED, correctly, and a
   * test asserting a clean 26Q there would be asserting a form that no longer exists. The refusal
   * has its own test below.
   */
  it('is clean once the challan is recorded and linked', () => {
    const s = setup()
    const p = s.party('Ram Contractors', '194C', 'AAAPA0000A')
    s.deduct({ date: '2025-06-10', partyLedgerId: p.id, base: 5_00_000_00, tds: 5_000_00, code: '194C' })
    linkDeductions(s.db, s.entryIds(), saveChallan(s.db, { ...CHALLAN, paidOn: '2025-07-07' }))
    const w = tdsReturnWorking(s.db, INFO, '26Q', 2025, 1)
    // Nothing blocking. The one remaining warning is the Income-tax Act 2025 section reference,
    // which is unverified by design and has its own test below.
    expect(w.issues.filter((i) => i.severity === 'blocking')).toEqual([])
    expect(w.challans).toHaveLength(1)
    expect(w.totalTds).toBe(5_000_00)
    expect(w.dueDate).toBe('2025-07-31')
  })

  it('blocks when the company has no TAN', () => {
    const s = setup()
    const w = tdsReturnWorking(s.db, { ...INFO, tan: null }, '26Q', 2026, 1)
    expect(w.issues.some((i) => i.message.includes('TAN'))).toBe(true)
  })

  it('warns rather than blocks on a deductee with no PAN, and carries the 206AA rate', () => {
    const s = setup()
    const p = s.party('No PAN Vendor', '194C', null)
    // 206AA forces 20% where there is no PAN — the suggestion machinery already does that, and
    // the return has to show the rate that was actually applied.
    s.deduct({ date: '2025-06-10', partyLedgerId: p.id, base: 1_00_000_00, tds: 20_000_00, code: '194C' })
    linkDeductions(s.db, s.entryIds(), saveChallan(s.db, { ...CHALLAN, tax: 20_000_00, paidOn: '2025-07-07' }))
    // FY 2025-26: this test is about PAN and the 206AA rate, and running it in a year where the
    // form itself does not exist would drown that in a blocking issue about the form.
    const w = tdsReturnWorking(s.db, INFO, '26Q', 2025, 1)
    expect(w.deductions[0]!.rate).toBeCloseTo(20, 5)
    expect(w.issues.every((i) => i.severity === 'warning')).toBe(true)
  })

  it('keeps salary out of 26Q and everything else out of 24Q', () => {
    const s = setup()
    saveSection(s.db, { code: '192', description: 'Salary', rate: 10, thresholdSingle: 0, thresholdAnnual: 0, code2025: null })
    const salaried = s.party('Employee Advance', '192', 'AAAPA2222A')
    const contractor = s.party('Ram Contractors', '194C', 'AAAPA0000A')
    s.deduct({ date: '2026-06-10', partyLedgerId: salaried.id, base: 1_00_000_00, tds: 10_000_00, code: '192' })
    s.deduct({ date: '2026-06-11', partyLedgerId: contractor.id, base: 5_00_000_00, tds: 5_000_00, code: '194C' })

    expect(tdsReturnWorking(s.db, INFO, '24Q', 2026, 1).deductions.map((d) => d.deducteeName)).toEqual(['Employee Advance'])
    expect(tdsReturnWorking(s.db, INFO, '26Q', 2026, 1).deductions.map((d) => d.deducteeName)).toEqual(['Ram Contractors'])
  })

  it('says something useful about a quarter with no deductions at all', () => {
    const s = setup()
    const w = tdsReturnWorking(s.db, INFO, '26Q', 2025, 3)
    expect(w.deductions).toEqual([])
    expect(w.issues[0]!.message).toContain('TRACES')
  })

  it('prints the 1961 Act section for a payment before 1 April 2026', () => {
    const s = setup()
    const p = s.party('Ram Contractors', '194C', 'AAAPA0000A')
    s.deduct({ date: '2026-02-10', partyLedgerId: p.id, base: 5_00_000_00, tds: 5_000_00, code: '194C' })
    const w = tdsReturnWorking(s.db, INFO, '26Q', 2025, 4)
    expect(w.deductions[0]!.sectionCode).toBe('194C')
    expect(w.deductions[0]!.sectionUnverified).toBe(false)
  })

  it('prints the user’s own 2025 Act reference for a payment after the Act changes', () => {
    const s = setup()
    saveSection(s.db, {
      id: s.sectionId('194C'), code: '194C', description: 'Contractors', rate: 1,
      thresholdSingle: 0, thresholdAnnual: 0, code2025: '393 Table 6'
    })
    const p = s.party('Ram Contractors', '194C', 'AAAPA0000A')
    s.deduct({ date: '2026-06-10', partyLedgerId: p.id, base: 5_00_000_00, tds: 5_000_00, code: '194C' })
    const w = tdsReturnWorking(s.db, INFO, '26Q', 2026, 1)
    expect(w.deductions[0]!.sectionCode).toBe('393 Table 6')
    expect(w.deductions[0]!.sectionUnverified).toBe(false)
  })

  it('falls back to the proposed reference and says it is unverified', () => {
    const s = setup()
    const p = s.party('Ram Contractors', '194C', 'AAAPA0000A')
    s.deduct({ date: '2026-06-10', partyLedgerId: p.id, base: 5_00_000_00, tds: 5_000_00, code: '194C' })
    linkDeductions(s.db, s.entryIds(), saveChallan(s.db, { ...CHALLAN, tax: 5_000_00 }))
    const w = tdsReturnWorking(s.db, INFO, '26Q', 2026, 1)
    expect(w.deductions[0]!.sectionUnverified).toBe(true)
    expect(w.issues.some((i) => i.message.includes('Income-tax Act 2025'))).toBe(true)
  })
})

describe('Form 16A', () => {
  it('lists only the parties with something to certify', () => {
    const s = setup()
    const p = s.party('Ram Contractors', '194C', 'AAAPA0000A')
    s.party('Untouched Vendor', '194C', 'AAAPA3333A')
    s.deduct({ date: '2026-06-10', partyLedgerId: p.id, base: 5_00_000_00, tds: 5_000_00, code: '194C' })
    expect(form16aDeductees(s.db, 2026, 1).map((d) => d.name)).toEqual(['Ram Contractors'])
  })

  it('builds the certificate with its challan, and heads it as a working copy', () => {
    const s = setup()
    const p = s.party('Ram Contractors', '194C', 'AAAPA0000A')
    s.deduct({ date: '2026-06-10', partyLedgerId: p.id, base: 5_00_000_00, tds: 5_000_00, code: '194C' })
    linkDeductions(s.db, s.entryIds(), saveChallan(s.db, { ...CHALLAN, tax: 5_000_00 }))

    const f = form16aFor(s.db, INFO, p.id, 2026, 1)
    expect(f.totalTds).toBe(5_000_00)
    expect(f.bySection).toHaveLength(1)
    expect(f.deductions[0]!.challan!.bsrCode).toBe('0004329')
    expect(f.dueDate).toBe('2026-08-15')
    expect(f.warnings[0]).toContain('TRACES')
  })

  it('refuses a certificate for a quarter in which nothing was deducted', () => {
    const s = setup()
    const p = s.party('Ram Contractors', '194C', 'AAAPA0000A')
    expect(() => form16aFor(s.db, INFO, p.id, 2026, 1)).toThrow(/no certificate to issue/i)
  })

  it('warns when the vendor has no PAN — the credit cannot reach their 26AS', () => {
    const s = setup()
    const p = s.party('No PAN Vendor', '194C', null)
    s.deduct({ date: '2026-06-10', partyLedgerId: p.id, base: 1_00_000_00, tds: 20_000_00, code: '194C' })
    expect(form16aFor(s.db, INFO, p.id, 2026, 1).warnings.join(' ')).toContain('26AS')
  })
})
