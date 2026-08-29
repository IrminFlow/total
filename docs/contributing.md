# Working on Total

Total is a fully offline accounting app. Its users file returns from what it says, so the bar for
a number being right is higher than the bar for a feature being finished. Most of what follows is
about that.

## The invariants

These are not style preferences. Breaking one produces books that do not balance, and the failure
usually appears months later in someone else's audit.

**Money is integer paise. Everywhere.** Never a float, never a rupee decimal, never a string that
is parsed twice. `₹1,234.56` is `123456`. Formatting and parsing happen only through
`src/shared/money.ts` — if you find yourself writing `toFixed(2)` or `* 100`, stop.

Floating point is not merely imprecise here, it is wrong in a way that hides: `0.1 + 0.2` is
`0.30000000000000004`, and a trial balance that is out by a paisa is indistinguishable from a
trial balance that is out because of a real bug.

**Quantities are integer thousandths** (`qtyMilli`). 1.5 kg is `1500`. Same reasoning.

**Voucher lines are the source of truth.** Every report is computed from `voucher_lines` plus
opening balances, at query time. Never denormalise a balance into a column. A cached balance is a
balance that can disagree with the vouchers that produced it, and when it does, nobody can tell
which one is lying.

**Every query touching vouchers filters `deleted_at IS NULL`.** Vouchers are soft-deleted into a
bin. Use `IN_BOOKS` or `NOT_DELETED` from `src/main/services/vouchers.ts` rather than writing the
condition by hand — the exceptions (reading the bin, `getVoucher`, `nextVoucherNumber`) are
deliberate and few.

**Dates are ISO `YYYY-MM-DD` strings, and the arithmetic is UTC.** An ISO date here is a calendar
day with no clock attached. Use `addDays` and `daysBetween` from `src/shared/dates.ts`; doing it
in local time makes 30 days land on a different date either side of a daylight-saving change.

The Indian financial year runs April to March. Q1 is April–June. `fyOf` and `fyFromStartYear`
know this; hand-rolled year arithmetic usually does not.

**Migrations are append-only.** Add a numbered string to `src/main/db/migrations.ts`. Never edit
an existing one — someone's database has already run it. New tables go in `EXPECTED_TABLES` in
`migrations.dbtest.ts`, which is the guard that catches a migration nobody wired up.

**`prep(db, sql)` only for SQL that is a fixed string.** The prepared-statement cache in
`src/main/db/stmt.ts` shares one `Statement` between every caller of that SQL on that connection —
which is why `saveVoucher` compiles three statements a save instead of twenty-six. SQL assembled
per call (`IN (${placeholders})`) must keep using `db.prepare`, or the cache grows forever; and
nothing may chain `.pluck()`, `.raw()`, `.expand()` or `.iterate()` onto a cached statement,
because all four leave state on it that the next caller inherits. `db/stmt.test.ts` checks both.

**The engine stays pure.** `src/shared/` imports no Electron and no database. `npm test` must
never load `better-sqlite3`: it is compiled for Electron's ABI, not Node's, and importing it there
fails in a way that looks unrelated to what you changed.

## Where code goes

| It is… | It lives in | It is tested by |
|---|---|---|
| arithmetic, a format, a rule | `src/shared/` | `npm test` |
| a query, a service, a posting | `src/main/services/` | `npm run test:db` |
| a hook or a helper in the UI | `src/renderer/src/` | `npm run test:renderer` |
| a screen a person uses | `src/renderer/src/screens/` | `npm run e2e` |

If a piece of logic can be pulled into `src/shared/`, pull it. Pure functions are the only things
in this codebase that can be tested exhaustively and cheaply, and the statutory rules — GST, TDS,
depreciation, gratuity — are exactly the code where exhaustive matters.

## Adding a feature

1. **Engine first**, in `src/shared/`, with tests that state the rule in the name. Statutory code
   should cite the section it implements, and say when it was checked.
2. **Service**, in `src/main/services/`, with a `.dbtest.ts`.
3. **IPC**, in `src/main/ipc.ts`. Every payload is Zod-parsed; handlers return `{ ok, data|error }`.
4. **Client**, in `src/renderer/src/lib/client.ts`. The renderer talks to main through nothing else.
5. **Screen.** If it introduces a react-query key family, add it to that screen's `invalidates` in
   `lib/screens.ts` — `__tests__/invalidation.test.ts` fails otherwise, and the bug it prevents is
   a screen serving a stale answer for five seconds after you changed the data.
6. **E2E scenario**, asserting the property rather than the pixels.

## Statutory code

Rates, slabs and thresholds move. Every one of them is dated data, not a constant — see
`src/shared/statutory.ts` and `src/shared/incomeTax.ts` for the shape. A run computed last year
must still answer what it answered when it was filed.

Write the section number in the comment, and write down what you checked it against. A tax feature
that is confidently wrong is worse than one that is honestly absent: the user does not find out
from the app, they find out from a notice.

Where two treatments genuinely differ — Companies Act depreciation against section 32, say — store
both. Deriving one from the other is wrong from the second year and compounds.

## Comments

Explain **why**, not what. The code already says what it does.

The comments worth writing are the ones that stop the next person undoing a deliberate decision:
why the accent selection bar is an inset `box-shadow` and not a `::before` (a `tr::before` renders
as a phantom first cell), why the accelerator red is not the credit red, why an unclassified MSME
supplier is not the same as an exempt one.

## Before you commit

```
npm run verify --fast    # typecheck + three harnesses, ~25s
npm run verify           # everything, including build and E2E
```

Install the hook so `--fast` runs on every commit:

```
git config core.hooksPath .githooks
```

A flake fails the run. `scripts/run-e2e.mjs` retries a failing scenario once and reports FLAKE
rather than PASS, because a test that passes half the time is how a real bug ships green — one
did, and it took a 50% failure rate before anyone looked.

## Looking at the UI

```
node scripts/shots-app.mjs --both
```

Photographs every screen in both themes into `smoke-out/shots/`, with a contact sheet. A screen
nobody has looked at since it was written is where the ugly lives.
