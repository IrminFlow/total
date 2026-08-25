import { describe, it, expect } from 'vitest'
import { citationsIn, parseAnswer, resolveRef } from './citations'

describe('citation refs', () => {
  it('maps every ref prefix the tools actually emit', () => {
    expect(resolveRef('tb', '17')?.target).toEqual({ kind: 'ledger', ledgerId: 17 })
    expect(resolveRef('l', '42')?.target).toEqual({ kind: 'ledger', ledgerId: 42 })
    expect(resolveRef('v', '9')?.target).toEqual({ kind: 'voucher', voucherId: 9 })
    expect(resolveRef('p', '42:2026-07')?.target).toEqual({ kind: 'ledger', ledgerId: 42 })
    expect(resolveRef('i', '3')?.target).toEqual({ kind: 'stock-item' })
    expect(resolveRef('reg', 'sales:2026-07')?.target).toEqual({ kind: 'registers' })
    expect(resolveRef('ex', 'unbalanced')?.target).toEqual({ kind: 'exceptions' })
  })

  it('refuses a prefix it does not know, rather than guessing a destination', () => {
    // A model that invents "[q4:99]" must produce a dead string, not a link to nowhere.
    expect(resolveRef('q4', '99')).toBeNull()
    expect(resolveRef('tb', 'not-a-number')).toBeNull()
  })
})

describe('answer parsing', () => {
  it('splits an answer into text and links, in order', () => {
    const segments = parseAnswer('HDFC Bank is at 12,45,600.00 [tb:17] as on today.')
    expect(segments.map((s) => s.type)).toEqual(['text', 'citation', 'text'])
    expect(segments[0]).toEqual({ type: 'text', text: 'HDFC Bank is at 12,45,600.00 ' })
    expect(segments[1]).toMatchObject({ ref: 'tb:17', label: 'ledger' })
  })

  it('leaves an unrecognised ref as literal text', () => {
    const segments = parseAnswer('Something [xyz:1] here')
    expect(segments).toEqual([{ type: 'text', text: 'Something [xyz:1] here' }])
  })

  it('handles an answer with no citations, and an empty one', () => {
    expect(parseAnswer('No figures here.')).toEqual([{ type: 'text', text: 'No figures here.' }])
    expect(parseAnswer('')).toEqual([])
  })

  it('is safe on a half-streamed ref, and becomes a link when the bracket arrives', () => {
    expect(parseAnswer('Cash is 500.00 [tb:')).toEqual([{ type: 'text', text: 'Cash is 500.00 [tb:' }])
    expect(parseAnswer('Cash is 500.00 [tb:1]').some((s) => s.type === 'citation')).toBe(true)
  })

  it('de-duplicates when collecting the citations of an answer', () => {
    const refs = citationsIn('A [tb:1] and B [v:2], then A again [tb:1].')
    expect(refs.map((c) => c.ref)).toEqual(['tb:1', 'v:2'])
  })
})
