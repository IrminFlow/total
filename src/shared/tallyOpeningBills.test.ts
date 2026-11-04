// PR #191 review: a Tally ledger master's opening bill-wise details (BILLALLOCATIONS.LIST under
// LEDGER — BILLDATE, NAME, BILLCREDITPERIOD from the bill date, OPENINGBALANCE in Tally's sign) and
// Physical Stock vouchers (counts, no ledger entries) are read from the file.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { parseTallyExport } from './tally'

const xml = readFileSync(new URL('./fixtures/tally/opening-bills-physical-stock.xml', import.meta.url), 'utf8')
const data = parseTallyExport(xml)
const ledger = (name: string) => data.ledgers.find((l) => l.name === name)!

describe('Tally export: opening bill-wise details, physical stock', () => {
  it('reads each party master\'s opening bills, dr-positive, due from the bill date', () => {
    expect(ledger('Ramesh Traders').opening).toBe(150_000)
    expect(ledger('Ramesh Traders').bills).toEqual([
      { name: 'INV/24-25/71', date: '2025-02-10', dueDate: '2025-03-12', amount: 50_000 },
      { name: 'INV/24-25/88', date: '2025-03-15', dueDate: '2025-04-14', amount: 100_000 }
    ])
    expect(ledger('Kumar Steel').bills).toEqual([
      { name: 'KS/101', date: '2025-02-05', dueDate: '2025-02-20', amount: -200_000 },
      { name: 'KS/102', date: '2025-03-25', dueDate: '2025-04-15', amount: -300_000 }
    ])
    // An advance in the opening is on the other side.
    expect(ledger('Patel & Co').bills!.map((b) => [b.name, b.amount])).toEqual([['PC/9', 100_000], ['ADV/3', -20_000]])
    expect(ledger('Mehta Stores').bills).toBeUndefined()
    expect(ledger('Sales Account').bills).toBeUndefined()
  })

  it('keeps Physical Stock vouchers (no ledger entries) under the predefined name or a custom type', () => {
    expect(data.vouchers.map((v) => v.number)).toEqual(['R-1', 'R-2', 'PY-1', 'CS-1', 'SJ-1', 'PS-1', 'SC-1'])
    expect(data.warnings).toEqual([])
    expect(data.vouchers.find((v) => v.number === 'PS-1')!.inventory).toEqual([
      { item: 'Bracket', qtyMilli: 10_000, amount: 0, direction: 'in', godown: 'Main Location' }
    ])
    expect(data.vouchers.find((v) => v.number === 'SC-1')!.inventory.map((l) => [l.item, l.qtyMilli])).toEqual([['Steel Rod', 18_000]])
  })
})
