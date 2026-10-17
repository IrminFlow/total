// s.18(6) CGST Act working — hand-worked figures in paise (texts in fixedAssetSources.ts).
import { describe, expect, it } from 'vitest'
import { capitalGoodsSale, capitalGoodsWorkingText, quartersOrPart, wholeMonthsUsed, ZERO_TAX_HEADS } from './capitalGoodsGst'

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
})

describe('capitalGoodsSale', () => {
  it('pays the higher of the credit-based amount and the tax on the value, the excess in the supply heads', () => {
    // ITC ₹18,000 (₹9,000 + ₹9,000) on a ₹1,00,000 machine invoiced 1 Apr 2025; sold 15 Sep 2026
    // within the State for ₹50,000 @ 18% ⇒ tax on the value ₹4,500 + ₹4,500.
    // rule 40(2): 6 quarters (or part) ⇒ less 30 points ⇒ 18,000 × 70% = 12,600.
    // rule 44(6): 17 whole months used ⇒ 43 of 60 left ⇒ 18,000 × 43 / 60 = 12,900 (the higher).
    // 12,900 > 9,000 ⇒ s.18(6) amount 12,900; extra output tax 3,900 = CGST 1,950 + SGST 1,950.
    const w = capitalGoodsSale({ itc: intra(900_000), invoiceDate: '2025-04-01', supplyDate: '2026-09-15', taxOnValue: intra(450_000), supply: 'intra' })
    expect(w.rule40).toEqual({ quarters: 6, reductionBp: 3000, heads: intra(630_000) })
    expect(w.rule44).toEqual({ monthsUsed: 17, remainingMonths: 43, heads: intra(645_000) })
    expect(w.creditBased).toEqual(intra(645_000))
    expect(w.excess).toEqual(intra(195_000))
    expect(w.payable).toEqual(intra(645_000))
    expect(capitalGoodsWorkingText(w)).toBe(
      's.18(6) CGST Act: ITC ₹18,000.00; rule 40(2) 6 quarters → less 30 points = ₹12,600.00; rule 44(6) 43/60 months left = ₹12,900.00; tax on the value ₹9,000.00; higher = ₹12,900.00 (extra output tax ₹3,900.00)'
    )
  })

  it('credit taken as IGST, sold within the State: the excess is CGST + SGST (odd paisa to CGST)', () => {
    // ITC IGST 10,000.01 (1,000,001 paise), 59 whole months used ⇒ 1/60 ⇒ 16,666.68 → 16,667 paise;
    // rule 40(2) after 20 quarters ⇒ 100 points ⇒ 0. Tax on the value 0 (a free disposal) ⇒ excess
    // 16,667 = CGST 8,334 + SGST 8,333.
    const w = capitalGoodsSale({ itc: { ...ZERO_TAX_HEADS, igst: 1_000_001 }, invoiceDate: '2020-04-01', supplyDate: '2025-03-15', taxOnValue: ZERO_TAX_HEADS, supply: 'intra' })
    expect(w.rule40.heads.igst).toBe(0)
    expect(w.rule44).toMatchObject({ monthsUsed: 59, remainingMonths: 1 })
    expect(w.excess).toEqual({ igst: 0, cgst: 8_334, sgst: 8_333, cess: 0 })
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
