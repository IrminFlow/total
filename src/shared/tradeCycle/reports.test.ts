import { describe, it, expect } from 'vitest'
import { beyondTolerance, DEFAULT_MATCH_TOLERANCES, expectedAmount, threeWayMatch, type MatchInputLine } from './match'
import { chainLevels, fullDeliveryDate, monthLabel, pct, summariseOrderBook } from './analysis'
import type { OrderBookRow } from './types'

const line = (p: Partial<MatchInputLine> & Pick<MatchInputLine, 'stage' | 'lineUid'>): MatchInputLine => ({
  voucherId: p.stage === 'po' ? null : 1, tradeDocId: p.stage === 'po' ? 1 : null, number: 'X', date: '2025-05-01', qtyMilli: 10_000,
  ratePaise: 10_000, amount: 100_000, partyLedgerId: 1, partyName: 'S', stockItemId: 1, itemName: 'W', decimals: 0, sourceUid: null,
  anchor: true, ...p
})

describe('threeWayMatch', () => {
  it('clean chain: no exceptions', () => {
    expect(threeWayMatch([
      line({ stage: 'po', lineUid: 'p', anchor: false }),
      line({ stage: 'grn', lineUid: 'g', sourceUid: 'p' }),
      line({ stage: 'bill', lineUid: 'b', sourceUid: 'g' })
    ])).toEqual([])
  })

  it('rate variance compares with the PO, else the GRN; pro rata for a partial bill', () => {
    const rows = threeWayMatch([
      line({ stage: 'po', lineUid: 'p', anchor: false, amount: 90_000 }),
      line({ stage: 'grn', lineUid: 'g', sourceUid: 'p' }),
      line({ stage: 'bill', lineUid: 'b', sourceUid: 'g', qtyMilli: 5000, amount: 50_000 })
    ])
    expect(rows.map((r) => [r.exception, r.expectedPaise, r.diffPaise])).toEqual([
      ['rate_variance', 45_000, 5000], ['qty_unbilled', null, 50_000]
    ])
    const noPo = threeWayMatch([
      line({ stage: 'grn', lineUid: 'g' }),
      line({ stage: 'bill', lineUid: 'b', sourceUid: 'g', amount: 101_000 })
    ], { ...DEFAULT_MATCH_TOLERANCES, flagGrnWithoutPo: false })
    expect(noPo.map((r) => [r.exception, r.diffPaise, r.diffBp])).toEqual([['rate_variance', 1000, 100]])
  })

  it('reference lines raise nothing; unmatched bills only on request', () => {
    const lines = [line({ stage: 'grn', lineUid: 'g', anchor: false }), line({ stage: 'bill', lineUid: 'b' })]
    expect(threeWayMatch(lines)).toEqual([])
    expect(threeWayMatch(lines, { ...DEFAULT_MATCH_TOLERANCES, flagUnmatchedBills: true }).map((r) => r.exception)).toEqual(['unmatched_bill_line'])
  })

  it('tolerance needs both the share and the flat amount exceeded', () => {
    expect(beyondTolerance(0, 100, { rateTolBp: 0, amountTolPaise: 0 })).toBe(false)
    expect(beyondTolerance(1, 100, { rateTolBp: 0, amountTolPaise: 0 })).toBe(true)
    expect(beyondTolerance(-500, 10_000, { rateTolBp: 500, amountTolPaise: 0 })).toBe(false)
    expect(beyondTolerance(-501, 10_000, { rateTolBp: 500, amountTolPaise: 0 })).toBe(true)
    expect(beyondTolerance(-501, 10_000, { rateTolBp: 500, amountTolPaise: 600 })).toBe(false)
    expect(expectedAmount({ qtyMilli: 3000, amount: 1000 }, 1000)).toBe(333)
  })
})

describe('analysis helpers', () => {
  it('chain levels: longest path, compacted', () => {
    const lv = chainLevels(['q', 's', 'd', 'i', 'c', 'x'], [
      { from: 'q', to: 's' }, { from: 's', to: 'd' }, { from: 'd', to: 'i' }, { from: 's', to: 'i' }, { from: 'i', to: 'c' }
    ])
    expect(Object.fromEntries(lv)).toEqual({ q: 0, s: 1, d: 2, i: 3, c: 4, x: 0 })
    // A pathological cycle terminates.
    expect(chainLevels(['a', 'b'], [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }]).size).toBe(2)
  })

  it('full delivery date per line, latest line wins; null while short', () => {
    const lines = [{ lineUid: 'a', qtyMilli: 10 }, { lineUid: 'b', qtyMilli: 2 }]
    expect(fullDeliveryDate(lines, [{ lineUid: 'a', date: '2025-05-09', qtyMilli: 4 }, { lineUid: 'a', date: '2025-05-04', qtyMilli: 6 }])).toBeNull()
    expect(fullDeliveryDate(lines, [
      { lineUid: 'a', date: '2025-05-09', qtyMilli: 4 }, { lineUid: 'a', date: '2025-05-04', qtyMilli: 6 }, { lineUid: 'b', date: '2025-05-06', qtyMilli: 2 }
    ])).toBe('2025-05-09')
  })

  it('order book summary by party and month; pct', () => {
    const r = (p: Partial<OrderBookRow>): OrderBookRow => ({
      docId: 1, kind: 'sales_order', number: '1', date: '2025-05-01', month: '2025-05', partyLedgerId: 1, partyName: 'A', status: 'open',
      lineCount: 1, orderedValue: 100, fulfilledValue: 40, pendingValue: 60, shortClosedValue: 0, ...p
    })
    const rows = [r({}), r({ docId: 2, month: '2025-06', partyLedgerId: 2, partyName: 'B', orderedValue: 300, fulfilledValue: 300, pendingValue: 0 })]
    expect(summariseOrderBook(rows, 'party').map((g) => [g.label, g.orders, g.fulfilledPct])).toEqual([['B', 1, 100], ['A', 1, 40]])
    expect(summariseOrderBook(rows, 'month').map((g) => [g.label, g.orderedValue])).toEqual([['May 2025', 100], ['Jun 2025', 300]])
    expect(pct(1, 3)).toBe(33.3)
    expect(pct(1, 0)).toBeNull()
    expect(monthLabel('2026-03')).toBe('Mar 2026')
  })
})
