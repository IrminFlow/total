import { describe, expect, it } from 'vitest'
import { settlementTimeline } from './settlements'
import type { BillEvent } from '../outstanding'

const bill = (voucherId: number, date: string, name: string, amount: number): BillEvent => ({ voucherId, date, number: `V${voucherId}`, amount, refs: [{ kind: 'new', name, amount, dueDate: null }] })
const pay = (voucherId: number, date: string, amount: number, against?: string): BillEvent => ({
  voucherId, date, number: `P${voucherId}`, amount: -amount, refs: against ? [{ kind: 'against', name: against, amount, dueDate: null }] : []
})

describe('settlement timeline', () => {
  it('sees a bill and its payment on the same day', () => {
    const t = settlementTimeline([bill(1, '2026-05-01', 'B-1', 1000), pay(2, '2026-05-01', 1000, 'B-1')], '2026-09-30', null, '2026-04-01')
    expect(t).toEqual([{ billKey: '1|B-1', billDate: '2026-05-01', billVoucherId: 1, byVoucherId: 2, date: '2026-05-01', amount: 1000 }])
  })
  it('splits a bill paid in two parts, keeping each settling voucher', () => {
    const t = settlementTimeline([bill(1, '2026-04-01', 'B-1', 1000), pay(2, '2026-04-20', 400), pay(3, '2026-06-30', 600)], '2026-09-30', null, '2026-04-01')
    expect(t.map((x) => [x.byVoucherId, x.date, x.amount])).toEqual([[2, '2026-04-20', 400], [3, '2026-06-30', 600]])
  })
  it('starts from the given date', () => {
    const t = settlementTimeline([bill(1, '2026-03-01', 'B-1', 1000), pay(2, '2026-03-05', 300), pay(3, '2026-04-05', 700)], '2026-09-30', null, '2026-04-01')
    expect(t.map((x) => x.amount)).toEqual([700])
  })
})
