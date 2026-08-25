# Performance at the size of a real business

Measured 25 August 2026, macOS, on a book of **85,840 vouchers** across three financial years —
44,000 sales invoices with their receipts and purchases, which is roughly what a business
migrating off Tally brings with it.

The book is built through the ordinary `voucher:save` channel, not by writing SQLite directly.
That is slower to build and it is the honest thing to measure against: it exercises the same
validation, audit and duplicate-number path a real entry does, so the result is a book the app
could actually have produced.

Each number is the time from clicking a sidebar entry to the screen reporting itself idle —
**query, IPC payload and React render together**, which is what a person actually waits for.
Cold is the first visit of the session. Warm is every visit after it, and it is the one that
matters, because it is the one that happens all day.

Reproduce with:

```bash
node scripts/perf-sweep.mjs --vouchers=44000              # builds the book, then times it
node scripts/perf-sweep.mjs --data-dir=<path it printed>  # re-time an existing book, in minutes
```

## What it costs now, at 5,500 vouchers

Everything below this section was measured on the 85,840-voucher book and is kept, because the
diagnosis in it is why the fixes were the fixes. What is true today, re-measured on a
5,500-voucher book on 25 August 2026 (the second half of roadmap section K):

| | Cold | Warm |
|---|---:|---:|
| Slowest screen (e-documents) | 27 ms | 244 ms |
| Second slowest (outstandings) | 43 ms | 75 ms |
| Everything else | 25–129 ms | 30–74 ms |

Nothing on the sidebar is over 250 ms, and only one screen is over 100.

Three further measurements, because each of them decided whether something got built:

- **Where the wait goes.** Splitting a screen's wait into its IPC call and everything after it:
  e-documents is 34 ms for 2,814 rows (697 KB), of which about 11 ms is React; the Day Book
  fetches 5,500 rows (1,244 KB) in 40 ms and renders them in 3 ms, because it is row-virtualized.
  Rendering is not what anybody is waiting for. (Roadmap #241, declined on those numbers.)
- **What an IPC round trip costs.** 0.10 ms median, 0.20 ms p95, empty. Ten sequential: 0.80 ms.
  Ten fired together: 0.30 ms — react-query already parallelises them. The largest wave any screen
  makes is seven calls, at voucher entry. (Roadmap #239, declined.)
- **What PDF generation blocks.** Not much: it runs in a hidden `BrowserWindow`, so a 5,000-row
  report PDF takes 17–21 seconds of wall time while stalling the main process for 149–169 ms,
  against a 3–8 ms stall when main is idle. (Roadmap #231, declined.)

And two things that got faster, both measured as paired A/B rather than before-and-after, for the
reason the retraction below exists:

- **The renderer's entry chunk: 2,557,901 → 1,396,206 bytes**, by code-splitting the screens most
  users never open. Over 12 paired cold launches the renderer's DCL went 210 → 177 ms and time to
  first screen 771 → 744 ms, both at the minimum; the medians are inside the noise. The byte count
  is the durable number.
- **`saveVoucher`: 26 prepared statements per save → 3.** The same code with the statement cache
  cleared before every call took 1,431 µs; with it, 1,046 µs (minimum of 40 alternating runs,
  −27%).

Two budgets now fail the build rather than sitting in a log. `src/main/services/
memoryCeiling.dbtest.ts` holds the heap on the 7,800-voucher fixture — a Day Book page carries
113 KB of the whole period's 1,765 KB, and the streaming export costs no heap at all. And
`scripts/bundle-budget.mjs` holds the renderer's entry chunk at 1,363 KB of 1,600 KB, which is
where a startup regression actually shows up: one static import dragging a screen back into the
startup path.

`scripts/e2e/37-startup-budget.mjs` measures the cold launch itself, and it is worth saying what
happened to it. It was written with a 2,500 ms ceiling against a measured 743 ms — three times the
measurement — and it failed on its first real run at 4,454 ms, with nothing wrong: that launch
happened while the other thirty-six E2E scenarios were finishing around it, and a retry a minute
later took 22 seconds. So the wall-clock half is a liveness check now, and the ceiling that stayed
is the renderer's DCL (121 ms quiet, 834 ms at the worst seen under the full suite, ceiling
3,000 ms), because it excludes process spawn and survives contention. This is the same lesson as
the retraction below, learned again by someone who had just read it.

## The slow end

| Screen | Cold | Warm |
|---|---:|---:|
| e-Invoice & e-Way | **19,381 ms** | — |
| Trial balance | 4,985 ms | 3,240 ms |
| Outstandings | 1,623 ms | 1,887 ms |
| Collections | 1,384 ms | 1,412 ms |
| Day book | 1,790 ms | 1,401 ms |
| Khata | 3,129 ms | 1,373 ms |
| GSTR-1 | 915 ms | 1,057 ms |
| Balance sheet | 1,036 ms | 1,017 ms |

## The fast end

| Screen | Cold | Warm |
|---|---:|---:|
| Payroll | 114 ms | 47 ms |
| Disclosure | 71 ms | 68 ms |
| Stock summary | 379 ms | 92 ms |
| Fixed assets | 136 ms | 94 ms |
| Borrowing | 167 ms | 141 ms |
| Budgets | 208 ms | 145 ms |
| Gateway | 101 ms | 182 ms |
| Banking | 245 ms | 197 ms |

Everything not listed falls between 200 ms and 1,000 ms warm.

## After the pagination work

Same machine, same 85,840-voucher book, same sweep — the build before the change and the build
after it, run back to back rather than compared against a number from another day. That matters:
the first run of this sweep was taken while five other jobs were on the machine, and it reported
trial balance at 3,240 ms warm. On a quiet machine the SAME build reports 159 ms. Nothing about
the app changed between those two numbers, so the "trial balance is the scaling wall" reading was
the load talking. Every figure below is a paired before/after from one sitting.

| Screen | Before (cold / warm) | After (cold / warm) |
|---|---:|---:|
| e-Invoice & e-Way | 10,093 / 11,252 ms | **1,664 / 1,310 ms** |
| Day book | 438 / 373 ms | **105 / 46 ms** |
| Trial balance | 168 / 159 ms | 137 / 152 ms |
| Outstandings | 270 / 247 ms | 126 / 125 ms |
| Khata | 268 / 230 ms | 144 / 168 ms |

The first two are the work of this lane. The rest moved inside the run-to-run spread — roughly
±90 ms on this machine — and are not claimed.

At the query level, on a 7,800-voucher fixture, before → after:

| | Before | After |
|---|---:|---:|
| Day Book, first page of 500 | 14.9 ms | 1.9 ms |
| Day Book, last page of 500 | 22.0 ms | 3.3 ms by offset, **0.4 ms by cursor** |
| Day Book, whole period (exports) | 28.3 ms | 30.1 ms |
| Ledger statement, first page of 500 | 13.9 ms | 5.7 ms |
| Ledger statement, whole period | 14.8 ms | 15.3 ms |

The whole-period Day Book got 1.8 ms slower. That is the two-phase rewrite's fixed cost, it is
paid on an export rather than on every visit to a screen, and it is the trade the paged numbers
in the same table bought.

On the real 85,840-voucher book, the individual queries behind the slow screens are all small:
trial balance 150 ms, what-changed 261 ms, balance sheet 307 ms, ratios 381 ms, outstandings with
every bill 439 ms, a Day Book page 3 ms, an e-document page 3 ms. **No query on the trial balance
screen exceeds 310 ms**, so whatever is left of that screen's time is renderer, not SQL — the next
person to look at it should profile React rather than add an index.

## What the numbers say

**e-Invoice & e-Way was the one real failure — fixed.** It is paged now, and the section above
has the numbers. What it was:

**e-Invoice & e-Way is the one real failure.** It did not settle at all inside the sweep's
60-second budget while the machine was busy, and takes **19 seconds** on a quiet one. Not a slow
screen — a screen that does not come back. `listSalesInvoices` returns every sales document in
the period unpaginated, and runs two correlated `EXISTS` subqueries against `inventory_lines`
per row. At 44,000 sales documents that is 88,000 correlated subqueries for one screen.

**Trial balance is the scaling wall.** — withdrawn, and worth leaving in as a warning. The
3.2 seconds was measured on a machine running five other jobs; the same build on a quiet machine
reports 159 ms warm, and no query behind that screen exceeds 310 ms on this book. A performance
number taken on a contended machine is a measurement of the machine.

**Cold and warm are different bugs.** The filing register takes 8.6 seconds on its first visit
and 217 ms on every one after, which is a cache filling once and is close to fine. Voucher entry
is 3.7 seconds cold and 771 ms warm, which is masters loading once. Trial balance is slow both
times, and that is the one to fix.

**Nothing crashed, and no screen ran out of memory.** The app opened, built and navigated an
85,840-voucher book for the length of the sweep without a console error.

## Why 85,840 and not 100,000

The generator posts a fixed ratio — every invoice, a receipt for three in four, a purchase for
one in five — so a round number of invoices does not produce a round number of vouchers. 44,000
invoices produced 85,840. The conclusions do not move between 86k and 100k; the numbers above
are what was measured, and saying "100,000" would be describing a book that was not built.
