// lib/table — pure sort / filter / group / view-state / export logic.
import { describe, expect, it } from 'vitest'
import {
  aggregate,
  applyLegacyReportConfig,
  buildRowLayout,
  capExportForPdf,
  columnDropTarget,
  itemAt,
  scrollTopFor,
  visibleRange,
  buildTableExport,
  buildTableModel,
  defaultView,
  describeFilter,
  filterRows,
  formatMilli,
  groupRows,
  moveColumn,
  moveColumnTo,
  parseFilterValue,
  parseMilli,
  parseViewState,
  reconcileView,
  sortRows,
  toggleSort,
  visibleColumns,
  type ColumnDef,
  type ViewState
} from '../../lib/table'

interface R {
  id: number
  name: string
  date: string
  amount: number
  qty: number
  status: 'open' | 'paid' | null
  note?: string | null
}

const COLS: ColumnDef<R>[] = [
  { id: 'name', header: 'Name', kind: 'text', value: (r) => r.name },
  { id: 'date', header: 'Date', kind: 'date', value: (r) => r.date },
  { id: 'amount', header: 'Amount', kind: 'money', value: (r) => r.amount, aggregate: 'sum' },
  { id: 'qty', header: 'Qty', kind: 'quantity', value: (r) => r.qty, aggregate: 'sum', decimals: 2 },
  {
    id: 'status',
    header: 'Status',
    kind: 'enum',
    value: (r) => r.status,
    options: [
      { value: 'open', label: 'Open' },
      { value: 'paid', label: 'Paid' }
    ]
  },
  { id: 'note', header: 'Note', kind: 'text', value: (r) => r.note, defaultHidden: true }
]

const ROWS: R[] = [
  { id: 1, name: 'Inv 10', date: '2026-04-03', amount: 150000, qty: 1500, status: 'open', note: 'urgent' },
  { id: 2, name: 'inv 9', date: '2026-04-01', amount: 99, qty: 250, status: 'paid' },
  { id: 3, name: 'Credit note', date: '2026-05-10', amount: -5000, qty: 0, status: null, note: '' },
  { id: 4, name: 'Inv 2', date: '2026-04-01', amount: 150000, qty: 1000, status: 'open', note: null }
]

const ids = (rows: R[]): number[] => rows.map((r) => r.id)

describe('sortRows', () => {
  it('text sorts case-insensitively with numeric-aware collation', () => {
    expect(ids(sortRows(ROWS, COLS, [{ id: 'name', dir: 'asc' }]))).toEqual([3, 4, 2, 1])
  })
  it('money sorts by paise, desc reverses', () => {
    expect(ids(sortRows(ROWS, COLS, [{ id: 'amount', dir: 'asc' }]))).toEqual([3, 2, 1, 4])
    expect(ids(sortRows(ROWS, COLS, [{ id: 'amount', dir: 'desc' }]))).toEqual([1, 4, 2, 3])
  })
  it('is stable and supports a secondary key', () => {
    expect(ids(sortRows(ROWS, COLS, [{ id: 'date', dir: 'asc' }]))).toEqual([2, 4, 1, 3])
    expect(
      ids(
        sortRows(ROWS, COLS, [
          { id: 'date', dir: 'asc' },
          { id: 'name', dir: 'asc' }
        ])
      )
    ).toEqual([4, 2, 1, 3])
    expect(
      ids(
        sortRows(ROWS, COLS, [
          { id: 'amount', dir: 'desc' },
          { id: 'date', dir: 'asc' }
        ])
      )
    ).toEqual([4, 1, 2, 3])
  })
  it('dates sort chronologically', () => {
    const rows = [{ ...ROWS[0]!, id: 1, date: '2025-12-31' }, { ...ROWS[0]!, id: 2, date: '2026-01-01' }, { ...ROWS[0]!, id: 3, date: '2025-04-01' }]
    expect(ids(sortRows(rows, COLS, [{ id: 'date', dir: 'asc' }]))).toEqual([3, 1, 2])
  })
  it('nulls and empties sort last in both directions', () => {
    expect(ids(sortRows(ROWS, COLS, [{ id: 'status', dir: 'asc' }])).at(-1)).toBe(3)
    expect(ids(sortRows(ROWS, COLS, [{ id: 'status', dir: 'desc' }])).at(-1)).toBe(3)
    const byNote = ids(sortRows(ROWS, COLS, [{ id: 'note', dir: 'desc' }]))
    expect(byNote[0]).toBe(1)
    expect(byNote.slice(1).sort()).toEqual([2, 3, 4])
  })
  it('ignores unknown and unsortable columns, never mutates input', () => {
    const cols = COLS.map((c) => (c.id === 'name' ? { ...c, sortable: false } : c))
    const input = ROWS.slice()
    expect(ids(sortRows(input, cols, [{ id: 'name', dir: 'asc' }, { id: 'nope', dir: 'asc' }]))).toEqual([1, 2, 3, 4])
    expect(input).toEqual(ROWS)
  })
})

describe('toggleSort', () => {
  it('plain click cycles asc → desc → none', () => {
    let k = toggleSort([], 'a', false)
    expect(k).toEqual([{ id: 'a', dir: 'asc' }])
    k = toggleSort(k, 'a', false)
    expect(k).toEqual([{ id: 'a', dir: 'desc' }])
    expect(toggleSort(k, 'a', false)).toEqual([])
  })
  it('plain click on another column replaces the sort', () => {
    expect(toggleSort([{ id: 'a', dir: 'desc' }], 'b', false)).toEqual([{ id: 'b', dir: 'asc' }])
  })
  it('shift-click adds, cycles and removes secondary keys', () => {
    let k = toggleSort([{ id: 'a', dir: 'asc' }], 'b', true)
    expect(k).toEqual([{ id: 'a', dir: 'asc' }, { id: 'b', dir: 'asc' }])
    k = toggleSort(k, 'b', true)
    expect(k).toEqual([{ id: 'a', dir: 'asc' }, { id: 'b', dir: 'desc' }])
    k = toggleSort(k, 'b', true)
    expect(k).toEqual([{ id: 'a', dir: 'asc' }])
  })
  it('plain click on a multi-sort collapses to that column', () => {
    expect(toggleSort([{ id: 'a', dir: 'asc' }, { id: 'b', dir: 'desc' }], 'b', false)).toEqual([{ id: 'b', dir: 'asc' }])
  })
})

describe('filterRows', () => {
  const f = (filters: Parameters<typeof filterRows<R>>[2], quick = ''): number[] => ids(filterRows(ROWS, COLS, filters, quick))
  it('text: contains / startsWith / equals / empty', () => {
    expect(f({ name: { type: 'text', op: 'contains', value: 'INV' } })).toEqual([1, 2, 4])
    expect(f({ name: { type: 'text', op: 'startsWith', value: 'cre' } })).toEqual([3])
    expect(f({ name: { type: 'text', op: 'equals', value: 'inv 2' } })).toEqual([4])
    expect(f({ note: { type: 'text', op: 'empty', value: '' } })).toEqual([2, 3, 4])
  })
  it('money ranges compare paise', () => {
    expect(f({ amount: { type: 'range', op: 'eq', a: 150000 } })).toEqual([1, 4])
    expect(f({ amount: { type: 'range', op: 'gte', a: 99 } })).toEqual([1, 2, 4])
    expect(f({ amount: { type: 'range', op: 'lte', a: 99 } })).toEqual([2, 3])
    expect(f({ amount: { type: 'range', op: 'between', a: 100, b: -10000 } })).toEqual([2, 3]) // reversed bounds
  })
  it('money operand parses with the shared money parser', () => {
    expect(parseFilterValue('money', '1,500.00', '2026-04-01')).toBe(150000)
    expect(parseFilterValue('money', '0.99', '2026-04-01')).toBe(99)
    expect(parseFilterValue('money', 'abc', '2026-04-01')).toBeNull()
  })
  it('quantity ranges compare milli', () => {
    expect(f({ qty: { type: 'range', op: 'gte', a: parseMilli('1')! } })).toEqual([1, 4])
  })
  it('date: on / before / after / between', () => {
    expect(f({ date: { type: 'date', op: 'on', a: '2026-04-01' } })).toEqual([2, 4])
    expect(f({ date: { type: 'date', op: 'before', a: '2026-04-03' } })).toEqual([2, 4])
    expect(f({ date: { type: 'date', op: 'after', a: '2026-04-03' } })).toEqual([3])
    expect(f({ date: { type: 'date', op: 'between', a: '2026-04-02', b: '2026-05-10' } })).toEqual([1, 3])
  })
  it('date operand accepts ISO and Tally smart dates', () => {
    expect(parseFilterValue('date', '2026-04-07', '2026-04-15')).toBe('2026-04-07')
    expect(parseFilterValue('date', '7/4', '2026-06-15')).toBe('2026-04-07')
    expect(parseFilterValue('date', 'nonsense', '2026-06-15')).toBeNull()
  })
  it('enum: one-of; none ticked = no constraint', () => {
    expect(f({ status: { type: 'enum', values: ['paid'] } })).toEqual([2])
    expect(f({ status: { type: 'enum', values: ['open', 'paid'] } })).toEqual([1, 2, 4])
    expect(f({ status: { type: 'enum', values: [] } })).toEqual([1, 2, 3, 4])
  })
  it('combines filters with AND', () => {
    expect(f({ status: { type: 'enum', values: ['open'] }, date: { type: 'date', op: 'on', a: '2026-04-01' } })).toEqual([4])
  })
  it('quick filter matches any text/enum column, every term must match', () => {
    expect(f({}, 'inv')).toEqual([1, 2, 4])
    expect(f({}, 'paid')).toEqual([2]) // enum label
    expect(f({}, 'inv open')).toEqual([1, 4])
    expect(f({}, '1,500')).toEqual([]) // money is not a quick-filter column
  })
  it('quick filter only searches the columns it is given (visible ones)', () => {
    const visible = COLS.filter((c) => c.id !== 'note')
    expect(ids(filterRows(ROWS, COLS, {}, 'urgent', visible))).toEqual([])
    expect(ids(filterRows(ROWS, COLS, {}, 'urgent', COLS))).toEqual([1])
  })
  it('describes filters for chips', () => {
    const amount = COLS[2]!
    expect(describeFilter(amount, { type: 'range', op: 'gte', a: 100000 })).toBe('Amount ≥ 1,000.00')
    expect(describeFilter(COLS[1]!, { type: 'date', op: 'between', a: '2026-04-01', b: '2026-04-30' })).toBe('Date 01-Apr-26 – 30-Apr-26')
    expect(describeFilter(COLS[4]!, { type: 'enum', values: ['open', 'paid'] })).toBe('Status: Open, Paid')
  })
})

describe('quantity formatting (integer math)', () => {
  it('formats and rounds half away from zero', () => {
    expect(formatMilli(1500)).toBe('1.500')
    expect(formatMilli(1505, 2)).toBe('1.51')
    expect(formatMilli(-1505, 2)).toBe('-1.51')
    expect(formatMilli(2499, 0)).toBe('2')
    expect(formatMilli(-4, 2)).toBe('0.00')
  })
  it('parses up to three decimals', () => {
    expect(parseMilli('12.5')).toBe(12500)
    expect(parseMilli('-0.001')).toBe(-1)
    expect(parseMilli('1.2345')).toBeNull()
    expect(parseMilli('')).toBeNull()
  })
})

describe('grouping', () => {
  it('groups by a column with subtotals; blanks last', () => {
    const groups = groupRows(ROWS, COLS[4]!, [COLS[2]!, COLS[3]!])
    expect(groups.map((g) => g.label)).toEqual(['Open', 'Paid', '(blank)'])
    expect(groups[0]!.totals).toEqual({ amount: 300000, qty: 2500 })
    expect(groups[2]!.rows.map((r) => r.id)).toEqual([3])
  })
  it('group direction follows the sort on the group column', () => {
    const model = buildTableModel(ROWS, COLS, { ...defaultView(COLS), groupBy: 'status', sort: [{ id: 'status', dir: 'desc' }] })
    expect(model.items.filter((i) => i.type === 'group').map((i) => (i.type === 'group' ? i.label : ''))).toEqual(['Paid', 'Open', '(blank)'])
  })
  it('custom groupKey (date by month)', () => {
    const cols = COLS.map((c) => (c.id === 'date' ? { ...c, groupKey: (r: R) => r.date.slice(0, 7) } : c))
    const groups = groupRows(ROWS, cols[1]!, [cols[2]!])
    expect(groups.map((g) => [g.label, g.rows.length, g.totals.amount])).toEqual([
      ['2026-04', 3, 300099],
      ['2026-05', 1, -5000]
    ])
  })
  it('collapsed groups hide their rows but keep header + subtotal', () => {
    const view = { ...defaultView(COLS), groupBy: 'status' }
    const model = buildTableModel(ROWS, COLS, view, { collapsed: new Set(['Open']) })
    expect(model.items.map((i) => (i.type === 'group' ? `g:${i.label}` : i.row.id))).toEqual(['g:Open', 'g:Paid', 2, 'g:(blank)', 3])
    expect(model.rows).toHaveLength(4)
    expect(model.totals.amount).toBe(295099)
  })
  it('aggregate supports custom functions', () => {
    const col: ColumnDef<R> = { ...COLS[2]!, aggregate: (rows) => rows.filter((r) => r.status === 'open').reduce((s, r) => s + r.amount, 0) }
    expect(aggregate(col, ROWS)).toBe(300000)
  })
})

describe('view state', () => {
  const def = defaultView(COLS)
  it('default view follows declared order and defaultHidden', () => {
    expect(def.order).toEqual(['name', 'date', 'amount', 'qty', 'status', 'note'])
    expect(def.hidden).toEqual(['note'])
    expect(visibleColumns(COLS, def).map((c) => c.id)).toEqual(['name', 'date', 'amount', 'qty', 'status'])
  })
  it('round-trips through JSON', () => {
    const v: ViewState = {
      ...def,
      order: ['amount', 'name', 'date', 'qty', 'status', 'note'],
      hidden: ['qty'],
      widths: { name: 240 },
      sort: [{ id: 'amount', dir: 'desc' }],
      filters: { amount: { type: 'range', op: 'gte', a: 100 } },
      groupBy: 'status',
      density: 'compact'
    }
    expect(parseViewState(JSON.stringify(v), COLS, def)).toEqual(v)
  })
  it('corrupt JSON, wrong shapes and other versions fall back to defaults', () => {
    expect(parseViewState('{not json', COLS, def)).toEqual(def)
    expect(parseViewState('[1,2]', COLS, def)).toEqual(def)
    expect(parseViewState(null, COLS, def)).toEqual(def)
    expect(parseViewState(JSON.stringify({ ...def, v: 0, density: 'compact' }), COLS, def)).toEqual(def)
    expect(parseViewState(JSON.stringify({ ...def, v: 2, density: 'compact' }), COLS, def)).toEqual(def)
  })
  it('bad individual fields fall back field-by-field', () => {
    const v = parseViewState(
      JSON.stringify({ v: 1, order: 'x', hidden: [1, 2], widths: { name: 'wide', date: -5, amount: 180 }, sort: [{ id: 'name', dir: 'sideways' }], density: 'huge' }),
      COLS,
      def
    )
    expect(v.order).toEqual(def.order)
    expect(v.hidden).toEqual(def.hidden)
    expect(v.widths).toEqual({ amount: 180 })
    expect(v.sort).toEqual([])
    expect(v.density).toBeNull() // fallback: follow the app density
  })
  it('drops unknown column ids everywhere and adds new columns at their declared spot', () => {
    const stored = {
      v: 1,
      order: ['gone', 'amount', 'name', 'status'],
      hidden: ['gone', 'status'],
      widths: { gone: 100 },
      sort: [{ id: 'gone', dir: 'asc' }, { id: 'name', dir: 'asc' }],
      filters: { gone: { type: 'text', op: 'contains', value: 'x' } },
      groupBy: 'gone',
      density: 'compact'
    }
    const v = parseViewState(stored, COLS, def)
    // date follows name (its declared predecessor); qty follows amount; note follows status.
    expect(v.order).toEqual(['amount', 'qty', 'name', 'date', 'status', 'note'])
    expect(v.hidden).toEqual(['status', 'note']) // note is new to this view → its default (hidden)
    expect(v.widths).toEqual({})
    expect(v.sort).toEqual([{ id: 'name', dir: 'asc' }])
    expect(v.filters).toEqual({})
    expect(v.groupBy).toBeNull()
  })
  it('rejects filters that do not fit the column kind or are not integral for money', () => {
    const v = reconcileView(
      {
        ...def,
        filters: {
          name: { type: 'range', op: 'eq', a: 1 },
          amount: { type: 'range', op: 'eq', a: 1.5 },
          qty: { type: 'range', op: 'between', a: 1 } as never,
          date: { type: 'date', op: 'on', a: '2026-04-01' }
        }
      },
      COLS
    )
    expect(Object.keys(v.filters)).toEqual(['date'])
  })
  it('unhideable columns are forced visible; non-groupable groupBy is dropped', () => {
    const cols = COLS.map((c) => (c.id === 'name' ? { ...c, hideable: false } : c))
    const v = reconcileView({ ...def, hidden: ['name', 'date'], groupBy: 'amount' }, cols)
    expect(v.hidden).toEqual(['date'])
    expect(v.groupBy).toBeNull()
  })
  it('moves columns', () => {
    expect(moveColumn(def, 'note', 0).order[0]).toBe('note')
    expect(moveColumnTo(def, 'name', 'amount', true).order).toEqual(['date', 'amount', 'name', 'qty', 'status', 'note'])
    expect(moveColumnTo(def, 'amount', 'name').order).toEqual(['amount', 'name', 'date', 'qty', 'status', 'note'])
  })
  it('screen defaults are reconciled too', () => {
    const v = defaultView(COLS, { sort: [{ id: 'date', dir: 'desc' }, { id: 'bogus', dir: 'asc' }], hidden: ['qty', 'bogus'] })
    expect(v.sort).toEqual([{ id: 'date', dir: 'desc' }])
    expect(v.hidden).toEqual(['qty'])
  })
})

describe('legacy useReportConfig migration', () => {
  const def = defaultView(COLS)
  it('maps legacy booleans onto hidden columns, including defaultHidden ones', () => {
    const v = applyLegacyReportConfig(JSON.stringify({ amount: false, note: true, bogus: false }), COLS, def)
    expect(v.hidden).toEqual(['amount'])
  })
  it('supports one legacy key driving several columns', () => {
    const v = applyLegacyReportConfig(JSON.stringify({ movement: false }), COLS, def, { movement: ['amount', 'qty'] })
    expect(v.hidden).toEqual(['amount', 'qty', 'note'])
  })
  it('ignores corrupt input', () => {
    expect(applyLegacyReportConfig('{oops', COLS, def)).toBe(def)
    expect(applyLegacyReportConfig(null, COLS, def)).toBe(def)
    expect(applyLegacyReportConfig('"str"', COLS, def)).toBe(def)
  })
})

describe('export of the current view', () => {
  it('uses visible columns in order, current sort/filter, formatted cells and a totals row', () => {
    const view: ViewState = {
      ...defaultView(COLS),
      order: ['amount', 'name', 'date', 'qty', 'status', 'note'],
      hidden: ['qty', 'note'],
      sort: [{ id: 'amount', dir: 'desc' }, { id: 'name', dir: 'asc' }],
      filters: { amount: { type: 'range', op: 'gte', a: 0 } }
    }
    const ex = buildTableExport(buildTableModel(ROWS, COLS, view))
    expect(ex.header).toEqual(['Amount', 'Name', 'Date', 'Status'])
    expect(ex.columns.map((c) => c.align)).toEqual(['r', 'l', 'l', 'l'])
    expect(ex.csvRows).toEqual([
      ['1,500.00', 'Inv 2', '01-Apr-26', 'Open'],
      ['1,500.00', 'Inv 10', '03-Apr-26', 'Open'],
      ['0.99', 'inv 9', '01-Apr-26', 'Paid'],
      ['3,000.99', 'Total', '', '']
    ])
    expect(ex.rows.at(-1)).toMatchObject({ bold: true, rule: true })
  })
  it('includes group header rows with subtotals', () => {
    const view: ViewState = { ...defaultView(COLS), hidden: ['date', 'qty', 'note'], groupBy: 'status' }
    const ex = buildTableExport(buildTableModel(ROWS, COLS, view))
    expect(ex.csvRows[0]).toEqual(['Open (2)', '3,000.00', ''])
    expect(ex.rows[0]!.bold).toBe(true)
    expect(ex.csvRows.at(-1)).toEqual(['Total', '2,950.99', ''])
  })
})

describe('variable-height row layout (virtualisation offset index)', () => {
  // 10 rows of 30px; rows 2 and 5 have detail rows of 100 and 40px.
  const extra = (i: number): number => (i === 2 ? 100 : i === 5 ? 40 : 0)
  const L = buildRowLayout(10, 30, extra)
  it('prefix sums include detail heights', () => {
    expect(Array.from(L.offsets)).toEqual([0, 30, 60, 190, 220, 250, 320, 350, 380, 410, 440])
    expect(L.total).toBe(440)
    expect(Array.from(L.rowIndex)).toEqual([0, 1, 2, 4, 5, 6, 8, 9, 10, 11, 12])
  })
  it('itemAt finds the item whose block contains y (detail area belongs to its row)', () => {
    expect(itemAt(L, 0)).toBe(0)
    expect(itemAt(L, 59)).toBe(1)
    expect(itemAt(L, 60)).toBe(2)
    expect(itemAt(L, 189)).toBe(2) // inside row 2's detail
    expect(itemAt(L, 190)).toBe(3)
    expect(itemAt(L, 10_000)).toBe(9)
    expect(itemAt(L, -5)).toBe(0)
  })
  it('visibleRange covers the viewport plus overscan', () => {
    expect(visibleRange(L, 100, 100, 0)).toEqual([2, 4]) // y 100..199 → row 2 (+detail) and row 3
    expect(visibleRange(L, 100, 100, 1)).toEqual([1, 5])
    expect(visibleRange(L, 0, 10_000, 2)).toEqual([0, 10])
    expect(visibleRange(buildRowLayout(0, 30), 0, 100, 2)).toEqual([0, 0])
  })
  it('scrollTopFor brings a row fully into view under a sticky header', () => {
    // viewport 120 incl. a 20px header; row 3's body offset is 190 → content y 210..240
    expect(scrollTopFor(L, 3, 30, 0, 120, 20)).toBe(120)
    expect(scrollTopFor(L, 0, 30, 120, 120, 20)).toBe(0)
    expect(scrollTopFor(L, 3, 30, 120, 120, 20)).toBe(120) // already visible
  })
  it('handles 50,000 rows with hundreds expanded quickly', () => {
    const t0 = performance.now()
    const big = buildRowLayout(50_000, 33, (i) => (i % 160 === 0 ? 50 + (i % 7) * 10 : 0))
    expect(performance.now() - t0).toBeLessThan(50)
    expect(big.rowIndex[50_000]).toBe(50_000 + 313)
    expect(itemAt(big, big.offsets[31_337]! + 5)).toBe(31_337)
  })
})

describe('columnDropTarget (drag-to-reorder hit testing)', () => {
  const rects = [
    { id: 'a', left: 0, right: 100 },
    { id: 'b', left: 100, right: 200 },
    { id: 'c', left: 200, right: 300 }
  ]
  it('drops before/after the column under the pointer', () => {
    expect(columnDropTarget(rects, 'a', 260)).toEqual({ id: 'c', after: true })
    expect(columnDropTarget(rects, 'c', 20)).toEqual({ id: 'a', after: false })
    expect(columnDropTarget(rects, 'a', 230)).toEqual({ id: 'c', after: false })
  })
  it('no-ops on itself and on the adjacent near edge; clamps past the ends', () => {
    expect(columnDropTarget(rects, 'b', 150)).toBeNull()
    expect(columnDropTarget(rects, 'a', 120)).toBeNull() // before b = where a already is
    expect(columnDropTarget(rects, 'c', 180)).toBeNull() // after b = where c already is
    expect(columnDropTarget(rects, 'a', 900)).toEqual({ id: 'c', after: true })
    expect(columnDropTarget([], 'a', 0)).toBeNull()
  })
  it('feeds moveColumnTo', () => {
    const t = columnDropTarget(
      [
        { id: 'name', left: 0, right: 100 },
        { id: 'date', left: 100, right: 200 },
        { id: 'amount', left: 200, right: 300 }
      ],
      'name',
      290
    )!
    expect(moveColumnTo(defaultView(COLS), 'name', t.id, t.after).order.slice(0, 3)).toEqual(['date', 'amount', 'name'])
  })
})

describe('capExportForPdf', () => {
  const big = (n: number): ReturnType<typeof buildTableExport> => {
    const rows: R[] = Array.from({ length: n }, (_, i) => ({ id: i, name: `R${i}`, date: '2026-04-01', amount: 100, qty: 0, status: 'open' }))
    return buildTableExport(buildTableModel(rows, COLS, defaultView(COLS)))
  }
  it('leaves exports under the cap alone', () => {
    const ex = big(10)
    const r = capExportForPdf(ex, 5000)
    expect(r.truncated).toBe(false)
    expect(r.note).toBeNull()
    expect(r.export).toBe(ex)
  })
  it('cuts the body, keeps the all-rows totals row and says so', () => {
    const r = capExportForPdf(big(6000), 5000)
    expect(r.truncated).toBe(true)
    expect(r.export.rows).toHaveLength(5000)
    const last = r.export.rows.at(-1)!
    expect(last.rule).toBe(true)
    expect(last.cells).toContain('6,000.00') // the totals still cover all 6,000 rows
    expect(r.note).toContain('first 4,999 of 6,000 lines')
    expect(r.note).toContain('CSV')
  })
})
