import { describe, it, expect } from 'vitest'
import { diffJson, diffJsonDeep, diffText } from './diff'

describe('diffJsonDeep (WP 3.8 edit log)', () => {
  it('diffs nested voucher lines leaf by leaf', () => {
    const before = JSON.stringify({ number: 'R-1', lines: [{ ledgerId: 1, amount: 5000 }, { ledgerId: 2, amount: 5000 }] })
    const after = JSON.stringify({ number: 'R-1', lines: [{ ledgerId: 1, amount: 6000 }, { ledgerId: 2, amount: 6000 }] })
    const d = diffJsonDeep(before, after)
    expect(d).toEqual([
      { key: 'lines[0].amount', from: '5000', to: '6000' },
      { key: 'lines[1].amount', from: '5000', to: '6000' }
    ])
    expect(diffText(d)).toBe('lines[0].amount: 5000 → 6000; lines[1].amount: 5000 → 6000')
    expect(diffText(d, 20)).toHaveLength(20)
  })
  it('create lists every leaf; non-object JSON still diffs', () => {
    expect(diffJsonDeep(null, '{"a":{"b":1},"t":["x","y"]}')).toEqual([
      { key: 'a.b', from: '', to: '1' },
      { key: 't', from: '', to: '["x","y"]' }
    ])
    expect(diffJsonDeep('3', '4')).toEqual([{ key: 'value', from: '3', to: '4' }])
  })
})

describe('diffJson', () => {
  it('reports changed keys only', () => {
    const before = JSON.stringify({ name: 'Cash', openingBalance: 100 })
    const after = JSON.stringify({ name: 'Cash', openingBalance: 200 })
    expect(diffJson(before, after)).toEqual([{ key: 'openingBalance', from: '100', to: '200' }])
  })

  it('reports an added key with from: ""', () => {
    const before = JSON.stringify({ name: 'Cash' })
    const after = JSON.stringify({ name: 'Cash', gstin: '27AAAAA0000A1Z5' })
    expect(diffJson(before, after)).toEqual([{ key: 'gstin', from: '', to: '27AAAAA0000A1Z5' }])
  })

  it('reports a removed key with to: ""', () => {
    const before = JSON.stringify({ name: 'Cash', gstin: '27AAAAA0000A1Z5' })
    const after = JSON.stringify({ name: 'Cash' })
    expect(diffJson(before, after)).toEqual([{ key: 'gstin', from: '27AAAAA0000A1Z5', to: '' }])
  })

  it('treats a null before as an empty object (everything reads as added)', () => {
    const after = JSON.stringify({ name: 'Cash' })
    expect(diffJson(null, after)).toEqual([{ key: 'name', from: '', to: 'Cash' }])
  })

  it('treats a null after as an empty object (everything reads as removed)', () => {
    const before = JSON.stringify({ name: 'Cash' })
    expect(diffJson(before, null)).toEqual([{ key: 'name', from: 'Cash', to: '' }])
  })

  it('tolerates invalid JSON by treating it as an empty object', () => {
    expect(diffJson('not json', 'also not json')).toEqual([])
    expect(diffJson('not json', JSON.stringify({ a: 1 }))).toEqual([{ key: 'a', from: '', to: '1' }])
  })

  it('stringifies nested objects/arrays for comparison and display', () => {
    const before = JSON.stringify({ lines: [{ ledgerId: 1, amount: 100 }] })
    const after = JSON.stringify({ lines: [{ ledgerId: 1, amount: 200 }] })
    expect(diffJson(before, after)).toEqual([
      {
        key: 'lines',
        from: JSON.stringify([{ ledgerId: 1, amount: 100 }]),
        to: JSON.stringify([{ ledgerId: 1, amount: 200 }])
      }
    ])
  })

  it('returns [] for identical objects', () => {
    const json = JSON.stringify({ name: 'Cash', openingBalance: 100 })
    expect(diffJson(json, json)).toEqual([])
  })

  it('returns [] for two nulls', () => {
    expect(diffJson(null, null)).toEqual([])
  })
})
