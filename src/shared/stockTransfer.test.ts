import { describe, it, expect } from 'vitest'
import { planTransfer, type TransferItemFacts } from './stockTransfer'

const facts = (over: Partial<TransferItemFacts> = {}): TransferItemFacts => ({
  name: 'Bolts',
  unitSymbol: 'Nos',
  decimals: 2,
  availableQtyMilli: 100_000,
  costPaise: 25_000,
  ...over
})

const oneItem = (over: Partial<TransferItemFacts> = {}): Map<number, TransferItemFacts> =>
  new Map([[1, facts(over)]])

describe('planTransfer', () => {
  it('takes out of one godown and puts into the other, same item, quantity and value', () => {
    const plan = planTransfer({ fromGodownId: 1, toGodownId: 2, items: [{ stockItemId: 1, qtyMilli: 10_000 }] }, oneItem())
    expect(plan.errors).toEqual([])
    expect(plan.lines).toHaveLength(2)
    const [out, into] = plan.lines
    expect(out).toMatchObject({ direction: 'out', godownId: 1, qtyMilli: 10_000, amount: 25_000 })
    expect(into).toMatchObject({ direction: 'in', godownId: 2, qtyMilli: 10_000, amount: 25_000 })
    // The whole point: what leaves equals what arrives, so company-wide stock does not move.
    expect(out!.amount).toBe(into!.amount)
    expect(out!.qtyMilli).toBe(into!.qtyMilli)
    expect(plan.totalValue).toBe(25_000)
  })

  it('refuses to move more than the source godown holds', () => {
    const plan = planTransfer(
      { fromGodownId: 1, toGodownId: 2, items: [{ stockItemId: 1, qtyMilli: 120_000 }] },
      oneItem({ availableQtyMilli: 100_000 })
    )
    expect(plan.lines).toEqual([])
    expect(plan.errors).toEqual(['Bolts: only 100.00 Nos in the source godown, cannot move 120.00 Nos'])
  })

  it('allows moving exactly what is there', () => {
    const plan = planTransfer(
      { fromGodownId: 1, toGodownId: 2, items: [{ stockItemId: 1, qtyMilli: 100_000 }] },
      oneItem({ availableQtyMilli: 100_000 })
    )
    expect(plan.errors).toEqual([])
  })

  it('refuses a godown that holds nothing, and does not print a negative availability', () => {
    const plan = planTransfer(
      { fromGodownId: 1, toGodownId: 2, items: [{ stockItemId: 1, qtyMilli: 1000 }] },
      oneItem({ availableQtyMilli: -5000 })
    )
    expect(plan.errors[0]).toContain('only 0.00 Nos')
  })

  it('refuses a move to the same godown', () => {
    const plan = planTransfer({ fromGodownId: 1, toGodownId: 1, items: [{ stockItemId: 1, qtyMilli: 1000 }] }, oneItem())
    expect(plan.errors).toContain('Stock has to move to a different godown')
    expect(plan.lines).toEqual([])
  })

  it('refuses an empty transfer, a zero quantity and an unknown item', () => {
    expect(planTransfer({ fromGodownId: 1, toGodownId: 2, items: [] }, new Map()).errors).toEqual([
      'Nothing to move — add at least one item'
    ])
    expect(
      planTransfer({ fromGodownId: 1, toGodownId: 2, items: [{ stockItemId: 1, qtyMilli: 0 }] }, oneItem()).errors
    ).toEqual(['Bolts: quantity to move must be more than zero'])
    expect(
      planTransfer({ fromGodownId: 1, toGodownId: 2, items: [{ stockItemId: 9, qtyMilli: 1000 }] }, oneItem()).errors
    ).toEqual(['Item 9 does not exist'])
  })

  it('refuses the same item twice, which would each pass the availability check and together overdraw', () => {
    const plan = planTransfer(
      {
        fromGodownId: 1,
        toGodownId: 2,
        items: [
          { stockItemId: 1, qtyMilli: 80_000 },
          { stockItemId: 1, qtyMilli: 80_000 }
        ]
      },
      oneItem({ availableQtyMilli: 100_000 })
    )
    expect(plan.errors).toEqual(['Bolts is on the transfer twice — put the whole quantity on one line'])
  })

  it('reports every problem at once rather than one per attempt', () => {
    const plan = planTransfer(
      {
        fromGodownId: 1,
        toGodownId: 1,
        items: [
          { stockItemId: 1, qtyMilli: 0 },
          { stockItemId: 2, qtyMilli: 5000 }
        ]
      },
      new Map([[1, facts()], [2, facts({ name: 'Nuts', availableQtyMilli: 1000 })]])
    )
    expect(plan.errors).toHaveLength(3)
  })

  it('shows a rate for display without letting it decide the value', () => {
    // 3 units costing 1000 paise is 333.33 paise per unit; the rate rounds, the amount does not.
    const plan = planTransfer(
      { fromGodownId: 1, toGodownId: 2, items: [{ stockItemId: 1, qtyMilli: 3000 }] },
      oneItem({ costPaise: 1000 })
    )
    expect(plan.lines[0]!.ratePaise).toBe(333)
    expect(plan.lines[0]!.amount).toBe(1000)
    expect(plan.lines[1]!.amount).toBe(1000)
  })

  it('moves a free item without inventing a value for it', () => {
    const plan = planTransfer(
      { fromGodownId: 1, toGodownId: 2, items: [{ stockItemId: 1, qtyMilli: 5000 }] },
      oneItem({ costPaise: 0 })
    )
    expect(plan.errors).toEqual([])
    expect(plan.lines.map((l) => l.amount)).toEqual([0, 0])
    expect(plan.lines.map((l) => l.ratePaise)).toEqual([0, 0])
  })
})
