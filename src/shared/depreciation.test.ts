import { describe, expect, it } from 'vitest'
import {
  daysInUseDuring,
  depreciateBlock,
  depreciateCompaniesAct,
  disposeAsset,
  HALF_RATE_DAYS,
  wdvRateFor,
  type CompaniesActAsset
} from './depreciation'

const asset = (over: Partial<CompaniesActAsset> = {}): CompaniesActAsset => ({
  cost: 1_00_000_00,
  residualValue: 5_000_00,
  usefulLifeMonths: 60,
  method: 'slm',
  putToUseDate: '2026-04-01',
  openingWdv: 1_00_000_00,
  accumulated: 0,
  ...over
})

describe('Companies Act — straight line', () => {
  it('spreads cost less residual evenly over the life', () => {
    // (1,00,000 − 5,000) / 5 years = 19,000 a year.
    const r = depreciateCompaniesAct(asset(), '2026-04-01', '2027-03-31')
    expect(r.heldFraction).toBe(1)
    expect(r.depreciation).toBe(19_000_00)
    expect(r.closingWdv).toBe(81_000_00)
  })

  it('pro-rates by days from the day it was put to use, not the day it was bought', () => {
    // Put to use 14 March: 18 days of a 365-day year.
    const r = depreciateCompaniesAct(asset({ putToUseDate: '2027-03-14' }), '2026-04-01', '2027-03-31')
    expect(r.heldFraction).toBeCloseTo(18 / 365, 6)
    expect(r.depreciation).toBe(Math.floor(19_000_00 * (18 / 365)))
  })

  it('charges nothing for an asset put to use after the year ended', () => {
    const r = depreciateCompaniesAct(asset({ putToUseDate: '2027-06-01' }), '2026-04-01', '2027-03-31')
    expect(r.depreciation).toBe(0)
    expect(r.closingWdv).toBe(1_00_000_00)
  })

  it('never depreciates below the residual value', () => {
    const r = depreciateCompaniesAct(asset({ openingWdv: 12_000_00 }), '2026-04-01', '2027-03-31')
    // Only 7,000 of depreciable value is left, not the 19,000 the formula wants.
    expect(r.depreciation).toBe(7_000_00)
    expect(r.closingWdv).toBe(5_000_00)
    expect(r.cappedAtResidual).toBe(true)
  })

  it('stops entirely once it is at the residual value', () => {
    const r = depreciateCompaniesAct(asset({ openingWdv: 5_000_00 }), '2026-04-01', '2027-03-31')
    expect(r.depreciation).toBe(0)
    expect(r.cappedAtResidual).toBe(true)
  })
})

describe('Companies Act — written-down value', () => {
  it('derives the rate that reaches the residual value over the life', () => {
    // 1 − (5,000/1,00,000)^(1/5) ≈ 0.4507
    const rate = wdvRateFor(1_00_000_00, 5_000_00, 60)
    expect(rate).toBeCloseTo(1 - Math.pow(0.05, 1 / 5), 6)
    // Applying it five times must land on the residual.
    let wdv = 1_00_000_00
    for (let i = 0; i < 5; i++) wdv -= wdv * rate
    expect(wdv).toBeCloseTo(5_000_00, -2)
  })

  it('charges more in the first year than straight line, and less later', () => {
    const first = depreciateCompaniesAct(asset({ method: 'wdv' }), '2026-04-01', '2027-03-31')
    const line = depreciateCompaniesAct(asset(), '2026-04-01', '2027-03-31')
    expect(first.depreciation).toBeGreaterThan(line.depreciation)

    const later = depreciateCompaniesAct(
      asset({ method: 'wdv', openingWdv: 20_000_00 }),
      '2026-04-01',
      '2027-03-31'
    )
    expect(later.depreciation).toBeLessThan(line.depreciation)
  })

  it('assumes a nominal residual rather than dividing by a rate that cannot exist', () => {
    // No percentage ever reaches zero, so a zero residual is treated as ₹1.
    expect(wdvRateFor(1_00_000_00, 0, 60)).toBeGreaterThan(0)
    expect(wdvRateFor(1_00_000_00, 0, 60)).toBeLessThan(1)
    expect(wdvRateFor(0, 0, 60)).toBe(0)
    expect(wdvRateFor(1_00_000_00, 2_00_000_00, 60)).toBe(0)
  })
})

describe('Income tax — blocks of assets', () => {
  const block = { blockName: 'Plant and machinery — general', rate: 15, openingWdv: 10_00_000_00, deletions: 0 }

  it('charges the full rate on the pool', () => {
    const r = depreciateBlock({ ...block, additions: [] })
    expect(r.depreciation).toBe(1_50_000_00)
    expect(r.closingWdv).toBe(8_50_000_00)
  })

  it('halves the rate for an addition used under 180 days, and not otherwise', () => {
    const late = depreciateBlock({
      ...block,
      openingWdv: 0,
      additions: [{ cost: 1_00_000_00, putToUseDate: '2027-01-01', daysInUse: 90 }]
    })
    expect(late.additionsHalfRate).toBe(1_00_000_00)
    expect(late.depreciation).toBe(7_500_00)

    const early = depreciateBlock({
      ...block,
      openingWdv: 0,
      additions: [{ cost: 1_00_000_00, putToUseDate: '2026-04-01', daysInUse: 365 }]
    })
    expect(early.additionsFullRate).toBe(1_00_000_00)
    expect(early.depreciation).toBe(15_000_00)
  })

  it('treats exactly 180 days as the full rate', () => {
    const r = depreciateBlock({
      ...block,
      openingWdv: 0,
      additions: [{ cost: 1_00_000_00, putToUseDate: '2026-10-03', daysInUse: HALF_RATE_DAYS }]
    })
    expect(r.additionsFullRate).toBe(1_00_000_00)
  })

  it('does not pro-rate an existing asset by days — only the year of acquisition matters', () => {
    const r = depreciateBlock({ ...block, additions: [] })
    expect(r.depreciation).toBe(Math.floor((10_00_000_00 * 15) / 100))
  })

  it('reduces the block by a sale rather than booking a gain on the asset', () => {
    const r = depreciateBlock({ ...block, deletions: 4_00_000_00, additions: [] })
    expect(r.writtenDownBeforeDepreciation).toBe(6_00_000_00)
    expect(r.depreciation).toBe(90_000_00)
    expect(r.shortTermGain).toBe(0)
  })

  it('allows no depreciation when a sale exhausts the block, and names the capital gain', () => {
    const r = depreciateBlock({ ...block, deletions: 12_00_000_00, additions: [] })
    expect(r.blockExhausted).toBe(true)
    expect(r.depreciation).toBe(0)
    expect(r.closingWdv).toBe(0)
    expect(r.shortTermGain).toBe(2_00_000_00)
  })

  it('takes deletions off the full-rate pool first, so the half-rate concession is not overstated', () => {
    const r = depreciateBlock({
      ...block,
      openingWdv: 5_00_000_00,
      deletions: 5_00_000_00,
      additions: [{ cost: 1_00_000_00, putToUseDate: '2027-01-01', daysInUse: 90 }]
    })
    // The whole opening pool is gone; only the half-rate addition is left.
    expect(r.depreciation).toBe(7_500_00)
  })

  it('counts days in use for the 180-day test from the put-to-use date', () => {
    expect(daysInUseDuring('2026-04-01', '2026-04-01', '2027-03-31')).toBe(365)
    expect(daysInUseDuring('2027-03-31', '2026-04-01', '2027-03-31')).toBe(1)
    expect(daysInUseDuring('2027-06-01', '2026-04-01', '2027-03-31')).toBe(0)
    // 3 October to 31 March is exactly 180 days.
    expect(daysInUseDuring('2026-10-03', '2026-04-01', '2027-03-31')).toBe(180)
  })
})

describe('disposal', () => {
  it('books a profit or loss for the books and says the return does neither', () => {
    const profit = disposeAsset(50_000_00, 70_000_00, 'Computers and software')
    expect(profit.profitOrLoss).toBe(20_000_00)
    expect(profit.incomeTaxTreatment).toContain('no gain or loss on the asset itself')

    const loss = disposeAsset(50_000_00, 30_000_00, 'Computers and software')
    expect(loss.profitOrLoss).toBe(-20_000_00)
  })
})

describe('the two treatments genuinely differ', () => {
  it('gives different numbers for the same asset, which is the point', () => {
    const companies = depreciateCompaniesAct(
      asset({ cost: 1_00_000_00, usefulLifeMonths: 36, residualValue: 5_000_00 }),
      '2026-04-01',
      '2027-03-31'
    )
    const tax = depreciateBlock({
      blockName: 'Computers and software',
      rate: 40,
      openingWdv: 0,
      deletions: 0,
      additions: [{ cost: 1_00_000_00, putToUseDate: '2026-04-01', daysInUse: 365 }]
    })
    // A computer: three-year life in the books, 40% WDV in the return. Neither is wrong.
    expect(companies.depreciation).not.toBe(tax.depreciation)
    expect(companies.depreciation).toBeGreaterThan(0)
    expect(tax.depreciation).toBe(40_000_00)
  })
})

describe('an asset that leaves mid-year', () => {
  it('is depreciated for the days it was held, against the full year', () => {
    // Sold 30 September: 183 days of a 365-day year.
    const r = depreciateCompaniesAct(asset(), '2026-04-01', '2027-03-31', '2026-09-30')
    expect(r.heldFraction).toBeCloseTo(183 / 365, 6)
    expect(r.depreciation).toBe(Math.floor(19_000_00 * (183 / 365)))
  })

  it('is not handed a full year by shortening the year instead of the holding', () => {
    const shortened = depreciateCompaniesAct(asset(), '2026-04-01', '2026-09-30')
    const held = depreciateCompaniesAct(asset(), '2026-04-01', '2027-03-31', '2026-09-30')
    // The first reads as a six-month year and charges the whole annual amount; the second is right.
    expect(shortened.heldFraction).toBe(1)
    expect(held.heldFraction).toBeLessThan(1)
    expect(held.depreciation).toBeLessThan(shortened.depreciation)
  })

  it('ignores a disposal after the year ended', () => {
    const r = depreciateCompaniesAct(asset(), '2026-04-01', '2027-03-31', '2028-01-01')
    expect(r.heldFraction).toBe(1)
  })
})
