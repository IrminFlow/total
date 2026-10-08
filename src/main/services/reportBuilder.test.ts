// Pure compile tests (plain-Node vitest — compile() never touches the database): every statement
// the report builder generates carries the books' standard filters, and the model's choices land
// in the SQL as intended.
import { describe, expect, it } from 'vitest'
import { reportModelSchema, DIMENSION_KEYS, MEASURE_KEYS, DIMENSIONS, MEASURES, type ReportModelInput } from '@shared/reportBuilder/model'
import { compile, groupAtLevel, type CompileContext } from './reportBuilder'
import { IN_BOOKS, MOVES_STOCK, NOT_DELETED, NOT_YEAR_END_CLOSE } from './vouchers'

const CTX: CompileContext = {
  groups: [
    { id: 1, parentId: null, name: 'Current Assets', nature: 'asset' },
    { id: 2, parentId: 1, name: 'Sundry Debtors', nature: 'asset' },
    { id: 3, parentId: 2, name: 'Mumbai Debtors', nature: 'asset' },
    { id: 10, parentId: null, name: 'Sales Accounts', nature: 'income' },
    { id: 11, parentId: null, name: 'Purchase Accounts', nature: 'expense' }
  ],
  stockGroups: [{ id: 1, parentId: null }, { id: 2, parentId: 1 }],
  salesRootGroupIds: [10],
  purchaseRootGroupIds: [11],
  booksFromYear: 2025
}
const RANGE = { from: '2025-04-01', to: '2026-03-31' }
const sqlOf = (m: ReportModelInput, range = RANGE) => compile(reportModelSchema.parse(m), CTX, range)

/** Every accounts query must read only in-books vouchers in every branch that touches vouchers. */
function assertStandardFilters(sql: string, source: 'accounts' | 'inventory'): void {
  expect(sql).toContain(NOT_DELETED)
  expect(sql).toContain(IN_BOOKS)
  // Each FROM over voucher lines / inventory lines is followed by IN_BOOKS in its own WHERE.
  const reads = sql.split(/FROM (?:voucher_lines|inventory_lines) /).length - 1
  const filtered = sql.split(IN_BOOKS).length - 1
  expect(filtered).toBeGreaterThanOrEqual(reads)
  if (source === 'inventory') expect(sql).toContain(MOVES_STOCK)
  else expect(sql).not.toContain('inventory_lines')
}

describe('report builder compile', () => {
  it('every accounts dimension × measure combination carries the standard filters', () => {
    for (const d of DIMENSION_KEYS.filter((k) => DIMENSIONS[k].sources.includes('accounts'))) {
      for (const k of MEASURE_KEYS.filter((m) => MEASURES[m].sources.includes('accounts'))) {
        if (k === 'balance' && !['ledger', 'group', 'month', 'quarter', 'fy', 'day'].includes(d)) continue
        const { sql } = sqlOf({ source: 'accounts', dimensions: [{ key: d }], measures: [k] })
        assertStandardFilters(sql, 'accounts')
        if (k === 'profit') expect(sql).toContain(NOT_YEAR_END_CLOSE)
      }
    }
  })

  it('every stock dimension × measure combination carries IN_BOOKS and MOVES_STOCK', () => {
    for (const d of DIMENSION_KEYS.filter((k) => DIMENSIONS[k].sources.includes('inventory'))) {
      for (const k of MEASURE_KEYS.filter((m) => MEASURES[m].sources.includes('inventory'))) {
        const { sql } = sqlOf({ source: 'inventory', dimensions: [{ key: d }], measures: [k] })
        assertStandardFilters(sql, 'inventory')
        expect(sql).toContain('il.is_absolute = 0')
      }
    }
  })

  it('profit adds the stored income/expense openings only when the period holds the books’ first day', () => {
    expect(sqlOf({ source: 'accounts', measures: ['profit'] }).sql).toContain("SELECT 'pnlopen'")
    expect(sqlOf({ source: 'accounts', measures: ['profit'] }, { from: '2025-05-01', to: '2026-03-31' }).sql).not.toContain("SELECT 'pnlopen'")
    const filtered = sqlOf({ source: 'accounts', measures: ['profit'], filters: { partyIds: [5] } })
    expect(filtered.sql).not.toContain("SELECT 'pnlopen'")
    expect(filtered.warnings[0]).toMatch(/opening balances/)
  })

  it('closing balance adds opening facts and a reset at every 1 April inside the period', () => {
    const one = sqlOf({ source: 'accounts', dimensions: [{ key: 'ledger' }], measures: ['balance'] })
    expect(one.sql).toContain("SELECT 'open'")
    expect(one.sql).not.toContain("SELECT 'reset'")
    expect(one.params).toMatchObject({ openFyStart: '2025-04-01', openStored: 1 })
    const two = sqlOf({ source: 'accounts', dimensions: [{ key: 'ledger' }], measures: ['balance'] }, { from: '2025-04-01', to: '2027-03-31' })
    expect(two.sql.match(/SELECT 'reset'/g)).toHaveLength(1)
    expect(two.params).toMatchObject({ rb0: '2026-04-01', rf0: '2025-04-01', rs0: 1 })
    // Every opening / reset branch reads in-books vouchers only.
    assertStandardFilters(two.sql, 'accounts')
  })

  it('cost-centre dimension splits lines by allocation and keeps the unallocated rest', () => {
    const { sql } = sqlOf({ source: 'accounts', dimensions: [{ key: 'costCentre' }], measures: ['profit'] })
    expect(sql).toContain('JOIN voucher_line_cost_allocations a ON a.voucher_line_id = vl.id')
    expect(sql).toContain('vl.amount > (CASE WHEN COALESCE(ua.alloc, 0) > vl.amount')
    // Over-allocated lines are scaled down to the line amount.
    expect(sql).toContain('CASE WHEN ua.alloc > vl.amount THEN (a.amount * vl.amount) / ua.alloc ELSE a.amount END')
    const only = sqlOf({ source: 'accounts', dimensions: [{ key: 'costCentre' }], measures: ['profit'], filters: { costCentreIds: [4] } }).sql
    expect(only).toContain('a.cost_centre_id IN (4)')
    expect(only).not.toContain('vl.amount > (CASE')
  })

  it('filters: group subtree, ledgers, parties, kinds, amount, narration, state, users, GST rate', () => {
    const q = sqlOf({
      source: 'accounts',
      dimensions: [{ key: 'party' }],
      measures: ['net'],
      filters: {
        groupIds: [1], ledgerIds: [7, 8], partyIds: [9], voucherKinds: ['sales'], amountMin: 100, amountMax: 900,
        narration: '50%_off', stateCodes: ['27'], users: ['asha'], gstRate: 18
      }
    })
    expect(q.sql).toContain('l.group_id IN (1, 2, 3)')
    expect(q.sql).toContain('f.ledger_id IN (7, 8)')
    expect(q.sql).toContain('v.party_ledger_id IN (9)')
    expect(q.sql).toMatch(/kind IN \(@p\d+\)/)
    expect(q.sql).toMatch(/vl\.amount >= @p\d+/)
    expect(q.sql).toContain("ESCAPE '\\'")
    expect(Object.values(q.params)).toEqual(expect.arrayContaining(['sales', 100, 900, '%50\\%\\_off%', '27', 'asha', 18]))
  })

  it('stock filters: item groups expand to their subtree; accounts-only filters are reported as ignored', () => {
    const q = sqlOf({ source: 'inventory', dimensions: [{ key: 'item' }], measures: ['qtyNet'], filters: { itemGroupIds: [1], godownIds: [3], ledgerIds: [1] } })
    expect(q.sql).toContain('si.group_id IN (1, 2)')
    expect(q.sql).toContain('il.godown_id IN (3)')
    expect(q.warnings).toEqual(['Stock reports ignore the ledger filter'])
  })

  it('group dimension rolls ledgers up to the chosen level', () => {
    expect(groupAtLevel(CTX.groups, 3, 1)).toBe(1)
    expect(groupAtLevel(CTX.groups, 3, 2)).toBe(2)
    expect(groupAtLevel(CTX.groups, 2, 3)).toBe(2)
    const { sql } = sqlOf({ source: 'accounts', dimensions: [{ key: 'group', level: 2 }], measures: ['net'] })
    expect(sql).toContain('gl(group_id, lvl_id) AS (VALUES (1, 1), (2, 2), (3, 2), (10, 10), (11, 11))')
  })

  it('orders by the sort measure so the row cap keeps the largest rows', () => {
    expect(sqlOf({ source: 'accounts', dimensions: [{ key: 'party' }], measures: ['net', 'debit'], sort: { by: 'debit', dir: 'desc' } }).sql).toContain('ORDER BY m1 DESC, d0_id, d0_label')
    // With a pivot, rows rank by entity totals after the query — the SQL keeps the dimension order.
    expect(sqlOf({ source: 'accounts', dimensions: [{ key: 'party' }, { key: 'month' }], measures: ['net'], sort: { by: 'net', dir: 'desc' }, pivot: 'month' }).sql).toContain('ORDER BY d0_id, d0_label, d1_id, d1_label')
  })

  it('caps rows: asks for one more than the cap', () => {
    expect(compile(reportModelSchema.parse({ source: 'accounts', measures: ['net'] }), CTX, RANGE, 50).sql).toMatch(/LIMIT 51$/)
  })
})
