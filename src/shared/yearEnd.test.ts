import { describe, it, expect } from 'vitest'
import { planClose, diffCloseNets, expectedCloseNets, type CloseLedgerRow } from './yearEnd'

describe('planClose', () => {
  it('profit: income credit balance dr\'d, expense debit balance cr\'d, netProfit positive', () => {
    const rows: CloseLedgerRow[] = [
      { ledgerId: 1, name: 'Sales Account', nature: 'income', net: -100000 }, // ₹1,000 credit balance
      { ledgerId: 2, name: 'Rent', nature: 'expense', net: 60000 } // ₹600 debit balance
    ]
    const plan = planClose(rows)
    expect(plan.lines).toEqual([
      { ledgerId: 1, drCr: 'dr', amount: 100000 },
      { ledgerId: 2, drCr: 'cr', amount: 60000 }
    ])
    expect(plan.netProfit).toBe(40000) // ₹400 profit
  })

  it('loss: netProfit negative', () => {
    const rows: CloseLedgerRow[] = [
      { ledgerId: 1, name: 'Sales Account', nature: 'income', net: -60000 },
      { ledgerId: 2, name: 'Rent', nature: 'expense', net: 100000 }
    ]
    const plan = planClose(rows)
    expect(plan.lines).toEqual([
      { ledgerId: 1, drCr: 'dr', amount: 60000 },
      { ledgerId: 2, drCr: 'cr', amount: 100000 }
    ])
    expect(plan.netProfit).toBe(-40000)
  })

  it('skips ledgers with zero net', () => {
    const rows: CloseLedgerRow[] = [
      { ledgerId: 1, name: 'Sales Account', nature: 'income', net: -100000 },
      { ledgerId: 2, name: 'Rent', nature: 'expense', net: 100000 },
      { ledgerId: 3, name: 'Untouched Income', nature: 'income', net: 0 }
    ]
    const plan = planClose(rows)
    expect(plan.lines.map((l) => l.ledgerId)).toEqual([1, 2])
    expect(plan.netProfit).toBe(0)
  })

  it('handles contra-signed ledgers by balance sign, not nature', () => {
    const rows: CloseLedgerRow[] = [
      // Expense ledger with an (unusual) credit net — e.g. a purchase return exceeding purchases.
      { ledgerId: 1, name: 'Purchase Returns Heavy', nature: 'expense', net: -20000 },
      // Income ledger with an (unusual) debit net — e.g. a sales return exceeding sales.
      { ledgerId: 2, name: 'Sales Returns Heavy', nature: 'income', net: 30000 }
    ]
    const plan = planClose(rows)
    expect(plan.lines).toEqual([
      { ledgerId: 1, drCr: 'dr', amount: 20000 },
      { ledgerId: 2, drCr: 'cr', amount: 30000 }
    ])
    expect(plan.netProfit).toBe(-10000)
  })

  it('lines plus the appended retained-earnings line always balance', () => {
    const cases: CloseLedgerRow[][] = [
      [
        { ledgerId: 1, name: 'Sales Account', nature: 'income', net: -100000 },
        { ledgerId: 2, name: 'Rent', nature: 'expense', net: 60000 }
      ],
      [
        { ledgerId: 1, name: 'Sales Account', nature: 'income', net: -60000 },
        { ledgerId: 2, name: 'Rent', nature: 'expense', net: 100000 }
      ],
      [
        { ledgerId: 1, name: 'Purchase Returns Heavy', nature: 'expense', net: -20000 },
        { ledgerId: 2, name: 'Sales Returns Heavy', nature: 'income', net: 30000 },
        { ledgerId: 3, name: 'Consulting Income', nature: 'income', net: -50000 }
      ]
    ]
    for (const rows of cases) {
      const plan = planClose(rows)
      const retained = { drCr: plan.netProfit > 0 ? ('cr' as const) : ('dr' as const), amount: Math.abs(plan.netProfit) }
      const allLines = [...plan.lines, { ledgerId: -1, ...retained }]
      const totalDr = allLines.filter((l) => l.drCr === 'dr').reduce((s, l) => s + l.amount, 0)
      const totalCr = allLines.filter((l) => l.drCr === 'cr').reduce((s, l) => s + l.amount, 0)
      expect(totalDr).toBe(totalCr)
    }
  })

  it('returns no lines and zero profit for an empty FY', () => {
    const plan = planClose([])
    expect(plan.lines).toEqual([])
    expect(plan.netProfit).toBe(0)
  })
})

describe('guided re-close (0.4.0 closes)', () => {
  // FY1: Sales stored opening Cr 5,000 + movements Cr 30,000; Rent Dr 10,000. Today's rule closes
  // Sales Dr 35,000, Rent Cr 10,000, Retained Earnings (id 9) Cr 25,000.
  const rows: CloseLedgerRow[] = [
    { ledgerId: 1, name: 'Sales', nature: 'income', net: -35_000_00 },
    { ledgerId: 2, name: 'Rent', nature: 'expense', net: 10_000_00 }
  ]
  it('expected nets reverse each amount and put the sum on the transfer ledger', () => {
    expect([...expectedCloseNets(rows, 9)]).toEqual([[1, 35_000_00], [2, -10_000_00], [9, -25_000_00]])
  })
  it('a 0.4.0 close (movements only) differs on Sales and Retained Earnings by the stored opening', () => {
    // 0.4.0 posted Sales Dr 30,000, Rent Cr 10,000, Retained Earnings Cr 20,000.
    const stored = new Map([[1, 30_000_00], [2, -10_000_00], [9, -20_000_00]])
    expect(diffCloseNets(stored, expectedCloseNets(rows, 9))).toEqual([
      { ledgerId: 1, stored: 30_000_00, expected: 35_000_00 },
      { ledgerId: 9, stored: -20_000_00, expected: -25_000_00 }
    ])
  })
  it('a correct close has no difference', () => {
    const e = expectedCloseNets(rows, 9)
    expect(diffCloseNets(new Map(e), e)).toEqual([])
  })
})
