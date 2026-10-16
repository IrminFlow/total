# Total — open items (to-do)

Compiled for WP 7.7 on 2026-10-15 from the orchestration notes, the PR bodies (#85–#112), the
review findings, CHANGELOG.md "Unreleased" and the UNVERIFIED lists in the source. Items already
done on main were dropped. One line each; the pointer says where to look.

## 1. Owner decisions needed (the default already taken is in brackets)

- D1: WP 8.0 correctness fixes change behaviour in both modes [yes — existing vouchers round-trip unchanged] — plan §D1, `docs/superpowers/specs/2026-10-13-simple-for-everyone-plan.md`
- D2: mode of the sample company and of new companies [simple for both; "show the full app" in setup] — plan §D2
- D3: who may switch a company's mode [owner only; anyone may open the accountant view per screen] — plan §D3
- D4: HSN search needs a bundled CBIC HSN / SAC list [not bundled; code-only field, the user picks the slab] — plan §D4, `src/shared/gst/rateTable.ts`
- D5: recruit 5+ real beginner testers [owner recruits; the scripted proxy study stood in] — plan §D5, PR #111
- D6: Hindi / Hinglish by a native reviewer [machine-drafted text shipped; Hinglish may ship as "beta"] — plan §D6, PR #105 (28 unsure phrases listed)
- D7: Phase 7 hardening items from the GPT review are prerequisites for 1.0 [yes] — plan §D7
- Selling before the purchase is recorded costs the sale at ₹0 (negative stock): re-cost from the next purchase (engine change, opt-in per company) or block / warn hard in simple mode [warning only, WP 10.8] — `src/shared/valuation.ts`
- Change price when there is no default price level but a non-default "Selling price" level exists: which level becomes the default [the row lands on that level; walk-in bills don't read it] — PR #91, `services/simpleStock.ts`
- Binning a closing journal moves the lock to the day before the reopened year; store the earlier lock instead? [not stored; the confirm says so] — PR #107
- Backup verification on open could move after the open reply (changes audit-row order) [not moved] — PR #104
- AI cost is shown in US dollars unless the company has a USD forex rate: set a default rate? [no default] — PR #101
- Product "usual cost" (`standard_cost_paise`) is stored but read by nothing: use it for purchase prefill? [no] — WP 8.4, `services/quickCreate.ts`
- No tour for existing / full-form companies [run it from Help or Settings only] — PR #100
- ~~Downgrade 0.11 → 0.10 is not blocked: add a schema-version guard before 1.0?~~ DONE — `db_newer_version` guard + pre-upgrade copy (protects files from 1.0 on; 0.11.0 can't be changed) — PR #116
- Old local branches `perf-lane-work` (104 commits, reports paging) and `worktree-agent-acf44857d65a8b1ae` (80 commits, counter / borrowing) fork from 0.4.0 and are superseded: delete them? [kept] — local repo only
- Closed old PRs #1, #2, #4 left their branches on GitHub (`t3code/revamp-ledgers-shortcuts[-1]`, `v5-cloud-agent-sync`, `pr-2-roadmap-complete`): delete? [kept for reference] — WP 7.7
- Releases v0.6.0 and v0.9.0 were never tagged (the changelog jumps): leave as is? [leave] — `git tag`

## 2. Owner sign-off on figure / rule changes (before publishing the next release)

- #85 Outstandings sign fix: advances and a note's own bill now count as named credits, so existing books with advances or own-bill notes show different outstandings — `src/shared/outstanding.ts`
- #93 GSTR-1 / 3B / 9 / HSN / e-invoice take an amount-only bill's rate from its posted tax; the gate's upgrade check moved a test company's Sep–Oct net payable 0.00 → 750.00 (intended) — `src/shared/gst/postedRate.ts`, upgrade-report-0.12.0
- #93 side effect: receivables interest on an amount-only bill now carries the bill's real GST rate (believed correct, not pinned by a test) — `services/receivables.ts`
- #94 due dates changed in both modes: quarterly GSTR-3B 22nd / 24th by state, March TDS 30 April (was 7 April), PMT-06 25th, CMP-08 18th, GSTR-4 30 June — `src/shared/compliance.ts`, `src/shared/gst/filing.ts`
- #107 binning a closing journal moves the period lock (see section 1) — `services/yearEnd.ts`
- #112 new database driver (SQLCipher-scheme build of the SQLite driver) for every company file, locked or not — PR #112, `docs/` security notes
- WP 3.4 GSTR-3B 4(A)(5) / 4(B)(1) / 4(D)(1) treatment per Circular 170 (a behaviour change) — `src/shared/gst/returns.ts`
- WP 3.7 payroll behaviour changes: EPF rupee rounding, ESI on Code wages — `src/shared/payrollStatutory.ts`
- Upgrade 0.5 notes: TDS section thresholds in old columns now reflect current dated rates (194J / 194I / 194H / 194A) — migration 020
- Year-end close moves ledger P&L only; the stock part of profit stays as the balance-sheet "Profit & Loss A/c" line (CA to confirm acceptable) — `services/yearEnd.ts`

## 3. Things only the owner can supply

- OpenAI API key for a live AI run (only mock runs so far; default model ids `gpt-6.1-sol` / `gpt-6-luna` unverified) — `npm run ai:evals -- --live`, workflow `ai-evals.yml` secret `OPENAI_API_KEY`
- NIC e-invoice / e-way sandbox credentials (the client has never talked to the real portal) — `src/main/services/nic.ts`
- Apple Developer ID certificate (`CSC_LINK` / `CSC_KEY_PASSWORD`) for signed, silently updating macOS builds — `release.yml`, `src/main/updater.ts`
- A Windows code-signing certificate (SmartScreen warning until then) — PR #109
- A real Windows machine for the checks CI can't do (section 4, Windows) — PR #109
- A native Hindi speaker (and a second reader) for the catalogues, help and prints (D6) — `src/shared/i18n/`, `GLOSSARY-hi.md`
- Five or more real first-time users per preset (D5) — `~/.claude/total-orch/study-10.8/`
- A CA (and an HR / payroll adviser) to review the tax rules marked UNVERIFIED (section 5) and the CA review lists of WP 3.1–3.7, 4.4
- Consented real exports from Tally / Busy / Zoho / Marg for importer fixtures — `src/shared/dataImport/`
- Account housekeeping: GitHub Actions artifact quota was full (uploads are failure-only now); CodeRabbit free plan reviews 1 PR / hour (upgrade or disable); Vercel twice reported the account "blocked" on preview deploys
- Advise users: backups taken before 0.5.0 hold NIC secrets in plain text — take a fresh backup and delete the old ones

## 4. Known bugs / limitations by area

### Simple mode
- Buy's "just an amount" bill with GST rounds to the rupee; it could send the printed `billTotal` like Money out does — PR #88, `simple/buy/`
- Money list names the supplier, not the category (e.g. Electricity), for an expense paid with a GST bill — PR #88 / #111, `services/simpleMoney.ts`
- ~~Money list stops at the working date, so an entry dated up to +30 days ahead isn't listed until then~~ DONE — lists up to the working date + 30 days with a "Dated ahead" chip (PR #121) — PR #88
- Expense tiles include "Purchases", "Raw material purchases", "Discount given"; paying "Purchases" from Money out books no goods — PR #88, `shared/simple/categories.ts`
- A refund from a supplier who owes you nothing is accepted silently (raises what you owe) — PR #88
- GST-bill expense preview says "Purchase bill …" even for rent or electricity — PR #88
- Two open bills with the same name (different years) tick together in Money in / out; a later bill can reuse an older settled credit's name — PR #88 / #89
- Refund TO a customer (money out against their credit) outside a return isn't offered — PR #88
- Bank: "Do you have a GST bill?" not asked for bank expenses; bank charges incl. GST not split for a regular registration — PR #90
- ~~Bank: no Undo / "Not this" on a Done line (unmatch in the full app); a skipped line isn't remembered after refresh; after "Pick the bills yourself" the user must go back to Bank themselves~~ DONE — "Not this" (the full app's unmatch), skips remembered on this computer under "Skipped for now", "Back to Bank" (PR #121) — PR #90
- Bank: the sentence doesn't compare the statement's own closing balance with the books — PR #90
- Stock: ~~no reorder-level editor~~, no recipe editor; counts go to the default stock place (needs a per-place count rule in the valuation engine first — a count line pins the item's whole quantity whatever place it names, `stockAnalysis.stockByGodown` KNOWN LIMITATION; asking "Which place?" would set the product's total to one place's count); ~~history rows don't open the entry~~ DONE — PR #124 ("Tell me when it runs low" on the product view; History rows open the bill / return / saved count, else the full app) — PR #91
- Stock: a count of a never-stocked product is valued ₹0; ~~reopening a saved count shows difference 0; Undo of a count / batch after later sales can leave stock negative~~ DONE — PR #124 (the saved count shows the engine's difference; Undo is refused when it would leave a product below zero; the full Physical Stock editor's "Book qty" on an alteration still includes the entry — PR #122 holds that file) — PR #91
- People: parties under imported group names (e.g. "Trade Receivables") show no balance (Outstandings counts only Sundry Debtors / Creditors; accountant screen too) — PR #92
- People: viewers see the statement only through History; reminder cadence is shown, not enforced — PR #92
- People: reminder_log has no WhatsApp / SMS channel (logged as `phone` / `other`, detail in the audit row) — needs a migration, PR #92
- ~~Returns: the bill card doesn't show the bill's own note; the purchase-return picker's empty state looks only at the last 12 months~~ DONE — note on the card, "Search older bills" (PR #121) — PR #89 / #100
- Hand-off: edits in the full editor aren't carried back; a "paid now" payment / refund isn't in the handed-off editor; ~~People / Reports / Taxes have no Accountant-view button~~ DONE — PR #122 — PR #96
- Hand-off review: ~~refused answers → blank editor after a discard prompt; Cancel returns to an EMPTY simple form; walk-in hand-off leaves the customer empty; missing GST / round-off accounts show empty rows; Reports / Taxes Accountant-view lack the "Always" menu; palette search results still titled "Ledgers" / "Vouchers"~~ DONE — PR #122; switching company with unsaved editor changes keeps the old stack (the kept answers are dropped on the switch since #122) — shots-96
- ~~Taxes: after "I've filed", Home's GST tile and the Gateway 3B chip still show the period's amount / date~~ DONE — PR #119 (the tile moves on to the running period) — PR #94
- Taxes: quarterly (QRMP) file preparation and the PMT-06 amount are full-app only — PR #94
- Home: "entries added for an earlier, closed date" also fires for ordinary entries 30 days late; one-column profit "Purchases" includes direct expenses (freight, wages) — PR #94
- ~~Why?: no link on composition / PMT-06 dates; no Why on Bills to pay "due this week"; one Why per by-month chart~~ DONE — Home's composition / PMT-06 Why opens Taxes, Bills to pay tiles and each month explained — PR #120. Still open: advance tax has no link (Total doesn't work it out); quarterly filers' GSTR-1 / 3B links open the quarter's first month; the Taxes screen's own CMP-08 / GSTR-4 / PMT-06 Whys have no link (it would open the same screen) — PR #99
- Ask Total: ~~drafts stay open until discarded in Settings → AI drafts~~; "5000 Ramesh" (no verb) gets "try these" instead of asking in / out (fixed in WP 10.8, the `direction` intent); ~~payroll / TDS amount / bill-by-number questions not understood; an Ask Total draft opened from Settings opens the accountant editor~~ DONE — PR #125 — PR #98
- Tour card can cover part of Home under its anchor; ~~help-link params (`filter=`, `tab=`) aren't validated per screen~~ DONE — `SCREEN_LINK_PARAMS`, unknown ones dropped (PR #121) — PR #100
- ~~Viewer sees Sell / Buy forms and Save, then a generic "no permission"; sidebar "Back up now" shown to a viewer~~ DONE — PR #119 (note at the top of each form, no Create / Add-account buttons, a note instead of Back up now) — shots-86 / PR #111
- ~~Sell: "Prices include GST" doesn't convert already-typed prices; a failed Print shows no message~~ DONE — PR #119 (Make a bill and Record a purchase); still open: supplier / customer with no credit days is overdue the next day (consider "no due date = not overdue") — shots-86 / shots-87
- Purchases: s.17(5) blocked ITC counted as claimable; reverse charge / ITC eligibility only in the accountant view — PR #87
- Opening products get the slab list in force on the books-begin date (pre-22 Sep 2025 books still offer 12 % / 28 %) — PR #111
- Beginner study leftovers: no photo option without an AI key; restaurant UPI settlement has to be "other money in"; a cash expense in Record a purchase needs a supplier; no polite pre-due reminder — PR #111
- Toasts can briefly cover Save; at 1700 px a toast covers docked Ask Total's question box; DataTable truncates names at 1024 px — PR #87 / #103
- ~~Dark mode: the selected + disabled walk-in "Cash" chip is hard to read~~ DONE — PR #119 — PR #111
- Hindi: ~~dates inside a few main-side error messages, wizard state names~~, preset account names, ~~the PDF footer "Page 1 of 1"~~, reminder-letter bodies (owner's template) stay English; ~~bank suggestions use the company language, not the reader's~~ — PR #105 (struck parts DONE — PR #123; "Hinglish (beta)" label ready behind `HINGLISH_BETA_LABEL`, off)
- AI helper: a company without sign-ins (while another has them) shows "anyone can change the key" before main refuses; payment draft prefill treats a non-party debit account as an expense without checking its class — PR #101

### Accountant (full app)
- ~~Credit hold doesn't cover restoring a binned invoice or automatic PDC maturing~~ DONE — restore of a held party's invoice / challan needs the owner's override; maturing a cheque never creates credit, a post-dated invoice to a held party waits (`blockedByHold`) — PR #126
- Cheque register is empty after upgrade (old instrument numbers not backfilled); ~~cash forecast ignores pending post-dated cheques~~ DONE — option, off by default — PR #126; ~~ledger form has no credit-hold control~~ DONE — PR #126 — WP 4.4 upgrade check
- Companies that closed a year on 0.4.0 show a permanent "Profit & Loss A/c (opening)" residual; a guided re-close would fix it — upgrade notes
- Pre-0.6 manufacture vouchers don't appear in the Manufacture register (Day book / Stock movements only) — by design, release notes
- ~~e-invoice original-bill lookup takes the newest sales voucher with that number at ANY party (wrong once numbers restart yearly)~~ DONE — the note's own party, its FY first — PR #120
- Import undo keeps a party ledger whose opening bill has a user receipt against it (openings stay unequal until fixed by hand) — PR #107, `services/dataImport.ts`
- ~~Stock summary analysis panel runs as on today while the summary runs to the period end (no date shown)~~ DONE — the date and a note are shown; the panel stays as on today (running it to a future period end would change what it shows) — PR #120
- Barcode labels date / price by the period END — PR #110
- Cash flow statement has no drill-down; labels PDF, CA pack and e-invoice export write to `exports/` with no save dialog; e-invoice export is whole-period only — e2e 68–71 notes
- Items created over IPC after a screen loaded don't appear in screens that cache the item list (Labels tab) — e2e 68 notes
- TDS: ~~late-deduction (1 %) interest computed but not shown~~ DONE — Deducted tab column + export, display only — PR #126; purchase returns don't reduce the threshold aggregate; 26Q CSV is RPU input, not FVU — WP 3.2
- Fixed assets not done: partial disposals, GST on asset sale, extra-shift depreciation, component lives, rule 25(2) 40 % cap — WP 3.6
- Trade cycle not done: 16-char invoice-number warning, challan / GRN list screens, convert-to-invoice, live NIC e-way for challans — WP 2.5b
- TCS not modelled: 206C(1G) 20 % slab, 206C(1C), LRS — WP 3.3
- Cash & finance not done: MSME deadlines in the forecast, loan disbursement posting, foreign opening balances — WP 4.4
- NIC follow-ups needing a migration: store signed QR / signed invoice; cancel IRN / cancel + extend e-way UI — WP 3.5
- ~~ITC-reversal apply has no audit row of its own~~ DONE — `itc_reversal` rows on apply and post — PR #120
- ~~Backup file names use UTC timestamps~~ DONE — local time since PR #114; one stamp helper + old-name test PR #118 (the list reads mtime) — PR #111
- ~~Report-pack / saved-report folders use the company slug ("Con" → `con-company/`)~~ DONE — pack folders via `portableFileName`, old folders kept (files inside still slugified, e.g. a saved report "Con" → `NN-con-company.csv`) — PR #120

### GST / tax
- Historical documents depend on mutable masters (item / ledger rates, HSN, party class): changing a master can change an old return or print; snapshot tax facts per document — GPT review, `services/gst.ts`, `services/edocs.ts`
- Invoice calc rounds tax per rate group, return extraction per line (paise can differ); percentages and FX use float intermediates — GPT review, `shared/voucherEdit/invoice.ts`, `shared/money.ts`
- An IRN doesn't freeze amount / party edits and binning doesn't cancel the IRN; needs a correction workflow (24 h cancel window) — GPT review, `services/vouchers.ts`
- e-invoice applicability needs a business profile (PAN-wide turnover, ₹5 cr mandate, 30-day rule at ₹10 cr) — GPT review, `shared/compliance.ts`
- Advance GST treats any new receipt reference from a rate-tagged party as a taxable advance (goods advances are generally exempt under N. 66/2017) — GPT review, `services/gst.ts` extractAdvances
- MSME deadlines run from the bill date; the law uses acceptance / deemed acceptance — GPT review, `shared/payables/msme.ts`
- Several rate-less lines at different true rates in one voucher get one blended rate (flagged off-slab); discounts debited to a ledger under Sales Accounts are ignored in the taxable value — PR #93
- Off-standard implied rate stays a warning (no source on what the portal accepts) — PR #93
- ~~Unused constant `GSTR3B_QRMP_DUE_DAY = 22` still exported from the close checklist~~ DONE — PR #118
- "Exporting JSON" is treated as "prepared"; filing / payment evidence is a manual mark only — GPT review, `services/gst.ts`

### Windows (needs a real machine — CI can't check)
- NSIS install / uninstall, SmartScreen dialog, in-place update (first one works only from the release after 0.11.0) — PR #109
- Explorer reveal and the default PDF viewer; printing to a real printer; HiDPI scaling; Hindi print fonts — PR #109 / #105
- Capture inbox with a file another program holds open; DPAPI after a password reset / roaming profile; OneDrive-redirected Documents (no setting to move the data folder) — PR #109
- Only a 4-scenario e2e subset runs on Windows CI; MCP single-quoted commands work in PowerShell / Git Bash, not cmd.exe; PowerShell Documents fallback only unit-tested on macOS — PR #109
- Windows CI flake seen once: backup.dbtest `rollbackRestore` timed out at 30 s (file locks vs the #104 check worker?) — after #111

### AI
- Figure checking matches absolute amounts; it can't prove sign, meaning or period — GPT review, `src/main/ai/numbers.ts`
- `find_anomalies` keys carry long digit runs that masking rewrites, so the model can't refer back to a finding by key — WP 5.8 review, `src/shared/anomalies.ts`
- Real-provider escalation, key rejection and capture never run against a live model (mock only) — PR #98 / #101

### Performance
- Launch to Home 6.5 s vs the 2 s target (Electron + renderer ~1.9 s; the Gateway's four reads could be one) — PR #104
- At 500k vouchers many reports take > 3 s on this laptop: stream stock lines into the valuation pass, share one pass / one Outstandings run per request, re-measure on a machine with more RAM — PR #104
- Voucher text search needs a full-text index (FTS5 + triggers); search budget 600 ms at 500k — PR #104
- ~~No timeout on the company-open quick_check worker~~ DONE — 60 s, then "not checked (timed out)" — PR #118
- company:open still waits, unbounded, for the open backup (`backupCompany`: snapshot + its own worker quick_check of the copy) before purge — on the slow disk / huge file the #118 timeout is for, that wait is as long; bounding it needs a rule for an unverified backup (purge must not run before the snapshot) — PR #118 review, `src/main/ipc.ts` openCompanyNow
- Synchronous SQLite and valuation run in the main process; cold start, save latency and UI responsiveness at 100k / 500k not gated — GPT review

### Security
- Attachments, capture files, exports, logs and the temporary plaintext snapshot inside an encrypted export are not encrypted — PR #112
- `total-cli` / MCP refuse a locked business (no `--passphrase`); consolidation reads a locked member only while it is the open business — PR #112
- No "remember on this Mac" — the passphrase is asked on every open — PR #112
- ~~`canSeeProfit` doesn't cover the trial balance, report builder or AI tools; the UI doesn't hide buttons by flag (main refuses)~~ DONE — trial balance redacted, report builder / packs / AI tools / Ask Total refuse profit, export / Save / AI-settings buttons follow the flags — PR #127 (from PR #112)
- ~~Session lock needs a user with a PIN~~ DONE — a business without users locks to a privacy screen (its passphrase when it has one; `session:unlock`) — PR #127 (from PR #112)
- Renderer sandbox is off (`sandbox: false`) and IPC handlers don't validate the sender frame — GPT review, `src/main/index.ts:93`, `src/main/ipc.ts`
- ~~deleteVoucher writes its audit row after (outside) the deleting transaction~~ DONE — restore / purge / PDC maturing too — PR #118
- ~~A company file migrates on open before any pre-upgrade snapshot is taken~~ DONE — `backups/pre-upgrade-*.db` before every migration, no copy = no migration (PR #116); interrupted multi-migration upgrades tested in PR #118 — GPT review, `src/main/db/connection.ts`
- The audit hash chain detects but can't prevent tampering (whoever holds the file can recompute it) — WP 3.8
- In a company without users anyone can change the app-wide update setting; real signed / unsigned macOS update behaviour unverified until a release — PR #108

## 5. UNVERIFIED tax points (confirm with a CA before relying on them)

- GST slabs 2025 / 2026 and schedule numbering read from secondary copies (N. 9/2025, 19/2025-CT (Rate)) — `src/shared/gst/rateTable.ts` GST_RATE_UNVERIFIED
- Services' GST rates after 22 Sep 2025; compensation cess nil / ended dates; biris at 18 %; the HSN → slab mapping — `rateTable.ts`
- GSTR-1 11th / 13th: amendments to N. 83/2020-CT (12/2021, 17/2021, 09/2024) and one-off extensions not read; IFF not modelled — `src/shared/gst/filing.ts`, `compliance.ts`
- Quarterly GSTR-3B for state code 97 / missing state listed on the 22nd; state / month extensions not modelled — `filing.ts`
- PMT-06 amount not worked out — `filing.ts`
- TDS deposit dates under the Income-tax Rules 2026 (rule 218) read only in secondary sources; 1962 rule 30(2) used — `compliance.ts`, `src/shared/tdsInterest.ts`
- ARN format (10–20 letters / digits); gst.gov.in menu wording; CBIC rule 61 / 62 pages fetched with TLS verification off — `src/shared/simple/taxes.ts`, PR #94
- s.10(4) / s.34 CGST wording not re-read; RCM received by a composition dealer not modelled; only one registration change kept — `src/shared/gst/registration.ts`
- GSTR-2B JSON field names (rev, itcavl, b2ba / cdnra) from real downloads, not the schema; s.16(4) uses 30 November only — `src/shared/assistantSources.ts`
- GSTR-9 row labels, the ₹2 crore exemption (N. 15/2025), GSTR-9 / ITC-04 / IMS JSON are the app's own layouts; IMS record key; s.50 interest 18 %; 3B 4(B) / 4(D) wording — `src/shared/gst/sources.ts`
- Table 13 doc codes and supply-challan category 12; NIC e-way sub-supply codes for challans; inter-State job-work proviso; approval read as a supply — WP 2.5b, `shared/gst/edocs.ts`, `shared/voucherEdit/stockNote.ts`
- e-invoice patterns the IRP enforces, OthChrg for TCS, IST of NIC timestamps, DUPIRN shape, URL prefixes / headers — `shared/gst/einvoiceSchema.ts`, `services/nic.ts`
- State-code list not re-read — `src/shared/gst/states.ts`
- TDS (WP 3.1 / 3.2): rounding (nearest rupee vs s.288B / s.516 ₹10), 194Q GST base and ₹10 cr condition, 194N not seeded, senior-citizen age under the 2025 Act, pre-FY26 figures; s.201(1A) / s.398(3)(a) interest wording, 26Q reason codes, Form 16A layout, TRACES month counting — migration 020, `services/tdsWorkbench.ts`
- TCS (WP 3.3): GST in the base outside 206C(1H), FA 2026 s.85 vs the s.394 table, Protean collectee codes 01 / 05 / 06, 1F due at receipt vs invoice — `services/tcs.ts`
- Fixed assets (WP 3.6): hotel / school furniture life 8 vs 10; FA 2026 on s.33 / 41 / 74; pre-FY26 IT rates partly seeded; sale proceeds vs half-rate additions — migration 026, `shared/depreciation.ts`
- Payroll (WP 3.7): EPF ceiling ₹25,000 from 17 Sep 2026 and its proration, admin / EDLI notifications, ECR `#~#` separator, ESI ceilings under the Code, PT slabs (WB / TN / AP / MP) and due dates, gratuity ₹20 L, bonus ₹21k / ₹7k, Form 16 Part B rows — `src/shared/payrollStatutory.ts` UNVERIFIED_WP37
- MSME: RBI bank-rate history before Oct 2025, s.37 FA 2026, s.43B(h) excluding traders, Form 1 S.O. number, Udyam number layout — `src/shared/payables/msmeSources.ts`
- Receivables: time of supply of interest (on receipt), GSTR-1 route of interest notes, SAC 9971 for interest — `src/shared/receivables/sources.ts`
- AS 11 / Ind AS 21 paragraph citations; EMI rounding / broken-period conventions; forecast statutory due dates written from memory — `shared/forex.ts`, `shared/loanSchedule.ts`, `services/cashForecast.ts`
- Consolidation: proportionate unrealised-profit estimate, uniform policies, acquisition book values, minority loss re-allocation, AS 23 — `src/shared/consolidation/sources.ts`
- Audit trail: s.128(5) wording, IT rule 6F, IT Act 2025 s.62 / Rules 2026 r.46(9) retention — `src/main/services/audit.ts`
- Busy / Zoho import header spellings and XML roots — `src/shared/dataImport/busy.ts`, `zoho.ts`
- GST calendar items from the GPT review that still need a CA: e-invoice applicability, advance GST, MSME acceptance date (section 4, GST)

## 6. Deferred engineering (per WP)

- WP 6.x / 7.5 site: marketing site work deferred by the owner (WP 10.7); site FAQ says "nothing leaves the machine" (false once AI / capture / NIC are on) — `site/app/docs/faq/page.tsx`
- WP 7.1: server-side DataTable paging not needed yet (Sales / People under budget at 100k) — PR #104
- WP 7.2: encrypt attachments / exports / logs; `--passphrase` for the CLI / MCP; remember-on-this-Mac — PR #112
- WP 7.3: no data-folder move setting for OneDrive users; full e2e on Windows — PR #109
- WP 7.4: tighten e2e 67–71 to the paths #107 fixed (drop workarounds); deferred coverage in `docs/e2e-coverage.md` (live NIC sandbox, price-list editor, TDS lower-deduction certificates) — PR #110
- WP 7.6: before tagging the release, finish `CHANGELOG.md`'s Unreleased section — it has no entries for #107, #108, #110, #111, #112 and still calls #104 open (#109's Windows text has no PR link); then confirm main's CI is green on all five jobs (the tag run does not repeat e2e or perf) — owner-docs review
- ~~WP 8.x: no schema-version guard against downgrade~~ DONE — PR #116
- WP 9.1: TDS / TCS, place-of-supply override and the owner's credit-hold override aren't part of simple intents — PR #85
- WP 9.4: TDS shown as a hint only, deducting stays in the accountant view — PR #88
- WP 9.9: quarterly file preparation in simple mode; opening gst.gov.in from the app — PR #94
- ~~WP 10.1: Ask Total corpus ~30 questions; extend (payroll, TDS, a bill by number)~~ DONE — PR #125 (+40 phrasings) — PR #98
- WP 10.3: help is simple-mode only; the full app keeps its shortcut list — PR #100
- WP 10.4: accountant screens stay English; full-app button names glossed in Hindi help — PR #105
- GPT review P3 / P6 / P7: freeze transaction tax facts and unify entry / return / PDF calculation with independent fixtures; guided GST review with filing evidence; verified upgrade recovery and external backups; Electron hardening — `~/.claude/total-orch/gpt-opinion.md`

## 7. Dependabot / dependency leftovers

- Electron 37 → 43 major (PR #3 open): fixes ~50 alerts (fixed in 38.8.6 / 39.8.x / 41.10.x); needs its own WP — rebuild the SQLite cipher driver, full e2e on mac + Windows, DMG / EXE install check
- vitest 3 → 5 major (PRs #7 and #14 open; removes tinypool): fixes tinypool (critical, dev-only), vitest / @vitest/mocker alerts; needs its own WP (test:db under Electron-as-Node, renderer config)
- No fix published: sprintf-js (medium), http-cache-semantics (high), extract-zip (high, via electron's installer) — `package-lock.json`, re-check when Electron moves
- site/ (deferred): next 16.3.1 → 16.3.8 (PR #63, fixes critical / high alerts), sharp 0.35.5 (PR #16), source-map-js 1.2.2 (PR #13) — merge when the site work resumes
- Closed as superseded by f3c9bf59 (#112): #6 xmldom, #10 js-yaml, #11 undici, #15 fast-uri, #17 brace-expansion, #62 source-map-js

## 8. Test gaps

- e2e 32 / 33 make 100- and 40-day-old bills in books that begin this FY; around April they fall in the previous FY (unverified) — PR #110
- e2e 57 / 59 move the "40 days ago" sale to the FY start, so overdue checks can fail 1 April – mid May — shots-92
- e2e harness can lose a failed scenario's result line on macOS (process.exit while writing to a pipe; exit code still fails) — PR #110
- e2e 63 uses `page.focus()` twice; e2e 12 "mid-fade" flake diagnosis unproven — PR #103
- Plain AI drawer a11y and the escalated drawer checked in renderer tests only (needs `TOTAL_AI_MOCK` in e2e) — PR #103
- No live-model run of AI evals, capture or Ask Total escalation — PR #98 / #101
- No live NIC sandbox scenario — WP 3.5, `docs/e2e-coverage.md`
- 500k-voucher run and the packaged DMG / EXE perf not verified by the reviewer — PR #104
- ~~Interrupted multi-migration upgrade not tested~~ DONE — `db/interruptedUpgrade.dbtest.ts`, no runner bug — PR #118
- Receivables interest on an amount-only bill at its real GST rate not pinned — PR #93
- PowerShell Documents fallback and locked capture-inbox path only unit-tested on macOS — PR #109
- CI e2e takes ~18–20 min (sharding is ready if needed) — PR #110
