// PR #104 (to-do §4 Performance): the valuation pass now reads inventory_lines as a STREAM (a
// prepared statement's iterator) instead of a materialised array, and a read-only service call can
// share one pass per (as-on, godown) through withStockPass. Neither may change a single figure:
// every streamed reader is compared, item by item and value by value, with the old in-memory input
// (setStreamedPassInput(false) — the test-only flag) on the demo company, a 10k Perf Traders seed
// and the randomised stock fixture (with derived manufactures), and every memoised answer with
// the same reader called on its own.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { freshDb, seededDb } from '../db/testdb'
import { openCompanyDb } from '../db/connection'
import type { DB } from '../db/connection'
import { createDemoCompany } from './demo'
import { PERF_TODAY, seedLargeAsync } from '../perf/seedLarge'
import { seedStockFixture } from './stockFixture.testutil'
import * as sa from './stockAnalysis'
import { profitAndLoss, balanceSheet } from './reports'
import { stockList, stockAttentionCounts, stockProduct } from './simpleStock'
import { canonical } from '../perf/reportSuite'

afterEach(() => {
  sa.setStreamedPassInput(true)
  sa.setDerivedCostingSource(null)
})

const monthEnds = (from: string, to: string): string[] => {
  const out: string[] = []
  let y = Number(from.slice(0, 4))
  let m = Number(from.slice(5, 7))
  for (;;) {
    const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
    if (last > to) break
    out.push(last)
    m++
    if (m > 12) {
      m = 1
      y++
    }
  }
  return out
}

/** Every reader that now streams, on `dates`, plus each item's movement register (FY of the last date). */
function streamedReaders(db: DB, dates: string[], opts: { registers?: 'all' | number } = {}): Record<string, unknown> {
  const items = (db.prepare('SELECT id FROM stock_items ORDER BY id').all() as { id: number }[]).map((r) => r.id)
  const godowns = (db.prepare('SELECT id FROM godowns ORDER BY id').all() as { id: number }[]).map((r) => r.id)
  const last = dates[dates.length - 1]!
  const fyFrom = `${Number(last.slice(5, 7)) >= 4 ? last.slice(0, 4) : Number(last.slice(0, 4)) - 1}-04-01`
  const counts = (
    db.prepare(`SELECT v.id, v.date FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id
                WHERE vt.kind = 'physical_stock' AND v.deleted_at IS NULL ORDER BY v.id LIMIT 20`).all() as { id: number; date: string }[]
  )
  const registerItems = opts.registers === 'all' || opts.registers === undefined ? items : items.slice(0, opts.registers)
  const out: Record<string, unknown> = {
    summary: dates.map((d) => sa.stockSummary(db, d)),
    godown: godowns.slice(0, 3).map((g) => sa.stockSummary(db, last, { godownId: g })),
    value: dates.map((d) => sa.stockValue(db, d)),
    valuesAt: [...sa.stockValuesAt(db, dates).entries()],
    consumption: [[fyFrom, last], [dates[0]!, dates[0]!]].map(([f, t]) => [...sa.periodConsumption(db, f!, t!).entries()]),
    counts: counts.map((c) => [...sa.countLineEffects(db, c.id, c.date).entries()]),
    reorder: sa.reorderPlan(db, fyFrom, last, { onlyBelow: false })
  }
  for (const id of registerItems) {
    out[`register:${id}`] = sa.stockMovements(db, id, fyFrom, last)
    if (godowns[0]) out[`register:${id}:g`] = sa.stockMovements(db, id, fyFrom, last, godowns[0])
  }
  return out
}

/** Streamed vs in-memory, key by key (so a failure names the reader and the item). */
function expectStreamParity(db: DB, dates: string[], opts?: { registers?: 'all' | number }): void {
  sa.setStreamedPassInput(false)
  const before = streamedReaders(db, dates, opts)
  sa.setStreamedPassInput(true)
  const after = streamedReaders(db, dates, opts)
  expect(Object.keys(after)).toEqual(Object.keys(before))
  for (const k of Object.keys(before)) expect(canonical(after[k]), k).toBe(canonical(before[k]))
}

/** The same readers, answered inside ONE withStockPass call, equal the readers called alone. */
function expectMemoParity(db: DB, dates: string[], booksFrom: string): void {
  const today = dates[dates.length - 1]!
  const fyFrom = `${Number(today.slice(5, 7)) >= 4 ? today.slice(0, 4) : Number(today.slice(0, 4)) - 1}-04-01`
  const firstItem = (db.prepare('SELECT id FROM stock_items ORDER BY id LIMIT 1').get() as { id: number } | undefined)?.id
  const run = (): unknown => ({
    // Overlapping dates on purpose: a summary after valuesAt / consumption / a register reuses them.
    valuesAt: [...sa.stockValuesAt(db, dates).entries()],
    summary: dates.map((d) => sa.stockSummary(db, d)),
    consumption: [...sa.periodConsumption(db, fyFrom, today).entries()],
    register: firstItem ? sa.stockMovements(db, firstItem, fyFrom, today) : null,
    again: sa.stockSummary(db, today),
    value: sa.stockValue(db, today),
    reorder: sa.reorderPlan(db, fyFrom, today, { onlyBelow: false }),
    list: stockList(db, today),
    attention: stockAttentionCounts(db, today),
    product: firstItem ? stockProduct(db, firstItem, today) : null,
    pnl: profitAndLoss(db, fyFrom, today),
    bs: balanceSheet(db, booksFrom, today)
  })
  const alone = canonical(run())
  expect(canonical(sa.withStockPass(db, run))).toBe(alone)
  // Nothing outlives the call: a later call recomputes (a write between them is seen).
  expect(canonical(run())).toBe(alone)
}

/** Inside withStockPass the same date is walked once, and line_links is read once. */
function expectOnePass(db: DB, today: string): void {
  const counts = { movements: 0, links: 0 }
  const prepare = db.prepare.bind(db)
  const spy = vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
    if (/FROM inventory_lines il JOIN vouchers v ON v.id = il.voucher_id\s+WHERE v.date <= \?/.test(sql)) counts.movements++
    if (sql.includes("ll.link_type = 'return'")) counts.links++
    return prepare(sql)
  }) as typeof db.prepare)
  try {
    sa.withStockPass(db, () => {
      sa.stockValuesAt(db, [today, '2025-09-30'])
      sa.stockSummary(db, today)
      sa.stockValue(db, '2025-09-30')
      sa.reorderPlan(db, '2025-04-01', today, { onlyBelow: false })
      sa.stockSummary(db, '2025-04-30') // a new date: a second pass, but no second line_links read
    })
    expect(counts.movements).toBe(2)
    expect(counts.links).toBeLessThanOrEqual(1)
    counts.movements = 0
    sa.stockSummary(db, today)
    sa.stockSummary(db, today)
    expect(counts.movements, 'never remembered outside withStockPass').toBe(2)
  } finally {
    spy.mockRestore()
  }
}

describe('valuation pass — streamed input = the in-memory input (PR #104)', () => {
  it('raw rows are read by position: the statement columns are, by name, in RawMovementRow order', () => {
    const db = seededDb()
    seedStockFixture(db, { vouchers: 50, items: 3, seed: 3 })
    const seen: string[] = []
    const prepare = db.prepare.bind(db)
    const spy = vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      if (/FROM inventory_lines il JOIN vouchers v ON v.id = il.voucher_id\s+WHERE v.date <= \?/.test(sql)) seen.push(sql)
      return prepare(sql)
    }) as typeof db.prepare)
    try {
      sa.stockSummary(db, '2026-03-31')
    } finally {
      spy.mockRestore()
    }
    expect(seen.length).toBe(1)
    // streamMovements reads r[0]..r[8] as these names — a changed SELECT list must fail here.
    expect(db.prepare(seen[0]!).columns().map((c) => c.name)).toEqual(
      ['lineId', 'voucherId', 'stockItemId', 'godownId', 'date', 'qtyMilli', 'amount', 'direction', 'isAbsolute']
    )
    // And the ORDER BY is explicit (never index order): the pass's key, then line order.
    expect(seen[0]!).toMatch(/ORDER BY v\.date, v\.id, il\.line_order, il\.id\s*$/)
    db.close()
  })

  it('on the randomised stock fixture, with derived manufactures and godown views', () => {
    const db = seededDb()
    const fx = seedStockFixture(db, { vouchers: 2500, items: 30, seed: 7 })
    const dates = monthEnds('2025-04-01', '2026-03-31')
    expectStreamParity(db, dates)
    const marked = new Set(fx.mixedJournalIds.filter((_, i) => i % 2 === 0))
    sa.setDerivedCostingSource((d, asOn) =>
      (d.prepare('SELECT id, date FROM vouchers WHERE date <= ?').all(asOn) as { id: number }[])
        .filter((v) => marked.has(v.id))
        .map((v) => ({ voucherId: v.id, additionalCostPaise: v.id % 3 === 0 ? 1500 : null }))
    )
    expectStreamParity(db, dates)
    expectMemoParity(db, dates, '2025-04-01')
    expectOnePass(db, '2026-03-31')
    db.close()
  })

  it('on the demo company', () => {
    const root = mkdtempSync(join(tmpdir(), 'total-stream-demo-'))
    const prev = process.env.TOTAL_DATA_DIR
    process.env.TOTAL_DATA_DIR = root
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(`${PERF_TODAY}T10:00:00`))
    try {
      const { slug } = createDemoCompany()
      const db = openCompanyDb(slug)
      try {
        const dates = monthEnds('2025-04-01', PERF_TODAY)
        expectStreamParity(db, dates)
        expectMemoParity(db, dates, '2025-04-01')
      } finally {
        db.close()
      }
    } finally {
      vi.useRealTimers()
      if (prev === undefined) delete process.env.TOTAL_DATA_DIR
      else process.env.TOTAL_DATA_DIR = prev
      rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)

  it('on a 10k-voucher Perf Traders seed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(`${PERF_TODAY}T10:00:00`))
    const db = freshDb()
    try {
      await seedLargeAsync(db, { vouchers: 10_000 })
      const dates = monthEnds('2024-04-01', PERF_TODAY).filter((_, i, a) => i % 3 === 2 || i === a.length - 1)
      // Every item's register on the last date (500 items), the readers on every quarter end.
      expectStreamParity(db, dates, { registers: 'all' })
      expectMemoParity(db, dates, '2024-04-01')
    } finally {
      db.close()
      vi.useRealTimers()
    }
  }, 600_000)
})
