import { describe, it, expect } from 'vitest'
import { diffJson } from './diff'

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
