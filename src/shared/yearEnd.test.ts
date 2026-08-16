import { describe, it, expect } from 'vitest'
import { planClose, type CloseLedgerRow } from './yearEnd'

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
