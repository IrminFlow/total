import { describe, it, expect } from 'vitest'
import {
  documentFulfilment,
  lineFulfilment,
  threeWayMatch,
  type MatchLine
} from './fulfilment'

describe('lineFulfilment', () => {
  it('nothing received is none, not complete', () => {
    expect(lineFulfilment(10_000, 0)).toMatchObject({ pendingMilli: 10_000, overMilli: 0, state: 'none' })
  })

  it('part received is partial — never open-or-closed', () => {
    expect(lineFulfilment(10_000, 3_000)).toMatchObject({ pendingMilli: 7_000, overMilli: 0, state: 'partial' })
  })

  it('exactly what was ordered is complete', () => {
    expect(lineFulfilment(10_000, 10_000)).toMatchObject({ pendingMilli: 0, overMilli: 0, state: 'complete' })
  })

  it('more than was ordered is over, and the excess is reported rather than clipped', () => {
    expect(lineFulfilment(10_000, 12_500)).toMatchObject({ pendingMilli: 0, overMilli: 2_500, state: 'over' })
  })

  it('never reports a negative pending or a negative excess', () => {
    const f = lineFulfilment(-5, -5)
    expect(f.pendingMilli).toBe(0)
    expect(f.overMilli).toBe(0)
  })
})

describe('documentFulfilment', () => {
  it('an order received in three parts stays partial until the last one', () => {
    const ordered = 9_000
    const steps = [2_000, 5_000, 9_000]
    const states = steps.map((got) => documentFulfilment([{ orderedMilli: ordered, fulfilledMilli: got }]).state)
    expect(states).toEqual(['partial', 'partial', 'complete'])
  })

  it('does not net one line’s excess against another line’s shortfall', () => {
    // Ten bolts and ten nuts, twenty bolts delivered. A SUM(qty) − SUM(received) would call this
    // finished; the purchase desk still has ten nuts to chase.
    const f = documentFulfilment([
      { orderedMilli: 10_000, fulfilledMilli: 20_000 },
      { orderedMilli: 10_000, fulfilledMilli: 0 }
    ])
    expect(f.pendingMilli).toBe(10_000)
    expect(f.overMilli).toBe(10_000)
    expect(f.state).toBe('partial')
  })

  it('is over only when nothing at all is still owed', () => {
    const f = documentFulfilment([
      { orderedMilli: 4_000, fulfilledMilli: 4_000 },
      { orderedMilli: 1_000, fulfilledMilli: 1_500 }
    ])
    expect(f.state).toBe('over')
    expect(f.overMilli).toBe(500)
  })

  it('an empty document is complete, not none — there is nothing to owe', () => {
    expect(documentFulfilment([]).state).toBe('complete')
  })
})

const line = (p: Partial<MatchLine>): MatchLine => ({
  key: 'k',
  description: 'Bolt',
  orderedMilli: 0,
  receivedMilli: 0,
  invoicedMilli: 0,
  ...p
})

describe('threeWayMatch', () => {
  it('agrees when all three counts are the same', () => {
    const r = threeWayMatch([line({ orderedMilli: 5_000, receivedMilli: 5_000, invoicedMilli: 5_000 })])
    expect(r.clean).toBe(true)
    expect(r.rows[0]!.status).toBe('matched')
  })

  it('flags an invoice for more than was received, above every other complaint', () => {
    // Short delivery AND an over-billing on the same line: the over-billing is what costs money.
    const r = threeWayMatch([line({ orderedMilli: 10_000, receivedMilli: 6_000, invoicedMilli: 10_000 })])
    expect(r.rows[0]!.status).toBe('over_invoiced')
    expect(r.rows[0]!.invoiceVarianceMilli).toBe(4_000)
    expect(r.rows[0]!.receiptVarianceMilli).toBe(-4_000)
  })

  it('flags goods that arrived with no order behind them', () => {
    const r = threeWayMatch([line({ orderedMilli: 0, receivedMilli: 3_000, invoicedMilli: 3_000 })])
    expect(r.rows[0]!.status).toBe('not_ordered')
    expect(r.clean).toBe(false)
  })

  it('separates an over-delivery from an over-billing', () => {
    const r = threeWayMatch([line({ orderedMilli: 10_000, receivedMilli: 12_000, invoicedMilli: 12_000 })])
    expect(r.rows[0]!.status).toBe('over_received')
  })

  it('a short delivery correctly invoiced is short_received, not an invoice problem', () => {
    const r = threeWayMatch([line({ orderedMilli: 10_000, receivedMilli: 7_000, invoicedMilli: 7_000 })])
    expect(r.rows[0]!.status).toBe('short_received')
  })

  it('an invoice behind the receipts is under_invoiced, and a nil invoice is simply not billed yet', () => {
    const partly = threeWayMatch([line({ orderedMilli: 5_000, receivedMilli: 5_000, invoicedMilli: 2_000 })])
    expect(partly.rows[0]!.status).toBe('under_invoiced')
    const unbilled = threeWayMatch([line({ orderedMilli: 5_000, receivedMilli: 5_000, invoicedMilli: 0 })])
    expect(unbilled.rows[0]!.status).toBe('matched')
  })

  it('orders the exceptions worst first', () => {
    const r = threeWayMatch([
      line({ key: 'a', orderedMilli: 5_000, receivedMilli: 4_000, invoicedMilli: 4_000 }),
      line({ key: 'b', orderedMilli: 5_000, receivedMilli: 5_000, invoicedMilli: 9_000 }),
      line({ key: 'c', orderedMilli: 0, receivedMilli: 1_000, invoicedMilli: 0 })
    ])
    expect(r.exceptions.map((e) => e.key)).toEqual(['b', 'c', 'a'])
  })
})
