import { describe, expect, it } from 'vitest'
import { allocateFifo, fcFromInr, foldExposure, formatFc, inrFromFc, microToRateText, openForeignBills, parseRateMicro, rateToMicro, revalue, settleBills, type FxLine } from './forex'

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
    expect(e).toEqual({ fcBalance: 1000_00, inrBook: 82_000_00, carryingRateMicro: 82_000_000, rupeeLines: 0 })
  })
  it('revaluation lines move rupees only', () => {
    const e = foldExposure([
      line({ amount: 82_000_00, currency: 'USD', rateMicro: 82_000_000 }),
      line({ amount: 1_250_00, revaluation: true })
    ], 'USD')
    expect(e.fcBalance).toBe(1000_00)
    expect(e.inrBook).toBe(83_250_00)
  })
  it('rupee entries before a USD invoice are not foreign money (review case)', () => {
    const e = foldExposure([
      line({ date: '2026-03-01', amount: 50_000_00 }), // a rupee sale to the same party
      line({ date: '2026-03-10', amount: 82_000_00, currency: 'USD', rateMicro: 82_000_000 })
    ], 'USD')
    expect(e).toEqual({ fcBalance: 1000_00, inrBook: 82_000_00, carryingRateMicro: 82_000_000, rupeeLines: 1 })
    expect(revalue(e.fcBalance, e.inrBook, 83_000_000).adjustment).toBe(1_000_00) // only the $1,000 is restated
  })
  it('rupee entries after a USD invoice (a rupee receipt) do not touch the foreign balance', () => {
    const e = foldExposure([
      line({ date: '2026-03-10', amount: 82_000_00, currency: 'USD', rateMicro: 82_000_000 }),
      line({ date: '2026-03-20', amount: -10_000_00 })
    ], 'USD')
    expect(e).toMatchObject({ fcBalance: 1000_00, inrBook: 82_000_00, rupeeLines: 1 })
  })
  it('a foreign opening balance counts when it is entered', () => {
    const e = foldExposure([line({ amount: 41_000_00, currency: 'USD', rateMicro: 82_000_000 })], 'USD', { fc: 500_00, inr: 40_000_00 })
    expect(e).toMatchObject({ fcBalance: 1000_00, inrBook: 81_000_00 })
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

describe('bill-wise settlement (realised difference, AS 11 para 13)', () => {
  const bills = openForeignBills([
    { name: 'E1', voucherId: 1, date: '2026-01-10', fc: 1000_00, inr: 80_000_00 },
    { name: 'E2', voucherId: 2, date: '2026-02-10', fc: 1000_00, inr: 84_000_00 }
  ], [], [])
  it('relieves each bill at its own rate, not a weighted average', () => {
    const s = settleBills(bills, [{ name: 'E2', fc: 1000_00 }], 83_000_000, 'receivable')
    expect(s).toMatchObject({ fcTotal: 1000_00, bankInr: 83_000_00, partyInr: 84_000_00, gainLoss: -1_000_00 })
    const f = settleBills(bills, allocateFifo(bills, 1500_00), 83_000_000, 'receivable')
    expect(f.lines).toEqual([{ name: 'E1', voucherId: 1, fc: 1000_00, bookInr: 80_000_00 }, { name: 'E2', voucherId: 2, fc: 500_00, bookInr: 42_000_00 }])
    expect(f.gainLoss).toBe(1_24_500_00 - 1_22_000_00)
  })
  it('earlier settlements and credit notes reduce the open bills', () => {
    const open = openForeignBills([
      { name: 'E1', voucherId: 1, date: '2026-01-10', fc: 1000_00, inr: 80_000_00 },
      { name: 'E2', voucherId: 2, date: '2026-02-10', fc: 1000_00, inr: 84_000_00 }
    ], [{ fc: 200_00 }], [{ name: 'E1', fc: 300_00, bookInr: 24_000_00 }])
    expect(open).toEqual([
      { name: 'E1', voucherId: 1, date: '2026-01-10', fcOpen: 500_00, bookOpen: 40_000_00 },
      { name: 'E2', voucherId: 2, date: '2026-02-10', fcOpen: 1000_00, bookOpen: 84_000_00 }
    ])
  })
  it('paying a payable at a higher rate is a loss', () => {
    const b = openForeignBills([{ name: 'P1', voucherId: 3, date: '2026-01-01', fc: 500_00, inr: 45_000_00 }], [], [])
    expect(settleBills(b, [{ name: 'P1', fc: 500_00 }], 91_000_000, 'payable').gainLoss).toBe(-500_00)
  })
  it('refuses more than is open', () => {
    expect(() => allocateFifo(bills, 3000_00)).toThrow(/open/)
    expect(() => settleBills(bills, [{ name: 'E1', fc: 2000_00 }], 80_000_000, 'receivable')).toThrow(/open/)
  })
})
