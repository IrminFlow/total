import { describe, it, expect } from 'vitest'
import { issueSelfInvoices, nextSelfInvoiceNumber, rcmRegister, rcmSupplies, getSelfInvoice, deleteSelfInvoice } from './rcm'
import { rcmInwardSummary } from './gst'
import { seededDb, TEST_INFO } from '../db/testdb'
import { createLedger } from './masters'
import { saveVoucher, deleteVoucher } from './vouchers'
import type { DrCr } from '@shared/domain'
import { writeCompanyInfo } from '../db/seed'
import { gstScope, listRegistrations, saveRegistration } from './registrations'

const MH = '27AAAPA1234A1ZT'
const GJ = '24AAAPA1234A1ZZ'

/**
 * The self-invoice against a real book.
 *
 * The document model is unit-tested in src/shared/gst/selfInvoice.ts. What can only be tested here
 * is the part that could silently drift: that the set of supplies documented is exactly the set
 * GSTR-3B charges tax on, that a purchase is never documented twice, and that the serial is
 * consecutive within a financial year.
 */
function setup() {
  const db = seededDb()
  const groupId = (name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
  const vtId = (kind: string): number => (db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }).id
  const L = (input: Parameters<typeof createLedger>[1]): number => createLedger(db, input).id

  // Unregistered local transporter in a notified 9(3) category.
  const unregistered = L({ name: 'Ram Transport', groupId: groupId('Sundry Creditors'), stateCode: '27', rcm: true, address: 'Pune' })
  // Registered advocate, flagged: the section 9(3) case.
  const advocate = L({
    name: 'S. Iyer, Advocate', groupId: groupId('Sundry Creditors'), stateCode: '27',
    gstin: '27AAPFU0939F1ZV', rcm: true
  })
  const ordinary = L({ name: 'Office Supplies Ltd', groupId: groupId('Sundry Creditors'), stateCode: '27' })
  const freight = L({ name: 'Freight Inward', groupId: groupId('Direct Expenses'), gstRate: 5, hsn: '996511' })
  const legal = L({ name: 'Legal Fees', groupId: groupId('Indirect Expenses'), gstRate: 18, hsn: '998211' })

  const post = (
    kind: string,
    date: string,
    partyId: number,
    lines: { ledgerId: number; drCr: DrCr; amount: number }[],
    gstRegistrationId?: number | null
  ) =>
    saveVoucher(db, {
      voucherTypeId: vtId(kind), date, partyLedgerId: partyId, posOverride: null,
      gstRegistrationId: gstRegistrationId ?? null,
      lines: lines.map((l) => ({ ...l, costAllocations: [] })),
      inventory: [], billRefs: [], tds: null
    })

  const buyFreight = (date: string, amount: number) =>
    post('purchase', date, unregistered, [
      { ledgerId: freight, drCr: 'dr', amount },
      { ledgerId: unregistered, drCr: 'cr', amount }
    ])

  const buyLegal = (date: string, amount: number) =>
    post('purchase', date, advocate, [
      { ledgerId: legal, drCr: 'dr', amount },
      { ledgerId: advocate, drCr: 'cr', amount }
    ])

  return { db, unregistered, advocate, ordinary, freight, legal, post, buyFreight, buyLegal }
}

describe('rcmSupplies', () => {
  it('finds nothing in a period with no purchases at all', () => {
    const s = setup()
    expect(rcmSupplies(s.db, TEST_INFO, '2026-04-01', '2026-04-30')).toEqual([])
  })

  it('reads the tax at master rates, because a reverse-charge purchase books no tax lines', () => {
    const s = setup()
    s.buyFreight('2026-04-10', 10_000_00)
    const [supply] = rcmSupplies(s.db, TEST_INFO, '2026-04-01', '2026-04-30')
    expect(supply!.lines[0]!.taxable).toBe(10_000_00)
    expect(supply!.lines[0]!.cgst).toBe(250_00)
    expect(supply!.lines[0]!.sgst).toBe(250_00)
    expect(supply!.lines[0]!.igst).toBe(0)
  })

  it('self-invoices only the notified supply from an unregistered supplier', () => {
    const s = setup()
    s.buyFreight('2026-04-10', 10_000_00)
    s.buyLegal('2026-04-12', 20_000_00)
    const supplies = rcmSupplies(s.db, TEST_INFO, '2026-04-01', '2026-04-30')
    expect(supplies).toHaveLength(1)
    expect(supplies[0]).toMatchObject({ supplierName: 'Ram Transport', supplierGstin: null, basis: 'notified' })
  })

  it('leaves a registered 9(3) supplier to its own RCM invoice while GSTR-3B still charges both', () => {
    const s = setup()
    s.buyFreight('2026-04-10', 10_000_00)
    s.buyLegal('2026-04-12', 20_000_00)
    const supplies = rcmSupplies(s.db, TEST_INFO, '2026-04-01', '2026-04-30')
    const fromDocs = supplies.flatMap((x) => x.lines).reduce((t, l) => t + l.cgst + l.sgst + l.igst, 0)
    const b3 = rcmInwardSummary(s.db, TEST_INFO, '2026-04-01', '2026-04-30')
    expect(fromDocs).toBe(500_00)
    expect(b3.cgst + b3.sgst + b3.igst).toBe(4_100_00)
  })

  it('ignores a purchase from a party nobody flagged', () => {
    const s = setup()
    s.post('purchase', '2026-04-10', s.ordinary, [
      { ledgerId: s.freight, drCr: 'dr', amount: 5_000_00 },
      { ledgerId: s.ordinary, drCr: 'cr', amount: 5_000_00 }
    ])
    expect(rcmSupplies(s.db, TEST_INFO, '2026-04-01', '2026-04-30')).toEqual([])
  })

  it('leaves a binned purchase out of the books', () => {
    const s = setup()
    const v = s.buyFreight('2026-04-10', 10_000_00)
    deleteVoucher(s.db, v.id)
    expect(rcmSupplies(s.db, TEST_INFO, '2026-04-01', '2026-04-30')).toEqual([])
  })
})

describe('issueSelfInvoices', () => {
  it('issues one document per supply, numbered consecutively within the financial year', () => {
    const s = setup()
    s.buyFreight('2026-04-10', 10_000_00)
    s.buyFreight('2026-04-20', 5_000_00)
    const out = issueSelfInvoices(s.db, TEST_INFO, '2026-04-01', '2026-04-30', { consolidate: false })
    expect(out.issued.map((d) => d.number)).toEqual(['RCM/2026-27/0001', 'RCM/2026-27/0002'])
  })

  it('restarts the series in the next financial year — Rule 46(b) wants a serial for a year', () => {
    const s = setup()
    s.buyFreight('2026-04-10', 10_000_00)
    issueSelfInvoices(s.db, TEST_INFO, '2026-04-01', '2026-04-30', { consolidate: false })
    s.buyFreight('2027-04-10', 10_000_00)
    const out = issueSelfInvoices(s.db, TEST_INFO, '2027-04-01', '2027-04-30', { consolidate: false })
    expect(out.issued[0]!.number).toBe('RCM/2027-28/0001')
  })

  it('never documents the same purchase twice', () => {
    // Two invoices for one supply is a worse finding than none.
    const s = setup()
    s.buyFreight('2026-04-10', 10_000_00)
    const first = issueSelfInvoices(s.db, TEST_INFO, '2026-04-01', '2026-04-30', { consolidate: false })
    const second = issueSelfInvoices(s.db, TEST_INFO, '2026-04-01', '2026-04-30', { consolidate: false })
    expect(first.issued).toHaveLength(1)
    expect(second.issued).toHaveLength(0)
    expect(second.skipped).toHaveLength(1)
  })

  it('refuses consolidation because the notified 9(4) promoter regime is not modeled', () => {
    const s = setup()
    s.buyFreight('2026-04-10', 10_000_00)
    s.buyFreight('2026-04-20', 5_000_00)
    expect(() => issueSelfInvoices(s.db, TEST_INFO, '2026-04-01', '2026-04-30', { consolidate: true }))
      .toThrow(/notified promoter regime.*daily threshold/i)
  })

  it('can be limited to a chosen voucher', () => {
    const s = setup()
    const keep = s.buyFreight('2026-04-10', 10_000_00)
    s.buyFreight('2026-04-20', 5_000_00)
    const out = issueSelfInvoices(s.db, TEST_INFO, '2026-04-01', '2026-04-30', { consolidate: false, voucherIds: [keep.id] })
    expect(out.issued).toHaveLength(1)
    expect(out.issued[0]!.voucherIds).toEqual([keep.id])
  })

  it('carries the Rule 46 gaps onto the stored document', () => {
    const s = setup()
    s.buyFreight('2026-04-10', 10_000_00)
    const out = issueSelfInvoices(s.db, { ...TEST_INFO, gstin: null }, '2026-04-01', '2026-04-30', { consolidate: false })
    expect(out.issued[0]!.warnings.join(' ')).toContain('Rule 46(b)')
  })

  it('reprints the paper that was issued rather than recomputing it', () => {
    const s = setup()
    s.buyFreight('2026-04-10', 10_000_00)
    const out = issueSelfInvoices(s.db, TEST_INFO, '2026-04-01', '2026-04-30', { consolidate: false })
    const doc = getSelfInvoice(s.db, out.issued[0]!.id)
    expect(doc.totals.taxable).toBe(10_000_00)
    expect(doc.lines[0]!.hsn).toBe('996511')
  })
})

describe('rcmRegister', () => {
  it('is empty and calm for a quiet month', () => {
    const s = setup()
    const reg = rcmRegister(s.db, TEST_INFO, '2026-04-01', '2026-04-30')
    expect(reg).toMatchObject({ pending: [], issued: [], unflagged: [] })
  })

  it('moves a purchase from pending to issued once it is documented', () => {
    const s = setup()
    s.buyFreight('2026-04-10', 10_000_00)
    expect(rcmRegister(s.db, TEST_INFO, '2026-04-01', '2026-04-30').pending).toHaveLength(1)
    issueSelfInvoices(s.db, TEST_INFO, '2026-04-01', '2026-04-30', { consolidate: false })
    const after = rcmRegister(s.db, TEST_INFO, '2026-04-01', '2026-04-30')
    expect(after.pending).toHaveLength(0)
    expect(after.issued).toHaveLength(1)
  })

  it('advises about a notified supply on a party nobody flagged, without documenting it', () => {
    // Issuing a self-invoice for it would document a liability the return does not carry.
    const s = setup()
    s.post('purchase', '2026-04-10', s.ordinary, [
      { ledgerId: s.legal, drCr: 'dr', amount: 20_000_00 },
      { ledgerId: s.ordinary, drCr: 'cr', amount: 20_000_00 }
    ])
    const reg = rcmRegister(s.db, TEST_INFO, '2026-04-01', '2026-04-30')
    expect(reg.pending).toHaveLength(0)
    expect(reg.unflagged).toHaveLength(1)
    expect(reg.unflagged[0]!.category).toBe('Legal services')
  })

  it('scopes purchases, tax type, issued documents and recipient GSTIN to one registration', () => {
    const s = setup()
    writeCompanyInfo(s.db, { ...TEST_INFO, gstin: MH, stateCode: '27' })
    const gj = saveRegistration(s.db, {
      gstin: GJ, stateCode: '24', tradeName: 'Gujarat branch', address: 'Surat',
      registeredOn: null, surrenderedOn: null
    }).id
    const mh = listRegistrations(s.db).find((r) => r.id !== gj)!.id
    const mhPurchase = s.post('purchase', '2026-04-10', s.unregistered, [
      { ledgerId: s.freight, drCr: 'dr', amount: 10_000_00 },
      { ledgerId: s.unregistered, drCr: 'cr', amount: 10_000_00 }
    ], mh)
    const gjPurchase = s.post('purchase', '2026-04-12', s.unregistered, [
      { ledgerId: s.freight, drCr: 'dr', amount: 20_000_00 },
      { ledgerId: s.unregistered, drCr: 'cr', amount: 20_000_00 }
    ], gj)
    const info = { ...TEST_INFO, gstin: MH, stateCode: '27' }
    const mhScope = gstScope(s.db, info, mh)
    const gjScope = gstScope(s.db, info, gj)

    expect(rcmRegister(s.db, mhScope, '2026-04-01', '2026-04-30').pending.map((p) => p.voucherId)).toEqual([mhPurchase.id])
    expect(rcmRegister(s.db, gjScope, '2026-04-01', '2026-04-30').pending.map((p) => p.voucherId)).toEqual([gjPurchase.id])

    const issued = issueSelfInvoices(s.db, gjScope, '2026-04-01', '2026-04-30', { consolidate: false }).issued[0]!
    const doc = getSelfInvoice(s.db, issued.id)
    expect(doc.recipientGstin).toBe(GJ)
    expect(doc.placeOfSupply).toBe('24')
    expect(doc.supplyType).toBe('inter')
    expect(doc.totals.igst).toBe(1_000_00)
    expect(doc.totals.cgst + doc.totals.sgst).toBe(0)
    expect(rcmRegister(s.db, gjScope, '2026-04-01', '2026-04-30').issued.map((d) => d.id)).toEqual([issued.id])
    expect(rcmRegister(s.db, mhScope, '2026-04-01', '2026-04-30').issued).toEqual([])
  })
})

describe('nextSelfInvoiceNumber and deleteSelfInvoice', () => {
  it('starts a fresh company at 0001', () => {
    const s = setup()
    expect(nextSelfInvoiceNumber(s.db, '2026-04-10')).toBe('RCM/2026-27/0001')
  })

  it('frees the purchase to be documented again when a mistaken document is withdrawn', () => {
    const s = setup()
    s.buyFreight('2026-04-10', 10_000_00)
    const out = issueSelfInvoices(s.db, TEST_INFO, '2026-04-01', '2026-04-30', { consolidate: false })
    deleteSelfInvoice(s.db, out.issued[0]!.id)
    expect(rcmRegister(s.db, TEST_INFO, '2026-04-01', '2026-04-30').pending).toHaveLength(1)
  })
})
