import { describe, it, expect } from 'vitest'
import { openBigBook } from '../db/bigbook'
import * as reports from './reports'
import * as analysis from './analysis'

/**
 * A query-time budget that fails the build.
 *
 * `scale.dbtest.ts` prints timings for a person to read. Nobody reads them: a report that goes
 * from 30 ms to 300 ms lands in a log nobody opens, and the first report of it comes from a user
 * whose book got big. This file is the same measurement with a ceiling attached.
 *
 * Two kinds of assertion, because a shared CI runner's variance is larger than most regressions:
 *
 *   - ABSOLUTE ceilings, set roughly ten times the measured cost. They catch the accident that
 *     makes something quadratic, and they are loose enough that a busy runner does not fail them.
 *     Raising one is fine — do it in a commit that says what got slower and why that is worth it.
 *   - SHAPE assertions: the last page of a report must cost about what the first page costs. That
 *     is the property keyset pagination exists to provide, it is machine-independent, and it is
 *     what an accidental return to `LIMIT ... OFFSET` would break while every absolute ceiling
 *     still passed.
 *
 * The fixture is the shared generated book (bigbook.ts), built once and copied.
 */

/** Slow, contended runners: `TOTAL_QUERY_BUDGET_SCALE=3 npm run test:db -- queryBudget`. */
const SCALE = Number(process.env.TOTAL_QUERY_BUDGET_SCALE ?? 1)

/**
 * The minimum of a few runs, not the mean.
 *
 * On a machine running five other things the mean measures the other five. The minimum is the
 * closest estimate of what the query actually costs, and it is the only statistic here that does
 * not drift with the load next to it.
 */
function fastest(reps: number, fn: () => unknown): number {
  let best = Infinity
  for (let i = 0; i < reps; i++) {
    const t = process.hrtime.bigint()
    fn()
    const ms = Number(process.hrtime.bigint() - t) / 1e6
    if (ms < best) best = ms
  }
  return best
}

function budget(label: string, ceilingMs: number, fn: () => unknown): number {
  const ms = fastest(5, fn)
  console.log(`[budget] ${label.padEnd(34)} ${ms.toFixed(1).padStart(7)} ms  of ${ceilingMs * SCALE} ms`)
  expect(ms, `${label} is over its query-time budget — see the header of queryBudget.dbtest.ts`)
    .toBeLessThan(ceilingMs * SCALE)
  return ms
}

describe('query-time budget', () => {
  // 900 invoices is ~1,750 vouchers: enough that a quadratic query is unmissable, small enough
  // that building the fixture once costs a couple of seconds.
  const book = openBigBook({ invoices: 900 })
  const { db } = book
  const { from, to } = book.shape
  const salesId = book.ledgerId(book.shape.salesLedger)

  it('serves a Day Book page in the time a page should take', () => {
    budget('dayBook page (first)', 60, () => reports.dayBook(db, from, to, { limit: 500 }))
    budget('dayBook count', 40, () => reports.dayBookCount(db, from, to))
    budget('dayBookByType', 60, () => reports.dayBookByType(db, from, to))
  })

  it('costs the same at the end of the book as at the start', () => {
    const first = fastest(5, () => reports.dayBook(db, from, to, { limit: 200 }))

    // Walk to the last page once, outside the measurement.
    let cursor: string | null = null
    let last: string | null = null
    for (;;) {
      const page = reports.dayBook(db, from, to, { limit: 200, after: cursor })
      if (page.length === 0) break
      last = cursor
      cursor = reports.dayBookCursor(page[page.length - 1]!)
    }
    const deep = fastest(5, () => reports.dayBook(db, from, to, { limit: 200, after: last }))
    const whole = fastest(3, () => reports.dayBook(db, from, to))
    console.log(
      `[budget] dayBook first ${first.toFixed(1)} ms, last ${deep.toFixed(1)} ms, whole period ${whole.toFixed(1)} ms`
    )

    // Under OFFSET this ratio grows with the book without limit; under a cursor it is ~1. At this
    // fixture size the gap is small, so this catches the pathological case rather than the merely
    // wasteful one — which is what the next assertion is for.
    expect(deep, 'the last Day Book page costs far more than the first — has paging gone back to OFFSET?')
      .toBeLessThan(first * 4 + 5)

    // The assertion with teeth. A page must cost a FRACTION of the whole period; if it costs the
    // same, the page is being carved out of a whole-period result that was computed anyway, which
    // is exactly what both of these reports used to do and what a careless refactor restores.
    expect(first, 'a Day Book page costs as much as the whole period — is the page being sliced out of a full result?')
      .toBeLessThan(whole / 3)
  })

  it('serves a ledger statement page from the page, not from the period', () => {
    budget('ledgerStatement page (first)', 80, () =>
      reports.ledgerStatement(db, salesId, from, to, undefined, { limit: 500, after: null })
    )

    let cursor = reports.ledgerStatement(db, salesId, from, to, undefined, { limit: 500 }).nextCursor
    let last = cursor
    while (cursor) {
      last = cursor
      cursor = reports.ledgerStatement(db, salesId, from, to, undefined, { limit: 500, after: cursor }).nextCursor
    }
    const deep = fastest(5, () => reports.ledgerStatement(db, salesId, from, to, undefined, { limit: 500, after: last }))
    const first = fastest(5, () => reports.ledgerStatement(db, salesId, from, to, undefined, { limit: 500 }))
    const whole = fastest(3, () => reports.ledgerStatement(db, salesId, from, to))
    console.log(
      `[budget] ledgerStatement first ${first.toFixed(1)} ms, last ${deep.toFixed(1)} ms, whole ${whole.toFixed(1)} ms`
    )
    expect(deep, 'a deep ledger-statement page costs far more than the first').toBeLessThan(first * 4 + 5)

    // Not a time ratio here, deliberately. A statement's page carries a fixed cost — the period
    // totals and the movement before the page, both aggregates over the ledger's own lines — and
    // on a fixture where the ledger holds 900 rows and a page holds 500 that fixed cost is most of
    // the measurement. What a page must always be a fraction of is the PAYLOAD, which is what
    // crosses IPC and what paging was for.
    const wholeKb = JSON.stringify(reports.ledgerStatement(db, salesId, from, to)).length / 1024
    const pageKb =
      JSON.stringify(reports.ledgerStatement(db, salesId, from, to, undefined, { limit: 100 })).length / 1024
    console.log(`[budget] ledgerStatement payload    ${pageKb.toFixed(0).padStart(7)} KB of ${wholeKb.toFixed(0)} KB whole`)
    expect(pageKb, 'a 100-row statement page is not much smaller than the whole period').toBeLessThan(wholeKb / 3)
  })

  it('keeps the aggregate reports inside their budgets', () => {
    budget('trialBalance', 120, () => reports.trialBalance(db, to))
    budget('profitAndLoss', 200, () => reports.profitAndLoss(db, from, to))
    budget('balanceSheet', 200, () => reports.balanceSheet(db, from, to))
    budget('outstandings (summary)', 400, () => analysis.outstandings(db, 'receivable', to, { includeBills: false }))
  })

  it('keeps a page payload small enough to cross IPC cheaply', () => {
    // The payload was the reason for paging in the first place: the SQL was never the slow part,
    // the structured clone of a whole period was.
    const page = reports.dayBook(db, from, to, { limit: 500 })
    const kb = JSON.stringify(page).length / 1024
    console.log(`[budget] dayBook 500-row payload      ${kb.toFixed(0).padStart(7)} KB of 400 KB`)
    expect(kb, 'a 500-row Day Book page has grown past 400 KB — a new column on every row?').toBeLessThan(400)
  })
})
