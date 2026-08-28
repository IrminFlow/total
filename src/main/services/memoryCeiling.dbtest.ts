import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openBigBook } from '../db/bigbook'
import * as reports from './reports'
import * as analysis from './analysis'
import { streamReportCsv } from './exportStream'

/**
 * A memory ceiling on a large book (roadmap K#237).
 *
 * `queryBudget.dbtest.ts` says how long the reports take. This says how much of the machine they
 * take while doing it, which is a different failure: a report that materialises the whole of
 * `voucher_lines` to answer a question about one page does not get slower in proportion, it gets
 * slower and then it dies, and the first person to see that is a user with three years of books
 * and 8 GB of RAM.
 *
 * Measured on the shared 4,000-invoice fixture (7,800 vouchers). At the time of writing, with a
 * baseline heap of 21.7 MB and the whole suite peaking at 149 MB RSS:
 *
 *   trialBalance / profitAndLoss / balanceSheet   +0.1 MB each
 *   dayBook, one 500-row page                     +0.6 to +0.8 MB
 *   dayBook, the WHOLE period (7,800 rows)        +8.5 MB
 *   outstandings with bills                       under a megabyte, and often negative — a
 *                                                 collection landed inside the measurement
 *   streamReportCsv of the whole day book         no growth at all (0.5 MB written to disk)
 *   four further sweeps of all seven reports      +3.5 MB, i.e. flat
 *
 * Two kinds of assertion, for the same reason `queryBudget` has two:
 *
 *   - An ABSOLUTE ceiling, set loosely enough that a busy runner does not trip it. It catches
 *     the accident that makes a report's memory a function of the book rather than the page.
 *   - A SHAPE assertion: sweeping every report repeatedly must not grow the heap. That is
 *     machine-independent, and it is what a cache with no bound — a memoised report, a
 *     statement map keyed on SQL built per call — would break while every ceiling still passed.
 *
 * Ordinary report measurements deliberately do not force GC, so those heap numbers are upper
 * bounds. The streaming-retention test is different: `scripts/test-db.mjs` exposes GC to the
 * Electron-as-Node Vitest worker, lets one equivalent export warm the SQLite/V8 machinery, then
 * collects before measuring a second export. That tests live retained state rather than whichever
 * suite-order garbage happened to be awaiting collection on Windows.
 */

/** Slow, contended runners: `TOTAL_MEMORY_CEILING_SCALE=2 npm run test:db -- memoryCeiling`. */
const SCALE = Number(process.env.TOTAL_MEMORY_CEILING_SCALE ?? 1)

const MB = 1024 * 1024
const heap = (): number => process.memoryUsage().heapUsed
const mb = (n: number): string => (n / MB).toFixed(1)

describe('memory ceiling on a large book', () => {
  const book = openBigBook({ invoices: 4000 })
  const { db } = book
  const { from, to } = book.shape

  /** Every report a person can reach in one sitting, in the order a suspicious accountant would. */
  const sweep = (): void => {
    reports.trialBalance(db, to)
    reports.profitAndLoss(db, from, to)
    reports.balanceSheet(db, from, to)
    reports.dayBook(db, from, to, { limit: 500 })
    reports.dayBookCount(db, from, to)
    analysis.outstandings(db, 'receivable', to, { includeBills: true })
    analysis.outstandings(db, 'payable', to, { includeBills: true })
  }

  it('answers each report without the book size landing in the heap', () => {
    const each: [string, number, () => unknown][] = [
      ['trialBalance', 8, () => reports.trialBalance(db, to)],
      ['profitAndLoss', 8, () => reports.profitAndLoss(db, from, to)],
      ['balanceSheet', 8, () => reports.balanceSheet(db, from, to)],
      ['dayBook page of 500', 12, () => reports.dayBook(db, from, to, { limit: 500 })],
      ['outstandings + bills', 40, () => analysis.outstandings(db, 'receivable', to, { includeBills: true })]
    ]
    for (const [label, ceilingMb, fn] of each) {
      const before = heap()
      fn()
      const grew = heap() - before
      console.log(`[memory] ${label.padEnd(22)} +${mb(grew).padStart(6)} MB of ${ceilingMb * SCALE} MB`)
      expect(grew, `${label} took more heap than its ceiling — see the header of memoryCeiling.dbtest.ts`)
        .toBeLessThan(ceilingMb * SCALE * MB)
    }
  })

  it('costs a page of memory for a page of Day Book, not a book of memory', () => {
    // Reported, not asserted. A heap delta is an upper bound with no lower bound: a collection
    // landing inside the measurement can make it negative, and the first version of this test
    // asserted `page < whole / 2` and failed with `expected 831368 to be less than -7689820`.
    // That is not a flake to retry, it is a measurement that cannot carry an assertion.
    const pageBefore = heap()
    reports.dayBook(db, from, to, { limit: 500 })
    const pageHeap = heap() - pageBefore
    const wholeBefore = heap()
    const all = reports.dayBook(db, from, to)
    const wholeHeap = heap() - wholeBefore
    console.log(`[memory] dayBook heap: page ${mb(pageHeap)} MB, whole period (${all.length} rows) ${mb(wholeHeap)} MB`)

    // Asserted: the payload, which is deterministic and is also the thing that actually crosses
    // IPC and is held by the renderer. This is the property paging exists for — if a page is not
    // a fraction of the book, the page is being sliced out of a whole-period result that was
    // built anyway.
    const pageKb = JSON.stringify(reports.dayBook(db, from, to, { limit: 500 })).length / 1024
    const wholeKb = JSON.stringify(all).length / 1024
    console.log(`[memory] dayBook payload: page ${pageKb.toFixed(0)} KB of ${wholeKb.toFixed(0)} KB whole`)
    expect(all.length).toBeGreaterThan(5000)
    expect(pageKb, 'a 500-row Day Book page carries nearly as much payload as the whole period')
      .toBeLessThan(wholeKb / 3)
  })

  it('exports in pages without retaining another export in memory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'total-memceiling-'))
    try {
      const gc = global.gc
      expect(gc, 'scripts/test-db.mjs must expose GC for a deterministic retention measurement')
        .toBeTypeOf('function')
      const request = {
        kind: 'dayBook' as const,
        from,
        to,
        includeOutOfBooks: false,
        columns: { type: true, number: true, account: true, debit: true, credit: true }
      }

      const first = streamReportCsv(
        db,
        request,
        join(dir, 'daybook-first.csv')
      )
      gc!()
      const settled = heap()

      const second = streamReportCsv(db, request, join(dir, 'daybook-second.csv'))
      gc!()
      const retained = heap() - settled
      console.log(
        `[memory] streamed ${second.rows} rows / ${(second.bytes / MB).toFixed(1)} MB in ` +
          `${second.pages} pages; second export retained ${mb(retained)} MB`
      )

      expect(first.rows).toBeGreaterThan(5000)
      expect(second).toEqual({ ...first, path: join(dir, 'daybook-second.csv') })
      // PAGE is 1,000. More than five pages proves the source rows were not fetched as one period;
      // exact page count proves the cursor neither repeated nor skipped a boundary row.
      expect(second.pages).toBe(Math.ceil(second.rows / 1000))
      // The first run has warmed lazy SQLite/V8 state. After collection, repeating the same export
      // must not leave another period-sized graph alive.
      expect(retained, 'a repeated streaming CSV export retains memory after its result is discarded')
        .toBeLessThan(4 * SCALE * MB)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not grow when the same reports are run again and again', () => {
    // Two warm-up sweeps first: the first run of anything fills lazily-built state (SQLite's page
    // cache, the prepared-statement cache, V8's inline caches) and counting that as a leak would
    // make this test a coin toss. What must be flat is the SIXTH sweep against the third.
    sweep()
    sweep()
    const settled = heap()
    for (let i = 0; i < 4; i++) sweep()
    const grew = heap() - settled
    console.log(`[memory] four further full sweeps: heap +${mb(grew)} MB (from ${mb(settled)} MB)`)
    // Four sweeps of seven reports each. Uncollected garbage is in here too, so this is loose on
    // purpose — what it catches is something that RETAINS per call, which after 28 report runs
    // would be well past this.
    expect(grew, 'repeating the report sweep grows the heap — something is retaining per call')
      .toBeLessThan(60 * SCALE * MB)
  })
})
