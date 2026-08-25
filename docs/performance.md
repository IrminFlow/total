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

## What the numbers say

**e-Invoice & e-Way is the one real failure.** It did not settle at all inside the sweep's
60-second budget while the machine was busy, and takes **19 seconds** on a quiet one. Not a slow
screen — a screen that does not come back. `listSalesInvoices` returns every sales document in
the period unpaginated, and runs two correlated `EXISTS` subqueries against `inventory_lines`
per row. At 44,000 sales documents that is 88,000 correlated subqueries for one screen.

**Trial balance is the scaling wall.** 3.2 seconds *warm* is not a cold-cache problem — it is
that much work being redone on every single visit. It is the clearest case for keyset pagination
in the app.

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
