// WP 2.5b lists: the pure half of "Convert to invoice / bill".
import { describe, expect, it } from 'vitest'
import type { OpenSourceLine } from './types'
import { convertiblePurpose, convertPicks, convertTogetherProblem, noteStatusLabel } from './convert'
import { rowsFromSourcePicks } from '../voucherEdit/addFrom'

const line = (uid: string, over: Partial<OpenSourceLine>): OpenSourceLine => ({
  lineUid: uid, voucherId: null, tradeDocId: null, kind: 'delivery_note', label: uid, date: '2025-05-01', stockItemId: 1, godownId: null,
  batchId: null, serials: [], qtyMilli: 5000, doneMilli: 0, pendingMilli: 5000, ratePaise: 10_000, amount: 50_000, ...over
})

describe('convertPicks', () => {
  const lines = [
    line('a', { voucherId: 1, pendingMilli: 2000, doneMilli: 3000 }),
    line('b', { voucherId: 2 }),
    line('c', { voucherId: 3 }),
    line('o', { tradeDocId: 1, kind: 'sales_order' }),
    line('z', { voucherId: 1, pendingMilli: 0, doneMilli: 5000 })
  ]
  it('takes every pending line of the named challans at its full pending quantity, in the open lines order', () => {
    expect(convertPicks(lines, { voucherIds: [2, 1] }).map((p) => [p.line.lineUid, p.qtyMilli])).toEqual([['a', 2000], ['b', 5000]])
  })
  it('an order id never matches a voucher with the same id (and vice versa)', () => {
    expect(convertPicks(lines, { tradeDocId: 1 }).map((p) => p.line.lineUid)).toEqual(['o'])
    expect(convertPicks(lines, {})).toEqual([])
  })
  it('the picks become the drawer\'s rows, linked as fulfilment', () => {
    const rows = rowsFromSourcePicks(convertPicks(lines, { voucherIds: [1] }), { linkType: 'fulfil' })
    expect(rows).toEqual([{ itemId: 1, qtyText: '2', rate: 10_000, discount: null, godownId: null, batchId: null, source: { lineUid: 'a', linkType: 'fulfil' } }])
  })
})

describe('which notes convert, and together', () => {
  it('supply / approval challans and purchase GRNs (the GDNI / GRNI purposes)', () => {
    expect(['supply', 'approval', 'job_work', 'liquid_gas', 'non_supply'].map((p) => convertiblePurpose('delivery_note', p as never))).toEqual([true, true, false, false, false])
    expect(['purchase', 'job_work', 'return'].map((p) => convertiblePurpose('receipt_note', p as never))).toEqual([true, false, false])
  })
  it('one party, all convertible', () => {
    expect(convertTogetherProblem([{ convertible: true, partyLedgerId: 4 }, { convertible: true, partyLedgerId: 4 }])).toBeNull()
    expect(convertTogetherProblem([{ convertible: true, partyLedgerId: 4 }, { convertible: true, partyLedgerId: 5 }])).toMatch(/one party/)
    expect(convertTogetherProblem([{ convertible: false, partyLedgerId: 4 }])).toMatch(/pending/)
    expect(convertTogetherProblem([])).toMatch(/Pick/)
  })
  it('status words per side', () => {
    expect(noteStatusLabel('delivery_note', 'partly')).toBe('Partly invoiced')
    expect(noteStatusLabel('receipt_note', 'done')).toBe('Billed')
    expect(noteStatusLabel('receipt_note', 'done', true)).toBe('Returned')
    expect(noteStatusLabel('delivery_note', 'closed')).toBe('Short-closed')
  })
})
