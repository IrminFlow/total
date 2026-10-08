import { describe, expect, it } from 'vitest'
import { figure, fyMonthList, monthlyVariance, overBudgetRows, phaseByWeights, phaseLine, type PhasedLine } from './budgetPhasing'

const months = fyMonthList(2026)

describe('phasing', () => {
  it('even: floor of a twelfth each, March absorbs the remainder', () => {
    const m = phaseByWeights(100_000_05, Array(12).fill(1))
    expect(m.slice(0, 11).every((v) => v === 833_333)).toBe(true)
    expect(m[11]).toBe(100_000_05 - 11 * 833_333)
    expect(m.reduce((s, v) => s + v, 0)).toBe(100_000_05)
  })
  it('seasonal: by weights (Diwali-heavy profile), sums exactly', () => {
    const w = [1, 1, 1, 1, 1, 1, 3, 2, 1, 1, 1, 1]
    const m = phaseByWeights(15_000_00, w)
    expect(m[6]).toBe(3_000_00)
    expect(m.reduce((s, v) => s + v, 0)).toBe(15_000_00)
  })
  it('refuses a bad profile', () => {
    expect(() => phaseByWeights(1, [1, 2])).toThrow()
    expect(() => phaseByWeights(1, Array(12).fill(0))).toThrow()
  })
  it('a single-month line, an annual line and a manual line', () => {
    expect(phaseLine({ month: '2026-06', amount: 5, phasing: 'annual', monthly: null }, months, null)![2]).toBe(5)
    expect(phaseLine({ month: null, amount: 5, phasing: 'annual', monthly: null }, months, null)).toBeNull()
    expect(phaseLine({ month: null, amount: 3, phasing: 'manual', monthly: [1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }, months, null)![1]).toBe(2)
  })
})

describe('favourable / unfavourable', () => {
  it('expense under budget is favourable; income under budget is not', () => {
    expect(figure(100, 80, 'expense')).toMatchObject({ variance: -20, pct: 80, favourable: true })
    expect(figure(100, 120, 'expense').favourable).toBe(false)
    expect(figure(100, 80, 'income').favourable).toBe(false)
    expect(figure(100, 130, 'income')).toMatchObject({ variance: 30, pct: 130, favourable: true })
    expect(figure(0, 0, 'expense')).toMatchObject({ pct: null, favourable: null })
    expect(figure(null, 5, 'expense')).toMatchObject({ budget: null, variance: null, favourable: null })
  })
})

describe('monthlyVariance', () => {
  const rent: PhasedLine = {
    lineId: 1, targetName: 'Rent', ledgerId: 10, groupId: null, costCentreId: null, costCentreName: null, nature: 'expense',
    month: null, phasing: 'even', amount: 120_000_00, monthly: phaseByWeights(120_000_00, Array(12).fill(1))
  }
  const ccLine: PhasedLine = { ...rent, lineId: 2, targetName: 'Indirect Expenses', ledgerId: null, groupId: 5, costCentreId: 7, costCentreName: 'Mumbai' }
  const actuals = [
    { ledgerId: 10, costCentreId: null, month: '2026-04', amount: 9_000_00 },
    { ledgerId: 10, costCentreId: null, month: '2026-05', amount: 12_000_00 },
    { ledgerId: 10, costCentreId: 7, month: '2026-05', amount: 4_000_00 },
    { ledgerId: 11, costCentreId: 8, month: '2026-05', amount: 1_000_00 }
  ]
  const groups = new Map([[5, new Set([10, 11])]])
  const cc = new Map([[7, new Set([7, 8])]])
  const [r, c] = monthlyVariance([rent, ccLine], actuals, groups, cc, months, '2026-05')
  it('by month and year to date', () => {
    expect(r!.current).toMatchObject({ budget: 10_000_00, actual: 12_000_00, variance: 2_000_00, favourable: false })
    expect(r!.ytd).toMatchObject({ budget: 20_000_00, actual: 21_000_00, variance: 1_000_00, pct: 105 })
    expect(r!.months[0]).toMatchObject({ actual: 9_000_00, favourable: true })
  })
  it('a cost-centre line counts only allocations to the centre and its sub-centres', () => {
    expect(c!.current.actual).toBe(5_000_00)
    expect(c!.ytd.actual).toBe(5_000_00)
  })
  it('over budget this month', () => {
    expect(overBudgetRows([r!, c!]).map((x) => x.lineId)).toEqual([1])
  })
  it('a single-month line compares that month only', () => {
    const [m] = monthlyVariance([{ ...rent, month: '2026-05', phasing: 'annual', monthly: null, amount: 11_000_00 }], actuals, groups, cc, months, '2026-05')
    expect(m!.current).toMatchObject({ budget: 11_000_00, actual: 12_000_00 })
    expect(m!.months[0]!.budget).toBeNull()
    expect(m!.ytd).toMatchObject({ budget: 11_000_00, actual: 12_000_00 })
  })
  it('an annual line compares the whole amount with the year to date', () => {
    const [a] = monthlyVariance([{ ...rent, phasing: 'annual', monthly: null }], actuals, groups, cc, months, '2026-05')
    expect(a!.current.budget).toBeNull()
    expect(a!.ytd).toMatchObject({ budget: 120_000_00, actual: 21_000_00 })
  })
})
