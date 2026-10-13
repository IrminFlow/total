# Simple mode (`src/renderer/src/simple/`)

The screens a first-time, non-accountant user sees (plan `docs/superpowers/specs/2026-10-13-simple-for-everyone-plan.md`, Phases 8–9). They drive the same engine as the accountant view — see the plan §0.1.

## Rules (lint-checked by `src/shared/i18n/simpleLint.test.ts`)

- **Every visible string goes through `t()`** from `useT()` (`lib/i18n.ts`). No text between JSX tags, no string literal in a JSX expression, and no string literal in a user-facing prop (`title`, `placeholder`, `label`, `aria-label`, …).
  - Allowed literals: `className`, `data-*`, `aria-*` state attributes (not `aria-label` / `aria-description` / `aria-placeholder` / `aria-roledescription` / `aria-valuetext`), and technical props such as `id`, `key`, `type`, `role`, `testId`, `href`, `variant`, `size`. Extend `TECHNICAL_PROPS` in the lint when a new kit prop is technical.
  - Text with no letters (`·`, `→`, `₹`) is fine.
- **Keys come from the `simple.*`, `common.*` or `errors.*` namespaces only.** Those catalogue values are checked against the plan §1 banned-word list (`src/shared/simple/bannedWords.ts`): voucher, ledger, journal, contra, Dr/Cr, particulars, narration, sundry, group, ITC, set-off, ageing, BRS, godown, BOM, SOA.
- Plain words for accounting terms live in `src/shared/simple/glossary.ts` (`plain(term)`, `explain(term)`).
- Amounts are formatted with `money.ts` and passed into `t()` as variables; never build a sentence by concatenation.

`SimplePlaceholder.tsx` is the stand-in until the WP 8.1 shell lands.
