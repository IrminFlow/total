/**
 * data-testid convention (v0.3 E2E instrumentation — Lane T, task T1).
 *
 * Every load-bearing control carries a kebab-case `data-testid` following the pattern
 * `<area>-<control>`. The `<area>` segment for screen-scoped ids is the screen's registry
 * name from `lib/screens.ts` VERBATIM (e.g. `daybook`, `trial-balance`, `year-end`) — do
 * not re-hyphenate names the registry spells without a dash.
 *
 * Families in use:
 *
 *   nav-<screen>            Sidebar nav buttons (derived: 'nav-' + screen registry name,
 *                           e.g. nav-daybook, nav-masters, nav-trial-balance).
 *   card-<screen>           Gateway cards (derived: 'card-' + registry name,
 *                           e.g. card-voucher-entry, card-gstr1).
 *   tab-<screen>-<tab>      Tab bars (tab-masters-ledgers, tab-settings-backups,
 *                           tab-payroll-runs, tab-outstandings-receivable, tab-registers-sales).
 *   btn-<screen>-<action>   Primary/submit buttons (btn-masters-new-ledger, btn-gstr1-export,
 *                           btn-banking-import, btn-payroll-post-run, btn-year-end-post,
 *                           btn-company-create, btn-unlock, btn-apply-period).
 *                           Voucher saving keeps the short canonical ids: btn-save-voucher
 *                           (invoice + accounting modes) and btn-save-manufacture.
 *   picker-<what>           TypeAhead pickers, prop-driven with defaults: picker-ledger,
 *                           picker-item (override via the `testId` prop when a screen has
 *                           several, e.g. picker-party).
 *   input-<what>            Form inputs. AmountInput defaults to input-amount, DateInput to
 *                           input-date (override via `testId` when a form has several).
 *   rows-<screen>[-<sub>]   The main <tbody> of each major table (rows-daybook,
 *                           rows-ledger-statement, rows-masters-ledgers, rows-outstandings…).
 *                           Voucher entry's line grids keep short canonical ids:
 *                           rows-invoice-lines (invoice mode) and rows-voucher-lines
 *                           (accounting mode). Rows with a natural id also carry
 *                           data-row-id={voucherId|ledgerId}.
 *
 * Established by Wave 2 (keep these names, never rename):
 *   modal-close, modal-keep-editing, modal-discard   — Modal chrome (ui.tsx); the dialog
 *                                                      element itself has data-modal={title}.
 *   confirm-ok, confirm-cancel                       — ConfirmModal (dialogs.tsx).
 *   prompt-input, prompt-ok, prompt-cancel           — PromptModal (dialogs.tsx).
 *   skeleton-rows                                    — SkeletonRows loading placeholder.
 *
 * Chrome (screen-less) controls the harness drives directly:
 *   btn-theme, btn-lock, btn-switch-company   — Shell header/sidebar chrome.
 *   input-company-name                        — CreateCompanyModal's name field.
 *
 * Screen-level markers (not testids, but part of the same harness contract):
 *   <main data-screen={screen.name} data-loading="true|false">  — Shell, when a company is
 *   open; data-loading reflects react-query's useIsFetching(). CompanySelect and LockScreen
 *   roots carry data-screen="company-select" / data-screen="lock" with the same data-loading.
 */

/** `tid('nav', 'daybook')` → `'nav-daybook'`. Prefer literals at call sites; use this when
 *  composing from variables (e.g. registry-derived ids). */
export function tid(...parts: (string | number)[]): string {
  return parts.join('-')
}
