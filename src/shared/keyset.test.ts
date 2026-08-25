import { describe, it, expect } from 'vitest'
import { compareKeys, decodeCursor, encodeCursor, keysetAfter, keysetOrderBy } from './keyset'

describe('compareKeys', () => {
  it('orders by the first column that differs', () => {
    expect(compareKeys(['2026-04-01', 9], ['2026-04-02', 1])).toBeLessThan(0)
    expect(compareKeys(['2026-04-02', 1], ['2026-04-01', 9])).toBeGreaterThan(0)
  })

  it('falls through to the tiebreak when the leading keys are equal — the whole point of the tuple', () => {
    expect(compareKeys(['2026-04-01', 7], ['2026-04-01', 8])).toBeLessThan(0)
    expect(compareKeys(['2026-04-01', 8], ['2026-04-01', 7])).toBeGreaterThan(0)
    expect(compareKeys(['2026-04-01', 8], ['2026-04-01', 8])).toBe(0)
  })

  it('compares numbers numerically, not as text', () => {
    // '10' < '9' as strings, which is how a keyset cursor silently skips 90% of a book.
    expect(compareKeys([9], [10])).toBeLessThan(0)
  })

  it('sorts a list the same way SQLite would order by the same columns', () => {
    const rows = [
      ['2026-04-02', 1],
      ['2026-04-01', 12],
      ['2026-04-01', 2],
      ['2026-03-31', 99]
    ] as const
    const sorted = [...rows].sort(compareKeys)
    expect(sorted).toEqual([
      ['2026-03-31', 99],
      ['2026-04-01', 2],
      ['2026-04-01', 12],
      ['2026-04-02', 1]
    ])
  })
})

describe('keysetAfter', () => {
  it('emits a row-value comparison over the ordering columns', () => {
    const { sql, params } = keysetAfter(['v.date', 'v.id'], ['2026-04-01', 42])
    expect(sql).toBe('(v.date, v.id) > (?, ?)')
    expect(params).toEqual(['2026-04-01', 42])
  })

  it('parenthesises a single column too', () => {
    expect(keysetAfter(['id'], [7]).sql).toBe('(id) > (?)')
  })

  it('refuses a cursor of the wrong width — a short cursor is a partial order', () => {
    expect(() => keysetAfter(['v.date', 'v.id'], ['2026-04-01'])).toThrow(/2 columns but 1/)
  })

  it('refuses anything but a plain identifier as a column', () => {
    expect(() => keysetAfter(['v.id; DROP TABLE vouchers'], [1])).toThrow(/unsafe/)
    expect(() => keysetAfter(['(SELECT 1)'], [1])).toThrow(/unsafe/)
    expect(() => keysetAfter([], [])).toThrow(/no ordering columns/)
  })

  it('names the same columns as the ORDER BY it is paired with', () => {
    const cols = ['v.date', 'v.id']
    expect(keysetOrderBy(cols)).toBe('v.date, v.id')
    expect(keysetAfter(cols, ['2026-04-01', 1]).sql).toContain('v.date, v.id')
  })
})

describe('cursor encoding', () => {
  it('round-trips a tuple', () => {
    const cursor = ['2026-04-01', 4231]
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor)
  })

  it('round-trips values that would break a delimiter-joined cursor', () => {
    const cursor = ['a|b:c,"d"', 12, 'शर्मा ट्रेडर्स ₹']
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor)
  })

  it('is url- and querykey-safe', () => {
    expect(encodeCursor(['2026-04-01', 1])).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('returns null rather than throwing on anything malformed', () => {
    expect(decodeCursor(null)).toBeNull()
    expect(decodeCursor('')).toBeNull()
    expect(decodeCursor('not-base64!!')).toBeNull()
    expect(decodeCursor(encodeCursor([]))).toBeNull()
    // A JSON object is well-formed base64 and still not a cursor.
    expect(decodeCursor(Buffer.from('{"a":1}', 'utf8').toString('base64'))).toBeNull()
    // Non-finite numbers do not survive JSON and must not decode to null-the-value.
    expect(decodeCursor(Buffer.from('[null]', 'utf8').toString('base64'))).toBeNull()
  })
})
