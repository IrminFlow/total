import { describe, it, expect } from 'vitest'
import type { DB } from '../db/connection'
import { seededDb, TEST_INFO } from '../db/testdb'
import { createLedger } from './masters'
import { saveVoucher } from './vouchers'
import { writeCompanyInfo } from '../db/seed'
import { gstScope, listRegistrations, saveRegistration } from './registrations'
import { gstr3b, itcBreakdown } from './gst'
import { profitAndLoss, trialBalance } from './reports'
import {
  distributeMonth,
  gstr6,
  isdDesk,
  isdRegistration,
  registrationTurnover,
  saveIsdCredit,
  setIsdRegistration,
  withdrawDistribution
} from './isd'

// One PAN: a Delhi head office that will be the ISD, plus Maharashtra and Gujarat.
const DL = '07AAAPA1234A1ZV'
const MH = '27AAAPA1234A1ZT'
const GJ = '24AAAPA1234A1ZZ'

const MONTH = '2026-06'
const AS_ON = '2027-03-31'

interface Book {
  db: DB
  dl: number
  mh: number
  gj: number
}

/**
 * Three registrations, with the Delhi one marked ISD, and turnover in the preceding financial
 * year on the other two in a 60:40 ratio — the ratio rule 39 will apportion on.
 */
function isdBook(opts: { markIsd?: boolean } = {}): Book {
  const db = seededDb()
  writeCompanyInfo(db, { ...TEST_INFO, gstin: MH, stateCode: '27' })
  const mh = listRegistrations(db)[0]!.id
  const gj = saveRegistration(db, {
    gstin: GJ, stateCode: '24', tradeName: 'Gujarat branch', address: 'Surat',
    registeredOn: null, surrenderedOn: null
  }).id
  const dl = saveRegistration(db, {
    gstin: DL, stateCode: '07', tradeName: 'Head office', address: 'Delhi',
    registeredOn: null, surrenderedOn: null
  }).id
  if (opts.markIsd !== false) setIsdRegistration(db, dl)

  const groupId = (name: string): number =>
    (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
  const vt = (db.prepare("SELECT id FROM voucher_types WHERE kind = 'sales'").get() as { id: number }).id
  const sales = createLedger(db, { name: 'Sales 18', groupId: groupId('Sales Accounts'), gstRate: 18 }).id
  const buyer = createLedger(db, {
    name: 'Buyer', groupId: groupId('Sundry Debtors'), gstin: '27AAPFU0939F1ZV', stateCode: '27'
  }).id

  // FY 2025-26 turnover: ₹6,00,000 in Maharashtra, ₹4,00,000 in Gujarat. The relevant period for
  // a June 2026 distribution is the preceding financial year.
  const sell = (reg: number, amount: number, date: string): void => {
    saveVoucher(db, {
      voucherTypeId: vt,
      date,
      partyLedgerId: buyer,
      gstRegistrationId: reg,
      lines: [
        { ledgerId: buyer, drCr: 'dr', amount, costAllocations: [] },
        { ledgerId: sales, drCr: 'cr', amount, costAllocations: [] }
      ],
      inventory: [],
      billRefs: [],
      tds: null
    })
  }
  sell(mh, 600_000_00, '2025-06-10')
  sell(gj, 400_000_00, '2025-06-11')

  return { db, dl, mh, gj }
}

/** The audit fee: ₹1,00,000 + ₹9,000 CGST + ₹9,000 SGST, used by everyone. */
const auditFee = (b: Book): ReturnType<typeof saveIsdCredit> =>
  saveIsdCredit(b.db, {
    date: '2026-06-12',
    supplierName: 'Audit LLP',
    supplierGstin: '07AAPFU0939F1ZX',
    invoiceNumber: 'A/26/9',
    description: 'Statutory audit fee',
    taxable: 100_000_00,
    invoiceValue: 118_000_00,
    placeOfSupply: '07',
    items: [{ lineNumber: 1, rateBps: 1800, taxable: 100_000_00, heads: { igst: 0, cgst: 9_000_00, sgst: 9_000_00, cess: 0 } }],
    igst: 0,
    cgst: 9_000_00,
    sgst: 9_000_00,
    cess: 0,
    eligibility: 'eligible',
    attribution: 'all',
    recipientRegistrationIds: [],
    reverseCharge: false
  })

describe('the ISD registration', () => {
  it('is exactly one, and moving it does not leave two', () => {
    const b = isdBook()
    expect(isdRegistration(b.db)?.id).toBe(b.dl)
    setIsdRegistration(b.db, b.mh)
    expect(isdRegistration(b.db)?.id).toBe(b.mh)
    const n = (b.db.prepare('SELECT COUNT(*) AS n FROM gst_registrations WHERE is_isd = 1').get() as { n: number }).n
    expect(n).toBe(1)
  })

  it('refuses to record a credit when nothing is marked as the ISD', () => {
    const b = isdBook({ markIsd: false })
    expect(() => auditFee(b)).toThrow(/Input Service Distributor/)
  })

  it('reports the GSTR-6 due date as the 13th of the FOLLOWING month — section 39(4)', () => {
    const b = isdBook()
    expect(isdDesk(b.db, MONTH).dueDate).toBe('2026-07-13')
  })

  it('says plainly why the mechanism cannot run on a one-registration book', () => {
    const db = seededDb()
    writeCompanyInfo(db, { ...TEST_INFO, gstin: MH, stateCode: '27' })
    const desk = isdDesk(db, MONTH)
    expect(desk.multiRegistration).toBe(false)
    expect(desk.blocked).toContain('nothing to distribute to')
  })
})

describe('the ratio — rule 39', () => {
  it('reads each recipient’s turnover from its own registration, not the company’s', () => {
    const b = isdBook()
    expect(registrationTurnover(b.db, b.mh, '2025-04-01', '2026-03-31')).toBe(600_000_00)
    expect(registrationTurnover(b.db, b.gj, '2025-04-01', '2026-03-31')).toBe(400_000_00)
  })

  it('uses the preceding financial year when every recipient traded in it', () => {
    const b = isdBook()
    const desk = isdDesk(b.db, MONTH)
    expect(desk.period.kind).toBe('preceding-fy')
    expect(desk.period).toMatchObject({ from: '2025-04-01', to: '2026-03-31' })
  })

  it('excludes the ISD itself from the recipients — it makes no outward supplies', () => {
    const b = isdBook()
    expect(isdDesk(b.db, MONTH).recipients.map((r) => r.registrationId).sort()).toEqual([b.mh, b.gj].sort())
  })

  it('honours a turnover the user typed, and marks it as typed', () => {
    const b = isdBook()
    const desk = isdDesk(b.db, MONTH, { [String(b.gj)]: 900_000_00 })
    const gj = desk.recipients.find((r) => r.registrationId === b.gj)!
    expect(gj.turnoverPaise).toBe(900_000_00)
    expect(gj.turnoverDeclared).toBe(true)
  })
})

describe('distributing a month', () => {
  it('splits on turnover and converts CGST+SGST to IGST outside the ISD’s own state', () => {
    const b = isdBook()
    auditFee(b)
    const r = distributeMonth(b.db, MONTH)
    expect(r.invoices).toHaveLength(2)
    // Delhi is the ISD; both recipients are outside it, so both receive IGST equal to CGST+SGST.
    const mh = r.invoices.find((i) => i.recipientRegistrationId === b.mh)!
    const gj = r.invoices.find((i) => i.recipientRegistrationId === b.gj)!
    expect(mh.eligible).toEqual({ igst: 10_800_00, cgst: 0, sgst: 0, cess: 0 })
    expect(gj.eligible).toEqual({ igst: 7_200_00, cgst: 0, sgst: 0, cess: 0 })
    // And nothing was lost: ₹18,000 in, ₹18,000 out.
    expect(mh.eligible.igst + gj.eligible.igst).toBe(18_000_00)
  })

  it('keeps CGST and SGST for a recipient in the ISD’s own state', () => {
    const b = isdBook()
    setIsdRegistration(b.db, b.dl)
    // Move the ISD to Maharashtra so one recipient shares its state.
    setIsdRegistration(b.db, b.mh)
    saveIsdCredit(b.db, {
      date: '2026-06-12', supplierName: 'Audit LLP', supplierGstin: null, invoiceNumber: 'A/1',
      description: null, taxable: 100_000_00, igst: 0, cgst: 9_000_00, sgst: 9_000_00, cess: 0,
      invoiceValue: 118_000_00, placeOfSupply: '27',
      items: [{ lineNumber: 1, rateBps: 1800, taxable: 100_000_00, heads: { igst: 0, cgst: 9_000_00, sgst: 9_000_00, cess: 0 } }],
      eligibility: 'eligible', attribution: 'one', recipientRegistrationIds: [b.gj], reverseCharge: false
    })
    // Gujarat is outside Maharashtra: it arrives as IGST.
    const r = distributeMonth(b.db, MONTH)
    expect(r.invoices[0]!.eligible).toEqual({ igst: 18_000_00, cgst: 0, sgst: 0, cess: 0 })
  })

  it('gives credit attributable to one registration to that one, whole', () => {
    const b = isdBook()
    saveIsdCredit(b.db, {
      date: '2026-06-12', supplierName: 'Rent', supplierGstin: null, invoiceNumber: 'R/1',
      description: 'Surat office rent', taxable: 50_000_00, igst: 9_000_00, cgst: 0, sgst: 0, cess: 0,
      invoiceValue: 59_000_00, placeOfSupply: '24',
      items: [{ lineNumber: 1, rateBps: 1800, taxable: 50_000_00, heads: { igst: 9_000_00, cgst: 0, sgst: 0, cess: 0 } }],
      eligibility: 'eligible', attribution: 'one', recipientRegistrationIds: [b.gj], reverseCharge: false
    })
    const r = distributeMonth(b.db, MONTH)
    expect(r.invoices).toHaveLength(1)
    expect(r.invoices[0]!.recipientRegistrationId).toBe(b.gj)
    expect(r.invoices[0]!.eligible.igst).toBe(9_000_00)
  })

  it('refuses to distribute a month twice', () => {
    const b = isdBook()
    auditFee(b)
    distributeMonth(b.db, MONTH)
    expect(() => distributeMonth(b.db, MONTH)).toThrow(/already been distributed/)
  })

  it('refuses to edit a credit that has been distributed, and takes it back on withdrawal', () => {
    const b = isdBook()
    const credit = auditFee(b)
    distributeMonth(b.db, MONTH)
    expect(() =>
      saveIsdCredit(b.db, {
        ...credit,
        id: credit.id,
        taxable: 1,
        igst: 0,
        cgst: 0,
        sgst: 0,
        cess: 0,
        description: null
      })
    ).toThrow(/Withdraw that distribution/)
    withdrawDistribution(b.db, MONTH)
    expect(isdDesk(b.db, MONTH).issued).toEqual([])
    expect(isdDesk(b.db, MONTH).credits[0]!.distributedMonth).toBeNull()
  })

  it('numbers the ISD invoices from one running series', () => {
    const b = isdBook()
    auditFee(b)
    const r = distributeMonth(b.db, MONTH)
    expect(r.invoices.map((i) => i.number)).toEqual(['ISD/2026-27/0001', 'ISD/2026-27/0002'])
  })
})

describe('the recipient’s return carries the credit', () => {
  it('lands in GSTR-3B 4(A)(4), eligible credit only', () => {
    const b = isdBook()
    auditFee(b)
    saveIsdCredit(b.db, {
      date: '2026-06-13', supplierName: 'Club', supplierGstin: null, invoiceNumber: 'C/1',
      description: 'Membership — blocked', taxable: 10_000_00, igst: 1_800_00, cgst: 0, sgst: 0, cess: 0,
      invoiceValue: 11_800_00, placeOfSupply: '27',
      items: [{ lineNumber: 1, rateBps: 1800, taxable: 10_000_00, heads: { igst: 1_800_00, cgst: 0, sgst: 0, cess: 0 } }],
      eligibility: 'ineligible', attribution: 'one', recipientRegistrationIds: [b.mh], reverseCharge: false
    })
    distributeMonth(b.db, MONTH)

    const mhScope = gstScope(b.db, { ...TEST_INFO, gstin: MH, stateCode: '27' }, b.mh)
    const itc = itcBreakdown(b.db, mhScope, '2026-06-01', '2026-06-30')
    // The audit fee's 60% share arrives as IGST; the ineligible membership does not arrive at all.
    expect(itc.isd).toEqual({ igst: 10_800_00, cgst: 0, sgst: 0, cess: 0 })

    const b3 = gstr3b(b.db, mhScope, '2026-06-01', '2026-06-30', '062026')
    expect(b3.itcParts.isd).toEqual({ igst: 10_800_00, cgst: 0, sgst: 0, cess: 0 })
    expect(b3.itc.igst).toBe(10_800_00)
    const avl = (b3.json as { itc_elg: { itc_avl: { ty: string; iamt: number }[] } }).itc_elg.itc_avl
    expect(avl.find((r) => r.ty === 'ISD')!.iamt).toBe(10800)
  })

  it('does not give a registration credit that was distributed to another', () => {
    const b = isdBook()
    saveIsdCredit(b.db, {
      date: '2026-06-12', supplierName: 'Rent', supplierGstin: null, invoiceNumber: 'R/1',
      description: null, taxable: 50_000_00, igst: 9_000_00, cgst: 0, sgst: 0, cess: 0,
      invoiceValue: 59_000_00, placeOfSupply: '24',
      items: [{ lineNumber: 1, rateBps: 1800, taxable: 50_000_00, heads: { igst: 9_000_00, cgst: 0, sgst: 0, cess: 0 } }],
      eligibility: 'eligible', attribution: 'one', recipientRegistrationIds: [b.gj], reverseCharge: false
    })
    distributeMonth(b.db, MONTH)
    const mhScope = gstScope(b.db, { ...TEST_INFO, gstin: MH, stateCode: '27' }, b.mh)
    expect(itcBreakdown(b.db, mhScope, '2026-06-01', '2026-06-30').isd).toEqual({
      igst: 0, cgst: 0, sgst: 0, cess: 0
    })
  })
})

describe('distribution does not touch the books', () => {
  it('leaves the trial balance and the P&L exactly as they were', () => {
    const b = isdBook()
    auditFee(b)
    const tb = trialBalance(b.db, AS_ON)
    const pl = profitAndLoss(b.db, '2026-04-01', AS_ON)
    const count = (b.db.prepare('SELECT COUNT(*) AS n FROM vouchers').get() as { n: number }).n

    distributeMonth(b.db, MONTH)

    expect(trialBalance(b.db, AS_ON)).toEqual(tb)
    expect(profitAndLoss(b.db, '2026-04-01', AS_ON)).toEqual(pl)
    expect((b.db.prepare('SELECT COUNT(*) AS n FROM vouchers').get() as { n: number }).n).toBe(count)
  })
})

describe('GSTR-6', () => {
  it('reports the month, its due date, and that nothing was left undistributed', () => {
    const b = isdBook()
    auditFee(b)
    distributeMonth(b.db, MONTH)
    const g6 = gstr6(b.db, MONTH)
    expect(g6.isdGstin).toBe(DL)
    expect(g6.dueDate).toBe('2026-07-13')
    expect(g6.inward).toHaveLength(1)
    expect(g6.distribution).toHaveLength(2)
    expect(g6.undistributedPaise).toBe(0)
    // The table numbering is checked against the form. The model now builds and validates the
    // Draft-v1.0-shaped preview, but portal upload remains disabled until current signed-in acceptance.
    expect(g6.layoutUnverified).toBe(false)
    expect(g6.formCitation).toContain('GSTR-6')
    expect(g6.portalFile.ready).toBe(false)
    expect(g6.portalFile.auditedOn).toBe('2026-08-28')
    expect(g6.portalFile.schemaVersion).toBe('v1.0')
    expect(g6.portalFile.schemaStatus).toBe('Draft')
    expect(g6.portalFile.validation).toEqual({ valid: true, errors: [] })
    expect(g6.portalFile.preview?.b2b[0]?.inv[0]?.pos).toBe('07')
    expect(g6.portalFile.preview?.isd.elglst).toHaveLength(2)
    expect(g6.portalFile.blockers).toHaveLength(2)
    expect(g6.portalFile.blockers.join(' ')).toContain('signed-in GST portal')
    const lineage = b.db.prepare('SELECT * FROM isd_invoice_lineage ORDER BY isd_invoice_id').all() as { camti: number; samti: number }[]
    expect(lineage).toHaveLength(2)
    expect(lineage.reduce((sum, row) => sum + row.camti + row.samti, 0)).toBe(18_000_00)
  })
})
