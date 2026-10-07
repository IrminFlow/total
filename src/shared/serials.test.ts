import { describe, expect, it } from 'vitest'
import { lineSerialError, outwardSerialStatus, parseSerialText, voucherSerialErrors, walkSerials, type SerialEvent } from './serials'
import {
  averageMonthlyConsumption, daysInclusive, daysToExpiry, encodableBarcode, expiresWithin, isBelowReorder, labelSheetHtml,
  monthsOfCover, suggestedOrderQty
} from './stockPlanning'

describe('serial line rules', () => {
  it('parses one-per-line / comma lists, trimming and dropping blanks', () => {
    expect(parseSerialText(' SN1\nSN2 , SN3;;\n\n')).toEqual(['SN1', 'SN2', 'SN3'])
  })

  it('a tracked line names exactly one serial per whole unit, both directions', () => {
    expect(lineSerialError({ stockItemId: 1, qtyMilli: 2000, direction: 'out', serials: ['A', 'B'] }, 'Phone')).toBeNull()
    expect(lineSerialError({ stockItemId: 1, qtyMilli: 2000, direction: 'in', serials: ['A', 'B'] }, 'Phone')).toBeNull()
    expect(lineSerialError({ stockItemId: 1, qtyMilli: 2000, direction: 'out', serials: ['A'] }, 'Phone')).toMatch(/2 units need 2 serial numbers \(got 1\)/)
    expect(lineSerialError({ stockItemId: 1, qtyMilli: 1000, direction: 'in', serials: [] }, 'Phone')).toMatch(/1 unit needs 1 serial number/)
    expect(lineSerialError({ stockItemId: 1, qtyMilli: 1500, direction: 'out', serials: ['A'] }, 'Phone')).toMatch(/whole units/)
  })

  it('a physical count names no serials; blanks and over-long serials are refused', () => {
    expect(lineSerialError({ stockItemId: 1, qtyMilli: 5000, direction: 'in', isAbsolute: true }, 'Phone')).toBeNull()
    expect(lineSerialError({ stockItemId: 1, qtyMilli: 5000, direction: 'in', isAbsolute: true, serials: ['A'] }, 'Phone')).toMatch(/physical count/)
    expect(lineSerialError({ stockItemId: 1, qtyMilli: 1000, direction: 'in', serials: [' A'] }, 'Phone')).toMatch(/blank or padded/)
    expect(lineSerialError({ stockItemId: 1, qtyMilli: 1000, direction: 'in', serials: ['x'.repeat(61)] }, 'Phone')).toMatch(/longer than 60/)
  })

  it('voucher-level: duplicates per item+direction; untracked items are ignored', () => {
    const tracked = new Map([[1, 'Phone']])
    expect(
      voucherSerialErrors(
        [
          { stockItemId: 1, qtyMilli: 1000, direction: 'out', serials: ['A'] },
          { stockItemId: 1, qtyMilli: 1000, direction: 'out', serials: ['A'] },
          { stockItemId: 1, qtyMilli: 1000, direction: 'in', serials: ['A'] }, // transfer leg: fine
          { stockItemId: 2, qtyMilli: 500, direction: 'out', serials: ['whatever'] }
        ],
        tracked
      )
    ).toEqual(['Phone: serial A appears twice on this voucher'])
  })

  it('outward status by voucher kind', () => {
    expect(outwardSerialStatus('sales')).toBe('sold')
    expect(outwardSerialStatus('debit_note')).toBe('returned')
    expect(outwardSerialStatus('stock_journal')).toBe('consumed')
    expect(outwardSerialStatus('journal')).toBe('consumed')
  })
})

describe('serial lifecycle walk', () => {
  let line = 0
  const ev = (serial: string, direction: 'in' | 'out', kind: SerialEvent['kind'], voucherId: number, godownId: number | null = null): SerialEvent => ({
    stockItemId: 1, serial, direction, kind, voucherId, lineId: ++line, voucherLabel: `V${voucherId}`, godownId, batchId: null
  })

  it('in → sold → returned by the customer (credit note) → back in stock → sold again', () => {
    const r = walkSerials([ev('A', 'in', 'purchase', 1), ev('A', 'out', 'sales', 2), ev('A', 'in', 'credit_note', 3), ev('A', 'out', 'sales', 4)])
    expect(r.ok && r.records).toEqual([expect.objectContaining({ serial: 'A', status: 'sold', outwardLineId: line })])
  })

  it('a serial can be in stock once', () => {
    const r = walkSerials([ev('A', 'in', 'purchase', 1), ev('A', 'in', 'purchase', 2)], () => 'Phone')
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/Phone: serial A is already in stock \(from V1\) — V2 can't bring it in again/) })
  })

  it('outward needs the serial in stock: never came in / already gone', () => {
    expect(walkSerials([ev('B', 'out', 'sales', 1)])).toEqual({ ok: false, error: expect.stringMatching(/never came in/) })
    expect(walkSerials([ev('B', 'in', 'purchase', 1), ev('B', 'out', 'sales', 2), ev('B', 'out', 'sales', 3)])).toEqual({
      ok: false, error: expect.stringMatching(/already went out on V2/)
    })
  })

  it('a godown transfer (out of A, then into B on the same voucher) keeps it in stock at B', () => {
    const r = walkSerials([ev('C', 'in', 'purchase', 1, 10), ev('C', 'out', 'stock_journal', 2, 10), ev('C', 'in', 'stock_journal', 2, 11)])
    expect(r.ok && r.records[0]).toMatchObject({ status: 'in_stock', godownId: 11, outwardLineId: null })
  })

  it('purchase return → returned (out of stock); consumption → consumed', () => {
    const r = walkSerials([ev('D', 'in', 'purchase', 1), ev('E', 'in', 'purchase', 1), ev('D', 'out', 'debit_note', 2), ev('E', 'out', 'stock_journal', 3)])
    expect(r.ok && r.records.map((x) => [x.serial, x.status])).toEqual([['D', 'returned'], ['E', 'consumed']])
  })
})

describe('reorder planning formulas', () => {
  it('suggested order = max(0, reorder level × 2 − closing)', () => {
    expect(suggestedOrderQty(10_000, 4_000)).toBe(16_000)
    expect(suggestedOrderQty(10_000, 25_000)).toBe(0)
    expect(suggestedOrderQty(10_000, -3_000)).toBe(23_000) // covers the overdraw too
    expect(suggestedOrderQty(0, 0)).toBe(0)
  })

  it('below reorder is strict and needs a positive level', () => {
    expect(isBelowReorder(9_999, 10_000)).toBe(true)
    expect(isBelowReorder(10_000, 10_000)).toBe(false)
    expect(isBelowReorder(-1, 0)).toBe(false)
    expect(isBelowReorder(0, null)).toBe(false)
  })

  it('average monthly consumption = round(outward × 30 / days in window)', () => {
    expect(daysInclusive('2026-04-01', '2027-03-31')).toBe(365)
    expect(averageMonthlyConsumption(365_000, '2026-04-01', '2027-03-31')).toBe(30_000)
    expect(averageMonthlyConsumption(10_000, '2026-04-01', '2026-04-30')).toBe(10_000)
    expect(averageMonthlyConsumption(1_000, '2026-04-01', '2026-04-01')).toBe(30_000)
    expect(monthsOfCover(45_000, 30_000)).toBe(1.5)
    expect(monthsOfCover(45_000, 0)).toBeNull()
  })

  it('expiry windows', () => {
    expect(daysToExpiry('2026-05-01', '2026-04-01')).toBe(30)
    expect(expiresWithin('2026-05-01', '2026-04-01', 30)).toBe(true)
    expect(expiresWithin('2026-05-02', '2026-04-01', 30)).toBe(false)
    expect(expiresWithin('2026-03-01', '2026-04-01', 0)).toBe(true) // already expired
  })
})

describe('label sheet', () => {
  it('repeats each item per copy with an SVG barcode; missing/unencodable barcodes print a note', () => {
    const html = labelSheetHtml(
      [
        { name: 'Widget <A>', barcode: 'ITEM0042', priceText: '₹ 10.00', copies: 2 },
        { name: 'Plain', barcode: null, priceText: null, copies: 1 },
        { name: 'Accented', barcode: 'café', priceText: null, copies: 1 }
      ],
      { caption: 'Demo Traders' }
    )
    expect(html.match(/class="label"/g)).toHaveLength(4)
    expect(html.match(/<svg /g)).toHaveLength(2)
    expect(html).toContain('Widget &lt;A&gt;')
    expect(html.match(/no barcode set/g)).toHaveLength(2)
    expect(encodableBarcode('café')).toBeNull()
  })
})
