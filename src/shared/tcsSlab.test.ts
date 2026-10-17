// s.206C(1G) overseas tour programme package slab (FY 2025-26: 5 % up to ₹10 lakh a year per
// buyer, 20 % above — src/shared/tcsSources.ts) and the cited source tables. Figures hand-worked
// in paise (₹1 = 100 paise; ₹10 lakh = 1,00,00,000 paise).
import { describe, it, expect } from 'vitest'
import { slabbedTcs, tcsSlabOn } from './tcs'
import { applicableRate, type WithholdingRateRow } from './withholding'
import { TCS_NOT_MODELLED, TCS_SLABS, TCS_SOURCES, TCS_STATUTORY_SECTIONS, TCS_UNVERIFIED } from './tcsSources'

const NO_PAN = { noPanMultiple: 2, noPanCapBp: 2000 }
const tourRow: WithholdingRateRow = {
  id: 1, sectionId: 9, effectiveFrom: '2025-04-01', effectiveTo: '2026-03-31', deducteeType: 'any', rateBp: 500,
  thresholdSinglePaise: 0, thresholdAnnualPaise: 0, thresholdBasis: 'fy', thresholdExcessOnly: false, returnCode: 'O',
  noPanRateBp: 500, baseIncludesGst: true, source: 'seeded'
}
const section = { id: 9, rates: [tourRow] }
const slab = tcsSlabOn('206C(1G) TOUR', '2025-08-20')!

describe('s.206C(1G) tour slab', () => {
  it('is in force for FY 2025-26 only, on the seeded code', () => {
    expect(slab).toMatchObject({ limitPaise: 100000000, aboveRateBp: 2000 })
    expect(tcsSlabOn('206C(1G) TOUR', '2025-03-31')).toBeNull()
    expect(tcsSlabOn('206C(1G) TOUR', '2026-03-31')).not.toBeNull()
    // FA 2026 s.85(f): flat 2 % from 1 Apr 2026 — no slab.
    expect(tcsSlabOn('206C(1G) TOUR', '2026-04-01')).toBeNull()
    expect(tcsSlabOn('206C(1) SCRAP', '2025-08-20')).toBeNull()
  })

  it('splits one collection across the limit and rounds once', () => {
    const rate = applicableRate(section, '2025-08-20', null, true, null, NO_PAN)!
    // Prior ₹6,30,000; now ₹4,20,000. Inside: ₹10,00,000 − ₹6,30,000 = ₹3,70,000 × 5 % = ₹18,500;
    // above: ₹4,20,000 − ₹3,70,000 = ₹50,000 × 20 % = ₹10,000. TCS ₹28,500.
    expect(slabbedTcs(rate, slab, 42000000, 63000000, NO_PAN)).toEqual({
      tcsPaise: 2850000, belowPaise: 37000000, abovePaise: 5000000, lowerRateBp: 500, upperRateBp: 2000, certificatePaise: 0, limitPaise: 100000000
    })
    // Wholly inside: ₹6,30,000 × 5 % = ₹31,500.
    expect(slabbedTcs(rate, slab, 63000000, 0, NO_PAN).tcsPaise).toBe(3150000)
    // Wholly above (prior ₹10,50,000): ₹1,05,000 × 20 % = ₹21,000.
    expect(slabbedTcs(rate, slab, 10500000, 105000000, NO_PAN)).toMatchObject({ tcsPaise: 2100000, belowPaise: 0, abovePaise: 10500000 })
    // Exactly at the limit stays at 5 %: ₹10,00,000 × 5 % = ₹50,000.
    expect(slabbedTcs(rate, slab, 100000000, 0, NO_PAN)).toMatchObject({ tcsPaise: 5000000, abovePaise: 0 })
    // Rupee rounding once over both parts: ₹10,00,000.50 from nil → inside ₹10,00,000 × 5 % = ₹50,000;
    // 50 paise × 20 % = 10 paise; ₹50,000.10 → ₹50,000.
    expect(slabbedTcs(rate, slab, 100000050, 0, NO_PAN).tcsPaise).toBe(5000000)
  })

  it('without a PAN each part takes the higher of twice its rate and 5 %, at most 20 % (s.206CC)', () => {
    const rate = applicableRate(section, '2025-06-10', null, false, null, NO_PAN)!
    expect(rate).toMatchObject({ basis: 'no_pan', rateBp: 1000 })
    // ₹10,50,000 from nil: ₹10,00,000 × 10 % = ₹1,00,000 + ₹50,000 × 20 % (40 % capped) = ₹10,000.
    expect(slabbedTcs(rate, slab, 105000000, 0, NO_PAN)).toMatchObject({ tcsPaise: 11000000, lowerRateBp: 1000, upperRateBp: 2000 })
  })

  it('a capped certificate covers its part first, the slab runs on the rest', () => {
    const cert = { id: 1, ledgerId: 2, sectionId: 9, certificateNo: 'C1', rateBp: 100, validFrom: '2025-04-01', validTo: '2026-03-31', capPaise: 20000000 }
    const rate = applicableRate(section, '2025-06-10', null, true, { certificate: cert, consumedPaise: 0 }, NO_PAN)!
    // ₹12,00,000 from nil: ₹2,00,000 at 1 % = ₹2,000; then prior ₹2,00,000: ₹8,00,000 × 5 % = ₹40,000
    // and ₹2,00,000 × 20 % = ₹40,000. TCS ₹82,000.
    expect(slabbedTcs(rate, slab, 120000000, 0, NO_PAN)).toMatchObject({
      tcsPaise: 8200000, certificatePaise: 20000000, belowPaise: 80000000, abovePaise: 20000000
    })
  })
})

describe('TCS sources', () => {
  it('every slab and statutory row cites sources that exist, with URLs and access dates', () => {
    const keys = new Set(TCS_SOURCES.map((s) => s.key))
    expect(keys.size).toBe(TCS_SOURCES.length)
    for (const s of TCS_SLABS) for (const k of s.sources) expect(keys.has(k)).toBe(true)
    for (const s of TCS_SOURCES) {
      expect(s.url).toMatch(/^https:\/\//)
      expect(s.accessed).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(s.quote.length).toBeGreaterThan(40)
    }
    for (const sec of TCS_STATUTORY_SECTIONS) {
      expect(sec.code.length).toBeLessThanOrEqual(20)
      for (const r of sec.rates) expect(r.source).toMatch(/https:\/\/.*accessed 2026-10-17/)
    }
    expect(TCS_UNVERIFIED.length).toBeGreaterThan(3)
    expect(TCS_NOT_MODELLED.some((n) => /authori[sz]ed dealer/i.test(n.text))).toBe(true)
  })

  it('s.206C(1C): 2 % on each of parking lot / toll plaza / mine, 27EQ F / G / H then Form 143 1090 / 1091 / 1092', () => {
    expect(TCS_STATUTORY_SECTIONS.map((s) => [s.code, s.rates.map((r) => [r.effectiveFrom, r.effectiveTo, r.rateBp, r.noPanRateBp, r.returnCode])])).toEqual([
      ['206C(1C) PARKING', [['2025-04-01', '2026-03-31', 200, 500, 'F'], ['2026-04-01', null, 200, 500, '1090']]],
      ['206C(1C) TOLL', [['2025-04-01', '2026-03-31', 200, 500, 'G'], ['2026-04-01', null, 200, 500, '1091']]],
      ['206C(1C) MINE', [['2025-04-01', '2026-03-31', 200, 500, 'H'], ['2026-04-01', null, 200, 500, '1092']]]
    ])
  })
})
