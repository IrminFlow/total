import { describe, expect, it } from 'vitest'
import { fyFromStartYear } from './dates'
import {
  addMonths, companiesActPeriod, daysInclusive, disposalLines, itBlockYear, lifeEndDate, mulDivRound,
  remainingMilliMonths, residualOf, scheduleTotals, wdvRatePpb, wdvRatePpbForLife, type CaAssetInput
} from './depreciation'

const R = (rupees: number): number => Math.round(rupees * 100)
const FY25 = { from: '2025-04-01', to: '2026-03-31' }
const FY26 = { from: '2026-04-01', to: '2027-03-31' }

function asset(over: Partial<CaAssetInput> = {}): CaAssetInput {
  return {
    method: 'slm',
    residualBp: 500,
    lifeMonths: 120,
    putToUseDate: '2025-04-01',
    disposalDate: null,
    layers: [{ date: '2025-04-01', amount: R(100000) }],
    basisDate: over.putToUseDate ?? '2025-04-01',
    accBeforeBasis: 0,
    accBeforeFy: 0,
    accInFyBeforePeriod: 0,
    depreciatedThrough: null,
    ...over
  }
}

describe('helpers', () => {
  it('counts days inclusively and adds calendar months', () => {
    expect(daysInclusive('2025-04-01', '2026-03-31')).toBe(365)
    expect(daysInclusive('2027-04-01', '2028-03-31')).toBe(366)
    expect(daysInclusive('2025-04-02', '2025-04-01')).toBe(0)
    expect(addMonths('2025-01-31', 1)).toBe('2025-02-28')
    expect(addMonths('2025-04-01', 120)).toBe('2035-04-01')
    expect(lifeEndDate('2025-04-01', 120)).toBe('2035-03-31')
  })

  it('rounds half away from zero, exactly, beyond 2^53 intermediates', () => {
    expect(mulDivRound(1, 1, 2)).toBe(1)
    expect(mulDivRound(-1, 1, 2)).toBe(-1)
    expect(mulDivRound(1, 1, 3)).toBe(0)
    expect(mulDivRound(9_000_000_000_000, 999_999, 1_000_000)).toBe(8_999_991_000_000)
    expect(() => mulDivRound(2 ** 53, 1, 1)).toThrow(/safe integers/)
    expect(residualOf(R(100000), 500)).toBe(R(5000))
  })

  it('measures the remaining life in thousandths of a month', () => {
    expect(remainingMilliMonths('2025-04-01', '2035-04-01')).toBe(120_000)
    expect(remainingMilliMonths('2027-04-01', '2031-04-01')).toBe(48_000)
    // 15 Jul 2025 → 1 Apr 2027: 20 whole months (to 15 Mar 2027) + 17 of March's 31 days.
    expect(remainingMilliMonths('2025-07-15', '2027-04-01')).toBe(20_548)
  })

  it('derives the WDV rate from the life and residual (1 − r^(1/n))', () => {
    // 5% residual: 10 years ⇒ 25.89%, 15 years ⇒ 18.10% (18.1036), 5 years ⇒ 45.07%, 3 years ⇒ 63.16%.
    const ppm = (ppb: number): number => Math.round(ppb / 1000)
    expect(ppm(wdvRatePpbForLife(500, 120))).toBe(258866)
    expect(ppm(wdvRatePpbForLife(500, 180))).toBe(181036)
    expect(ppm(wdvRatePpbForLife(500, 60))).toBe(450720)
    expect(ppm(wdvRatePpbForLife(500, 36))).toBe(631597)
    expect(() => wdvRatePpb(100, 0, 12000)).toThrow(/residual/)
  })
})

describe('Companies Act — SLM', () => {
  it('ICAI GN(A) 35 ¶41: ₹5,00,000 over 10 years with no residual ⇒ ₹50,000 a year', () => {
    const r = companiesActPeriod(asset({ residualBp: 0, layers: [{ date: '2025-04-01', amount: R(500000) }] }), FY25)
    expect(r.depreciation).toBe(R(50000))
  })

  it('charges (cost − residual) ÷ life for a full year', () => {
    // ₹1,00,000, residual 5%, 10 years: (1,00,000 − 5,000) ÷ 10 = ₹9,500.
    const r = companiesActPeriod(asset(), FY25)
    expect(r.depreciation).toBe(R(9500))
    expect(r.daysUsed).toBe(365)
    expect(r.openingWdv).toBe(0)
    expect(r.additions).toBe(R(100000))
    expect(r.closingWdv).toBe(R(90500))
  })

  it('a leap financial year still charges exactly the annual amount', () => {
    const r = companiesActPeriod(asset({ accBeforeFy: R(19000), depreciatedThrough: '2027-03-31' }), { from: '2027-04-01', to: '2028-03-31' })
    expect(r.daysUsed).toBe(366)
    expect(r.depreciation).toBe(R(9500))
  })

  it('pro-rates from the date the asset is available for use', () => {
    // Put to use 1 Oct 2025: 182 of 365 days ⇒ 9,500 × 182 / 365 = 4,736.986… ⇒ ₹4,736.99.
    const a = asset({ putToUseDate: '2025-10-01', layers: [{ date: '2025-10-01', amount: R(100000) }] })
    const r = companiesActPeriod(a, FY25)
    expect(r.daysUsed).toBe(182)
    expect(r.depreciation).toBe(473699)
  })

  it('stops the day before disposal', () => {
    // Sold 1 Oct 2026 ⇒ 183 days (1 Apr – 30 Sep) ⇒ 9,500 × 183 / 365 = 4,763.013… ⇒ ₹4,763.01.
    const r = companiesActPeriod(asset({ disposalDate: '2026-10-01', accBeforeFy: R(9500), depreciatedThrough: '2026-03-31' }), FY26)
    expect(r.daysUsed).toBe(183)
    expect(r.depreciation).toBe(476301)
  })

  it('quarterly runs add up to the annual charge (±1 paisa per run) and never double-charge', () => {
    const q1 = companiesActPeriod(asset(), { from: '2025-04-01', to: '2025-06-30' })
    const q2 = companiesActPeriod(asset({ accInFyBeforePeriod: q1.depreciation, depreciatedThrough: '2025-06-30' }), { from: '2025-07-01', to: '2025-12-31' })
    const q3 = companiesActPeriod(
      asset({ accInFyBeforePeriod: q1.depreciation + q2.depreciation, depreciatedThrough: '2025-12-31' }),
      { from: '2026-01-01', to: '2026-03-31' }
    )
    expect(Math.abs(q1.depreciation + q2.depreciation + q3.depreciation - R(9500))).toBeLessThanOrEqual(2)
    // Re-running Q1 for an asset already depreciated through 30 Jun charges nothing.
    expect(companiesActPeriod(asset({ depreciatedThrough: '2025-06-30' }), { from: '2025-04-01', to: '2025-06-30' }).depreciation).toBe(0)
  })

  it('writes down to the residual in the year the life ends, then charges nothing', () => {
    // Laptop: ₹60,000, 3 years, residual 5% ⇒ ₹19,000 a year; the 3rd year ends the life.
    const base = asset({ lifeMonths: 36, layers: [{ date: '2025-04-01', amount: R(60000) }] })
    let acc = 0
    for (const y of [2025, 2026, 2027]) {
      const fy = fyFromStartYear(y)
      const r = companiesActPeriod({ ...base, accBeforeFy: acc, depreciatedThrough: acc ? `${y}-03-31` : null }, fy)
      expect(r.depreciation).toBe(R(19000))
      acc += r.depreciation
    }
    const after = companiesActPeriod({ ...base, accBeforeFy: acc, depreciatedThrough: '2028-03-31' }, fyFromStartYear(2028))
    expect(after.depreciation).toBe(0)
    expect(after.fullyDepreciated).toBe(true)
    expect(after.openingWdv).toBe(R(3000))
  })

  it('writes off the rounding remainder when the life ends mid-year', () => {
    // Put to use 1 Oct 2025, 1 year: 182 days in FY25 then 183 days in FY26 to 30 Sep 2026.
    const a = asset({ lifeMonths: 12, putToUseDate: '2025-10-01', layers: [{ date: '2025-10-01', amount: R(1000) }] })
    const y1 = companiesActPeriod(a, FY25)
    const y2 = companiesActPeriod({ ...a, accBeforeFy: y1.depreciation, depreciatedThrough: '2026-03-31' }, FY26)
    expect(y1.depreciation + y2.depreciation).toBe(R(950))
    expect(y2.closingWdv).toBe(R(50))
  })

  it('depreciates an improvement over the remaining life from its own date', () => {
    // Improvement of ₹48,000 on 1 Apr 2026, asset life ends 31 Mar 2035 ⇒ 108 months left:
    // (48,000 − 5%) × 12 / 108 = ₹5,066.67 a year, on top of the original ₹9,500.
    const a = asset({ layers: [{ date: '2025-04-01', amount: R(100000) }, { date: '2026-04-01', amount: R(48000) }], accBeforeFy: R(9500), depreciatedThrough: '2026-03-31' })
    const r = companiesActPeriod(a, FY26)
    expect(r.additions).toBe(R(48000))
    expect(r.depreciation).toBe(R(9500) + 506667)
  })

  it('applies a change of useful life prospectively from the start of a year', () => {
    // After two years (₹19,000 booked) the total life is cut to 6 years: carrying ₹81,000 less the
    // ₹5,000 residual over the remaining 4 years ⇒ ₹19,000 a year; earlier years are not restated.
    const a = asset({ lifeMonths: 72, basisDate: '2027-04-01', accBeforeBasis: R(19000), accBeforeFy: R(19000), depreciatedThrough: '2027-03-31' })
    const r = companiesActPeriod(a, { from: '2027-04-01', to: '2028-03-31' })
    expect(r.depreciation).toBe(R(19000))
  })

  it('rejects a period that spans two financial years', () => {
    expect(() => companiesActPeriod(asset(), { from: '2025-04-01', to: '2026-04-30' })).toThrow(/one financial year/)
  })
})

describe('Companies Act — WDV', () => {
  const wdv = (over: Partial<CaAssetInput> = {}): CaAssetInput => asset({ method: 'wdv', ...over })

  it('applies the derived rate to the carrying amount', () => {
    // 25.88656% of ₹1,00,000 = ₹25,886.56; next year the same rate on what is left.
    const y1 = companiesActPeriod(wdv(), FY25)
    expect(Math.round(y1.ratePpb! / 1000)).toBe(258866)
    expect(y1.depreciation).toBe(R(25886.56))
    const y2 = companiesActPeriod(wdv({ accBeforeFy: y1.depreciation, depreciatedThrough: '2026-03-31' }), FY26)
    expect(y2.depreciation).toBe(mulDivRound(R(100000) - y1.depreciation, y1.ratePpb!, 1_000_000_000))
  })

  it('reaches exactly the residual at the end of the life', () => {
    const a = wdv({ lifeMonths: 60, putToUseDate: '2025-07-15', layers: [{ date: '2025-07-15', amount: R(250000) }] })
    let acc = 0
    let last = null as ReturnType<typeof companiesActPeriod> | null
    for (let y = 2025; y <= 2030; y++) {
      last = companiesActPeriod({ ...a, accBeforeFy: acc, depreciatedThrough: acc ? `${y}-03-31` : null }, fyFromStartYear(y))
      acc += last.depreciation
    }
    expect(R(250000) - acc).toBe(R(12500))
    expect(last!.fullyDepreciated).toBe(true)
  })

  it('ICAI Guidance Note GN(A) 35 ¶38: carrying amount over the remaining life at 18.47%', () => {
    // GN(A) 35 (ICAI, Feb 2016) ¶38 worked example: WDV ₹23,63,919, residual ₹2,50,000, remaining
    // life 11 years ⇒ R = 1 − (s/c)^(1/n) = 18.47%; year 1 ₹4,36,690.25, year 2 ₹3,56,019.82,
    // year 11 ₹56,647.43 leaving exactly ₹2,50,000. Modelled as a ₹50,00,000 asset (5% residual =
    // ₹2,50,000) put to use 1 Apr 2014 with a 22-year life, ₹26,36,081 depreciated before a change
    // of estimate effective 1 Apr 2025 (Schedule II Note 7 transition reads the same way).
    const a: CaAssetInput = asset({
      method: 'wdv', putToUseDate: '2014-04-01', lifeMonths: 264, basisDate: '2025-04-01',
      layers: [{ date: '2014-04-01', amount: R(5000000) }], accBeforeBasis: R(2636081)
    })
    expect(wdvRatePpb(R(2363919), R(250000), 132_000)).toBe(184731478)
    const charges: number[] = []
    let acc = R(2636081)
    for (let y = 2025; y <= 2035; y++) {
      const r = companiesActPeriod({ ...a, accBeforeFy: acc, depreciatedThrough: `${y}-03-31` }, fyFromStartYear(y))
      charges.push(r.depreciation)
      acc += r.depreciation
    }
    expect(charges[0]).toBe(R(436690.25))
    expect(charges[1]).toBe(R(356019.82))
    expect(charges[10]).toBe(R(56647.43))
    expect(R(5000000) - acc).toBe(R(250000))
  })

  it('refuses WDV with no residual value', () => {
    expect(() => companiesActPeriod(wdv({ residualBp: 0 }), FY25)).toThrow(/residual/)
  })
})

describe('disposal', () => {
  it('posts a balanced sale voucher with the loss and catch-up depreciation', () => {
    const { lines, figures } = disposalLines({
      gross: R(100000), accumulatedBooked: R(9500), catchUp: 476301, proceeds: R(70000),
      assetLedgerId: 1, accDepLedgerId: 2, depExpenseLedgerId: 3, considerationLedgerId: 4, profitLedgerId: 5, lossLedgerId: 6
    })
    // carrying = 1,00,000 − 9,500 − 4,763.01 = 85,736.99 ⇒ loss ₹15,736.99
    expect(figures.carrying).toBe(8573699)
    expect(figures.profit).toBe(-1573699)
    const dr = lines.filter((l) => l.drCr === 'dr').reduce((s, l) => s + l.amount, 0)
    const cr = lines.filter((l) => l.drCr === 'cr').reduce((s, l) => s + l.amount, 0)
    expect(dr).toBe(cr)
    expect(lines).toEqual([
      { ledgerId: 4, drCr: 'dr', amount: R(70000) },
      { ledgerId: 3, drCr: 'dr', amount: 476301 },
      { ledgerId: 2, drCr: 'dr', amount: R(9500) },
      { ledgerId: 1, drCr: 'cr', amount: R(100000) },
      { ledgerId: 6, drCr: 'dr', amount: 1573699 }
    ])
  })

  it('a scrap with no proceeds needs no consideration account; a gain is credited', () => {
    expect(disposalLines({
      gross: R(1000), accumulatedBooked: R(950), catchUp: 0, proceeds: 0,
      assetLedgerId: 1, accDepLedgerId: 2, depExpenseLedgerId: 3, considerationLedgerId: null, profitLedgerId: 5, lossLedgerId: 6
    }).lines).toEqual([{ ledgerId: 2, drCr: 'dr', amount: R(950) }, { ledgerId: 1, drCr: 'cr', amount: R(1000) }, { ledgerId: 6, drCr: 'dr', amount: R(50) }])
    const gain = disposalLines({
      gross: R(1000), accumulatedBooked: R(950), catchUp: 0, proceeds: R(200),
      assetLedgerId: 1, accDepLedgerId: 2, depExpenseLedgerId: 3, considerationLedgerId: 4, profitLedgerId: 5, lossLedgerId: 6
    })
    expect(gain.lines.at(-1)).toEqual({ ledgerId: 5, drCr: 'cr', amount: R(150) })
    expect(() => disposalLines({
      gross: R(1000), accumulatedBooked: 0, catchUp: 0, proceeds: R(200),
      assetLedgerId: 1, accDepLedgerId: 2, depExpenseLedgerId: 3, considerationLedgerId: null, profitLedgerId: 5, lossLedgerId: 6
    })).toThrow(/proceeds/)
  })
})

describe('schedule totals', () => {
  it('gross − accumulated = net, opening and closing', () => {
    const t = scheduleTotals([
      { grossOpening: 100, grossAdditions: 50, grossDisposals: 30, accOpening: 20, accCharge: 10, accDisposals: 5 },
      { grossOpening: 0, grossAdditions: 10, grossDisposals: 0, accOpening: 0, accCharge: 1, accDisposals: 0 }
    ])
    expect(t).toEqual({
      grossOpening: 100, grossAdditions: 60, grossDisposals: 30, grossClosing: 130,
      accOpening: 20, accCharge: 11, accDisposals: 5, accClosing: 26, netOpening: 80, netClosing: 104
    })
  })
})

describe('Income-tax block of assets', () => {
  const fy = fyFromStartYear(2025)

  it('full rate, half rate under 180 days, sale proceeds off the full-rate base', () => {
    // Plant & machinery @15%: opening ₹10,00,000; ₹2,00,000 put to use 1 Jun 2025 (304 days);
    // ₹1,00,000 put to use 15 Dec 2025 (107 days < 180 ⇒ 7.5%); a machine sold for ₹50,000.
    // Full: (10,00,000 + 2,00,000 − 50,000) × 15% = 1,72,500; half: 1,00,000 × 7.5% = 7,500.
    const r = itBlockYear({
      fy, rateBp: 1500, openingWdv: R(1000000), saleProceeds: R(50000), blockCeases: false,
      additions: [{ putToUseDate: '2025-06-01', amount: R(200000) }, { putToUseDate: '2025-12-15', amount: R(100000) }]
    })
    expect(r.additionsFullRate).toBe(R(200000))
    expect(r.additionsHalfRate).toBe(R(100000))
    expect(r.wdvBeforeDepreciation).toBe(R(1250000))
    expect(r.depreciationFullRate).toBe(R(172500))
    expect(r.depreciationHalfRate).toBe(R(7500))
    expect(r.totalDepreciation).toBe(R(180000))
    expect(r.closingWdv).toBe(R(1070000))
  })

  it('ICAI BoS Final DT, Module 1 Ch.3 Illustration 4 (AY 2026-27): 15% block with additional depreciation', () => {
    // Opening ₹5,78,000; Machinery Y ₹8,00,000 (12.07.2025, eligible); office AC ₹3,00,000
    // (08.09.2025, not eligible); second-hand machine ₹2,00,000 (29.12.2025, not eligible);
    // Machinery Z ₹3,25,000 (23.11.2025, eligible, < 180 days); machine X sold ₹3,10,000.
    // ICAI: 39,375 + 2,05,200 normal, 1,60,000 + 32,500 additional = 4,37,075; closing 14,55,925.
    const r = itBlockYear({
      fy, rateBp: 1500, openingWdv: R(578000), saleProceeds: R(310000), blockCeases: false, additionalRateBp: 2000,
      additions: [
        { putToUseDate: '2025-07-12', amount: R(800000), additionalEligible: true },
        { putToUseDate: '2025-09-08', amount: R(300000) },
        { putToUseDate: '2025-12-29', amount: R(200000) },
        { putToUseDate: '2025-11-23', amount: R(325000), additionalEligible: true }
      ]
    })
    expect(r.wdvBeforeDepreciation).toBe(R(1893000))
    expect(r.depreciationHalfRate).toBe(R(39375))
    expect(r.depreciationFullRate).toBe(R(205200))
    expect(r.additionalDepreciation).toBe(R(192500))
    expect(r.additionalCarriedForward).toBe(R(32500))
    expect(r.totalDepreciation).toBe(R(437075))
    expect(r.closingWdv).toBe(R(1455925))
  })

  it('ICAI Illustration 1: ₹30L opening + ₹20L (8 Jun) + ₹8L (15 Dec), all eligible ⇒ ₹12,90,000', () => {
    const r = itBlockYear({
      fy, rateBp: 1500, openingWdv: R(3000000), saleProceeds: 0, blockCeases: false, additionalRateBp: 2000,
      additions: [{ putToUseDate: '2025-06-08', amount: R(2000000), additionalEligible: true }, { putToUseDate: '2025-12-15', amount: R(800000), additionalEligible: true }]
    })
    expect(r.depreciationFullRate).toBe(R(750000))
    expect(r.depreciationHalfRate).toBe(R(60000))
    expect(r.additionalDepreciation).toBe(R(480000))
    expect(r.totalDepreciation).toBe(R(1290000))
    // Its separate 40% computer block: ₹3,00,000 put to use 02.01.2026 ⇒ 20% = ₹60,000.
    expect(itBlockYear({ fy, rateBp: 4000, openingWdv: 0, saleProceeds: 0, blockCeases: false, additions: [{ putToUseDate: '2026-01-02', amount: R(300000) }] }).totalDepreciation).toBe(R(60000))
  })

  it('ICAI BoS Final DT, Module 1 Ch.4 Illustration 11: sale beyond the old WDV leaves a half-rate block', () => {
    // Opening ₹8,50,000 + ₹8,50,000 (30.11.2025) − sale ₹11,00,000 = ₹6,00,000 ⇒ 7.5% = ₹45,000.
    const r = itBlockYear({ fy, rateBp: 1500, openingWdv: R(850000), saleProceeds: R(1100000), blockCeases: false, additions: [{ putToUseDate: '2025-11-30', amount: R(850000) }] })
    expect(r.wdvBeforeDepreciation).toBe(R(600000))
    expect(r.totalDepreciation).toBe(R(45000))
    // Variant: sold for ₹21,00,000 ⇒ short-term capital gain ₹4,00,000.
    const g = itBlockYear({ fy, rateBp: 1500, openingWdv: R(850000), saleProceeds: R(2100000), blockCeases: false, additions: [{ putToUseDate: '2025-11-30', amount: R(850000) }] })
    expect(g.shortTermCapitalGain).toBe(R(400000))
  })

  it('the 180-day test counts the put-to-use day and 31 March', () => {
    // 3 Oct 2025 → 31 Mar 2026 = 180 days ⇒ full rate; 4 Oct = 179 days ⇒ half rate.
    const at = (d: string): number =>
      itBlockYear({ fy, rateBp: 1000, openingWdv: 0, saleProceeds: 0, blockCeases: false, additions: [{ putToUseDate: d, amount: R(1000) }] }).totalDepreciation
    expect(at('2025-10-03')).toBe(R(100))
    expect(at('2025-10-04')).toBe(R(50))
  })

  it('sale proceeds beyond the full-rate base eat into the half-rate additions', () => {
    const r = itBlockYear({
      fy, rateBp: 1500, openingWdv: R(100000), saleProceeds: R(150000), blockCeases: false,
      additions: [{ putToUseDate: '2026-01-01', amount: R(200000) }]
    })
    expect(r.wdvBeforeDepreciation).toBe(R(150000))
    expect(r.depreciationFullRate).toBe(0)
    expect(r.depreciationHalfRate).toBe(R(11250)) // 1,50,000 × 7.5%
  })

  it('proceeds above opening WDV + additions are a short-term capital gain; the block is nil', () => {
    const r = itBlockYear({ fy, rateBp: 1500, openingWdv: R(100000), saleProceeds: R(130000), blockCeases: false, additions: [] })
    expect(r.shortTermCapitalGain).toBe(R(30000))
    expect(r.closingWdv).toBe(0)
    expect(r.totalDepreciation).toBe(0)
  })

  it('a block that ceases with WDV left gives a short-term capital loss and no depreciation', () => {
    const r = itBlockYear({ fy, rateBp: 1500, openingWdv: R(100000), saleProceeds: R(60000), blockCeases: true, additions: [] })
    expect(r.shortTermCapitalLoss).toBe(R(40000))
    expect(r.totalDepreciation).toBe(0)
    expect(r.closingWdv).toBe(0)
  })

  it('additional depreciation: half now for < 180 days, the rest carried to next year', () => {
    const r = itBlockYear({
      fy, rateBp: 1500, openingWdv: 0, saleProceeds: 0, blockCeases: false, additionalRateBp: 2000,
      additions: [{ putToUseDate: '2025-04-10', amount: R(100000), additionalEligible: true }, { putToUseDate: '2026-01-10', amount: R(100000), additionalEligible: true }]
    })
    expect(r.additionalDepreciation).toBe(R(20000) + R(10000))
    expect(r.additionalCarriedForward).toBe(R(10000))
    expect(r.depreciationFullRate).toBe(R(15000))
    expect(r.depreciationHalfRate).toBe(R(7500))
    expect(r.closingWdv).toBe(R(200000) - R(15000) - R(7500) - R(30000))
    const next = itBlockYear({ fy: fyFromStartYear(2026), rateBp: 1500, openingWdv: r.closingWdv, saleProceeds: 0, blockCeases: false, additions: [], additionalRateBp: 2000, additionalBroughtForward: r.additionalCarriedForward })
    expect(next.additionalDepreciation).toBe(R(10000))
  })
})
