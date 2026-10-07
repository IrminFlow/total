import { describe, expect, it } from 'vitest'
import { fcFromInr, foldExposure, formatFc, inrFromFc, microToRateText, parseRateMicro, rateToMicro, revalue, settlementSplit, type FxLine } from './forex'

const line = (p: Partial<FxLine> & Pick<FxLine, 'amount'>): FxLine => ({
  date: '2026-04-10', voucherId: 1, currency: null, rateMicro: null, fcOverride: null, revaluation: false, ...p
})

describe('rates and conversion', () => {
  it('parses decimal rates exactly into micro-rupees', () => {
    expect(parseRateMicro('83.25')).toBe(83_250_000)
    expect(parseRateMicro('0.5512')).toBe(551_200)
    expect(parseRateMicro('-1')).toBeNull()
    expect(parseRateMicro('0')).toBeNull()
    expect(rateToMicro(83.1234567)).toBe(83_123_457)
    expect(microToRateText(83_250_000)).toBe('83.25')
  })
  it('converts both ways, rounding half away from zero', () => {
    expect(inrFromFc(1000_00, 83_250_000)).toBe(83_250_00) // $1,000 × 83.25 = ₹83,250
    expect(fcFromInr(83_250_00, 83_250_000)).toBe(1000_00)
    expect(inrFromFc(-1, 83_250_000)).toBe(-83) // −$0.01 → −₹0.8325 → −83 paise
  })
  it('formats foreign amounts', () => {
    expect(formatFc(1234567, 'USD')).toBe('12,345.67 USD')
    expect(formatFc(-5, 'EUR')).toBe('-0.05 EUR')
  })
})

describe('foldExposure', () => {
  it('a USD invoice at 82 gives $1,000 / ₹82,000', () => {
    const e = foldExposure([line({ amount: 82_000_00, currency: 'USD', rateMicro: 82_000_000 })], 'USD')
    expect(e).toEqual({ fcBalance: 1000_00, inrBook: 82_000_00, carryingRateMicro: 82_000_000, inferredLines: 0 })
  })
  it('revaluation lines move rupees only', () => {
    const e = foldExposure([
      line({ amount: 82_000_00, currency: 'USD', rateMicro: 82_000_000 }),
      line({ amount: 1_250_00, revaluation: true })
    ], 'USD')
    expect(e.fcBalance).toBe(1000_00)
    expect(e.inrBook).toBe(83_250_00)
  })
  it('a rupee receipt settles units at the carrying rate (inferred)', () => {
    const e = foldExposure([
      line({ amount: 82_000_00, currency: 'USD', rateMicro: 82_000_000 }),
      line({ amount: -41_000_00 })
    ], 'USD')
    expect(e.fcBalance).toBe(500_00)
    expect(e.inrBook).toBe(41_000_00)
    expect(e.inferredLines).toBe(1)
  })
  it('a settlement override moves exactly the foreign amount', () => {
    const e = foldExposure([
      line({ amount: 82_000_00, currency: 'USD', rateMicro: 82_000_000 }),
      line({ amount: -82_000_00, currency: 'USD', rateMicro: 84_000_000, fcOverride: -1000_00 })
    ], 'USD')
    expect(e.fcBalance).toBe(0)
    expect(e.inrBook).toBe(0)
    expect(e.carryingRateMicro).toBeNull()
  })
  it('a payable (credit) balance is negative in both currencies', () => {
    const e = foldExposure([line({ amount: -50_000_00, currency: 'EUR', rateMicro: 90_000_000 })], 'EUR')
    expect(e.fcBalance).toBe(-555_56)
    expect(e.carryingRateMicro).toBe(Math.abs(Math.round((50_000_00 * 1e6) / 555_56)))
  })
})

describe('revalue (AS 11 para 11 / Ind AS 21 para 23: monetary items at the closing rate)', () => {
  it('receivable $1,000 booked at 82, closing 83.25 → ₹1,250 gain (Dr party)', () => {
    expect(revalue(1000_00, 82_000_00, 83_250_000)).toEqual({ target: 83_250_00, adjustment: 1_250_00, gainLoss: 1_250_00 })
  })
  it('receivable at a falling rate → loss (Cr party)', () => {
    expect(revalue(1000_00, 82_000_00, 81_500_000).adjustment).toBe(-500_00)
  })
  it('payable €500 booked at 90, closing 92 → ₹1,000 loss (Cr creditor)', () => {
    const r = revalue(-500_00, -45_000_00, 92_000_000)
    expect(r.target).toBe(-46_000_00)
    expect(r.adjustment).toBe(-1_000_00)
    expect(r.gainLoss).toBe(-1_000_00)
  })
  it('a second revaluation only books the further change', () => {
    const first = revalue(1000_00, 82_000_00, 83_000_000)
    const second = revalue(1000_00, 82_000_00 + first.adjustment, 83_500_000)
    expect(second.adjustment).toBe(500_00)
  })
})

describe('settlementSplit (realised difference, AS 11 para 13)', () => {
  it('full receipt at a better rate is a gain and relieves the whole book value', () => {
    expect(settlementSplit({ fcBalance: 1000_00, inrBook: 82_000_00 }, 1000_00, 84_000_000)).toEqual({ bankInr: 84_000_00, partyInr: 82_000_00, gainLoss: 2_000_00 })
  })
  it('part settlement relieves book value pro rata', () => {
    expect(settlementSplit({ fcBalance: 1000_00, inrBook: 82_000_00 }, 250_00, 81_000_000)).toEqual({ bankInr: 20_250_00, partyInr: 20_500_00, gainLoss: -250_00 })
  })
  it('paying a payable at a higher rate is a loss', () => {
    expect(settlementSplit({ fcBalance: -500_00, inrBook: -45_000_00 }, 500_00, 91_000_000).gainLoss).toBe(-500_00)
  })
  it('refuses more than is open', () => {
    expect(() => settlementSplit({ fcBalance: 100_00, inrBook: 8_000_00 }, 200_00, 80_000_000)).toThrow(/open/)
  })
})
