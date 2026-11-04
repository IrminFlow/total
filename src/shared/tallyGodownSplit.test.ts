// PR #191 re-review: an item line's BATCHALLOCATIONS can split it over several godowns — one
// inventory line per godown, quantities and amounts as Tally splits them (summing to the line).
import { describe, expect, it } from 'vitest'
import { parseTallyExport } from './tally'
import { tallyBaseMasters, tallyEnvelope, tallyItem, tallyPurchase, type TallyBatch } from './fixtures/tally/tallyXml'

const lines = (godowns: TallyBatch[], qty = 15, rupees = 1500) => {
  const data = parseTallyExport(tallyEnvelope([...tallyBaseMasters, tallyItem('Widget'), tallyPurchase('P-1', '20260401', 'Widget', qty, rupees, godowns)]))
  return { inventory: data.vouchers[0]!.inventory, warnings: data.warnings }
}

describe('Tally export: item lines split over godowns', () => {
  it('one line per godown, with Tally\'s own quantities and amounts', () => {
    expect(lines([{ godown: 'Godown A', qty: 10, rupees: 1000 }, { godown: 'Godown B', qty: 5, rupees: 500 }])).toEqual({
      inventory: [
        { item: 'Widget', qtyMilli: 10_000, amount: 100_000, direction: 'in', godown: 'Godown A' },
        { item: 'Widget', qtyMilli: 5_000, amount: 50_000, direction: 'in', godown: 'Godown B' }
      ],
      warnings: []
    })
  })

  it('batches in one godown join; one godown stays one line', () => {
    expect(lines([{ godown: 'Godown A', qty: 10, rupees: 1000 }, { godown: 'Godown A', qty: 5, rupees: 500 }]).inventory).toEqual([
      { item: 'Widget', qtyMilli: 15_000, amount: 150_000, direction: 'in', godown: 'Godown A' }
    ])
  })

  it('batches without amounts split the line\'s amount by quantity, to the paisa', () => {
    const { inventory } = lines([{ godown: 'Godown A', qty: 10 }, { godown: 'Godown B', qty: 5 }], 15, 1000)
    expect(inventory.map((l) => [l.godown, l.qtyMilli, l.amount])).toEqual([['Godown A', 10_000, 66_667], ['Godown B', 5_000, 33_333]])
  })

  it('a split that does not add up to the line keeps one line without a godown, and says so', () => {
    const qty = lines([{ godown: 'Godown A', qty: 10, rupees: 1000 }, { godown: 'Godown B', qty: 4, rupees: 500 }])
    expect(qty.inventory).toEqual([{ item: 'Widget', qtyMilli: 15_000, amount: 150_000, direction: 'in' }])
    expect(qty.warnings).toEqual([expect.stringMatching(/P-1.*Widget.*Godown A, Godown B/)])
    const money = lines([{ godown: 'Godown A', qty: 10, rupees: 1000 }, { godown: 'Godown B', qty: 5, rupees: 400 }])
    expect(money.inventory.map((l) => l.godown)).toEqual([undefined])
    expect(money.warnings).toHaveLength(1)
  })
})
