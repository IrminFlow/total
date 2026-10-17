// s.18(6) CGST Act working — hand-worked figures in paise (texts in fixedAssetSources.ts).
import { describe, expect, it } from 'vitest'
import { capitalGoodsSale, capitalGoodsWorkingText, monthsUsedOrPart, quartersOrPart, wholeMonthsUsed, ZERO_TAX_HEADS } from './capitalGoodsGst'

const intra = (cgst: number): typeof ZERO_TAX_HEADS => ({ ...ZERO_TAX_HEADS, cgst, sgst: cgst })

describe('counting from the invoice date', () => {
  it('quarters or part thereof', () => {
    expect(quartersOrPart('2025-04-01', '2025-04-01')).toBe(1)
    expect(quartersOrPart('2025-04-01', '2025-06-30')).toBe(1)
    expect(quartersOrPart('2025-04-01', '2025-07-01')).toBe(2)
    expect(quartersOrPart('2025-04-01', '2026-09-15')).toBe(6)
    expect(() => quartersOrPart('2025-04-01', '2025-03-31')).toThrow(/before/)
  })
  it('whole months used', () => {
    expect(wholeMonthsUsed('2025-04-01', '2025-04-30')).toBe(0)
    expect(wholeMonthsUsed('2025-04-01', '2025-05-01')).toBe(1)
    expect(wholeMonthsUsed('2025-04-01', '2026-09-15')).toBe(17)
    expect(wholeMonthsUsed('2025-01-31', '2025-02-28')).toBe(1)
  })
  it('a part of a month counts as used for rule 44(1)(b) — its illustration: 4 years 6 months 15 days ⇒ 5 months remain', () => {
    expect(monthsUsedOrPart('2020-10-01', '2025-04-16')).toBe(55) // 54 whole + 15 days ⇒ 60 − 55 = 5 left
    expect(monthsUsedOrPart('2025-04-01', '2025-04-01')).toBe(0)
    expect(monthsUsedOrPart('2025-04-01', '2025-04-02')).toBe(1)
    expect(monthsUsedOrPart('2025-04-01', '2025-05-01')).toBe(1)
    expect(capitalGoodsSale({ itc: intra(300_000), invoiceDate: '2020-10-01', supplyDate: '2025-04-16', taxOnValue: ZERO_TAX_HEADS, supply: 'intra' }).rule44)
      .toEqual({ monthsUsed: 55, remainingMonths: 5, heads: intra(25_000) }) // 3,000 × 5/60 = 250 each head
  })
})

describe('capitalGoodsSale', () => {
  it('pays the higher of the credit-based amount and the tax on the value, the excess in the supply heads', () => {
    // ITC ₹18,000 (₹9,000 + ₹9,000) on a ₹1,00,000 machine invoiced 1 Apr 2025; sold 15 Sep 2026
    // within the State for ₹50,000 @ 18% ⇒ tax on the value ₹4,500 + ₹4,500.
    // rule 40(2): 6 quarters (or part) ⇒ less 30 points ⇒ 18,000 × 70% = 12,600.
    // rule 44(6): 17 months 14 days used ⇒ 18 months (a part counts) ⇒ 42 of 60 left ⇒ 18,000 × 42 / 60 = 12,600.
    // 12,600 > 9,000 ⇒ s.18(6) amount 12,600; extra output tax 3,600 = CGST 1,800 + SGST 1,800.
    const w = capitalGoodsSale({ itc: intra(900_000), invoiceDate: '2025-04-01', supplyDate: '2026-09-15', taxOnValue: intra(450_000), supply: 'intra' })
    expect(w.rule40).toEqual({ quarters: 6, reductionBp: 3000, heads: intra(630_000) })
    expect(w.rule44).toEqual({ monthsUsed: 18, remainingMonths: 42, heads: intra(630_000) })
    expect(w.creditBased).toEqual(intra(630_000))
    expect(w.excess).toEqual(intra(180_000))
    expect(w.payable).toEqual(intra(630_000))
    expect(capitalGoodsWorkingText(w)).toBe(
      's.18(6) CGST Act: ITC ₹18,000.00; rule 40(2) 6 quarters → less 30 points = ₹12,600.00; rule 44(6) 42/60 months left = ₹12,600.00; tax on the value ₹9,000.00; higher = ₹12,600.00 (extra output tax ₹3,600.00)'
    )
    // One day into the 18th month the two rules part: 2026-09-02 is 17 months 1 day ⇒ still 42/60;
    // 2026-09-01 exactly is 17 whole months ⇒ 43/60 = 12,900, the higher.
    const exact = capitalGoodsSale({ itc: intra(900_000), invoiceDate: '2025-04-01', supplyDate: '2026-09-01', taxOnValue: intra(450_000), supply: 'intra' })
    expect(exact.rule44).toEqual({ monthsUsed: 17, remainingMonths: 43, heads: intra(645_000) })
    expect(exact.excess).toEqual(intra(195_000))
  })

  it('credit taken as IGST, sold within the State: the excess is CGST + SGST (odd paisa to CGST)', () => {
    // ITC IGST 10,000.01 (1,000,001 paise), exactly 59 months used ⇒ 1/60 ⇒ 16,666.68 → 16,667 paise;
    // rule 40(2) after 20 quarters ⇒ 100 points ⇒ 0. Tax on the value 0 (a free disposal) ⇒ excess
    // 16,667 = CGST 8,334 + SGST 8,333. (A day later the 60th month is part-used ⇒ 0/60 ⇒ nothing.)
    const w = capitalGoodsSale({ itc: { ...ZERO_TAX_HEADS, igst: 1_000_001 }, invoiceDate: '2020-04-01', supplyDate: '2025-03-01', taxOnValue: ZERO_TAX_HEADS, supply: 'intra' })
    expect(w.rule40.heads.igst).toBe(0)
    expect(w.rule44).toMatchObject({ monthsUsed: 59, remainingMonths: 1 })
    expect(w.excess).toEqual({ igst: 0, cgst: 8_334, sgst: 8_333, cess: 0 })
    expect(capitalGoodsSale({ itc: { ...ZERO_TAX_HEADS, igst: 1_000_001 }, invoiceDate: '2020-04-01', supplyDate: '2025-03-02', taxOnValue: ZERO_TAX_HEADS, supply: 'intra' }).rule44)
      .toMatchObject({ monthsUsed: 60, remainingMonths: 0 })
  })

  it('the tax on the value wins when it is higher; no credit = the ordinary tax; the scrap proviso pays the value only', () => {
    const high = capitalGoodsSale({ itc: intra(100_000), invoiceDate: '2025-04-01', supplyDate: '2025-05-01', taxOnValue: intra(450_000), supply: 'intra' })
    expect(high.excess).toEqual(ZERO_TAX_HEADS)
    expect(high.payable).toEqual(intra(450_000))
    const none = capitalGoodsSale({ itc: ZERO_TAX_HEADS, invoiceDate: '2025-04-01', supplyDate: '2026-09-15', taxOnValue: { ...ZERO_TAX_HEADS, igst: 900_000 }, supply: 'inter' })
    expect(none.excess).toEqual(ZERO_TAX_HEADS)
    expect(capitalGoodsWorkingText(none)).toBe('GST on the value ₹9,000.00 (no input tax credit on the goods)')
    const scrap = capitalGoodsSale({ itc: intra(900_000), invoiceDate: '2025-04-01', supplyDate: '2026-09-15', taxOnValue: intra(10_000), supply: 'intra', scrapProviso: true })
    expect(scrap.excess).toEqual(ZERO_TAX_HEADS)
    expect(scrap.payable).toEqual(intra(10_000))
  })
})
