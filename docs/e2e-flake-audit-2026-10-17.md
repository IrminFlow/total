# E2E flake audit — 2026-10-17 (WP 7.4)

Main at f4f37251, built `npm run build`, `TZ=Asia/Kolkata`, `env -u ELECTRON_RUN_AS_NODE`, 72 scenarios.
The laptop is shared, so each run waited for 1-minute load < 15 and no other `run-e2e.mjs`; the three
runs were therefore three separate `run-e2e.mjs` invocations (one per repeat) rather than one
`--repeat 3`, so the wait could happen before each. Flaky = passed in one run, failed in another
(computed from the three `results.json`; no `summary.json` since there was no single invocation).

## Three full runs

| Run | Load (1 min) at start | Result | Wall time | Failures | "did not close within 20 s" |
|---|---|---|---|---|---|
| 1 | 6.17 | 71/72 | 58.8 min | 37-report-builder | 2 (54-buy, 56-returns) |
| 2 | 11.58 | 70/72 | 40.1 min | 12-theme-a11y (5-min runner cap), 37-report-builder | 0 |
| 3 | 11.99 | 71/72 | 20.8 min | 37-report-builder | 0 |

Other agents kept the machine at load 20-60 during runs 1 and 2 (15-min load at start of run 1 was 49), which
is why wall time varied 3x. Run 3 is the closest to a quiet machine.

## Findings

1. **37-report-builder — failed in all three runs (deterministic regression, not a flake).** Pack files are now
   named `NN-<report title>.pdf` (`packFileBase`, #150 "pack file names"), but the scenario still looked for
   `sales-by-party-by-month.pdf`. Fixed in the scenario: it matches `\d\d-Sales by party by month.pdf`.
   Passes 5/5 (13.9-15.9 s).
   Update: main fixed the same regression meanwhile (#154, a title-based regex); this PR dropped its duplicate
   fix and keeps main's version of the scenario.
2. **12-theme-a11y — 127 s / 300 s (killed by the runner) / 116 s.** Not a race: one scenario did the
   whole classic sweep (every sidebar screen x 2 themes, 12 Tab stops + Options drawer each) AND the whole
   simple-shell sweep (WP 10.5, 4 theme/size combinations + toast layout), about two minutes of work on a
   quiet laptop and over the 5-minute cap at load 20+. Fix without touching any timeout: split the
   simple-shell half into its own scenario, `73-a11y-simple-shell` (same checks, same helpers); 12 keeps the
   classic sweep. Matrix row 10.5 and `timings.json` updated. 5/5 each: 12 takes 59-63 s, 73 takes 24-31 s.
3. **"did not close within 20 s" — 54-buy and 56-returns in run 1 only.** Both scenarios finished and passed;
   the harness killed the app after the 20 s bound. Both happened while run 1 was the slowest (54-buy took 103 s
   vs 15 s on a quiet machine), the close path on quit runs `backupOnQuit` (a synchronous snapshot) and
   `closeCurrentCompany` in main. No code race was found: 0 occurrences in 10 further runs of 54 and 56 at
   load < 7, and 0 in runs 2 and 3. Treated as load-induced; the 20 s kill remains a bounded fallback and
   no scenario result was affected. Watch for it if it ever appears at low load (then profile `backupOnQuit`).

No sleeps, retries or timeouts were added or raised.

## Verification of the fixes

`node scripts/run-e2e.mjs 37 12 73 54 56 --repeat 5` (load 4.56 at start): 5/5 runs all pass, 0 close messages.

## Slowest scenarios

Run 3 (quietest): 12-theme-a11y 116 s (now ~60 s after the split, 73 ~25 s), 31-banking-depth 40 s,
33-payables 34 s, 41-ai-drafting 33 s, 45-ai-capture 32 s, 39-ai-chat 32 s, 35-ai-core 32 s,
30-audit-trail 32 s.
Run 1 (loaded): 12 127 s, 67-year-boundary 104 s, 54-buy 103 s, 65-security 98 s, 60-ask-total 97 s,
41-ai-drafting 89 s, 44-ai-assistants 86 s, 35-ai-core 86 s.
