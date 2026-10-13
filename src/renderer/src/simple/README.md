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
- `SimpleHome.tsx` is Home until WP 8.6 (a placeholder card + the setup checklist). `ModeSetting.tsx` is the owner's mode switch in Settings → How Total looks.
- `SimplePlaceholder.tsx` is the generic "on its way" card.

## Save card and errors (WP 8.5)

- `SaveCard.tsx` is what a simple flow shows after a save: the sentences from `shared/simple/saveCard.ts` over `voucher:saveSummary` (figures computed by main), Print / PDF / Share, New and Undo (`voucher:undoSave`, the whole group; "Edit instead" once a voucher changed since). Phase 9 flows pass every voucher their intent saved; today the voucher editors show it after a new save while the company is in simple mode.
- Errors in a simple screen are placed with `useFormErrors(form, { simple: true, t })` and show only the plain `errors.*` text; the technical message goes behind "Details". Never a toast for an error that has a field.

## Opening setup (WP 8.7)

- `Openings.tsx` (+ `OpeningsSteps.tsx`) is "What you had on day one": money, customers (bill by bill), suppliers, stock, then Check and confirm (the difference in one sentence from `simple:openings:preview`; saved with `simple:openings` and that figure). Field errors come from `shared/simple/openings.ts` `openingsStepErrors` by path and show under their field (`OField` reads them by `name`). `OpeningsHomeCard.tsx` is Home's setup step (progress, "I started fresh").
