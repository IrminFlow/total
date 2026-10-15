# Total — technical state and progress: done, to do, could be done

**Date: 15 October 2026** · Code state: branch `main` at commit `401b5d9a` (after PR #114) · Version in the app: still **0.11.0**

This document is written for the owner. It explains the whole technical picture in plain words: how
Total is built, how it is tested and shipped, what has been done phase by phase, what is still open,
and what could be done next. Where a technical word is unavoidable it is explained the first time it
appears. Pointers in `code font` say where a developer would look; you can skip them.

---

## Summary

- **The planned work of Phases 1 to 10 is built and merged**, except two items you asked to hold
  back: publishing the release (WP 7.6) and the marketing-site update (WP 10.7). "Built" does not
  mean every acceptance check is met. Real beginner testing, a native Hindi review, a full check on
  a real Windows PC, the launch-speed target and some deferred test coverage are still open
  (section 4).
- 95 pull requests have been merged. The code is about 298,000 lines of TypeScript in 1,328 files,
  with about 420 automated test files and 72 end-to-end scenarios that drive the real app.
- The last public release is **v0.11.0** (13 October 2026). Everything after it (PRs #85–#114:
  the simple screens, Ask Total, Hindi, performance, Windows, security) is on `main` and **has not
  been published**.
- A local test build exists only on your Desktop:
  **`~/Desktop/Total-dev-401b5d9a.dmg`**, SHA-256
  `43965afd674c1c628fddf240b90271a255797ec3b4b22f22324fb19a88a0d3f1` (128,639,178 bytes). It still
  says 0.11.0 in About and in its file names, because the version has not been bumped. It passed the
  smoke check.
- **Final gate result:** a real v0.11.0 installation upgraded to this code with every figure the
  same, except one intended correction: GSTR-1 / GSTR-3B for "amount only" sales now carry the GST
  that was posted (details in section 4). This needs your sign-off before release.
- What stands between today and a 1.0 is mainly **people and paperwork, not code**. Your sign-off on
  changed figures and your decision to publish are required. A CA review of the tax rules marked
  UNVERIFIED, a native Hindi reviewer, real beginner testers and an Apple Developer ID are
  recommended. Which of those must come BEFORE 1.0 is your decision (document 04, section 3.6).

---

## 1. How the app is built

### 1.1 The building blocks

Total is a desktop app, like Tally, not a website. It is built from four well-known pieces:

| Piece | What it is | Why it is used |
|---|---|---|
| **Electron** | A frame that turns web technology into a Mac / Windows app (the same as Slack or VS Code). | One code base runs on macOS and Windows. |
| **React** | A library for drawing screens. | Every screen, form and table is a React component. |
| **TypeScript** | JavaScript with types: the computer checks that, say, an amount is never passed where a date is expected. | Catches whole classes of mistakes before the app runs. |
| **SQLite** | A database that is a single file on your disk. | Each business is one file you can copy, back up and keep. No server. |

The SQLite driver is now **`better-sqlite3-multiple-ciphers`** (since PR #112). It is the same
driver as before but compiled with optional encryption, so a business can be locked with a
passphrase. An unlocked business file opens exactly as before.

All data lives in `~/Documents/total/` on the Mac (`Documents\total` on Windows). Each business is a
folder there with its `company.db` file and a `backups/` folder. Nothing goes to a cloud. The only
things that can talk to the internet are optional: the update check (on by default, can be turned
off; it only asks whether a newer version exists, and nothing downloads without a click), the AI
helper (off by default; your own OpenAI key), live e-invoice filing (NIC, off by default) and links
you click.

### 1.2 The four layers

Think of the app as four floors of a building, each allowed to talk only to the floor next to it.

1. **The shared engine (`src/shared/`)** — pure arithmetic and rules: money, dates, GST
   calculation and validation, GSTR-1 / 3B builders, e-invoice and e-way bill files, posting rules,
   payroll maths, TDS / TCS rules, the stock valuation pass, the Tally XML reader, the simple-mode
   "intents" and sentences. It has no screens and no database, which is why it is easy to test:
   most unit tests live here.
2. **Main (`src/main/`)** — the "back office" of the app. It owns the database (only main may touch
   it), runs the migrations (see below), the services (masters, vouchers, reports, GST, banking,
   payroll, AI, backups, security, …) and answers requests from the screens. Every request is
   checked against a strict shape before it is acted on (this checking library is called Zod), and
   every answer is either "ok" with the data, or "not ok" with an error message.
3. **Preload (`src/preload/`)** — a thin, locked door between the screens and main. The screens can
   only call `window.total.invoke(channel, payload)`. They cannot open files or the database
   themselves.
4. **Renderer (`src/renderer/`)** — the screens you see, drawn with React and styled with Tailwind
   (a styling toolkit). It talks to main only through one typed client. It contains the shared
   table (`DataTable`, used by every list), the component kit, and the simple-mode screens in
   `src/renderer/src/simple/`.

A "channel" is the name of one request, for example `voucher:save` or `simple:home`. There are
roughly 670 of them.

### 1.3 The rules that keep the books right

These are hard rules every change must obey; tests fail if one is broken.

- **Money is whole paise, always.** ₹12.50 is stored as the integer 1250. Decimal fractions
  (floats), which computers round in surprising ways, never touch an amount. Quantities are whole
  thousandths (2.5 kg = 2500).
- **Voucher lines are the single truth.** Every report — trial balance, P&L, balance sheet,
  outstandings, GST returns, Home tiles — is computed fresh from the voucher lines and the opening
  balances each time you open it. No balance is ever stored separately, so screens that use the same
  calculation agree, and tests check the important pairs. The known small exceptions are in
  section 4d.
- **One definition of profit** (`pnlLedgerAmounts`), used by every report that shows profit.
  Income and expense accounts restart at zero each financial year.
- **One stock valuation pass** (`runInventoryPass`) that every stock figure comes from.
- **Deleting is soft.** A deleted voucher goes to the Bin and can be restored; every query skips
  binned vouchers.
- **Migrations.** When the database needs a new table or column, a numbered "migration" is added at
  the end of a list. On first open after an update, the app applies the missing ones in order. Old
  migrations are never edited. There are **52** now; v0.11.0 had 49, so opening an existing business
  in the next release applies 050 (simple posts), 051 (speed indexes) and 052 (backup checks and user
  permission flags). Going back to an older version is not supported. The older version does
  not refuse to open a newer file, but it may misread it. To go back, restore a copy you made before
  upgrading (the automatic backup on open is taken after the upgrade has run, see section 4d). A
  guard that refuses to open a newer file is proposed in section 4a.
- **The audit chain.** Every change to the books writes an audit row with the whole before and
  after (the Companies Act rule 3(1) "edit log"). Each row carries a fingerprint (hash) of the row
  before it, like links in a chain, and the database refuses edits or deletes of audit rows. If
  anyone tampers with the file, the chain no longer verifies. (It detects tampering; someone with
  the file and enough skill could rebuild the chain, so it is evidence, not a lock.)
- **Tax rules are never written from memory.** Every rate, threshold and due date sits next to the
  official text it came from; what could not be checked against an official source is labelled
  UNVERIFIED in the code.

### 1.4 How simple mode sits on top of the same books

Simple mode (Phases 8–10) is a second set of screens for people who don't know accounting. It is
**not** a second accounting system. Here is the path of a simple "Make a bill":

1. The screen collects plain answers: who, what, how much, paid how.
2. It turns them into an **intent** — a small description such as "sale to Ramesh, 2 items,
   paid ₹500 by UPI".
3. The intent goes to one channel, **`simple:post`**. Main translates it (`mapIntent`) into exactly
   the form the accountant's invoice editor would have filled in.
4. That form is saved through the **same `saveVoucher`** the accountant screens use, with all its
   checks: lock dates, credit holds, GST registration rules, stock rules, the audit trail.

So a bill made in simple mode is an ordinary sales voucher (plus a receipt if paid now) that an
accountant can open, edit and report on. Tests prove that each simple entry equals the same entry
typed by hand in the full app, and that every simple figure equals the accountant report it came
from. Every simple screen has an **Accountant view** button that opens the same work in the full
editor, and **Back to simple** returns.

A business is in simple or accountant mode (the owner chooses). Every business that existed before
0.11 opens in accountant mode, unchanged.

---

## 2. How it is tested and shipped

### 2.1 The kinds of tests

| Kind | What it checks | How many | Command |
|---|---|---|---|
| **Unit tests** (engine) | The pure rules: money, GST, intents, sentences, valuation. Fast, no database. | ~155 files | `npm test` |
| **Renderer tests** | Screens and hooks in a simulated browser: labels, keyboard, accessibility, that a field error lands on its field. | ~100 files | `npm run test:renderer` |
| **DB tests** | Services against a real scratch database: e.g. "the simple bill equals the hand-entered one", "an upgrade keeps every figure", "the audit chain verifies". Run inside Electron so the SQLite driver matches. | ~165 files | `npm run test:db` |
| **Smoke test** | Launches the built app without showing a window and runs a round trip: create a business, a ledger, a voucher, trial balance, bin / restore, backup → change → restore, an encrypted backup. | 1 script | `npm run smoke` |
| **End-to-end (e2e) scenarios** | A robot (Playwright) clicks through the real built app like a user: setup wizard, bills, bank import, GST, Hindi, security, the beginner journey. | **72** | `npm run e2e` |
| **Performance check** | A generated business with 100,000 vouchers; each report must finish within its time budget. | 1 job | `npm run perf` |
| **AI evaluations** | 100+ scored questions against a sample company with a scripted (mock) AI; a live run with a real key is manual. | 1 suite | `npm run ai:evals` |
| **Typecheck** | The TypeScript compiler checks the whole code base. | — | `npm run typecheck` |

Several "saved comparison" tests deliberately freeze old behaviour — for example the accountant sidebar as
0.10 showed it, stock values from before the valuation rewrite, and report outputs hashed from the
previous code — so that a change cannot quietly alter the accountant's view.

### 2.2 CI: what "green" means

CI ("continuous integration") is GitHub running the tests automatically on every push and pull
request (`.github/workflows/ci.yml`). The repository is public, so this is free. There are five jobs:

1. **test** (Linux): typecheck, unit, renderer and DB tests.
2. **perf** (Linux): the 100k-voucher budgets (a case fails above 150 % of its budget, scaled for the
   slower runner).
3. **smoke-mac** (macOS): build, the packaging boundary check for the MCP server, the smoke test.
4. **e2e-mac** (macOS, on pushes to main): all 72 scenarios, in India's time zone.
5. **build-win** (Windows): typecheck, all three test suites, build, the command-line tool, smoke
   against the built app and against the packaged `Total.exe`, four e2e scenarios, and the Windows
   installer with a check that the update file names it exactly.

On a push to main, "green" means all five passed. On a pull request the Mac e2e job is skipped,
so green there means four passed and one skipped. Every PR in this programme followed the same routine: an independent
reviewer tried to break it, the findings were fixed, CI went green, then it was merged, and main's CI
was watched afterwards. The last full main run before the final gate (run 38648053324, after #112)
was green on all five jobs.

### 2.3 How a release is made (not done yet for this work)

1. Move the changelog's "Unreleased" section under the new version.
2. `npm version minor` for a 0.x step (0.11.0 becomes 0.12.0), or `npm version major` for 1.0.0.
   Either bumps the version, commits and makes the matching tag.
3. `git push --follow-tags`. The tag starts `.github/workflows/release.yml`, which re-runs the tests
   on macOS and Windows and publishes the **DMG and ZIP** (Apple Silicon Mac) and the **EXE**
   installer (`Total-Setup-<version>.exe`) to the GitHub release.
4. The website's `/api/latest` and `/api/download` then point at the new version.

**Updates with consent.** Installed copies check for a newer version on launch (this can be turned
off). Nothing downloads or installs without a click: the notice offers Download now / Later / Skip
this version, then Restart to update / Install when I quit.

**Builds are unsigned.** There is no Apple Developer ID yet, so macOS calls the app "damaged"
until you clear the quarantine flag (section 7), and updates on Mac go through the download page
instead of installing in place. Windows shows a SmartScreen warning ("More info → Run anyway").
Both disappear once the builds are signed.

---

## 3. Done — phase by phase

Versions note: 0.6.0 and 0.9.0 were never tagged. Phases 2 and 3 shipped together as **0.7.0**;
Phases 5 and 6 together as **0.10.0**. Before 0.5.0 there were 0.1–0.4 (August 2026).

"WP" means work package, one planned piece of work. PR numbers are GitHub pull requests.

### Phase 1 — Foundation and UI revamp → released as 0.5.0 (7 Oct)

- **1.0** Baseline, branding, CI coverage, the plan (#12).
- **1.1** Collapsible sidebar, recurring vouchers removed (#19). **1.2** Masters shows ledgers under
  their groups (#20).
- **1.3** Income / expense ledgers open each year at zero; one definition of profit; closing
  journals flagged and read-only (#21).
- **1.4** Every voucher reopens in the form that created it — no data loss on open-and-save (#24).
- **1.5** Ledger form keeps reverse charge / ITC; NIC credentials now stored encrypted with your computer's secure storage (#22).
- **1.6 / 1.7** One shared table everywhere — sort, filter, group, saved views, export, smooth at
  50,000 rows — and every list moved onto it (#23, #26, #27, #28, #30).
- **1.8** Click a name to edit, the row for its statement (#29). **1.9** Search with typed filters
  (#25).
- **1.10** Dashboard (Gateway) (#31), print templates Classic / Compact / Modern (#32), design system
  and accessibility sweep (#33). Gate (#34).

### Phase 2 — Inventory, manufacturing, trade cycle → released in 0.7.0 (8 Oct)

- **2.1** One valuation pass for every stock figure; existing books proven to give identical results (#35).
- **2.2** Manufacture voucher with live profit (#37). **2.4** BOM versions, multi-level recipes,
  by-products, job work (#40).
- **2.3** Stock movements, stock journal, godown / batch / serial, reorder, ageing, expiry, labels
  (#38).
- **2.5** Quotations, sales / purchase orders, delivery challans, goods receipt notes, returns,
  three-way match, goods received or delivered but not yet billed (GRNI / GDNI) (#41, #43, #45, #48). Off by default.
- **2.6** Price lists, party rates, discount schemes, tax-inclusive prices, counter billing with an
  80 mm receipt (#50).

### Phase 3 — Compliance → released in 0.7.0

- **3.1 / 3.2** TDS with effective-dated, cited rates; the TDS screen (eligible, deducted, challans,
  returns) (#36, #39). **3.3** TCS (#44).
- **3.4** GSTR-9 workings, ITC-04, fuzzy GSTR-2B matching, RCM self-invoices, ITC reversal (#46).
- **3.5** NIC e-invoice / e-way client hardened against a fake sandbox — **never run against the
  real portal** (#52).
- **3.6** Fixed assets with depreciation (#42). **3.7** Payroll statutory: PF / ESI / PT / salary
  TDS / ECR (#47).
- **3.8** The hash-chained audit trail for MCA rule 3(1) (#49). Gate (#51).

### Phase 4 — Banking, receivables, cash → released as 0.8.0 (8 Oct)

- **4.1** Bank statement import (CSV, Excel, MT940, CAMT.053, pasted PDF text), learning match rules,
  cheque books, post-dated cheques, bulk NEFT / RTGS files (#56).
- **4.2** Statements, reminder letters, interest on overdue bills, credit holds with an audited owner
  override (#54).
- **4.3** Payment planning, payment runs, MSME deadlines and s.43B(h) (#55).
- **4.4** Cash-flow forecast, budgets, loans and EMI schedules, forex revaluation (#57). Gate (#61).

### Phase 5 — Optional AI assistant → released in 0.10.0 (13 Oct)

Off by default; nothing is sent until you accept a data notice and add your own OpenAI key. The AI
can read and **draft**, never post: a draft opens in the normal editor and you save it.

- **5.1** Core: provider, tools, masking of GSTIN / PAN / account numbers, settings (#58).
- **5.2** Chat panel (⌘J), "Explain this" on figures (#66). **5.3** Drafting entries from plain
  language (#69).
- **5.4** Document capture: bill photo / PDF → purchase draft; statement categorisation (#72).
- **5.5** Assistants: month-end checklist, GSTR-2B mismatches, anomalies, report from a question
  (#71).
- **5.6** Per-company memory, proposals only (#70). **5.7** MCP server for developers (#68).
- **5.8** Evaluation suite, 100+ cases (#73).

### Phase 6 — Reports and data → released in 0.10.0

- **6.1 / 6.2** Report builder, comparatives, 18 ratios, scheduled packs, pinned reports (#60).
- **6.3** Excel export everywhere, whole-books export / import, import wizard with undo, Busy and Zoho
  importers (layouts UNVERIFIED) (#59).
- **6.4** Bulk edit with undo, attachments in backups, notes and tasks (#65).
- **6.5** Group consolidation (#67). Docs (#64, #74).

### Phase 8 — Simple mode foundation → released as 0.11.0 (13 Oct)

- **8.0** Correctness in both modes: only a regular GST registration charges GST, by date;
  composition prints "BILL OF SUPPLY", unregistered prints "INVOICE"; outstandings as on today (#76).
- **8.1** Simple / accountant mode and the simple layout (#77). **8.2** Translation layer, glossary,
  banned-word check (no "voucher", "ledger", "Dr/Cr" in simple screens) (#75).
- **8.3** Setup wizard with business presets (#80). **8.4** Plain pickers, quick-create, "Did you
  mean …?", phone / WhatsApp on parties (#81).
- **8.5** Errors under the field, the save card with 24-hour Undo (#79).
- **8.6** Simple Home with "Why?" (#83). **8.7** "What you had on day one" openings, bill by bill
  (#82). Fixes / docs (#78, #84).

### Phase 9 — The simple daily jobs → on main, unreleased

- **9.1** The intent layer and `simple:post` (one transaction, safe to retry) (#85). Includes the
  Outstandings sign fix and bill-name collision fix.
- **9.2** Make a bill (#86). **9.3** Record a purchase (#87). **9.4** Money in / out / move (#88).
- **9.5** Returns (#89). **9.6** Bank (statement in, "What is this?" per line, one-sentence
  reconciliation, no AI needed) (#90).
- **9.7** Stock, stock count, made goods (#91). **9.8** People: who owes what, reminders by
  WhatsApp / SMS text (the app sends nothing), bills to pay (#92).
- **9.9** Plain reports and Taxes (three GST figures, due dates, "I've filed" with ARN) (#94).
- **9.10** Accountant-view hand-off from every simple screen (#96).
- GST correction for "amount only" bills (#93). e2e fixes (#95, #97).

### Phase 10 — Guidance, Ask Total, Hindi, polish → on main, unreleased (except 10.7)

- **10.1** Ask Total: answers "who owes me?", "kitna profit hua is mahine", or opens a pre-filled
  form — with **no AI key and no internet**; it asks "Which Ramesh?" instead of guessing (#98).
- **10.2** "Why?" on every Home / Reports / Taxes figure (#99).
- **10.3** First-run tour, empty screens that teach, offline help (16 articles) (#100).
- **10.4** Hindi and Hinglish for all of simple mode, Hindi prints with a Devanagari font, amount in
  words in lakh / crore — **machine-drafted, pending native review** (#105).
- **10.5** Keyboard, screen readers, small windows (#103). **10.6** The AI helper in plain words
  (#101, #102).
- **10.7** Site and messaging — **deferred on your instruction**.
- **10.8** Beginner study (a scripted proxy of six personas until real testers are found) and the
  fixes it found; e2e 60 is the whole "no ledger knowledge" journey (#111).
- **Gate polish** from the final first-run drive: Ask Total stock answers, round-off as a "Rounding"
  line, opening stock asks the selling price, plain Backups without a file path, local-time backup
  names, language fixes (#114).

### Phase 7 — Hardening → on main, unreleased (except 7.6)

- **7.1** Performance: 100k / 500k test businesses, time budgets, new indexes, background checks, a
  CI perf job (#104). Launch to Home at 100k went from 9.7 s to 6.5 s.
- **7.2** Security: optional passphrase lock (the file is encrypted), every backup checked to really
  restore, screen lock (⌘L) and idle auto-lock, per-person switches (can post / see profit / export /
  manage AI) (#112).
- **7.3** Windows parity: every suite on Windows CI, the installer renamed so Windows auto-update
  works (0.11.0's asset name broke it), Tally "Unicode" files, reserved names like CON / NUL, file
  locks (#109).
- **7.4** An e2e scenario for every feature (66–72 added), zero-flake runs (#110).
- **7.5** Docs: changelog, AI & privacy page, migration guides, features list (#106).
- **7.6** Publish 1.0 — **deferred on your instruction**.
- **7.7** `to-do.md` and triage of old PRs (#113).
- Also merged: year-end and lock fixes (#107) and the consent-first updater (#108).

### What the final gate checked (15 October)

The real **v0.11.0** release was installed into a scratch folder, two businesses were made in it
(the demo and an "Upgrade Co"), then they were opened with the new packaged build:

- Migrations 49 → 52 applied cleanly; database integrity and foreign keys OK.
- Both opened in accountant mode with the sidebar identical to 0.11.
- Demo Traders: **0 differences** across 52 result sets (TB, BS, stock, outstandings, P&L, GSTR-1 /
  3B from April 2025 to October 2026).
- Upgrade Co: everything identical **except** GSTR-1 / 3B for September and October 2026, the
  intended #93 correction (section 4).
- The audit chain verified after the upgrade; no console errors.
- Lock with a passphrase, quit, reopen, wrong passphrase refused, right one opens with identical
  figures; lock off again; a pre-lock backup restored and checked.
- e2e 60 (the whole beginner journey in Hinglish) passed on the packaged app: 115 clicks, 0 errors.
- A first-run drive through 31 simple screens: 0 banned words, 0 console errors. Its findings were
  fixed in #114 and the DMG on your Desktop was rebuilt from `401b5d9a`.

Not verifiable here: your own real books (`~/Documents/total` on this Mac has no businesses), the
Windows packaged app beyond CI, signed updates, the quality of the Hindi.

---

## 4. To do

`to-do.md` at the repo root holds 180 items in eight sections. This is the summary.

### 4a. Needs your sign-off or decision

**Figure and rule changes to approve before the next release:**

1. **#93 — GST on "amount only" bills.** A sale typed as a Sales ledger line plus CGST / SGST lines,
   on a Sales ledger with no GST rate, used to appear in GSTR-1 / 3B as nil-rated with ₹0 payable,
   even though the tax was in the books. Now it is reported at the rate the posted tax implies. In
   the gate's Upgrade Co, GSTR-3B September 2026 moved from ₹0 to ₹20,000 taxable and net payable
   ₹250 CGST + ₹250 SGST; October ₹5,000 taxable and ₹125 + ₹125. **Anyone who filed from Total's
   returns for such bills on 0.11.0 or earlier should check those months with their CA.**
2. **#85 — Outstandings with advances.** An advance, or a return's own bill, now counts as the
   party's credit. Books without such references are unchanged.
3. **#94 — Due dates.** Quarterly GSTR-3B 22nd / 24th by state; PMT-06 the 25th; CMP-08 the 18th;
   GSTR-4 30 June; **TDS for March deductions 30 April** (was 7 April).
4. **#107 — Binning a closing journal moves the period lock** back to the day before that year.
5. **#112 — New database driver** for every business file (figures identical in the upgrade test).
6. Older ones still awaiting a CA's nod: GSTR-3B blocked-credit rows per Circular 170, payroll
   rounding changes, TDS thresholds updated by migration 020, and year-end close moving only ledger
   P&L.

**The plan's decisions (defaults already taken, in brackets):**

| | Decision | Default taken / proposal |
|---|---|---|
| D1 | WP 8.0 correctness fixes change behaviour in both modes | Yes; old vouchers round-trip unchanged |
| D2 | Mode of the sample company and new companies | Simple, with a "show the full app" choice |
| D3 | Who may switch a company's mode | Owner only |
| D4 | Bundle the official HSN / SAC list for search | Not bundled; the user picks the rate |
| D5 | Recruit 5+ real beginner testers | You recruit; a scripted proxy stood in. Before or after 1.0 is open (doc 04, 3.6) |
| D6 | Native Hindi / Hinglish reviewer | Machine-drafted text shipped with a warning in Settings. A "beta" label on Hinglish is a proposal, not in the app today |
| D7 | Phase 7 hardening is required for 1.0 | Yes. The Phase 7 packages are done; some outside-review items remain open (doc 04, 3.6) |

Smaller open choices are in `to-do.md` section 1: how to cost a sale made before its purchase is
recorded (today: warning only), a downgrade guard before 1.0, whether to delete two old superseded
local branches and three old GitHub branches, whether to show AI cost in rupees by default, and a
few more.

**Things only you can supply:** an OpenAI key (only mock AI runs so far; the default model names
are unverified), NIC sandbox credentials, an Apple Developer ID, a Windows signing certificate, a
real Windows PC for the checks CI can't do, a native Hindi speaker, five or more real first-time
users, a CA (and a payroll adviser) for the UNVERIFIED rules, real exports from Tally / Busy / Zoho /
Marg, and account housekeeping (GitHub Actions artefact storage was full; the CodeRabbit free plan
reviews one PR an hour; Vercel twice reported the account "blocked" on preview deploys).

### 4b. Deferred on your instruction

- **WP 7.6 publish:** bump the version (the plan calls it 1.0.0; you decide), tag, let the release
  workflow publish DMG / ZIP / EXE, edit the release notes, confirm `/api/latest`, and test an
  in-place update from 0.11.0. A draft of the release notes exists in the orchestrator's notes
  (`~/.claude/total-orch/release-notes-next-draft.md`).
  **Before tagging, the changelog needs finishing:** its "Unreleased" section describes #85–#106 and
  #114 but has no entries yet for #104 (it still says "open"), #107, #108, #110, #111 and #112.
- **WP 10.7 site:** reposition the site toward "easy books", and correct the FAQ line "nothing
  leaves the machine", which is not true once AI, capture or live NIC is turned on.

### 4c. Open dependency PRs (Dependabot) and why they wait

Dependabot is GitHub's robot that proposes library upgrades. Six PRs are left open on purpose:

- **#3 Electron 37 → 43** — a major jump that fixes about 50 security alerts. It needs its own work
  package: rebuild the encrypted SQLite driver for the new Electron, full e2e on Mac and Windows,
  and an install check of the DMG and EXE.
- **#7 and #14 vitest 3 → 5** (the test runner) — also major; the DB tests' special Electron set-up
  must be re-proven. The critical alert it fixes is in a development-only tool.
- **#63 Next.js, #16 sharp, #13 source-map-js** — all in the marketing site, which is on hold.

Six others were closed as superseded by a lockfile update in #112. Three alerts (sprintf-js,
http-cache-semantics, extract-zip) have no published fix yet.

### 4d. Known gaps and bugs

None of these blocked the gate. The full list (with file pointers) is `to-do.md` section 4.

- **Simple mode.** Mostly small: a few wording and rounding cases in Money / Buy; Bank has no Undo
  on a done line and no GST question for bank expenses; Stock has no reorder or recipe editor; People
  doesn't show balances for parties under imported group names like "Trade Receivables"; the
  hand-off doesn't carry edits back from the full editor; after "I've filed", Home's GST tile still
  shows the amount; QRMP (quarterly) filing preparation is full-app only; Ask Total misses payroll /
  TDS questions; the Quick bill screen is still English; viewers now get a note instead of Save in the main simple flows (#111), but a few
  other forms may still show Save and then refuse; a photo of a bill needs an AI key.
- **Accountant app.** Credit hold doesn't cover restoring a binned invoice; the cheque register is
  empty for pre-0.8 cheques; e-invoice original-bill lookup can pick the wrong year's bill; fixed
  assets lack partial disposals and GST on sale; TCS 206C(1G) / (1C) not modelled; some exports have
  no save dialog.
- **GST / tax design.** Old returns read today's masters (changing an item's rate can change an old
  return — should snapshot tax facts per bill); tax rounding differs slightly between the bill and
  the return (paise); an IRN doesn't freeze the invoice; e-invoice applicability needs a business
  profile; MSME deadlines run from the bill date instead of acceptance.
- **Windows.** The installer, SmartScreen, in-place update, printing, HiDPI, Hindi fonts and OneDrive
  folders need a real PC; only four e2e scenarios run on Windows CI.
- **AI.** Its number check matches amounts but cannot prove sign or period; never run against a live
  model.
- **Performance.** Launch to Home is 6.5 s at 100k vouchers against a 2 s target; at 500k some
  reports exceed 3 s on this 8 GB laptop; voucher text search needs a full-text index.
- **Security.** Attachments, capture files, exports and logs are not encrypted by the lock; the
  command-line tool and MCP refuse a locked business; no "remember on this Mac"; the screen sandbox
  in Electron is off and IPC doesn't check which window sent a request; deleting a voucher writes its
  audit row just outside the same transaction; a business migrates before a pre-upgrade snapshot is
  taken.
- **Tests.** A few e2e scenarios may misbehave near 1 April (financial-year boundary); no live AI or
  NIC runs; no test of an interrupted multi-step upgrade.

### 4e. UNVERIFIED tax points (for a CA)

Each is labelled UNVERIFIED in the code with what it was read from. In short:

- GST slabs for 2025 / 2026, services' rates after 22 Sep 2025, cess ending, HSN → slab mapping.
- GSTR-1 due-date amendments and IFF; quarterly 3B for state code 97; the PMT-06 amount.
- TDS deposit dates under the Income-tax Rules 2026; TDS rounding, 194Q, 194N, senior-citizen age;
  26Q / Form 16A layouts.
- TCS details (GST in the base, collectee codes, timing).
- ARN format; GSTR-2B JSON field names; s.16(4) date; GSTR-9 / ITC-04 / IMS layouts are the app's own.
- e-invoice schema details and NIC headers (never tested on the portal).
- Payroll: the new EPF ceiling of ₹25,000 from 17 Sep 2026, ESI ceilings under the Code, PT slabs
  for some states, gratuity and bonus caps.
- Fixed-asset lives, MSME bank-rate history, receivables interest GST, forex / EMI conventions,
  consolidation simplifications, audit-trail retention wording, Busy / Zoho file layouts.

---

## 5. Could be done

Rough effort for one experienced developer working with the current agent set-up; "days" are working
days and assume no surprises.

| Idea | What it gives | Effort |
|---|---|---|
| **Code signing + notarisation (Mac)** | No "damaged" warning; updates install in place after the user approves. | 1–2 days once you have an Apple Developer ID ($99/year) |
| **Signed auto-update** | Follows from the above: electron-updater installs in place. | Included in signing, plus one test release |
| **Windows release** | The EXE is already built and smoke-tested; needs a signing certificate and a real-PC test pass. | 2–4 days plus certificate |
| **Linux build** | An AppImage / deb from the same code; CI already runs on Linux. | 2–3 days (packaging, fonts, keyring) |
| **Electron upgrade (PR #3)** | Clears ~50 security alerts. | 2–3 days |
| **Sandbox + IPC sender checks** | Stronger Electron hardening from the review. | 2–4 days |
| **Tax-fact snapshots per bill** | Old returns never change when a master changes. | 1–2 weeks (migration + all return readers) |
| **NIC live run** | Real e-invoice / e-way filing, out of "experimental". | 3–5 days once sandbox credentials exist |
| **Native Hindi review** | Trustworthy Hindi; the machine-drafted warning can go. | Reviewer time ~1 week; code changes 1–2 days |
| **More languages** (Gujarati, Marathi, Tamil …) | The translation system is ready; each needs a catalogue, fonts for prints, help articles. | ~1 week per language plus a reviewer |
| **Opt-in backup sync** (iCloud Drive / Google Drive / a USB copy) | Protection against a lost laptop. Backups are already self-checking; copying them elsewhere, encrypted, is simple. | 1 week |
| **Multi-device (two computers, one business)** | Real sync with conflict handling. A large change to the "one file" model. | 2–3 months |
| **Mobile companion** | A phone app to see figures, snap bills, record cash. Needs sync first. | 3–6 months after sync |
| **WhatsApp Business API** | Send reminders / bills from the app instead of copying text. Needs a Meta business account and breaks "nothing is sent". | 2–3 weeks |
| **Bank feeds** | Statements arrive automatically (Account Aggregator framework). Regulated; needs a licensed partner. | 1–2 months plus partner |
| **Performance beyond 500k vouchers** | Full-text search, streaming valuation, faster launch (one Home query). | 2–3 weeks |
| **Launch under 2 s** | Merge the Gateway's reads, defer the open backup. | 3–5 days |
| **Plugin / MCP ecosystem** | The MCP server already exposes read and draft tools; packaging it for non-developers and documenting it. | 1–2 weeks |
| **Independent accessibility audit** | A professional screen-reader and contrast audit; automated sweeps already pass. | External audit + 1 week of fixes |
| **Encrypt attachments / exports, remember passphrase** | Closes the security gaps above. | 1 week |
| **Real beginner study** | Real people instead of scripts; the measuring tools exist. | Your recruiting time + 1 week of fixes |

---

## 6. Health numbers

| Measure | Value |
|---|---|
| TypeScript code (lines, `.ts` + `.tsx`, tracked files) | **297,896** in 1,328 files |
| Database migrations | **52** (v0.11.0 had 49) |
| End-to-end scenarios | **72** (`scripts/e2e/01-…` to `72-…`) |
| Test files | ~**420**: ~255 unit + renderer, ~165 DB |
| IPC channels (requests the screens can make) | about **670** |
| Pull requests merged | **95** (of 114 opened; 6 Dependabot PRs left open on purpose) |
| CI jobs per push | 5 (Linux tests, perf, Mac smoke, Mac e2e, Windows) |
| Speed at 100k vouchers | main reports within 1 s budgets; launch → Home 6.5 s |
| Last public release | v0.11.0, 13 Oct 2026 |
| Local test build | `Total-dev-401b5d9a.dmg`, 128.6 MB, not published |

---

## 7. How to run it

### 7.1 As a user (the test build on your Desktop)

1. Double-click **`~/Desktop/Total-dev-401b5d9a.dmg`** and drag **Total** into Applications
   (replace the old one if asked).
2. Because the build is unsigned, open Terminal and run once:

   ```bash
   xattr -cr /Applications/Total.app
   open /Applications/Total.app
   ```

3. With no businesses yet, the setup wizard appears. Choose a language, answer the questions, or try
   "Try with sample data".
4. **Where your data lives:** `~/Documents/total/companies/<business name>/company.db`, with backups
   in the `backups` folder next to it.
5. **Backing up:** Total backs up automatically when you open a business and every 30 minutes,
   and checks that each backup really restores (Home says "checked OK", or shows a red card). For
   a manual one: Settings → Backups → Back up now. To protect against losing the laptop, copy the
   whole `~/Documents/total` folder to a pen drive or another disk now and then. If you turn on the
   passphrase lock, a single backup file is not enough to recover: copy the whole business folder
   (it holds the key), or export the portable `.totalbak` and keep its own passphrase separately. **Before opening
   real books in a new build, take a backup** — going back to an older version is not supported.
6. If you turn on the passphrase lock, **write the passphrase down**: nobody, including Total, can
   open the books without it. Save the recovery copy it offers.

### 7.2 As a developer

Needs Node 22 and npm, on a Mac (or Windows).

```bash
git clone https://github.com/IrminFlow/total.git && cd total
npm ci                                                    # install; rebuilds the SQLite driver
npx @electron/rebuild -f -w better-sqlite3-multiple-ciphers   # only if NODE_MODULE_VERSION errors
npm run dev                                               # the app with live reload
npm test && npm run test:renderer && npm run test:db      # the three test suites
npm run build && npm run smoke && npm run e2e             # build, smoke, the 72 scenarios
npm run build:mac                                         # DMG + ZIP in dist/
```

Point the app at a scratch folder instead of your real books with
`TOTAL_DATA_DIR=/some/scratch TOTAL_SUPPRESS_SYNC_WARNING=1`. If a shell has `ELECTRON_RUN_AS_NODE=1`
set (agent shells often do), run smoke / e2e with `env -u ELECTRON_RUN_AS_NODE`. The project guide
for developers is `CLAUDE.md`; the open list is `to-do.md`; the feature list is `docs/features.md`.

---

## Where to read more

- `CHANGELOG.md` — what changed per version, in plain words first.
- `to-do.md` — the 180 open items in full.
- `docs/features.md` — every feature, simple and accountant.
- `docs/ai-and-privacy.md` — exactly what can leave the computer, and when.
- `docs/security/encryption-at-rest.md` — the passphrase lock design.
- `docs/perf-budgets.md`, `docs/windows.md`, `docs/e2e-coverage.md`,
  `docs/beginner-study-2026-10.md` — performance, Windows, test coverage, the beginner study.
- `docs/superpowers/specs/` — the two master plans (Phases 1–7 and 8–10).
