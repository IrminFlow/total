// TCS after WP 3.3: the s.206C(1G) overseas tour programme package slab (FY 2025-26: 5 % up to
// ₹10 lakh of a buyer's year, 20 % above; FY 2026-27 a flat 2 %) — src/shared/tcsSources.ts.
// Every figure is hand-worked in paise in the comments (₹1 = 100 paise; ₹10 lakh = 1,00,00,000).
import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { seededDb } from '../db/testdb'
import type { DB } from '../db/connection'
import { createLedger } from './masters'
import { getVoucher, saveVoucher } from './vouchers'
import { listRates, listSections, saveRate } from './tds'
import { addStatutoryTcsSections, statutoryTcsSections, tcsSuggestion } from './tcs'
import { applyTcsToVoucher, export27eqCsv, form27eqData, tcsEligible } from './tcsWorkbench'
import { ensureCompanyTree } from '../paths'
import type { VoucherInput } from '@shared/schemas'
import type { Form26qData } from '@shared/tdsTypes'

type Form26qDataRow = Form26qData['deductees'][number]

beforeAll(() => {
  process.env.TOTAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'total-tcs206c-test-'))
})

const sid = (db: DB, code: string): number => (db.prepare('SELECT id FROM tds_sections WHERE code = ?').get(code) as { id: number }).id
const gid = (db: DB, name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
const vtId = (db: DB, kind: string): number => (db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }).id

function ledger(db: DB, name: string, group: string, extra: Record<string, unknown> = {}): number {
  return createLedger(db, {
    name, groupId: gid(db, group), openingBalance: 0, gstin: null, stateCode: null, address: null,
    taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null, ...extra
  } as Parameters<typeof createLedger>[1]).id
}

function tourFixture(db: DB) {
  const tour = sid(db, '206C(1G) TOUR')
  return {
    tour,
    mehta: ledger(db, 'Mehta Family', 'Sundry Debtors', { pan: 'ABCPM1234K', tcsSectionId: tour }),
    walkIn: ledger(db, 'Walk-in Traveller', 'Sundry Debtors', { tcsSectionId: tour }),
    packages: ledger(db, 'Tour Packages', 'Sales Accounts'),
    cgst: ledger(db, 'CGST Output', 'Duties & Taxes', { taxType: 'cgst' }),
    sgst: ledger(db, 'SGST Output', 'Duties & Taxes', { taxType: 'sgst' })
  }
}
type Fx = ReturnType<typeof tourFixture>

/** A package sale at 5 % GST (2.5 % + 2.5 %): Dr buyer taxable + GST (+ TCS) / Cr packages / Cr CGST, SGST. */
function tourSale(db: DB, fx: Fx, date: string, party: number, taxable: number, tcs: VoucherInput['tcs'] = null): number {
  const half = Math.round(taxable * 0.025)
  const total = taxable + 2 * half + (tcs?.tcsAmount ?? 0)
  return saveVoucher(db, {
    voucherTypeId: vtId(db, 'sales'), date, partyLedgerId: party,
    lines: [
      { ledgerId: party, drCr: 'dr', amount: total }, { ledgerId: fx.packages, drCr: 'cr', amount: taxable },
      { ledgerId: fx.cgst, drCr: 'cr', amount: half }, { ledgerId: fx.sgst, drCr: 'cr', amount: half }
    ],
    billRefs: [{ kind: 'new', name: `T-${date}`, amount: total, dueDate: null }],
    tcs
  }).id
}

const suggest = (db: DB, fx: Fx, party: number, date: string, taxable: number) =>
  tcsSuggestion(db, { partyLedgerId: party, date, voucherKind: 'sales', taxablePaise: taxable, gstPaise: 2 * Math.round(taxable * 0.025), salesLedgerId: fx.packages })!

describe('s.206C(1G) tour package — the ₹10 lakh slab', () => {
  it('collects 5 % inside the buyer\'s ₹10 lakh for the year and 20 % beyond, one entry across the line in two parts', () => {
    const db = seededDb()
    const fx = tourFixture(db)
    // Sale 1, 10 Jun 2025: ₹6,00,000 + GST ₹30,000 = base ₹6,30,000 (GST in the base, migration 027);
    // nothing before it, so all inside the slab: ₹6,30,000 × 5 % = ₹31,500.
    const s1 = suggest(db, fx, fx.mehta, '2025-06-10', 60000000)
    expect(s1).toMatchObject({ basePaise: 63000000, tdsPaise: 3150000, rateBp: 500 })
    expect(s1.slab).toEqual({ limitPaise: 100000000, priorPaise: 0, belowPaise: 63000000, abovePaise: 0, lowerRateBp: 500, upperRateBp: 2000 })
    const v1 = tourSale(db, fx, '2025-06-10', fx.mehta, 60000000, { sectionId: fx.tour, baseAmount: 63000000, tcsAmount: 3150000, isManual: false, autoPayable: true })
    expect(getVoucher(db, v1)!.tcs).toMatchObject({ tcsAmount: 3150000, rateBp: 500 })

    // Sale 2, 20 Aug 2025: ₹4,00,000 + GST ₹20,000 = ₹4,20,000. Prior ₹6,30,000, so ₹3,70,000 is
    // inside (× 5 % = ₹18,500) and ₹50,000 above (× 20 % = ₹10,000): ₹28,500.
    const s2 = suggest(db, fx, fx.mehta, '2025-08-20', 40000000)
    expect(s2).toMatchObject({ basePaise: 42000000, tdsPaise: 2850000, rateBp: 2000 })
    expect(s2.slab).toMatchObject({ priorPaise: 63000000, belowPaise: 37000000, abovePaise: 5000000 })
    // The pre-slab figure (₹4,20,000 × 5 % = ₹21,000) is refused at save.
    expect(() => tourSale(db, fx, '2025-08-20', fx.mehta, 40000000, { sectionId: fx.tour, baseAmount: 42000000, tcsAmount: 2100000, isManual: false, autoPayable: true }))
      .toThrow(/should be ₹28,500\.00 on a base of ₹4,20,000\.00/)
    const v2 = tourSale(db, fx, '2025-08-20', fx.mehta, 40000000, { sectionId: fx.tour, baseAmount: 42000000, tcsAmount: 2850000, isManual: false, autoPayable: true })
    const saved2 = getVoucher(db, v2)!
    // The stored rate is the upper slab's once any part is above the limit.
    expect(saved2.tcs).toMatchObject({ tcsAmount: 2850000, rateBp: 2000 })
    // Dr buyer ₹4,20,000 + ₹28,500 = ₹4,48,500; Cr TCS payable ₹28,500 as the last line.
    expect(saved2.lines[0]).toMatchObject({ ledgerId: fx.mehta, drCr: 'dr', amount: 44850000 })
    expect(saved2.lines.at(-1)).toMatchObject({ drCr: 'cr', amount: 2850000 })

    // Sale 3, 5 Nov 2025, left without TCS: ₹1,00,000 + GST ₹5,000 = ₹1,05,000, all above
    // (prior ₹10,50,000): × 20 % = ₹21,000 — on the Eligible list and through Move to TCS.
    const v3 = tourSale(db, fx, '2025-11-05', fx.mehta, 10000000)
    expect(tcsEligible(db, '2025-10-01', '2025-12-31').map((r) => [r.voucherId, r.basePaise, r.tdsPaise])).toEqual([[v3, 10500000, 2100000]])
    const moved = applyTcsToVoucher(db, { voucherId: v3 })!
    expect(moved.tcs).toMatchObject({ tcsAmount: 2100000, baseAmount: 10500000, rateBp: 2000 })
    expect(moved.lines[0]).toMatchObject({ ledgerId: fx.mehta, amount: 10500000 + 2100000 })

    // FY 2026-27 starts the aggregate again, and FA 2026 s.85(f) makes it a flat 2 %: ₹12,00,000
    // + GST ₹60,000 = ₹12,60,000 × 2 % = ₹25,200, no slab.
    const s4 = suggest(db, fx, fx.mehta, '2026-05-01', 120000000)
    expect(s4).toMatchObject({ basePaise: 126000000, tdsPaise: 2520000, rateBp: 200, slab: null, reference: '394(1) Sl. 8' })
  })

  it('no PAN: 10 % inside the slab (twice 5 %), 20 % above (twice 20 % capped) — s.206CC', () => {
    const db = seededDb()
    const fx = tourFixture(db)
    // ₹10,00,000 + GST ₹50,000 = ₹10,50,000: ₹10,00,000 × 10 % = ₹1,00,000 + ₹50,000 × 20 % = ₹10,000.
    const s = suggest(db, fx, fx.walkIn, '2025-06-10', 100000000)
    expect(s).toMatchObject({ basis: 'no_pan', basePaise: 105000000, tdsPaise: 11000000, rateBp: 2000 })
    expect(s.slab).toMatchObject({ belowPaise: 100000000, abovePaise: 5000000, lowerRateBp: 1000, upperRateBp: 2000 })
  })

  it('a rate row you add yourself (no source) is taken as it stands — no slab on top', () => {
    const db = seededDb()
    const fx = tourFixture(db)
    saveRate(db, {
      sectionId: fx.tour, effectiveFrom: '2025-04-01', effectiveTo: '2026-03-31', deducteeType: 'any', rateBp: 2000,
      noPanRateBp: 2000, returnCode: 'O', baseIncludesGst: true
    })
    // ₹4,00,000 + GST ₹20,000 = ₹4,20,000 × 20 % = ₹84,000 (the slab would have given ₹21,000).
    const s = suggest(db, fx, fx.mehta, '2025-06-10', 40000000)
    expect(s).toMatchObject({ basePaise: 42000000, tdsPaise: 8400000, rateBp: 2000, slab: null })
  })
})

// ---------------------------------------------------------------------------------------------
// s.206C(1C) — parking lot / toll plaza / mine or quarry, 2 % collected by the licensor
// ---------------------------------------------------------------------------------------------

const existing = (db: DB, name: string): number | null =>
  (db.prepare('SELECT id FROM ledgers WHERE name = ?').get(name) as { id: number } | undefined)?.id ?? null

function licenceFixture(db: DB) {
  addStatutoryTcsSections(db)
  const parking = sid(db, '206C(1C) PARKING')
  return {
    parking,
    contractor: ledger(db, 'City Parking Contractors LLP', 'Sundry Debtors', { pan: 'AAFFC1234B', tcsSectionId: parking }),
    noPan: ledger(db, 'Kiosk Operator', 'Sundry Debtors', { tcsSectionId: parking }),
    fees: ledger(db, 'Parking Licence Fees', 'Indirect Incomes'),
    cgst: existing(db, 'CGST Output') ?? ledger(db, 'CGST Output', 'Duties & Taxes', { taxType: 'cgst' }),
    sgst: existing(db, 'SGST Output') ?? ledger(db, 'SGST Output', 'Duties & Taxes', { taxType: 'sgst' }),
    bank: ledger(db, 'HDFC Bank', 'Bank Accounts')
  }
}
type Lx = ReturnType<typeof licenceFixture>

/** A licence-fee invoice at 18 % GST: Dr licensee fee + GST (+ TCS) / Cr fees / Cr CGST, SGST 9 % each. */
function licenceBill(db: DB, lx: Lx, date: string, party: number, fee: number, tcs: VoucherInput['tcs'] = null): number {
  const half = Math.round(fee * 0.09)
  const total = fee + 2 * half + (tcs?.tcsAmount ?? 0)
  return saveVoucher(db, {
    voucherTypeId: vtId(db, 'sales'), date, partyLedgerId: party,
    lines: [
      { ledgerId: party, drCr: 'dr', amount: total }, { ledgerId: lx.fees, drCr: 'cr', amount: fee },
      { ledgerId: lx.cgst, drCr: 'cr', amount: half }, { ledgerId: lx.sgst, drCr: 'cr', amount: half }
    ],
    billRefs: [{ kind: 'new', name: `L-${date}`, amount: total, dueDate: null }],
    tcs
  }).id
}

describe('s.206C(1C) — the statutory sections, added by the owner (no migration)', () => {
  it('lists the three sections as missing, adds them once with cited rows and audit, and is idempotent', () => {
    const db = seededDb()
    expect(statutoryTcsSections(db).map((s) => [s.code, s.sectionId])).toEqual([
      ['206C(1C) PARKING', null], ['206C(1C) TOLL', null], ['206C(1C) MINE', null]
    ])
    const auditRows = (): number => (db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity IN ('tdsSection', 'tdsRate')").get() as { n: number }).n
    const before = auditRows()
    const created = addStatutoryTcsSections(db, ['206C(1C) MINE'])
    expect(created.map((s) => [s.code, s.kind, s.legacyCode, s.newReference])).toEqual([['206C(1C) MINE', 'tcs', '206C(1C)', '394(1) Sl. 9']])
    expect(auditRows()).toBe(before + 3) // the section + its two rate rows
    expect(addStatutoryTcsSections(db).map((s) => s.code)).toEqual(['206C(1C) PARKING', '206C(1C) TOLL'])
    expect(auditRows()).toBe(before + 9)
    expect(addStatutoryTcsSections(db)).toEqual([])
    expect(auditRows()).toBe(before + 9)
    expect(statutoryTcsSections(db).every((s) => s.sectionId != null)).toBe(true)
    expect(() => addStatutoryTcsSections(db, ['206C(1Z)'])).toThrow(/Not a statutory TCS section/)
    const mine = listRates(db, sid(db, '206C(1C) MINE'))
    expect(mine.map((r) => [r.effectiveFrom, r.effectiveTo, r.rateBp, r.noPanRateBp, r.returnCode, r.baseIncludesGst])).toEqual([
      ['2025-04-01', '2026-03-31', 200, 500, 'H', true],
      ['2026-04-01', null, 200, 500, '1092', true]
    ])
    expect(mine.every((r) => /accessed 2026-10-17/.test(r.source ?? ''))).toBe(true)
    // TCS sections only — the TDS master is untouched.
    expect(listSections(db).some((s) => s.code.startsWith('206C'))).toBe(false)
  })

  it('collects 2 % on the licence fee at debit, creates the tagged payable, and 2 % under the 2025 Act', () => {
    const db = seededDb()
    const lx = licenceFixture(db)
    // July 2025 fee ₹50,000 + GST ₹9,000 = ₹59,000 (base incl. GST); × 2 % = ₹1,180. No threshold.
    const s = tcsSuggestion(db, { partyLedgerId: lx.contractor, date: '2025-07-01', voucherKind: 'sales', taxablePaise: 5000000, gstPaise: 900000, salesLedgerId: lx.fees })!
    expect(s).toMatchObject({ code: '206C(1C) PARKING', basePaise: 5900000, tdsPaise: 118000, rateBp: 200, slab: null, reference: '206C(1C)', payableLedgerId: null })
    expect(s.payableLedgerName).toBe('TCS Payable 206C(1C) PARKING')
    const id = licenceBill(db, lx, '2025-07-01', lx.contractor, 5000000, { sectionId: lx.parking, baseAmount: 5900000, tcsAmount: 118000, isManual: false, autoPayable: true })
    const v = getVoucher(db, id)!
    expect(v.tcs).toMatchObject({ tcsAmount: 118000, baseAmount: 5900000, rateBp: 200, gstInBase: true })
    // Dr licensee ₹59,000 + ₹1,180 = ₹60,180; Cr the section's tagged payable ₹1,180.
    expect(v.lines[0]).toMatchObject({ ledgerId: lx.contractor, drCr: 'dr', amount: 6018000 })
    const payable = db.prepare('SELECT name, tcs_payable_section_id AS t FROM ledgers WHERE id = ?').get(v.lines.at(-1)!.ledgerId)
    expect(payable).toEqual({ name: 'TCS Payable 206C(1C) PARKING', t: lx.parking })
    // A wrong figure is refused by the shared check: 1 % (₹590) is not the table's ₹1,180.
    expect(() => licenceBill(db, lx, '2025-07-02', lx.contractor, 5000000, { sectionId: lx.parking, baseAmount: 5900000, tcsAmount: 59000, isManual: false, autoPayable: true }))
      .toThrow(/TCS u\/s 206C\(1C\) PARKING should be ₹1,180\.00/)

    // 1 Jul 2026: 2025 Act s.394(1) Sl. 9, still 2 % (FA 2026 s.85 leaves Sl. 9 alone): ₹1,180.
    expect(tcsSuggestion(db, { partyLedgerId: lx.contractor, date: '2026-07-01', voucherKind: 'sales', taxablePaise: 5000000, gstPaise: 900000 }))
      .toMatchObject({ tdsPaise: 118000, rateBp: 200, reference: '394(1) Sl. 9' })

    // No PAN: the higher of twice 2 % (4 %) and 5 % = 5 %: ₹59,000 × 5 % = ₹2,950.
    expect(tcsSuggestion(db, { partyLedgerId: lx.noPan, date: '2025-07-01', voucherKind: 'sales', taxablePaise: 5000000, gstPaise: 900000 }))
      .toMatchObject({ basis: 'no_pan', rateBp: 500, tdsPaise: 295000 })
  })

  it('collects on a receipt when it comes first: ₹1,18,000 received, ₹59,000 of it an advance → ₹1,180', () => {
    const db = seededDb()
    const lx = licenceFixture(db)
    licenceBill(db, lx, '2025-07-01', lx.contractor, 5000000, { sectionId: lx.parking, baseAmount: 5900000, tcsAmount: 118000, isManual: false, autoPayable: true })
    // 1 Aug 2025 the licensee pays ₹1,18,000: ₹59,000 covers July's bill (collected at debit), the
    // other ₹59,000 is August's fee received before it is billed — "receipt ... whichever is earlier":
    // ₹59,000 × 2 % = ₹1,180.
    const r = tcsSuggestion(db, { partyLedgerId: lx.contractor, date: '2025-08-01', voucherKind: 'receipt', taxablePaise: 11800000 })!
    expect(r).toMatchObject({ basePaise: 5900000, tdsPaise: 118000, payment: { undeductedBillsPaise: 0, advancePaise: 5900000, deductedAtCredit: false } })
  })
})

// ---------------------------------------------------------------------------------------------
// Form 27EQ / Form 143 rows
// ---------------------------------------------------------------------------------------------

describe('27EQ / Form 143 — codes and the slab split', () => {
  it('a tour collection across ₹10 lakh is two rows (5 % / 20 %) of one entry, flagged; 1C rows carry H (27EQ) and 1090 (Form 143)', () => {
    const db = seededDb()
    const fx = tourFixture(db)
    const tcs = (base: number, amount: number): VoucherInput['tcs'] => ({ sectionId: fx.tour, baseAmount: base, tcsAmount: amount, isManual: false, autoPayable: true })
    // As in the first test: ₹6,30,000 → ₹31,500 (Q1); ₹4,20,000 → ₹18,500 + ₹10,000 (Q2); ₹1,05,000 → ₹21,000 (Q3).
    const v1 = tourSale(db, fx, '2025-06-10', fx.mehta, 60000000, tcs(63000000, 3150000))
    const v2 = tourSale(db, fx, '2025-08-20', fx.mehta, 40000000, tcs(42000000, 2850000))
    const v3 = tourSale(db, fx, '2025-11-05', fx.mehta, 10000000, tcs(10500000, 2100000))
    const lx = licenceFixture(db)
    const mine = sid(db, '206C(1C) MINE')
    const quarry = ledger(db, 'Stone Quarry Lessee', 'Sundry Debtors', { pan: 'AABCQ1234E', tcsSectionId: mine })
    // Quarry lease rent ₹2,00,000 + GST ₹36,000 = ₹2,36,000 × 2 % = ₹4,720 (Q2, code H).
    const q2 = licenceBill(db, lx, '2025-09-01', quarry, 20000000, { sectionId: mine, baseAmount: 23600000, tcsAmount: 472000, isManual: false, autoPayable: true })
    // Parking fee 1 Jul 2026 ₹59,000 × 2 % = ₹1,180 (Form 143, code 1090).
    const p26 = licenceBill(db, lx, '2026-07-01', lx.contractor, 5000000, { sectionId: lx.parking, baseAmount: 5900000, tcsAmount: 118000, isManual: false, autoPayable: true })

    const shape = (d: Form26qDataRow) => [d.voucherId, d.returnCode, d.amountPaise, d.rateBp, d.tdsPaise, d.note ?? '']
    expect(form27eqData(db, 2025, 1).deductees.map(shape)).toEqual([[v1, 'O', 63000000, 500, 3150000, '']])
    const q2data = form27eqData(db, 2025, 2)
    expect(q2data.deductees.map(shape)).toEqual([
      [v2, 'O', 37000000, 500, 1850000, '1G slab: one collection split at ₹10,00,000.00 (UNVERIFIED) — part up to the limit'],
      [v2, 'O', 5000000, 2000, 1000000, '1G slab: one collection split at ₹10,00,000.00 (UNVERIFIED) — part above the limit'],
      [q2, 'H', 23600000, 200, 472000, '']
    ])
    // The split keeps the quarter's totals: ₹4,20,000 + ₹2,36,000 = ₹6,56,000; TCS ₹28,500 + ₹4,720 = ₹33,220.
    expect(q2data.totals).toMatchObject({ amountPaise: 65600000 })
    expect(q2data.deductees.reduce((t, d) => t + d.tdsPaise, 0)).toBe(3322000)
    expect(form27eqData(db, 2025, 3).deductees.map(shape)).toEqual([[v3, 'O', 10500000, 2000, 2100000, '1G slab: above ₹10,00,000.00 for the year — 20%']])
    const f143 = form27eqData(db, 2026, 2)
    expect(f143.layout).toBe('form143')
    expect(f143.deductees.map(shape)).toEqual([[p26, '1090', 5900000, 200, 118000, '']])

    ensureCompanyTree('tcs206c-co')
    const csv = readFileSync(export27eqCsv(db, 'tcs206c-co', 2025, 2), 'utf8')
    expect(csv.split(/\r?\n/)[0]).toMatch(/,Challan Amount \(Rs\),Note$/)
    expect(csv).toContain('370000.00,5.00,18500.00')
    expect(csv).toContain('50000.00,20.00,10000.00')
    expect(csv).toContain('part above the limit')
  })
})
