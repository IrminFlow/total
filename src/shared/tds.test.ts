import { describe, it, expect } from 'vitest'
import { validateVoucher } from './posting'
import {
  applicableRate, computeTds, computeTdsPaise, deducteeTypeFromPan, expectedTdsPaise, rateRowOn, resolveDeducteeType,
  sectionReferenceOn, taxableBase, tdsQuarterBounds, tdsQuarterOf, thresholdCrossed, thresholdPeriod, thresholdStatus,
  validateTdsEntries, type TdsCertificate, type TdsRateRow
} from './tds'

let nextId = 1
const row = (over: Partial<TdsRateRow>): TdsRateRow => ({
  id: nextId++, sectionId: 1, effectiveFrom: '2025-04-01', effectiveTo: null, deducteeType: 'any', rateBp: 200,
  thresholdSinglePaise: 0, thresholdAnnualPaise: 0, thresholdBasis: 'fy', thresholdExcessOnly: false, returnCode: null,
  noPanRateBp: 2000, source: null, ...over
})

// The seeded 194C shape (migration 020): 1% individual/HUF, 2% others; single 30,000 / aggregate 1,00,000.
const contractor = {
  id: 1,
  rates: [
    row({ effectiveFrom: '1961-04-01', effectiveTo: '2025-03-31', rateBp: 200, thresholdSinglePaise: 3000000, thresholdAnnualPaise: 10000000 }),
    row({ effectiveTo: '2026-03-31', deducteeType: 'individual_huf', rateBp: 100, thresholdSinglePaise: 3000000, thresholdAnnualPaise: 10000000 }),
    row({ effectiveTo: '2026-03-31', rateBp: 200, thresholdSinglePaise: 3000000, thresholdAnnualPaise: 10000000 }),
    row({ effectiveFrom: '2026-04-01', deducteeType: 'individual_huf', rateBp: 100, thresholdSinglePaise: 3000000, thresholdAnnualPaise: 10000000 }),
    row({ effectiveFrom: '2026-04-01', rateBp: 200, thresholdSinglePaise: 3000000, thresholdAnnualPaise: 10000000 })
  ]
}

const cert = (over: Partial<TdsCertificate> = {}): TdsCertificate => ({
  id: 9, ledgerId: 5, sectionId: 1, certificateNo: 'LDC-1', rateBp: 50, validFrom: '2025-04-01', validTo: '2026-03-31',
  capPaise: null, ...over
})

describe('deductee type', () => {
  it('reads the PAN 4th character', () => {
    expect(deducteeTypeFromPan('ABCPE1234F')).toBe('individual_huf')
    expect(deducteeTypeFromPan('ABCHE1234F')).toBe('individual_huf')
    expect(deducteeTypeFromPan('ABCCE1234F')).toBe('company')
    expect(deducteeTypeFromPan('ABCFE1234F')).toBe('firm')
    for (const c of 'ATBLJG') expect(deducteeTypeFromPan(`ABC${c}E1234F`)).toBe('other')
    expect(deducteeTypeFromPan('ABCDE1234F')).toBeNull() // D is not a status letter
    expect(deducteeTypeFromPan('not-a-pan')).toBeNull()
    expect(deducteeTypeFromPan(null)).toBeNull()
  })
  it('an explicit type wins over the PAN', () => {
    expect(resolveDeducteeType('company', 'ABCPE1234F')).toBe('company')
    expect(resolveDeducteeType(null, 'ABCPE1234F')).toBe('individual_huf')
  })
})

describe('applicableRate — by date, deductee type, PAN, certificate', () => {
  it('picks the row in force on the date', () => {
    expect(applicableRate(contractor, '2024-12-01', 'individual_huf', true)!.rateBp).toBe(200) // pre-FY25 carried row is 'any'
    expect(applicableRate(contractor, '2025-06-01', 'individual_huf', true)!.rateBp).toBe(100)
    expect(applicableRate(contractor, '2026-03-31', 'individual_huf', true)!.row.effectiveTo).toBe('2026-03-31')
    expect(applicableRate(contractor, '2026-04-01', 'individual_huf', true)!.row.effectiveFrom).toBe('2026-04-01')
  })
  it('an exact deductee row first, else any', () => {
    expect(applicableRate(contractor, '2025-06-01', 'company', true)!.rateBp).toBe(200)
    expect(applicableRate(contractor, '2025-06-01', 'firm', true)!.rateBp).toBe(200)
  })
  it('an unknown deductee takes the any row, or the highest rate when there is none', () => {
    expect(applicableRate(contractor, '2025-06-01', null, true)!.rateBp).toBe(200)
    const onlyTyped = { id: 2, rates: [row({ deducteeType: 'individual_huf', rateBp: 100 }), row({ deducteeType: 'company', rateBp: 300 })] }
    expect(rateRowOn(onlyTyped.rates, '2025-06-01', null)!.rateBp).toBe(300)
    expect(rateRowOn(onlyTyped.rates, '2025-06-01', 'firm')).toBeNull() // typed rows only, none for firms
  })
  it('null when no row is in force', () => {
    expect(applicableRate({ id: 3, rates: [row({ effectiveFrom: '2026-04-01' })] }, '2025-06-01', null, true)).toBeNull()
  })
  it('no PAN: the higher of the section rate and the no-PAN rate (20%, 5% for 194Q)', () => {
    const r = applicableRate(contractor, '2025-06-01', 'individual_huf', false)!
    expect(r).toMatchObject({ rateBp: 2000, basis: 'no_pan' })
    const goods = { id: 4, rates: [row({ rateBp: 10, noPanRateBp: 500 })] }
    expect(applicableRate(goods, '2025-06-01', null, false)!.rateBp).toBe(500)
    const high = { id: 5, rates: [row({ rateBp: 3000 })] }
    expect(applicableRate(high, '2025-06-01', null, false)).toMatchObject({ rateBp: 3000, basis: 'section' })
  })
  it('a valid certificate applies its rate; not without a PAN, outside its dates, for another section, or once its cap is used', () => {
    expect(applicableRate(contractor, '2025-06-01', 'company', true, { certificate: cert(), consumedPaise: 0 })).toMatchObject({
      basis: 'certificate', certificateId: 9, certificateRateBp: 50, certificateRemainingPaise: null
    })
    expect(applicableRate(contractor, '2025-06-01', 'company', false, { certificate: cert(), consumedPaise: 0 })!.basis).toBe('no_pan')
    expect(applicableRate(contractor, '2026-06-01', 'company', true, { certificate: cert(), consumedPaise: 0 })!.basis).toBe('section')
    expect(applicableRate(contractor, '2025-06-01', 'company', true, { certificate: cert({ sectionId: 7 }), consumedPaise: 0 })!.basis).toBe('section')
    expect(applicableRate(contractor, '2025-06-01', 'company', true, { certificate: cert({ sectionId: null }), consumedPaise: 0 })!.basis).toBe('certificate')
    expect(applicableRate(contractor, '2025-06-01', 'company', true, { certificate: cert({ capPaise: 1000000 }), consumedPaise: 1000000 })!.basis).toBe('section')
  })
})

describe('computeTdsPaise — rounding and certificate caps', () => {
  const plain = (rateBp: number) => ({ rateBp, basis: 'section' as const, certificateRateBp: null, certificateRemainingPaise: null })
  it('rate in basis points, rounded to the nearest rupee half up', () => {
    expect(computeTdsPaise(5000000, plain(200))).toBe(100000) // 2% of ₹50,000
    expect(computeTdsPaise(333350, plain(1000))).toBe(33300) // ₹333.35 → ₹333
    expect(computeTdsPaise(335000, plain(1000))).toBe(33500)
    expect(computeTdsPaise(3350, plain(1000))).toBe(300) // ₹3.35 → ₹3
    expect(computeTdsPaise(3500, plain(1000))).toBe(400) // ₹3.50 → ₹4 (half up)
    expect(computeTdsPaise(10000000, plain(10))).toBe(10000) // 0.1% of ₹1,00,000 = ₹100
    expect(computeTdsPaise(0, plain(200))).toBe(0)
  })
  it('a capped certificate covers only what is left; the excess goes at the table rate', () => {
    const r = { rateBp: 200, basis: 'certificate' as const, certificateRateBp: 50, certificateRemainingPaise: 2000000 }
    // ₹20,000 at 0.5% = ₹100 + ₹30,000 at 2% = ₹600
    expect(computeTdsPaise(5000000, r)).toBe(70000)
    expect(computeTdsPaise(1000000, r)).toBe(5000)
  })
  it('legacy percent helper keeps its no-PAN floor of 20%', () => {
    expect(computeTds(2, 10000000, true)).toBe(200000)
    expect(computeTds(2, 10000000, false)).toBe(2000000)
    expect(computeTds(25, 10000000, false)).toBe(2500000)
  })
})

describe('thresholds', () => {
  const c = contractor.rates[2]! // 2%, single 30,000, aggregate 1,00,000
  it('statute says "exceeds": a payment exactly at the limit is not liable', () => {
    expect(thresholdCrossed({ thresholdSingle: 3000000, thresholdAnnual: 10000000 }, 3000000, 0)).toBe(false)
    expect(thresholdCrossed({ thresholdSingle: 3000000, thresholdAnnual: 10000000 }, 3000001, 0)).toBe(true)
    expect(thresholdCrossed({ thresholdSingle: 0, thresholdAnnual: 0 }, 100, 0)).toBe(true)
  })
  it('aggregate crossing mid-year counts prior entries', () => {
    // Four ₹25,000 bills: none crosses the single limit; the fifth takes the year past ₹1,00,000.
    expect(thresholdStatus(c, '2025-08-01', 2500000, 7500000)).toMatchObject({ crossed: false, reason: 'below', aggregatePaise: 10000000 })
    expect(thresholdStatus(c, '2025-09-01', 2500000, 10000000)).toMatchObject({ crossed: true, reason: 'aggregate', aggregatePaise: 12500000 })
    expect(thresholdStatus(c, '2025-09-01', 4000000, 0)).toMatchObject({ crossed: true, reason: 'single' })
    expect(thresholdStatus(row({}), '2025-09-01', 1, 0).reason).toBe('none')
  })
  it('period: FY, or the calendar month for rent', () => {
    expect(thresholdPeriod('fy', '2026-02-10')).toEqual({ from: '2025-04-01', to: '2026-03-31' })
    expect(thresholdPeriod('month', '2024-02-10')).toEqual({ from: '2024-02-01', to: '2024-02-29' })
    const rent = row({ rateBp: 1000, thresholdAnnualPaise: 5000000, thresholdBasis: 'month' })
    expect(thresholdStatus(rent, '2025-05-10', 5000000, 0).crossed).toBe(false) // exactly ₹50,000 a month
    expect(thresholdStatus(rent, '2025-05-10', 5000100, 0)).toMatchObject({ crossed: true, period: { from: '2025-05-01', to: '2025-05-31' } })
  })
  it('excess-only (194Q): only the part above the aggregate threshold is taxed', () => {
    const goods = row({ rateBp: 10, thresholdAnnualPaise: 500000000, thresholdExcessOnly: true })
    expect(taxableBase(goods, 200000000, 400000000)).toBe(100000000) // 40L before + 20L → 10L above 50L
    expect(taxableBase(goods, 200000000, 600000000)).toBe(200000000) // already above
    expect(taxableBase(goods, 100000000, 100000000)).toBe(0)
    expect(taxableBase(row({}), 123, 999)).toBe(123)
    const rate = applicableRate({ id: 6, rates: [goods] }, '2025-06-01', null, true)!
    expect(expectedTdsPaise(rate, 200000000, 400000000)).toBe(100000) // 0.1% of ₹10 lakh = ₹1,000
  })
})

describe('Act references and quarters', () => {
  const s = { code: '194C', legacyCode: '194C', newReference: '393(1) Sl. 6(i)' }
  it('1961 code before 1 Apr 2026, the 2025-Act reference from it', () => {
    expect(sectionReferenceOn(s, '2026-03-31')).toBe('194C')
    expect(sectionReferenceOn(s, '2026-04-01')).toBe('393(1) Sl. 6(i)')
    expect(sectionReferenceOn({ ...s, newReference: null }, '2026-04-01')).toBe('194C')
  })
  it('quarters', () => {
    expect(tdsQuarterOf('2025-04-01')).toMatchObject({ q: 1, label: 'Q1 FY2025-26' })
    expect(tdsQuarterOf('2026-03-31')).toMatchObject({ q: 4, fyStartYear: 2025, from: '2026-01-01' })
    expect(tdsQuarterBounds(2025, 3)).toEqual({ from: '2025-10-01', to: '2025-12-31' })
    expect(tdsQuarterBounds(2025, 4)).toEqual({ from: '2026-01-01', to: '2026-03-31' })
  })
})

describe('validateTdsEntries', () => {
  const PARTY = 10
  const BANK = 11
  const PAYABLE = 12
  const OTHER_PAYABLE = 13
  const tags = new Map([[PAYABLE, 1], [OTHER_PAYABLE, 2]])
  const voucher = (payableCr: number, ledger = PAYABLE) => ({
    partyLedgerId: PARTY as number | null,
    lines: [
      { ledgerId: PARTY, drCr: 'dr' as const, amount: 5000000 },
      { ledgerId: BANK, drCr: 'cr' as const, amount: 5000000 - payableCr },
      { ledgerId: ledger, drCr: 'cr' as const, amount: payableCr }
    ]
  })
  const entry = { sectionId: 1, baseAmount: 5000000, tdsAmount: 100000, isManual: false }
  const facts = (expected: number | null) => () => ({ code: '194C', expectedTdsPaise: expected })

  it('accepts a computed entry with a matching payable credit', () => {
    expect(validateTdsEntries(voucher(100000), [entry], tags, facts(100000))).toEqual([])
    expect(validateTdsEntries(voucher(0), [], tags, facts(null))).toEqual([])
  })
  it('rejects an amount that is not rate x base, unless manual', () => {
    const e = validateTdsEntries(voucher(90000), [{ ...entry, tdsAmount: 90000 }], tags, facts(100000))
    expect(e.map((x) => x.code)).toEqual(['tds_amount_mismatch'])
    expect(e[0]!.message).toMatch(/should be ₹1,000\.00/)
    expect(validateTdsEntries(voucher(90000), [{ ...entry, tdsAmount: 90000, isManual: true }], tags, facts(100000))).toEqual([])
  })
  it('rejects a missing, wrong-section or wrong-amount payable credit', () => {
    expect(validateTdsEntries(voucher(100000, OTHER_PAYABLE), [entry], tags, facts(100000)).map((x) => x.code)).toEqual(['tds_no_payable_line'])
    expect(validateTdsEntries(voucher(100000, 99), [entry], tags, facts(100000)).map((x) => x.code)).toEqual(['tds_no_payable_line'])
    const v = voucher(100000)
    v.lines[2]!.amount = 80000
    expect(validateTdsEntries(v, [entry], tags, facts(100000)).map((x) => x.code)).toEqual(['tds_payable_mismatch'])
    // Manual: any credit to the tagged ledger will do, but there must be one.
    expect(validateTdsEntries(v, [{ ...entry, isManual: true }], tags, facts(100000))).toEqual([])
    expect(validateTdsEntries(voucher(100000, 99), [{ ...entry, isManual: true }], tags, facts(100000)).map((x) => x.code)).toEqual(['tds_no_payable_line'])
  })
  it('rejects no party, an unknown section, no rate in force, and tds above base', () => {
    expect(validateTdsEntries({ ...voucher(100000), partyLedgerId: null }, [entry], tags, facts(100000)).map((x) => x.code)).toEqual(['tds_no_party'])
    expect(validateTdsEntries(voucher(100000), [entry], tags, () => null).map((x) => x.code)).toEqual(['tds_unknown_section'])
    expect(validateTdsEntries(voucher(100000), [entry], tags, facts(null)).map((x) => x.code)).toEqual(['tds_no_rate'])
    expect(
      validateTdsEntries(voucher(100000), [{ ...entry, baseAmount: 50000, isManual: true }], tags, facts(1000)).map((x) => x.code)
    ).toEqual(['tds_exceeds_base'])
  })
})

describe('payment-kind money-side rule with TDS', () => {
  const facts = (id: number) => ({ exists: true, isCashOrBank: id === 2, isTdsPayable: id === 3 })
  const input = (tds: boolean) => ({
    voucherTypeId: 1, date: '2025-05-01', partyLedgerId: 1, narration: null, reference: null, inventory: [],
    lines: [
      { ledgerId: 1, drCr: 'dr' as const, amount: 5000000 },
      { ledgerId: 2, drCr: 'cr' as const, amount: 4900000 },
      { ledgerId: 3, drCr: 'cr' as const, amount: 100000 }
    ],
    tds: tds ? { sectionId: 1, baseAmount: 5000000, tdsAmount: 100000 } : null
  })
  it('a TDS payable credit on a payment that carries TDS is outside the cash/bank-for-the-full-amount test', () => {
    expect(validateVoucher(input(true), 'payment', facts)).toEqual([])
    expect(validateVoucher(input(false), 'payment', facts).map((e) => e.code)).toEqual(['cash_bank_rule'])
  })
})
