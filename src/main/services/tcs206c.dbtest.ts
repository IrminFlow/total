// TCS after WP 3.3: the s.206C(1G) overseas tour programme package slab (FY 2025-26: 5 % up to
// ₹10 lakh of a buyer's year, 20 % above; FY 2026-27 a flat 2 %) — src/shared/tcsSources.ts.
// Every figure is hand-worked in paise in the comments (₹1 = 100 paise; ₹10 lakh = 1,00,00,000).
import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { seededDb } from '../db/testdb'
import type { DB } from '../db/connection'
import { createLedger } from './masters'
import { getVoucher, saveVoucher } from './vouchers'
import { saveRate } from './tds'
import { tcsSuggestion } from './tcs'
import { applyTcsToVoucher, tcsEligible } from './tcsWorkbench'
import type { VoucherInput } from '@shared/schemas'

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
