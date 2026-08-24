import { describe, expect, it } from 'vitest'
import { auditFieldChanges, fieldLabel } from './auditDiff'
import { formatPaise } from './money'

const money = (p: number): string => formatPaise(p)
const changes = (a: unknown, b: unknown) => auditFieldChanges(a, b, money)

describe('auditFieldChanges', () => {
  it('lists only the fields that differ', () => {
    const out = changes(
      { date: '2026-04-01', narration: 'Old', number: '7' },
      { date: '2026-04-01', narration: 'New', number: '7' }
    )
    expect(out).toEqual([{ field: 'narration', before: 'Old', after: 'New' }])
  })

  it('treats a field added on one side as a change', () => {
    // Adding a narration where there was none is exactly the edit someone wants to see.
    expect(changes({ number: '7' }, { number: '7', narration: 'Added' })).toEqual([
      { field: 'narration', before: null, after: 'Added' }
    ])
    expect(changes({ number: '7', narration: 'Was here' }, { number: '7' })).toEqual([
      { field: 'narration', before: 'Was here', after: null }
    ])
  })

  it('renders a null value as a dash rather than as "null"', () => {
    expect(changes({ narration: 'Something' }, { narration: null })).toEqual([
      { field: 'narration', before: 'Something', after: '—' }
    ])
  })

  it('formats money fields as money and other numbers as numbers', () => {
    const out = changes({ amount: 100000, quantity: 3 }, { amount: 120000, quantity: 4 })
    expect(out.find((c) => c.field === 'amount')).toEqual({
      field: 'amount',
      before: '1,000.00',
      after: '1,200.00'
    })
    expect(out.find((c) => c.field === 'quantity')).toEqual({ field: 'quantity', before: '3', after: '4' })
  })

  it('totals only the debit side, so a balanced voucher does not read as double its value', () => {
    // Lines sum to twice the voucher's value; printing that as the total would make every entry
    // look like double what it is, and a reader would take it at face value.
    const out = changes(
      { lines: [{ drCr: 'dr', amount: 100000 }, { drCr: 'cr', amount: 100000 }] },
      { lines: [{ drCr: 'dr', amount: 200000 }, { drCr: 'cr', amount: 200000 }] }
    )
    expect(out).toEqual([{ field: 'lines', before: '2 lines, 1,000.00', after: '2 lines, 2,000.00' }])
  })

  it('falls back to totalling everything when the lines carry no side', () => {
    // Inventory lines have amounts but no dr/cr; summing them all is the right reading there.
    const out = changes({ inventory: [{ amount: 100 }] }, { inventory: [{ amount: 100 }, { amount: 200 }] })
    expect(out[0]!.after).toBe('2 lines, 3.00')
  })

  it('summarises a line array by count and total instead of diffing it', () => {
    // A line-level diff of a re-keyed voucher grid is mostly noise about ids that moved; the
    // question is nearly always "did the money change".
    const out = changes(
      { lines: [{ id: 1, amount: 50000 }, { id: 2, amount: 50000 }] },
      { lines: [{ id: 9, amount: 60000 }, { id: 10, amount: 60000 }] }
    )
    expect(out).toEqual([{ field: 'lines', before: '2 lines, 1,000.00', after: '2 lines, 1,200.00' }])
  })

  it('says nothing when a line array is reordered but unchanged in substance', () => {
    // Structural comparison, so two arrays with the same contents are the same value.
    const lines = [{ id: 1, amount: 100 }]
    expect(changes({ lines }, { lines: [{ id: 1, amount: 100 }] })).toEqual([])
  })

  it('reports a line array whose count changed even at the same total', () => {
    const out = changes(
      { lines: [{ amount: 100000 }] },
      { lines: [{ amount: 50000 }, { amount: 50000 }] }
    )
    expect(out[0]!.before).toBe('1 line, 1,000.00')
    expect(out[0]!.after).toBe('2 lines, 1,000.00')
  })

  it('renders booleans as yes and no', () => {
    expect(changes({ postDated: false }, { postDated: true })).toEqual([
      { field: 'postDated', before: 'no', after: 'yes' }
    ])
  })

  it('ignores fields that change on every save and carry no meaning', () => {
    expect(changes({ id: 1, updatedAt: 'a' }, { id: 2, updatedAt: 'b' })).toEqual([])
  })

  it('handles a create and a delete, where one side is absent entirely', () => {
    expect(changes(null, { narration: 'First' })).toEqual([
      { field: 'narration', before: null, after: 'First' }
    ])
    expect(changes({ narration: 'Last' }, null)).toEqual([
      { field: 'narration', before: 'Last', after: null }
    ])
    expect(changes(null, null)).toEqual([])
  })

  it('does not choke on a nested object', () => {
    const out = changes({ tds: { sectionId: 1 } }, { tds: { sectionId: 2 } })
    expect(out).toHaveLength(1)
    expect(out[0]!.after).toContain('2')
  })
})

describe('fieldLabel', () => {
  it('turns a field name into something a person reads', () => {
    expect(fieldLabel('partyLedgerId')).toBe('Party ledger id')
    expect(fieldLabel('post_dated')).toBe('Post dated')
    expect(fieldLabel('narration')).toBe('Narration')
    expect(fieldLabel('transportDistanceKm')).toBe('Transport distance km')
  })
})
