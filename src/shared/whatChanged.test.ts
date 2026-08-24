import { describe, expect, it } from 'vitest'
import { summariseChanges, type ChangeInput } from './whatChanged'

const row = (over: Partial<ChangeInput> & { ledgerId: number }): ChangeInput => ({
  ledgerName: `L${over.ledgerId}`,
  groupName: 'Sundry Debtors',
  opening: 0,
  closing: 0,
  vouchers: 0,
  ...over
})

describe('summariseChanges', () => {
  it('ranks by the size of the move, not by name', () => {
    const r = summariseChanges('2026-04-01', '2026-04-30', [
      row({ ledgerId: 1, ledgerName: 'Aaa', opening: 0, closing: 100_00, vouchers: 1 }),
      row({ ledgerId: 2, ledgerName: 'Zzz', opening: 0, closing: -900_00, vouchers: 3 })
    ])
    expect(r.rows.map((x) => x.ledgerName)).toEqual(['Zzz', 'Aaa'])
    expect(r.rows[0]!.change).toBe(-900_00)
  })

  it('drops ledgers that neither moved nor were touched', () => {
    const r = summariseChanges('2026-04-01', '2026-04-30', [
      row({ ledgerId: 1, opening: 500_00, closing: 500_00 }),
      row({ ledgerId: 2, opening: 0, closing: 10_00, vouchers: 1 })
    ])
    expect(r.rows).toHaveLength(1)
    expect(r.movedCount).toBe(1)
  })

  it('keeps a ledger whose entries offset to nothing — that is worth seeing', () => {
    const r = summariseChanges('2026-04-01', '2026-04-30', [
      row({ ledgerId: 1, opening: 100_00, closing: 100_00, vouchers: 4 })
    ])
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0]!.change).toBe(0)
    expect(r.movedCount).toBe(0)
  })

  it('reports no percentage for a ledger that started at zero', () => {
    const r = summariseChanges('2026-04-01', '2026-04-30', [row({ ledgerId: 1, opening: 0, closing: 250_00, vouchers: 1 })])
    expect(r.rows[0]!.changePct).toBeNull()
  })

  it('measures the percentage against the size of the opening, so a credit balance is not inverted', () => {
    const r = summariseChanges('2026-04-01', '2026-04-30', [
      row({ ledgerId: 1, opening: -200_00, closing: -300_00, vouchers: 1 })
    ])
    // A liability that grew by 100 on a 200 base has grown 50%, and the change stays negative.
    expect(r.rows[0]!.change).toBe(-100_00)
    expect(r.rows[0]!.changePct).toBe(-50)
  })

  it('nets to zero over a balanced set of books', () => {
    const r = summariseChanges('2026-04-01', '2026-04-30', [
      row({ ledgerId: 1, opening: 0, closing: 500_00, vouchers: 1 }),
      row({ ledgerId: 2, opening: 0, closing: -500_00, vouchers: 1 })
    ])
    expect(r.netChange).toBe(0)
  })

  it('an empty period reports nothing changed rather than failing', () => {
    const r = summariseChanges('2026-04-01', '2026-04-01', [])
    expect(r.rows).toEqual([])
    expect(r.netChange).toBe(0)
    expect(r.movedCount).toBe(0)
  })

  it('a ledger with only an opening balance and no entries is not reported as a change', () => {
    const r = summariseChanges('2026-04-01', '2026-04-30', [row({ ledgerId: 1, opening: 900_00, closing: 900_00 })])
    expect(r.rows).toEqual([])
  })
})
