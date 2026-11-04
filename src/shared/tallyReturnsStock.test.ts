// Bug hunt 2026-11: Tally exports read in full — VOUCHERTYPE masters (a custom "Sales Return" made
// from Credit Note), every item list (ALLINVENTORYENTRIES, INVENTORYENTRIES, the stock journal's
// INVENTORYENTRIESIN / OUT) with its direction, and bill-wise allocations (BILLALLOCATIONS).
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { parseTallyExport, tallyBaseTypeName } from './tally'

const xml = readFileSync(new URL('./fixtures/tally/daybook-returns-stock-bills.xml', import.meta.url), 'utf8')
const data = parseTallyExport(xml)
const byNumber = (n: string) => data.vouchers.find((v) => v.number === n)!

describe('Tally export: voucher types, item lists, bill allocations', () => {
  it('reads VOUCHERTYPE masters and follows PARENT to the predefined type', () => {
    expect(data.voucherTypes).toEqual([
      { name: 'Sales', parent: 'Sales' },
      { name: 'Sales Return', parent: 'Credit Note' },
      { name: 'Purchase Return', parent: 'Debit Note' },
      { name: 'Assembly', parent: 'Stock Journal' }
    ])
    expect(tallyBaseTypeName('Sales Return', data.voucherTypes)).toBe('Credit Note')
    expect(tallyBaseTypeName('sales', data.voucherTypes)).toBe('sales')
    expect(tallyBaseTypeName('Payment', data.voucherTypes)).toBe('Payment')
    // A loop in the masters never hangs.
    expect(tallyBaseTypeName('A', [{ name: 'A', parent: 'B' }, { name: 'B', parent: 'A' }])).toBe('A')
  })
  it('imports every voucher — stock and manufacturing journals without ledger entries included', () => {
    expect(data.vouchers.map((v) => v.number)).toEqual(['S-1', 'SR-1', 'P-1', 'PR-1', 'R-1', 'MJ-1', 'AS-1'])
    expect(data.warnings).toEqual([])
  })
  it('reads INVENTORYENTRIES.LIST (voucher mode) and the stock journal IN / OUT lists with their direction', () => {
    expect(byNumber('P-1').inventory).toEqual([{ item: 'Steel Rod', qtyMilli: 30_000, amount: 300_000, direction: 'in' }])
    expect(byNumber('MJ-1').inventory).toEqual([
      { item: 'Bracket', qtyMilli: 2_000, amount: 40_000, direction: 'in', godown: 'Main Location' },
      { item: 'Steel Rod', qtyMilli: 4_000, amount: 40_000, direction: 'out', godown: 'Main Location' }
    ])
    expect(byNumber('AS-1').inventory.map((l) => [l.item, l.direction])).toEqual([['Steel Rod', 'out'], ['Bracket', 'in']])
    expect(byNumber('SR-1').inventory[0]!.direction).toBe('in')
  })
  it('reads bill-wise allocations on the party entry (credit period -> due date)', () => {
    expect(byNumber('S-1').lines.find((l) => l.ledger === 'Ramesh Traders')!.bills).toEqual([{ name: 'S-1', type: 'new', amount: 100_000, dueDate: '2026-09-04' }])
    expect(byNumber('R-1').lines[0]!.bills).toEqual([
      { name: 'S-1', type: 'against', amount: 50_000, dueDate: null },
      { name: 'R-1', type: 'advance', amount: 20_000, dueDate: null }
    ])
    expect(byNumber('R-1').lines[1]!.bills).toBeUndefined()
  })
})
