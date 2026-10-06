// lib/table — column width model, header bands, grouped/plain export labels, per-row quantity
// formatting (WP 1.6b).
import { describe, expect, it } from 'vitest'
import {
  aggregateText,
  buildTableExport,
  buildTableModel,
  cellText,
  columnLabel,
  columnWidthSpecs,
  defaultView,
  describeFilter,
  estimateLabelWidth,
  FLEX_MIN_WIDTH,
  headerBands,
  headerMinWidth,
  KIND_DEFAULT_WIDTH,
  layoutColumnWidths,
  type ColumnDef,
  type ViewState
} from '../../lib/table'

describe('column width model', () => {
  interface R {
    a: string
  }
  const col = (c: Partial<ColumnDef<R>> & Pick<ColumnDef<R>, 'id' | 'kind'>): ColumnDef<R> => ({ header: c.id, value: () => '', ...c })

  it('kind defaults widen to fit the header label; text columns are flexible at max(minWidth ?? 120, label)', () => {
    const specs = columnWidthSpecs([
      col({ id: 'amt', kind: 'money', header: 'Amount' }),
      col({ id: 'vt', kind: 'enum', header: 'Voucher type of the entry' }),
      col({ id: 'name', kind: 'text', header: 'Name' }),
      col({ id: 'party', kind: 'text', header: 'Party', minWidth: 180 }),
      col({ id: 'fixed', kind: 'text', header: 'Ref', width: 90 })
    ])
    expect(specs.map((s) => s.base)).toEqual([
      KIND_DEFAULT_WIDTH.money,
      headerMinWidth('Voucher type of the entry'),
      FLEX_MIN_WIDTH,
      180,
      90
    ])
    expect(headerMinWidth('Voucher type of the entry')).toBeGreaterThan(KIND_DEFAULT_WIDTH.enum!)
    expect(specs.map((s) => s.flex)).toEqual([false, false, true, true, false])
  })

  it('every width respects minWidth — explicit, user-resized and default alike', () => {
    const specs = columnWidthSpecs(
      [
        col({ id: 'a', kind: 'text', width: 60, minWidth: 100 }),
        col({ id: 'b', kind: 'money', minWidth: 200 }),
        col({ id: 'c', kind: 'text', minWidth: 90 })
      ],
      { c: 40 }
    )
    expect(specs.map((s) => s.base)).toEqual([100, 200, 90])
    expect(specs[2]).toMatchObject({ resized: true, flex: false })
  })

  it('label estimates grow with the text and never undershoot a plain upper-case label', () => {
    expect(estimateLabelWidth('No.')).toBeLessThan(estimateLabelWidth('Voucher'))
    // ~7.9px per capital at 10.5px semibold + 0.08em tracking
    expect(estimateLabelWidth('MARGIN')).toBeGreaterThanOrEqual(6 * 7.5)
    expect(headerMinWidth('Deleted', false)).toBe(estimateLabelWidth('Deleted') + 24)
    expect(headerMinWidth('Deleted')).toBeGreaterThan(headerMinWidth('Deleted', false))
  })

  it('shares spare space in whole pixels among flexible columns, remainder from the left; total is exact', () => {
    const specs = [
      { id: 'a', base: 100, flex: true, text: true, resized: false },
      { id: 'b', base: 150, flex: false, text: false, resized: false },
      { id: 'c', base: 120, flex: true, text: true, resized: false },
      { id: 'd', base: 120, flex: true, text: true, resized: false }
    ]
    const { widths, total } = layoutColumnWidths(specs, 1000, 40)
    // spare = 1000 - (490 + 40) = 470 → 156 each + 2 remainder px to the first two flex columns
    expect(widths).toEqual([257, 150, 277, 276])
    expect(widths.every(Number.isInteger)).toBe(true)
    expect(total).toBe(1000)
  })

  it('with no flexible column the spare goes to the last text column the user has not resized', () => {
    const base = [
      { id: 'date', base: 104, flex: false, text: false, resized: false },
      { id: 'acct', base: 200, flex: false, text: true, resized: false },
      { id: 'ref', base: 90, flex: false, text: true, resized: true },
      { id: 'amt', base: 150, flex: false, text: false, resized: false }
    ]
    expect(layoutColumnWidths(base, 800).widths).toEqual([104, 456, 90, 150])
    // no text column at all → the last column the user hasn't resized
    const numeric = base.map((s) => ({ ...s, text: false }))
    expect(layoutColumnWidths(numeric, 800).widths).toEqual([104, 200, 90, 406])
    expect(layoutColumnWidths(numeric, 800).total).toBe(800)
  })

  it('does not shrink below the base widths: an over-wide table keeps them and scrolls (also when unmeasured)', () => {
    const specs = [
      { id: 'a', base: 300, flex: true, text: true, resized: false },
      { id: 'b', base: 300, flex: false, text: false, resized: false }
    ]
    expect(layoutColumnWidths(specs, 500).widths).toEqual([300, 300])
    expect(layoutColumnWidths(specs, 500).total).toBe(600)
    expect(layoutColumnWidths(specs, 0).widths).toEqual([300, 300])
    // fractional container widths are floored so the sum never exceeds the space
    expect(layoutColumnWidths(specs, 700.6).total).toBe(700)
  })
})

describe('header bands', () => {
  const cols = [
    { id: 'pNo', group: 'Portal' },
    { id: 'pDate', group: 'Portal' },
    { id: 'bNo', group: 'Books' },
    { id: 'bDate', group: 'Books' },
    { id: 'diff' }
  ]
  it('groups adjacent columns with the same group; ungrouped columns get an empty run', () => {
    expect(headerBands(cols).map((b) => [b.group, b.start, b.span])).toEqual([
      ['Portal', 0, 2],
      ['Books', 2, 2],
      [null, 4, 1]
    ])
  })
  it('follows reorder (a split group shows one band per contiguous stretch) and hiding', () => {
    const reordered = [cols[0]!, cols[2]!, cols[1]!, cols[3]!]
    expect(headerBands(reordered).map((b) => [b.group, b.span])).toEqual([
      ['Portal', 1],
      ['Books', 1],
      ['Portal', 1],
      ['Books', 1]
    ])
    expect(headerBands([cols[4]!])).toEqual([]) // no visible grouped column → no band row
  })
})

interface Q {
  id: number
  qty: number
  dec: number
  unit: string
  amt: number | null
  ref: string
}
const QROWS: Q[] = [
  { id: 1, qty: 12500, dec: 3, unit: 'kg', amt: 123456, ref: 'A' },
  { id: 2, qty: 4000, dec: 0, unit: 'pcs', amt: -5000, ref: 'B' },
  { id: 3, qty: 0, dec: 2, unit: 'm', amt: null, ref: 'C' }
]
const QCOLS: ColumnDef<Q>[] = [
  { id: 'ref', header: 'Invoice no.', group: 'Portal', kind: 'text', value: (r) => r.ref },
  { id: 'qty', header: 'Qty', kind: 'quantity', value: (r) => r.qty, decimals: (r) => r.dec, unit: (r) => r.unit, aggregate: 'sum' },
  { id: 'amt', header: 'Value', group: 'Books', kind: 'money', signed: true, value: (r) => r.amt, aggregate: 'sum' }
]

describe('per-row quantity formatting', () => {
  it('uses per-row decimals and unit for cells; aggregates fall back to aggregateDecimals (default 3) without a per-row unit', () => {
    expect(QROWS.map((r) => cellText(QCOLS[1]!, r))).toEqual(['12.500 kg', '4 pcs', '0.00 m'])
    expect(aggregateText(QCOLS[1]!, 16500)).toBe('16.500')
    expect(aggregateText({ ...QCOLS[1]!, aggregateDecimals: 1 }, 16500)).toBe('16.5')
    // a fixed unit does carry to the aggregate
    expect(aggregateText({ ...QCOLS[1]!, decimals: 2, unit: 'kg' }, 16500)).toBe('16.50 kg')
    expect(describeFilter(QCOLS[1]!, { type: 'range', op: 'gte', a: 1500 })).toBe('Qty ≥ 1.500')
  })
})

describe('export labels and money format', () => {
  const view: ViewState = defaultView(QCOLS)
  it('prefixes grouped column labels in CSV and PDF headers (and filter chips)', () => {
    const ex = buildTableExport(buildTableModel(QROWS, QCOLS, view))
    expect(ex.header).toEqual(['Portal · Invoice no.', 'Qty', 'Books · Value'])
    expect(ex.columns.map((c) => c.label)).toEqual(ex.header)
    expect(columnLabel(QCOLS[0]!)).toBe('Portal · Invoice no.')
    expect(describeFilter(QCOLS[0]!, { type: 'text', op: 'contains', value: 'x' })).toBe('Portal · Invoice no. contains “x”')
  })
  it("default ('display') is unchanged: Dr/Cr text, dash for none", () => {
    const ex = buildTableExport(buildTableModel(QROWS, QCOLS, view))
    expect(ex.csvRows.map((r) => r[2])).toEqual(['1,234.56 Dr', '50.00 Cr', '', '1,184.56 Dr'])
  })
  it("'plain' writes signed decimals (dr-positive) a spreadsheet reads as numbers, including group rows and totals", () => {
    const ex = buildTableExport(buildTableModel(QROWS, QCOLS, view), { moneyFormat: 'plain' })
    expect(ex.csvRows.map((r) => r[2])).toEqual(['1234.56', '-50.00', '', '1184.56'])
    expect(ex.csvRows.map((r) => r[1])).toEqual(['12.500 kg', '4 pcs', '0.00 m', '16.500']) // non-money untouched
    const grouped = buildTableExport(buildTableModel(QROWS, QCOLS, { ...view, groupBy: 'ref' }), { moneyFormat: 'plain' })
    expect(grouped.csvRows[0]).toEqual(['A (1)', '12.500', '1234.56'])
  })
})
