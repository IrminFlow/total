import { describe, it, expect } from 'vitest'
import { issueSelfInvoices, nextSelfInvoiceNumber, rcmRegister, rcmSupplies, getSelfInvoice, deleteSelfInvoice } from './rcm'
import { rcmInwardSummary } from './gst'
import { seededDb, TEST_INFO } from '../db/testdb'
import { createLedger } from './masters'
import { saveVoucher, deleteVoucher } from './vouchers'
import type { DrCr } from '@shared/domain'

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

  // Unregistered local vendor, flagged for reverse charge: the section 9(4) case.
  const unregistered = L({ name: 'Ram Transport', groupId: groupId('Sundry Creditors'), stateCode: '27', rcm: true, address: 'Pune' })
  // Registered advocate, flagged: the section 9(3) case.
  const advocate = L({
    name: 'S. Iyer, Advocate', groupId: groupId('Sundry Creditors'), stateCode: '27',
    gstin: '27AAPFU0939F1ZV', rcm: true
  })
  const ordinary = L({ name: 'Office Supplies Ltd', groupId: groupId('Sundry Creditors'), stateCode: '27' })
  const freight = L({ name: 'Freight Inward', groupId: groupId('Direct Expenses'), gstRate: 5, hsn: '996511' })
  const legal = L({ name: 'Legal Fees', groupId: groupId('Indirect Expenses'), gstRate: 18, hsn: '998211' })

  const post = (kind: string, date: string, partyId: number, lines: { ledgerId: number; drCr: DrCr; amount: number }[]) =>
    saveVoucher(db, {
      voucherTypeId: vtId(kind), date, partyLedgerId: partyId, posOverride: null,
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

  it('classifies an unregistered supplier as 9(4) and a registered one as 9(3)', () => {
    const s = setup()
    s.buyFreight('2026-04-10', 10_000_00)
    s.buyLegal('2026-04-12', 20_000_00)
    const supplies = rcmSupplies(s.db, TEST_INFO, '2026-04-01', '2026-04-30')
    expect(supplies.map((x) => x.basis).sort()).toEqual(['notified', 'unregistered'])
  })

  it('documents exactly the supplies GSTR-3B charges tax on', () => {
    // If these two ever diverge the documents stop adding up to the return, and reconciling them
    // becomes the user's problem forever.
    const s = setup()
    s.buyFreight('2026-04-10', 10_000_00)
    s.buyLegal('2026-04-12', 20_000_00)
    const supplies = rcmSupplies(s.db, TEST_INFO, '2026-04-01', '2026-04-30')
    const fromDocs = supplies.flatMap((x) => x.lines).reduce((t, l) => t + l.cgst + l.sgst + l.igst, 0)
    const b3 = rcmInwardSummary(s.db, TEST_INFO, '2026-04-01', '2026-04-30')
    expect(fromDocs).toBe(b3.cgst + b3.sgst + b3.igst)
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

  it('consolidates a supplier’s 9(4) month into one document and leaves 9(3) alone', () => {
    const s = setup()
    s.buyFreight('2026-04-10', 10_000_00)
    s.buyFreight('2026-04-20', 5_000_00)
    s.buyLegal('2026-04-12', 20_000_00)
    const out = issueSelfInvoices(s.db, TEST_INFO, '2026-04-01', '2026-04-30', { consolidate: true })
    expect(out.issued).toHaveLength(2)
    const consolidated = out.issued.find((d) => d.voucherIds.length === 2)!
    expect(consolidated.taxable).toBe(15_000_00)
    expect(consolidated.date).toBe('2026-04-30')
    expect(out.issued.every((d, i, all) => all.findIndex((x) => x.number === d.number) === i)).toBe(true)
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
