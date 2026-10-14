# Simple mode (`src/renderer/src/simple/`)

The screens a first-time, non-accountant user sees (plan `docs/superpowers/specs/2026-10-13-simple-for-everyone-plan.md`, Phases 8–9). They drive the same engine as the accountant view — see the plan §0.1.

## Rules (lint-checked by `src/shared/i18n/simpleLint.test.ts`)

- **Every visible string goes through `t()`** from `useT()` (`lib/i18n.ts`). No text between JSX tags, no string literal in a JSX expression, and no string literal in a user-facing prop (`title`, `placeholder`, `label`, `aria-label`, …).
  - Allowed literals: `className`, `data-*`, `aria-*` state attributes (not `aria-label` / `aria-description` / `aria-placeholder` / `aria-roledescription` / `aria-valuetext`), and technical props such as `id`, `key`, `type`, `role`, `testId`, `href`, `variant`, `size`. Extend `TECHNICAL_PROPS` in the lint when a new kit prop is technical.
  - Text with no letters (`·`, `→`, `₹`) is fine.
  - Outside JSX, a literal that reads like prose, or a single all-letter word of 2+ characters (`'saved'`, `'OK'`, `'GST'`), is flagged unless it is in the lint's `CODE_WORDS` list or its line carries an `i18n-technical` comment.
- **Keys come from the `simple.*`, `common.*` or `errors.*` namespaces only.** Those catalogue values are checked against the plan §1 banned-word list (`src/shared/simple/bannedWords.ts`): voucher, ledger, journal, contra, Dr/Cr, particulars, narration, sundry, group, ITC, set-off, ageing, BRS, godown, BOM, SOA.
- Plain words for accounting terms live in `src/shared/simple/glossary.ts` (`plain(term)`, `explain(term)`).
- Amounts are formatted with `money.ts` and passed into `t()` as variables; never build a sentence by concatenation.

## The simple shell (WP 8.1)

- `SimpleHeader.tsx` / `SimpleSidebar.tsx` replace the accountant header and sidebar inside `components/Shell.tsx` when the visible screen's view is simple (`lib/mode.ts` `useScreenView`); `<main>` stays mounted, so "Accountant view" / "Back to simple" (`ViewToggle.tsx`) keep the screen's state.
- `SimpleSection.tsx` is a section's page (Sell, Buy, Money …); its entries come from the registry (`lib/screens.ts` `simpleEntries`, ordered by `SIMPLE_ENTRY_ORDER`). Registry keys are passed to `t()` on lines marked `i18n-technical`; `__tests__/simpleRegistry.test.ts` checks they are `simple.*` / `common.*` keys in the catalogue.
- `SimpleHome.tsx` is Home (WP 8.6, below). `ModeSetting.tsx` is the owner's mode switch in Settings → How Total looks.
- `SimplePlaceholder.tsx` is the generic "on its way" card.

## Save card and errors (WP 8.5)

- `SaveCard.tsx` is what a simple flow shows after a save: the sentences from `shared/simple/saveCard.ts` over `voucher:saveSummary` (figures computed by main), Print / PDF / Share, New and Undo (`voucher:undoSave`, the whole group; "Edit instead" once a voucher changed since). Phase 9 flows pass every voucher their intent saved; today the voucher editors show it after a new save while the company is in simple mode.
- Errors in a simple screen are placed with `useFormErrors(form, { simple: true, t })` and show only the plain `errors.*` text; the technical message goes behind "Details". Never a toast for an error that has a field.

## Home (WP 8.6)

- `SimpleHome.tsx` makes ONE call, `simple:home` (`services/simpleHome.ts`, shape in `shared/simple/home.ts`): money in / out today, customers owe you, you owe suppliers, cash and each bank, GST due (regular only; composition → the CMP-08 note), how the business is doing (month + FY profit), "Needs attention", what is coming up, the backup nudge and the setup facts — every figure as on today from the services the accountant screens use.
- "Needs attention" fills in after Home shows: overdue rows from the tiles' own figures (by side), the close checklist + anomalies from `simple:homeAttention`. A company with nothing recorded gets one "Nothing recorded yet" card with the next setup step.
- Each tile's "Why?" (`kit/Why.tsx`) shows a sentence from `shared/simple/explain.ts` (pure, `t()` + money.ts) and a link that says what it opens and opens THAT figure (`homeReportScreen` in `homeTasks.ts`: same date, side, period).
- `homeTasks.ts` is the one mapping for the task buttons (+ Sale, + Purchase, Money in, Money out) and the report links — Phase 9 swaps a task's `screen` for its simple flow there.
- The setup checklist labels are keyed by `onboarding.ts` step id; WP 8.7's `openings` step ("Enter what you had on day one") is a real step with its own label.

## Opening setup (WP 8.7)

- `Openings.tsx` (+ `OpeningsSteps.tsx`) is "What you had on day one": money, customers (bill by bill), suppliers, stock, then Check and confirm (the difference in one sentence from `simple:openings:preview`; saved with `simple:openings` and that figure). Field errors come from `shared/simple/openings.ts` `openingsStepErrors` by path and show under their field (`OField` reads them by `name`). `OpeningsHomeCard.tsx` is Home's setup step (progress, "I started fresh").

## Sell (WP 9.2)

- `sell/MakeBill.tsx` is Make a bill: customer (empty = the walk-in "Cash customer"), date, products (`BillLines`) or "just an amount" (`AmountLine`; the only mode with stock off), "Paid how?" (`PaidHow`), the live total and the preview line. Everything it computes comes from `shared/simple/sell.ts` (the editor's calculation); it saves only through `useSimplePost` → `simple:post`, then shows the save card.
- `sell/SalesList.tsx` is the sales list (shared `DataTable`) and, with `billId`, one bill's read-only view (Print, Record a payment, Edit in the full app). `sell/QuickBill.tsx` is the Counter screen with a plain title.
- `returns/ReturnScreen.tsx` is Return a sale / Return a purchase (`ReturnSale` / `ReturnPurchase` pick the side): which bill (`BillPicker`, the shared `DataTable` over `simple:returns:bills`), what came back (`ReturnLines`, per bill line with what is left) or an amount, a reason, and — only for the part that is not still due on the bill — money back or kept (`RefundHow`). Everything it computes comes from `shared/simple/returns.ts` (the editor's calculation over the rows `mapIntent` posts); it saves only through `useSimplePost` → `simple:post`, then shows the save card.
