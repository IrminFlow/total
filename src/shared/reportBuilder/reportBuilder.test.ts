import { describe, expect, it } from 'vitest'
import { defaultModel, modelJsonEnvelope, parseModelJson, reportModelSchema, type ReportResult, type ResultRow } from './model'
import {
  addMonths, comparativeShiftMonths, fyQuarterOf, fyStartsWithin, periodKey, periodKeysBetween, periodLabel, previousPeriod,
  previousYear, relativePeriod, resolvePeriod, shiftPeriodKey
} from './period'
import { accumulateBalance, chartSeries, flattenResult, mergeComparative, pivotResult, sortRows, totalsOf, variance } from './shape'

const parse = (m: unknown) => reportModelSchema.safeParse(m)
const problems = (m: unknown): string[] => {
  const r = parse(m)
  return r.success ? [] : r.error.issues.map((i) => i.message)
}

describe('report model validation', () => {
  it('fills defaults for a minimal model', () => {
    const m = reportModelSchema.parse({ source: 'accounts', measures: ['net'] })
    expect(m).toMatchObject({
      version: 1, dimensions: [], period: { kind: 'working' }, sort: { by: 'dimension', dir: 'asc' }, topN: null, pivot: null,
      comparative: { kind: 'none', budgetId: null }, chart: 'bar'
    })
    expect(m.filters.ledgerIds).toEqual([])
    expect(defaultModel('inventory').measures).toEqual(['qtyIn', 'qtyOut', 'qtyNet'])
  })

  it('rejects dimensions and measures from the other source', () => {
    expect(problems({ source: 'accounts', dimensions: [{ key: 'item' }], measures: ['qtyIn'] })).toEqual([
      'Stock item is not available for accounts',
      'Qty in is not available for accounts'
    ])
    expect(problems({ source: 'inventory', dimensions: [{ key: 'ledger' }], measures: ['debit'] })).toHaveLength(2)
  })

  it('needs at least one measure, unique dimensions, one date dimension', () => {
    expect(problems({ source: 'accounts', measures: [] })[0]).toMatch(/at least one measure/)
    expect(problems({ source: 'accounts', dimensions: [{ key: 'party' }, { key: 'party' }], measures: ['net'] })).toContain('A dimension can be used only once')
    expect(problems({ source: 'accounts', dimensions: [{ key: 'month' }, { key: 'fy' }], measures: ['net'] })[0]).toMatch(/one date dimension/)
    expect(problems({ source: 'accounts', dimensions: [{ key: 'party', level: 2 }], measures: ['net'] })).toContain('Only the group dimension has a level')
  })

  it('pivot must be a dimension and cannot combine with a comparative', () => {
    expect(problems({ source: 'accounts', dimensions: [{ key: 'party' }], measures: ['net'], pivot: 'month' })[0]).toMatch(/pivot must be/)
    expect(problems({ source: 'accounts', dimensions: [{ key: 'party' }, { key: 'month' }], measures: ['net'], pivot: 'month', comparative: { kind: 'previousYear' } })[0]).toMatch(/Turn the pivot off/)
    expect(parse({ source: 'accounts', dimensions: [{ key: 'party' }, { key: 'month' }], measures: ['net'], pivot: 'month' }).success).toBe(true)
  })

  it('closing balance: ledger/group/date dimensions only, no voucher filters', () => {
    expect(problems({ source: 'accounts', dimensions: [{ key: 'party' }], measures: ['balance'] })[0]).toMatch(/Closing balance works with/)
    expect(problems({ source: 'accounts', dimensions: [{ key: 'ledger' }], measures: ['balance'], filters: { narration: 'rent' } })[0]).toMatch(/voucher filters \(narration\)/)
    expect(parse({ source: 'accounts', dimensions: [{ key: 'group', level: 2 }, { key: 'month' }], measures: ['balance'], filters: { groupIds: [3] } }).success).toBe(true)
  })

  it('budget comparative: accounts, budget chosen, net/profit first, ledger/group/date dims', () => {
    const p = problems({ source: 'accounts', dimensions: [{ key: 'party' }], measures: ['debit'], comparative: { kind: 'budget' } })
    expect(p).toEqual(expect.arrayContaining([
      'Choose the budget to compare against',
      'A budget compares against the first measure, which must be Net or Profit'
    ]))
    expect(p.some((x) => /can’t be split by party/.test(x))).toBe(true)
    expect(parse({ source: 'accounts', dimensions: [{ key: 'ledger' }, { key: 'month' }], measures: ['profit'], comparative: { kind: 'budget', budgetId: 4 } }).success).toBe(true)
  })

  it('sort must name a shown measure; amount range must not be empty; range order', () => {
    expect(problems({ source: 'accounts', measures: ['net'], sort: { by: 'debit', dir: 'desc' } })).toContain('Sort by a measure the report shows')
    expect(problems({ source: 'accounts', measures: ['net'], filters: { amountMin: 500, amountMax: 100 } })[0]).toMatch(/amount range is empty/)
    expect(problems({ source: 'accounts', measures: ['net'], period: { kind: 'range', from: '2025-05-01', to: '2025-04-01' } })).toContain('The period starts after it ends')
  })

  it('round-trips through the share-as-JSON envelope and reports bad JSON', () => {
    const m = defaultModel('accounts')
    const back = parseModelJson(modelJsonEnvelope('Sales by party', m))
    expect(back).toEqual({ ok: true, model: m, name: 'Sales by party' })
    expect(parseModelJson('{nope')).toEqual({ ok: false, error: 'Not valid JSON' })
    expect(parseModelJson(JSON.stringify({ source: 'accounts', measures: ['qtyIn'] })).ok).toBe(false)
  })
})

describe('period arithmetic', () => {
  it('relative periods', () => {
    expect(relativePeriod('lastMonth', '2026-01-15')).toEqual({ from: '2025-12-01', to: '2025-12-31' })
    expect(relativePeriod('thisQuarter', '2026-02-10')).toEqual({ from: '2026-01-01', to: '2026-03-31' })
    expect(relativePeriod('lastQuarter', '2026-05-10')).toEqual({ from: '2026-01-01', to: '2026-03-31' })
    expect(relativePeriod('lastQuarter', '2026-08-10')).toEqual({ from: '2026-04-01', to: '2026-06-30' })
    expect(relativePeriod('fyToDate', '2026-02-10')).toEqual({ from: '2025-04-01', to: '2026-02-10' })
    expect(relativePeriod('lastFy', '2026-02-10')).toEqual({ from: '2024-04-01', to: '2025-03-31' })
    expect(resolvePeriod({ kind: 'working' }, { from: '2025-04-01', to: '2026-03-31' }, '2026-01-01')).toEqual({ from: '2025-04-01', to: '2026-03-31' })
  })

  it('previous period and previous year', () => {
    expect(previousPeriod('2025-04-01', '2025-06-30')).toEqual({ from: '2025-01-01', to: '2025-03-31' })
    expect(previousPeriod('2025-03-01', '2025-03-31')).toEqual({ from: '2025-02-01', to: '2025-02-28' })
    expect(previousPeriod('2025-04-10', '2025-04-19')).toEqual({ from: '2025-03-31', to: '2025-04-09' })
    expect(previousYear('2024-03-01', '2024-03-31')).toEqual({ from: '2023-03-01', to: '2023-03-31' })
    expect(previousYear('2024-02-01', '2024-02-29')).toEqual({ from: '2023-02-01', to: '2023-02-28' })
    expect(previousYear('2025-02-01', '2025-02-28')).toEqual({ from: '2024-02-01', to: '2024-02-29' })
    expect(comparativeShiftMonths('previousPeriod', '2025-04-01', '2025-06-30')).toBe(3)
    expect(comparativeShiftMonths('previousPeriod', '2025-04-02', '2025-06-30')).toBeNull()
    expect(addMonths('2025-01-31', 1)).toBe('2025-02-28')
  })

  it('bucket keys mirror the SQL (FY quarters, FY start year)', () => {
    expect(periodKey('2025-04-01', 'quarter')).toBe('2025-Q1')
    expect(periodKey('2026-03-31', 'quarter')).toBe('2025-Q4')
    expect(periodKey('2026-01-05', 'fy')).toBe('2025')
    expect(periodLabel('2025-Q4', 'quarter')).toBe('Q4 2025-26')
    expect(periodLabel('2025', 'fy')).toBe('FY 2025-26')
    expect(periodLabel('2025-05', 'month')).toBe('May 2025')
    expect(fyQuarterOf('2025-12-01')).toMatchObject({ q: 3, from: '2025-10-01', to: '2025-12-31' })
    expect(periodKeysBetween('2025-02-15', '2025-05-02', 'month')).toEqual(['2025-02', '2025-03', '2025-04', '2025-05'])
    expect(periodKeysBetween('2025-02-15', '2025-07-02', 'quarter')).toEqual(['2024-Q4', '2025-Q1', '2025-Q2'])
    expect(periodKeysBetween('2024-04-01', '2026-03-31', 'fy')).toEqual(['2024', '2025'])
    expect(shiftPeriodKey('2024-05', 'month', 12)).toBe('2025-05')
    expect(shiftPeriodKey('2024-Q4', 'quarter', 3)).toBe('2025-Q1')
    expect(shiftPeriodKey('2024', 'fy', 12)).toBe('2025')
    expect(fyStartsWithin('2024-04-01', '2026-03-31')).toEqual(['2025-04-01'])
    expect(fyStartsWithin('2024-05-01', '2026-04-01')).toEqual(['2025-04-01', '2026-04-01'])
  })
})

const row = (keys: [string | number | null, string][], values: number[], compare?: (number | null)[]): ResultRow => ({
  keys: keys.map(([id, label]) => ({ id, label })),
  values,
  ...(compare ? { compare } : {})
})

describe('shaping: running balance, comparatives, sort, totals, pivot', () => {
  it('accumulates closing balances across every date bucket, filling the gaps', () => {
    const rows = [
      row([[1, 'Cash'], ['2025-04', 'Apr']], [1000, 1]),
      row([[1, 'Cash'], ['2025-06', 'Jun']], [-300, 2]),
      row([[2, 'Bank'], ['2025-05', 'May']], [500, 1])
    ]
    const out = accumulateBalance(rows, ['ledger', 'month'], ['balance', 'count'], '2025-04-01', '2025-06-30')
    const cash = out.filter((r) => r.keys[0]!.id === 1).map((r) => [r.keys[1]!.id, ...r.values])
    expect(cash).toEqual([['2025-04', 1000, 1], ['2025-05', 1000, 0], ['2025-06', 700, 2]])
    const bank = out.filter((r) => r.keys[0]!.id === 2).map((r) => r.values[0])
    expect(bank).toEqual([0, 500, 500])
    // Totals of a closing balance with a date dimension = the last bucket only.
    expect(totalsOf(out, ['ledger', 'month'], ['balance', 'count'])).toEqual([1200, 4])
  })

  it('variance: absolute and percent of the comparative magnitude', () => {
    expect(variance(1500, 1000)).toEqual({ abs: 500, pct: 50 })
    expect(variance(-500, -1000)).toEqual({ abs: 500, pct: 50 })
    expect(variance(100, 0)).toEqual({ abs: 100, pct: null })
    expect(variance(100, null)).toEqual({ abs: null, pct: null })
    expect(variance(1, 3).pct).toBe(-66.7)
  })

  it('merges a previous-year run by re-keyed month and keeps rows that dropped away', () => {
    const cur = [row([[7, 'Acme'], ['2025-05', 'May 2025']], [900])]
    const prior = [row([[7, 'Acme'], ['2024-05', 'May 2024']], [600]), row([[8, 'Gone'], ['2024-06', 'Jun 2024']], [50])]
    const merged = mergeComparative(cur, prior, ['party', 'month'], 12)
    expect(merged).toEqual([
      { keys: [{ id: 7, label: 'Acme' }, { id: '2025-05', label: 'May 2025' }], values: [900], compare: [600] },
      { keys: [{ id: 8, label: 'Gone' }, { id: '2025-06', label: 'Jun 2025' }], values: [0], compare: [50] }
    ])
  })

  it('sorts by a measure (ties by dimension) and keeps the top N', () => {
    const rows = [row([[1, 'B']], [10]), row([[2, 'A']], [30]), row([[3, 'C']], [10]), row([[null, '(no party)']], [99])]
    const sorted = sortRows(rows, { sort: { by: 'net', dir: 'desc' }, measures: ['net'], topN: 3 })
    expect(sorted.map((r) => r.keys[0]!.label)).toEqual(['(no party)', 'A', 'B'])
    const byName = sortRows(rows, { sort: { by: 'dimension', dir: 'asc' }, measures: ['net'], topN: null })
    expect(byName.map((r) => r.keys[0]!.label)).toEqual(['A', 'B', 'C', '(no party)'])
  })

  it('pivots one dimension into columns with row, column and grand totals', () => {
    const result = {
      dims: [{ key: 'party', label: 'Party', link: 'ledger' }, { key: 'month', label: 'Month', link: 'month' }],
      measures: [{ key: 'taxable', label: 'Taxable value', kind: 'money', signed: false }],
      rows: [
        row([[1, 'Acme'], ['2025-05', 'May 2025']], [100]),
        row([[1, 'Acme'], ['2025-04', 'Apr 2025']], [50]),
        row([[2, 'Bolt'], ['2025-05', 'May 2025']], [7])
      ]
    } as Pick<ReportResult, 'dims' | 'measures' | 'rows'>
    const p = pivotResult(result, 'month')
    expect(p.columns.map((c) => c.id)).toEqual(['2025-04', '2025-05'])
    expect(p.rows.map((r) => [r.keys[0]!.label, r.cells.map((c) => c[0]), r.total[0]])).toEqual([
      ['Acme', [50, 100], 150],
      ['Bolt', [null, 7], 7]
    ])
    expect(p.columnTotals).toEqual([[50], [107]])
    expect(p.grandTotal).toEqual([157])
  })

  it('pivoted closing balances total to the last column', () => {
    const result = {
      dims: [{ key: 'ledger', label: 'Ledger', link: 'ledger' }, { key: 'month', label: 'Month', link: 'month' }],
      measures: [{ key: 'balance', label: 'Closing balance', kind: 'money', signed: true }],
      rows: [row([[1, 'Cash'], ['2025-04', 'Apr']], [100]), row([[1, 'Cash'], ['2025-05', 'May']], [80])]
    } as Pick<ReportResult, 'dims' | 'measures' | 'rows'>
    expect(pivotResult(result, 'month').rows[0]!.total).toEqual([80])
  })

  it('flattens a comparative result with change and change % columns, plus a totals row', () => {
    const result: ReportResult = {
      from: '2025-04-01', to: '2025-04-30',
      dims: [{ key: 'party', label: 'Party', link: 'ledger' }],
      measures: [{ key: 'taxable', label: 'Taxable value', kind: 'money', signed: false }],
      rows: [row([[1, 'Acme']], [150000], [100000])],
      totals: [150000],
      compare: { kind: 'previousYear', label: 'Previous year', from: '2024-04-01', to: '2024-04-30' },
      compareTotals: [100000],
      truncated: false, rowCap: 20000, warnings: []
    }
    const flat = flattenResult(result, null)
    expect(flat.header).toEqual(['Party', 'Taxable value', 'Taxable value · Previous year', 'Taxable value · change', 'Taxable value · change %'])
    expect(flat.rows[0]).toEqual(['Acme', '1,500.00', '1,000.00', '500.00', '+50.0%'])
    expect(flat.rows[1]![0]).toBe('Total')
    expect(flattenResult(result, null, 'plain').rows[0]![1]).toBe('1500.00')
    expect(chartSeries(result)).toEqual({ categories: [{ key: '1', label: 'Acme' }], values: [150000], compare: [100000] })
  })
})
