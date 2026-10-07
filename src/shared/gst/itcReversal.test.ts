// WP 3.4 — ITC reversal maths, as worked examples of the rule texts (sources: rule 42, rule 43,
// rule 37 in shared/gst/sources.ts; rupee figures ×100 = paise).
import { describe, expect, it } from 'vitest'
import {
  effectiveTurnover, mulDiv, proposalLines, rule37Events, rule37Timeline, rule42, rule42TrueUp, rule43, summarise, sumHeads, ZERO_HEADS,
  monthsOfUse, gstr3bDueDate, type Heads, type Rule37Bill
} from './itcReversal'

const r = (rupees: number): number => rupees * 100
const intra = (rupees: number): Heads => ({ igst: 0, cgst: r(rupees / 2), sgst: r(rupees / 2), cess: 0 })
const igst = (rupees: number): Heads => ({ igst: r(rupees), cgst: 0, sgst: 0, cess: 0 })

describe('mulDiv', () => {
  it('is exact beyond the double range and rounds half away from zero', () => {
    expect(mulDiv(1_000_000_000_000, 3_000_000_000_000, 1_000_000_000_000)).toBe(3_000_000_000_000)
    expect(mulDiv(5, 1, 2)).toBe(3)
    expect(mulDiv(-5, 1, 2)).toBe(-3)
  })
})

describe('rule 42 — worked example', () => {
  // T ₹1,00,000 of ITC on inputs/input services (intra-state, CGST+SGST), of which T1 (non-business)
  // ₹0, T2 (exclusively exempt) ₹10,000, T3 (blocked u/s 17(5)) ₹5,000, T4 (exclusively taxable)
  // ₹25,000. Exempt turnover E ₹2,00,000 of total turnover F ₹10,00,000.
  // C1 = T − (T1+T2+T3) = 85,000; C2 = C1 − T4 = 60,000; D1 = E/F × C2 = 12,000; C3 = 48,000.
  const base = { T: intra(100000), T1: ZERO_HEADS, T2: intra(10000), T3: intra(5000), T4: intra(25000), E: r(200000), F: r(1000000), nonBusiness: false }

  it('C1, C2, D1, C3 per head', () => {
    const x = rule42(base)
    expect(x.C1).toEqual(intra(85000))
    expect(x.C2).toEqual(intra(60000))
    expect(x.D1).toEqual(intra(12000))
    expect(x.D2).toEqual(ZERO_HEADS)
    expect(x.C3).toEqual(intra(48000))
    expect(x.reversal).toEqual(intra(12000))
  })

  it('D2 = 5% of C2 when inputs are partly for non-business use', () => {
    const x = rule42({ ...base, nonBusiness: true })
    expect(x.D2).toEqual(intra(3000))
    expect(x.reversal).toEqual(intra(15000))
    expect(x.C3).toEqual(intra(45000))
  })

  it('no turnover → nothing apportioned by D1; E/F is borrowed from the last period that had turnover', () => {
    expect(rule42({ ...base, F: 0, E: 0 }).D1).toEqual(ZERO_HEADS)
    expect(effectiveTurnover({ E: 0, F: 0 }, [{ E: 1, F: 10 }, { E: 2, F: 20 }, { E: 0, F: 0 }])).toEqual({ E: 2, F: 20, borrowed: true })
    expect(effectiveTurnover({ E: 5, F: 50 }, [{ E: 2, F: 20 }])).toEqual({ E: 5, F: 50, borrowed: false })
  })

  it('annual true-up: the year’s E/F on Σ C2 against Σ monthly D1', () => {
    // Two months of C2 ₹60,000 each; month 1 E/F 20%, month 2 0% → monthly D1 12,000 + 0.
    // Year: E ₹2,00,000 of F ₹20,00,000 = 10% × ₹1,20,000 = ₹12,000 → difference nil.
    const m1 = rule42(base)
    const m2 = rule42({ ...base, E: 0 })
    const t = rule42TrueUp([m1, m2], r(200000), r(2000000), false)
    expect(t.C2).toEqual(intra(120000))
    expect(t.annual).toEqual(intra(12000))
    expect(t.difference).toEqual(ZERO_HEADS)
    // Year E/F 15% → ₹18,000 annual vs ₹12,000 monthly: reverse ₹6,000 more.
    expect(rule42TrueUp([m1, m2], r(300000), r(2000000), false).difference).toEqual(intra(6000))
  })
})

describe('rule 43 — worked example', () => {
  // Common capital goods with IGST ITC ₹6,00,000 bought in April 2026: Tm = Tc/60 = ₹10,000 per
  // month; with E/F 20%, Te = ₹2,000 per month for 60 months.
  const goods = [{ voucherId: 1, number: 'P1', date: '2026-04-15', partyName: 'Machine Co', itc: igst(600000), common: true }]

  it('Tc, Tm, Te', () => {
    const x = rule43(goods, '2026-07', r(200000), r(1000000))
    expect(x.Tc).toEqual(igst(600000))
    expect(x.Tm).toEqual(igst(10000))
    expect(x.Te).toEqual(igst(2000))
  })

  it('only common goods within the 60-month life count', () => {
    expect(monthsOfUse('2026-04-15', '2026-04')).toBe(1)
    expect(monthsOfUse('2026-04-15', '2031-03')).toBe(60)
    expect(rule43(goods, '2031-03', 1, 5).Tc).toEqual(igst(600000))
    expect(rule43(goods, '2031-04', 1, 5).Tc).toEqual(ZERO_HEADS)
    expect(rule43([{ ...goods[0]!, common: false }], '2026-07', 1, 5).Tc).toEqual(ZERO_HEADS)
  })
})

describe('rule 37 — unpaid after 180 days', () => {
  // Bill of ₹1,18,000 (IGST ITC ₹18,000) dated 10 January 2026; ₹59,000 paid within 180 days.
  // The 180th day is 9 July 2026, so the reversal belongs to the August 2026 return: half the
  // credit (₹9,000), with interest from the January 3B due date (20 Feb) to the August 3B due date
  // (20 Sep) = 212 days at 18% p.a.
  const bill: Rule37Bill = {
    voucherId: 7, number: 'P-7', supplierRef: 'S-1', date: '2026-01-10', partyLedgerId: 3, partyName: 'Supplier',
    billAmount: r(118000), itc: igst(18000), unpaidAt180: r(59000), unpaidAtPrevEnd: r(59000), unpaidAtEnd: r(59000)
  }

  it('timeline', () => {
    expect(rule37Timeline('2026-01-10')).toEqual({ day180: '2026-07-09', reversalPeriod: '2026-08' })
    expect(gstr3bDueDate('2026-08')).toBe('2026-09-20')
  })

  it('reverses the unpaid share in the period after the 180 days, with interest', () => {
    expect(rule37Events([bill], '2026-07')).toEqual([])
    const [e] = rule37Events([bill], '2026-08')
    expect(e!.reversed).toEqual(igst(9000))
    expect(e!.interestDays).toBe(212)
    expect(e!.interest.igst).toBe(Math.round((r(9000) * 18 * 212) / 36500))
    expect(e!.reclaimed).toEqual(ZERO_HEADS)
  })

  it('re-avails proportionately in the period of payment', () => {
    const paidInOctober = { ...bill, unpaidAtPrevEnd: r(59000), unpaidAtEnd: r(29500) }
    const [e] = rule37Events([paidInOctober], '2026-10')
    expect(e!.reversed).toEqual(ZERO_HEADS)
    expect(e!.reclaimed).toEqual(igst(4500))
  })

  it('a bill paid in full within 180 days never appears', () => {
    expect(rule37Events([{ ...bill, unpaidAt180: 0 }], '2026-08')).toEqual([])
  })
})

describe('journal proposal', () => {
  it('Dr ITC reversal / Cr input tax per head, net of re-availment; interest separately; balanced', () => {
    const s = summarise({
      rule42: intra(12000), rule43: igst(2000), blocked175: intra(1000), rule37: igst(9000), reclaimed: igst(4500), interest: igst(940)
    })
    expect(s.table4B1).toEqual({ igst: r(2000), cgst: r(6000), sgst: r(6000), cess: 0 })
    expect(s.table4B2).toEqual(igst(9000))
    const lines = proposalLines(s, true)
    const dr = lines.filter((l) => l.drCr === 'dr').reduce((t, l) => t + l.amount, 0)
    const cr = lines.filter((l) => l.drCr === 'cr').reduce((t, l) => t + l.amount, 0)
    expect(dr).toBe(cr)
    expect(lines.find((l) => l.role === 'input_tax' && l.head === 'igst')).toMatchObject({ drCr: 'cr', amount: r(2000 + 9000 - 4500) })
    expect(lines.find((l) => l.role === 'input_tax' && l.head === 'cgst')).toMatchObject({ drCr: 'cr', amount: r(6000 + 500) })
    expect(lines.find((l) => l.role === 'reversal_expense')).toMatchObject({ drCr: 'dr', amount: sumHeads(s.rule42) + sumHeads(s.rule43) + sumHeads(s.blocked175) + r(9000 - 4500) })
    expect(lines.filter((l) => l.role === 'interest_expense' || l.role === 'interest_payable').map((l) => l.amount)).toEqual([r(940), r(940)])
  })

  it('a net re-availment reverses the direction; nothing → no lines', () => {
    const s = summarise({ rule42: ZERO_HEADS, rule43: ZERO_HEADS, blocked175: ZERO_HEADS, rule37: ZERO_HEADS, reclaimed: igst(100), interest: ZERO_HEADS })
    expect(proposalLines(s, true)).toEqual([
      { role: 'reversal_expense', drCr: 'cr', amount: r(100) },
      { role: 'input_tax', head: 'igst', drCr: 'dr', amount: r(100) }
    ])
    expect(proposalLines(summarise({ rule42: ZERO_HEADS, rule43: ZERO_HEADS, blocked175: ZERO_HEADS, rule37: ZERO_HEADS, reclaimed: ZERO_HEADS, interest: ZERO_HEADS }), true)).toEqual([])
  })
})
