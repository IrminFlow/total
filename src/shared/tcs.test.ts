import { describe, expect, it } from 'vitest'
import { computeTcs, tcsAppliesToSeller, TCS_THRESHOLD_PAISE } from './tcs'

describe('tcsAppliesToSeller', () => {
  it('applies only above ₹10 crore of preceding-year turnover', () => {
    expect(tcsAppliesToSeller('10Cr-plus')).toBe(true)
    expect(tcsAppliesToSeller('5Cr-10Cr')).toBe(false) // the band's whole range is under it
    expect(tcsAppliesToSeller('1.5Cr-5Cr')).toBe(false)
  })

  it('says nothing when turnover was never declared', () => {
    // Warning a business that never told us its turnover about a threshold that probably does
    // not apply is noise that gets the whole feature ignored.
    expect(tcsAppliesToSeller(null)).toBe(false)
  })
})

describe('computeTcs', () => {
  it('collects nothing below the threshold', () => {
    const t = computeTcs({ receiptsThisFy: TCS_THRESHOLD_PAISE, hasPan: true })
    expect(t.crossed).toBe(false)
    expect(t.excess).toBe(0)
    expect(t.collectible).toBe(0)
  })

  it('collects 0.1% of the excess, not of the whole receipt', () => {
    // A buyer who pays ₹49 lakh and then ₹2 lakh owes on ₹1 lakh, not on ₹2 lakh.
    const t = computeTcs({ receiptsThisFy: TCS_THRESHOLD_PAISE + 1_00_000_00, hasPan: true })
    expect(t.excess).toBe(1_00_000_00) // ₹1,00,000
    expect(t.collectible).toBe(1_000_0) // 0.1% of ₹1,00,000 = ₹100 = 10,000 paise
  })

  it('charges ten times as much without a PAN', () => {
    const withPan = computeTcs({ receiptsThisFy: TCS_THRESHOLD_PAISE + 1_00_000_00, hasPan: true })
    const without = computeTcs({ receiptsThisFy: TCS_THRESHOLD_PAISE + 1_00_000_00, hasPan: false })
    expect(without.ratePercent).toBe(1)
    expect(without.collectible).toBe(withPan.collectible * 10)
  })

  it('keeps the arithmetic in integer paise', () => {
    for (const extra of [1, 7, 999, 1_23_456]) {
      const t = computeTcs({ receiptsThisFy: TCS_THRESHOLD_PAISE + extra, hasPan: true })
      expect(Number.isInteger(t.collectible)).toBe(true)
      expect(Number.isInteger(t.excess)).toBe(true)
    }
  })

  it('nets off what has already been collected', () => {
    const t = computeTcs({
      receiptsThisFy: TCS_THRESHOLD_PAISE + 10_00_000_00,
      hasPan: true,
      alreadyCollected: 50_000
    })
    expect(t.collectible).toBe(1_00_000)
    expect(t.outstanding).toBe(50_000)
  })

  it('never reports a negative outstanding when more was collected than due', () => {
    // Over-collection is a refund question, not a negative liability.
    const t = computeTcs({
      receiptsThisFy: TCS_THRESHOLD_PAISE + 1_00_000_00,
      hasPan: true,
      alreadyCollected: 99_999_99
    })
    expect(t.outstanding).toBe(0)
  })

  it('is computed on cumulative receipts, so payment order cannot change the answer', () => {
    const oneGo = computeTcs({ receiptsThisFy: TCS_THRESHOLD_PAISE + 5_00_000_00, hasPan: true })
    const inParts = computeTcs({
      receiptsThisFy: TCS_THRESHOLD_PAISE + 2_00_000_00 + 3_00_000_00,
      hasPan: true
    })
    expect(inParts.collectible).toBe(oneGo.collectible)
  })
})
