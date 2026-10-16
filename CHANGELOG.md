# Changelog

All notable changes to Total are listed here, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Each entry links the pull request that
made the change (`#N` = `https://github.com/IrminFlow/total/pull/N`). The full text of each
release is on the [GitHub releases page](https://github.com/IrminFlow/total/releases).

How to read it: **plain words first** (what a shop owner sees), then **for accountants** (figures
that changed, and why), then **for developers** (migrations, new IPC namespaces). Released
versions are grouped as Added / Changed / Fixed instead.

Things to know about the version numbers:

- 0.6.0 and 0.9.0 were never tagged. The Phase 2 and 3 work shipped together as 0.7.0, and the
  Phase 5 and 6 work shipped together as 0.10.0.
- Versions before 0.5.0 (0.1.0 to 0.4.0, August 2026) are on the releases page and not repeated here.
- `package.json` still says 0.11.0. Nothing under "Unreleased" has a tag yet.
- Anything this file calls "unverified" is marked UNVERIFIED in the code or in the release notes it
  was taken from. The privacy-related ones are in [docs/ai-and-privacy.md](docs/ai-and-privacy.md).

## [Unreleased]

Everything merged after v0.11.0 (2026-10-13): Phase 9 (simple screens for the daily jobs), the
Phase 10 simple-mode work (Ask Total, "Why?", help, Hindi, keyboard and accessibility, the plain AI
helper, the beginner-study fixes), the Phase 7 work (performance, security, Windows, end-to-end
tests, documentation) and several correctness fixes.

### For shop owners (simple mode)

Every simple screen below also has an **Accountant view** button that opens the full editor with
what you typed, and a **Back to simple** button.

- **Make a bill** (Sell). Pick a customer (or leave it empty for a cash customer), add products or
  just an amount, say how it was paid (cash, UPI, card, bank transfer, on credit, partly paid), and
  save. A part payment leaves the rest due. [#86](https://github.com/IrminFlow/total/pull/86)
- **Record a purchase** (Buy). The supplier's bill number and date, products or just an amount,
  and whether you paid now. The same supplier and bill number twice in a year is refused.
  A business that cannot claim GST books the GST as part of the cost.
  [#87](https://github.com/IrminFlow/total/pull/87)
- **Money in, Money out, Move money**. Choose who paid you or whom you paid; the open bills are
  listed oldest first and ticked as far as the amount goes. Advances, owner's money, loans and
  other income are plain choices. [#88](https://github.com/IrminFlow/total/pull/88)
- **Return a sale / Return a purchase**. Pick the bill, say what came back, and say whether to
  give the money back or keep it for the next bill. [#89](https://github.com/IrminFlow/total/pull/89)
- **Bank**. Drop a statement file; each line asks "What is this?" with plain choices. A one-sentence
  reconciliation. PDF statements cannot be read yet. [#90](https://github.com/IrminFlow/total/pull/90)
- **Stock and Made goods**. Products with on hand, worth, selling price and a "Running low" flag; a
  product page; count your stock; make goods from materials. [#91](https://github.com/IrminFlow/total/pull/91)
- **People**. Every customer and supplier with what they owe or are owed, late bills, a person
  page, reminders, and "bills to pay". [#92](https://github.com/IrminFlow/total/pull/92)
- **Reports and Taxes**. "How is my business doing" as one column with the change from the
  previous period; cash in the next 30 days; who owes me and whom I owe; sales and purchases by
  month; a "For your CA" list. Taxes shows three separate GST figures (collected, on purchases,
  to pay in cash), the due dates, five steps to file, and an "I've filed" mark where you record the
  ARN and date. Total prepares the figures; you file on gst.gov.in.
  [#94](https://github.com/IrminFlow/total/pull/94)
- **Accountant-view hand-off on every simple screen**: what you typed and have not saved goes to
  the full editor. [#96](https://github.com/IrminFlow/total/pull/96)
- **Hand-off polish.** Cancel or "Back to simple" from that editor brings back the answers you
  typed. If your answers can't be carried over, the empty editor opens without asking you to
  discard them. A sale to a walk-in customer shows "Cash sale", and GST / round-off accounts
  show their names. These are added when you save, as the full app does the first time.
  Reports and Taxes have the "Always open the full app for this" menu. People and the Reports page
  have their own Accountant view. ⌘K results say Accounts / Products / Entries.
  [#122](https://github.com/IrminFlow/total/pull/122)
- **Ask Total** (no key needed). Type a question or a short entry ("who owes me?", "paid 2,500 rent
  in cash") and Total answers from the same figures the screens show, or opens the right form
  pre-filled. It also understands some Hinglish and Hindi words. It does not guess a name: it asks
  "Which Ramesh do you mean?". [#98](https://github.com/IrminFlow/total/pull/98)
- **Ask Total knows more.** Ask about a bill by its number ("bill 42 paid?", "invoice no 42 kiska
  hai", "supplier bill M-7") and it says who it is for, the date, the total and what is still due,
  with a link to the bill. "TDS kitna dena hai" gives the TDS you deducted this month, what is
  still to pay and what is late (the Taxes screen's figures); "salary kitni gayi is mahine" gives
  the month's pay run (Payroll's net pay). An entry Ask Total opened and you left without saving
  no longer stays behind in Settings → AI drafts, and opening one from there in simple mode goes
  to the simple form, not the accountant one. [#125](https://github.com/IrminFlow/total/pull/125)
- **"Why?" for every figure and date** on Home, Reports and Taxes: one sentence built from the
  returned figures, with a link to the exact report. [#99](https://github.com/IrminFlow/total/pull/99)
- **First-run tour, empty states that teach, and an offline help panel** with 16 English articles
  (press `?` or `Cmd+/`). [#100](https://github.com/IrminFlow/total/pull/100)
- **The AI helper in plain words** (Settings, "AI helper"). Optional. A three-point summary of what
  is sent, what is hidden and where it goes comes first; you paste your own OpenAI key and press
  "Check it". Spend is shown in rupees only when the business has a dollar rate recorded (Forex); otherwise in US dollars.
  [#101](https://github.com/IrminFlow/total/pull/101)
- **Keyboard, screen readers and small windows**: icon-only sidebar under 1200 px wide; the help,
  Ask Total and AI panels overlay instead of docking under 1600 px.
  [#103](https://github.com/IrminFlow/total/pull/103)
- **Hindi and Hinglish**: every simple-mode message has a Hindi (Devanagari) and a Hinglish
  (Latin script) version; the help articles are in Hindi (all 16) and Hinglish (the six most used);
  for a simple-mode company set to Hindi or Hinglish, bills, receipts and statements print their
  labels in that language (legal titles such as TAX INVOICE and BILL OF SUPPLY stay English);
  amount in words uses lakh and crore. The
  translations are machine-drafted and **pending native-speaker review**; the catalogue headers
  say so. Accountant screens stay in English. [#105](https://github.com/IrminFlow/total/pull/105)
- **First-run polish**: Ask Total answers "Tata Namak kitna bacha hai" with the stock left (not
  the sales), adds this month's GST so far, and explains a term in the language you asked in; a
  bill's round-off is its own "Rounding" line instead of a negative running cost; opening stock can
  take what you sell each product for; Backups no longer show a file path (Show in Finder instead)
  and are named in local time; the leave-without-saving question and table words follow your
  language. [#114](https://github.com/IrminFlow/total/pull/114)
- **Fixes from a trial with first-time users** (six scripted "shop owners" drove the app; the real
  study with people is still to be done). A regular business's opening products now ask their GST
  rate, so the first bill is not silently sent out without GST; Make a bill and Record a purchase
  warn when a product has no rate. GST periods start with your books (no "overdue" month from
  before you began). The bank sentence compares the bank's own closing balance with your books. A
  sign-in that cannot save sees a note instead of a Save button. Plainer words: "a credit of ₹X to
  use on the next bill", "no due date set", "Loss ₹X", "This year: Apr 2026 – Mar 2027". Backups is
  a plain screen. Selling more than you have says the profit will be wrong, and Home flags stock
  below zero. A customer page says why there is no reminder when nothing is late. "5000 Ramesh" in
  Ask Total asks which way the money went. "Did you mean ...?" sees through "ji" and a plural s.
  [#111](https://github.com/IrminFlow/total/pull/111)
- **Lock your books with a passphrase** (opt-in, owner only: Settings, "Lock and safety"). The
  books file and every backup are encrypted, Total asks for the passphrase each time you open the
  business, and **a lost passphrase means lost books**; a recovery copy is offered right after
  locking. Also: after each backup Total opens a copy in a scratch folder and checks it (Home says
  "Last backup ... checked OK", or shows a red card), per-person switches in People and roles (post
  entries, see profit, export, manage the AI helper), and Ctrl/Cmd+L or an idle timeout to sign out.
  [#112](https://github.com/IrminFlow/total/pull/112)
- **Updates ask first.** Total never downloads or installs an update without a click ("Download
  now", "Later", "Skip this version"; "Install when I quit" is a choice). Settings, "How Total
  looks" (in the full app: Settings, About), has "Check for updates automatically" (on by default);
  turned off, Total makes no request at launch. [#108](https://github.com/IrminFlow/total/pull/108)
- **Faster on big books.** Reports, lists, search and opening a business are faster with 100,000
  or more entries (for example the profit and loss for a year in about 0.2 s on a 100,000-entry
  test company). Nothing you see changes except the speed. [#104](https://github.com/IrminFlow/total/pull/104)
- **Windows.** Updating on Windows works again (see Developers), Tally and bank files saved by
  Windows programs (UTF-16 or with a byte-order mark) import, and shortcuts show as Ctrl and Alt.
  [#109](https://github.com/IrminFlow/total/pull/109)
- **Period lock and Bin in a business with no sign-ins** no longer say "Only owners can change
  this"; the closing entry of a year has a **Move to Bin** button; stock age counts from today,
  not from the end of the year. See the accountant notes below.
  [#107](https://github.com/IrminFlow/total/pull/107)

- **A safe copy before an upgrade, and no opening books from a newer Total.** When a new version
  of Total has to upgrade your books, it first keeps a copy of them as they were in Backups
  ("Before upgrade to …"; the newest two are kept — it is not counted as a backup you took, so
  Home's backup reminder is unchanged). If the copy can't be made — a full disk — the
  books are not upgraded and Total says so. Books last opened with a newer Total are refused with
  "Update Total to open it" instead of being opened and misread. This protects books from 1.0 on:
  0.11.0 and earlier, already installed, can't be changed. [#116](https://github.com/IrminFlow/total/pull/116)
- **Small fixes from the screenshots.** Once you note a GST return as filed (Taxes, "I've filed"),
  Home's GST figure and the dashboard's GSTR-3B date move on to the next period. A Print that fails
  now says so. Switching "Prices include GST" on Make a bill or Record a purchase converts the
  prices already typed, so the bill stays the same. In dark mode, a choice that is already made and
  can't be changed is readable. Someone who can only look (a viewer) is told so at
  the top of every bill, purchase, return and money form, and sees a short note instead of
  "Back up now". [#119](https://github.com/IrminFlow/total/pull/119)
- **More "Why?" answers.** A composition business's GST tile on Home explains the CMP-08 and
  GSTR-4 dates, and a quarterly filer's tile explains the PMT-06 dates. Both open Taxes. People →
  Bills to pay explains "due this week" and "due this month" (which bills, from how many suppliers,
  and how much is already late). Reports → by month has a "Why?" for every month that opens the
  sales and purchase lists on that month. [#120](https://github.com/IrminFlow/total/pull/120)
- **Bank, Returns and Money list fixes.** On Bank, "Skip for now" is remembered on this computer,
  and skipped lines wait under "Skipped for now" with "Bring back". A line marked Done has "Not
  this": the line goes back to the lines to answer and the entry stays in your books. After "Pick
  the bills yourself", "Back to Bank" takes you back to the same bank. Returns shows the bill's own
  note on its card. If no bill falls in the last 12 months but older ones exist, the picker says so
  and offers "Search older bills". Money in and out also lists entries dated up to 30 days ahead,
  with a "Dated ahead" label. Help links that point to a screen view that doesn't exist now just
  open the screen. [#121](https://github.com/IrminFlow/total/pull/121)
- **More of Total in Hindi.** The setup wizard lists the states by their Hindi names. A Hindi
  bill, statement or reminder says "पृष्ठ 1 / 1" at the foot of the page (Hinglish: "Page 1 / 1").
  "Entries up to … are locked" and "this date is after the first day you record" write their date
  in your language, and on the Bank screen "already recorded on …" follows the language you picked,
  not the business's. Prints in English and every full-app screen are unchanged.
  [#123](https://github.com/IrminFlow/total/pull/123)

### For accountants (figures that changed)

Read these before filing from the next release.

- **GSTR-1, GSTR-3B, GSTR-9, HSN, e-invoice and interest notes now take the rate the posted tax
  implies** for "amount only" (ledger-line) sales, credit notes and outward debit notes whose
  Sales ledger has no GST rate. Before, such a document was reported as nil-rated even though Output
  CGST/SGST was in the books. A voucher whose posted tax fits no slab of its date is reported at the
  implied rate with an `off_slab_rate` warning. Item-mode invoices, ledgers that carry a rate,
  composition and unregistered companies are meant to be unchanged: in a 28-document test corpus the 19
  documents the fix does not touch come out identical to the old code, and the 9 that change were
  worked out by hand.
  **If you billed through ledger lines with tax on 0.11.0 or earlier and filed from Total's GSTR-1
  or 3B, those sales may have been filed as nil-rated; check the returns for the months concerned.**
  Known limits: several rate-less lines at different true rates in one voucher get one blended
  rate, and the 2025/2026 slab tables are partly UNVERIFIED (`src/shared/gst/rateTable.ts`).
  [#93](https://github.com/IrminFlow/total/pull/93)
- **Outstandings engine sign fix** (`src/shared/outstanding.ts`). A bill reference now follows the
  sign of its entry: a `new` reference on a settling entry (an advance received or paid, or a
  credit note's own bill) is a named credit counted as unapplied credit, and a later entry's
  `against` reference uses that credit by name. Entries without references, `new` on positive
  entries and `against` on negative ones behave as before. GSTR-1 11A/11B read bill references
  directly and are not affected. **After upgrading, advances and credit notes with bill references
  can move between "open bills" and "unapplied credit". Outstandings, ageing and everything built
  on the same allocation change with it (Home and People totals, statements, reminders and interest,
  payment runs, the cash forecast, the month-end checklist); re-check customers and suppliers who
  paid in advance.** [#85](https://github.com/IrminFlow/total/pull/85)
- **Due dates corrected** (`src/shared/gst/filing.ts`, cited in the code). Quarterly GSTR-3B is the
  22nd or 24th by state per the rule 61(1)(ii) table (a state in neither entry, such as 97, gets the
  22nd and is flagged). PMT-06 is the 25th (rule 61(3)). CMP-08 is the 18th and GSTR-4 is 30 June
  from FY 2024-25 (rule 62). The TDS deposit for **March deductions is 30 April**, not 7 April
  (rule 30(2)). **After upgrading, the deadlines shown for these returns (Home, Taxes, the Gateway) use these
  dates instead of the older ones.** [#94](https://github.com/IrminFlow/total/pull/94)
- **New bill names never collide.** A new bill, advance or note bill whose name the party still has
  open gets the financial year added (`1/25-26`, then ` (2)`), because numbering restarts each year
  and a settlement by name applies to the oldest open bill of that name.
  [#85](https://github.com/IrminFlow/total/pull/85)
- **Dates are stricter on simple screens than in the voucher editor**: inside the lock date, in a
  closed year, before the books begin, or more than 30 days after today are refused. The voucher
  editor is unchanged. [#85](https://github.com/IrminFlow/total/pull/85)
- **Moving a year-end closing journal to the bin moves the period lock.** The close locks the books
  up to its own date, so the editor's new **Move to Bin** button first asks, then sets the lock back
  to the day before that financial year starts (owner only, audited) and bins the entry; if the
  bin is refused the lock is put back. If the lock is later than the entry (a later year is
  closed, or you set it by hand) nothing is changed and you are told to move the lock in Settings,
  About first. After upgrading, reopening a closed year this way moves your lock date; check it.
  [#107](https://github.com/IrminFlow/total/pull/107)
- **Other #107 fixes that change what you see.** The duplicate-number warning now looks only at the
  financial year of the voucher's date when the series restarts each year (continuous series still
  clash across years); a cost centre's Net follows the P&L (profit = Cr, loss = Dr), where a loss
  used to read "Cr"; stock ageing (and the Stock summary's analysis panel) runs as on today, capped
  at the period end, instead of the period's end date, which had put stock bought today in "90+
  days"; undoing an import that left a used ledger or item now clears its opening instead of
  leaving the openings off by that amount. [#107](https://github.com/IrminFlow/total/pull/107)
- **New database driver (SQLite Multiple Ciphers).** Books files are read and written by
  `better-sqlite3-multiple-ciphers`, the same SQLite engine with encryption support. An existing
  business opens exactly as before, with no prompt and no change to any figure; only a business you
  lock gets an encrypted file. Do take a backup before upgrading, as for any release.
  [#112](https://github.com/IrminFlow/total/pull/112)
- **Round Off is its own line in "How is my business doing".** It no longer shows as a negative
  running cost; profit is unchanged (sales - cost + other income + rounding - running costs =
  the P&L's net profit). [#114](https://github.com/IrminFlow/total/pull/114)
- **Performance work left every figure unchanged**: each budgeted report, list and search was
  hashed against the previous code on a demo and a 10,000-entry company and matches exactly.
  [#104](https://github.com/IrminFlow/total/pull/104)
- **Simple Taxes and Home skip periods before the books begin** (a month before your books or GST
  registration began is not asked for); a running month's files wait for its month end. The
  accountant GST screens are unchanged. [#111](https://github.com/IrminFlow/total/pull/111)
- **No figure changed in these fixes** [#120](https://github.com/IrminFlow/total/pull/120):
  - A credit or debit note's e-invoice "preceding document" is now its own party's bill of that
    number, from the note's FY first. Before, it could be another party's newer bill once numbers
    restart each year.
  - ITC-reversal "apply to GSTR-3B" and "post" each leave an edit-log row of their own
    (`itc_reversal`).
  - The Stock summary's ageing and reorder panel shows its as-on date and says when the summary
    runs to a later date. The panel still runs to today.
  - Report-pack folders are named after the pack ("Con" becomes `_Con/`, not `con-company/`).
    Folders that already exist keep being used.
- The UNVERIFIED items listed under 0.11.0 (QRMP details, GSTR-1 amendment notifications, the
  2025/2026 slab sources) still apply.

### For developers

- **Migrations.** Two more migrations are appended after 050, each the last in its turn (numbered
  by position): migration 051, WP 7.1's six covering indexes (`CREATE INDEX IF NOT EXISTS` only,
  [#104](https://github.com/IrminFlow/total/pull/104)) and migration 052, WP 7.2's `backup_runs` table plus
  `users.capabilities_json` (NULL = the role exactly, [#112](https://github.com/IrminFlow/total/pull/112)).
- **Migration 050** `simple_posts` (the 50th entry, numbered by position): the idempotency record
  for `simple:post`. [#85](https://github.com/IrminFlow/total/pull/85) Migrations 046 to 049 shipped
  in 0.11.0 (below). WP 9.2 to 9.10 and 10.1 to 10.6 added no migration.
- **IPC.** `simple:post` (accountant+, audited as `simple_intent`), `simple:preview` (viewer,
  rehearsed and rolled back), `simple:intentForm` (the hand-off), `simple:handoffTarget`; per
  section: `simple:sell:setup`, `simple:sales`, `simple:sale`, `simple:buy:setup`,
  `simple:purchases`, `simple:purchase`, `simple:money:setup|bills|list|entry`,
  `simple:returns:bills|bill`, `simple:bank:setup|lines|accept`,
  `simple:stock:list|product|madeSetup|setPrice`,
  `simple:people:list|person|billsToPay|update|reminded`, `simple:reports:doing|cash|owed|byMonth`,
  `simple:taxes`, `simple:taxes:filed`. The complete list is `src/main/auditCoverage.ts`.
- **New modules**: `src/shared/simple/` (`intents.ts` and one file per section, `explain*.ts` for the
  "Why?" sentences), `src/main/assist/` (Ask Total: deterministic, no model, no network) and
  `src/shared/gst/postedRate.ts` ([#93](https://github.com/IrminFlow/total/pull/93)).
- Ask Total: new intents `bill` / `withholding` / `payroll` (`src/shared/assist.ts`, `picks.bill`);
  new IPC `assist:draft:discard` (accountant+, audited `ai_draft`); an Ask Total draft records
  `payload.simple.askedBy`. [#125](https://github.com/IrminFlow/total/pull/125)
- "I've filed" lives in company meta `gstFiled`, not in `assistant_marks` (which has no room for an
  ARN). [#94](https://github.com/IrminFlow/total/pull/94)
- i18n: `Translate.lang`, `toPlainDate(d, lang)`, `amountInWords(paise, lang)`; the glossary is
  `src/shared/i18n/GLOSSARY-hi.md`; `bannedWords.ts` gained Hindi and Hinglish patterns.
  [#105](https://github.com/IrminFlow/total/pull/105)
- Docs and tests: [#84](https://github.com/IrminFlow/total/pull/84) (CLAUDE.md tidy after Phase 8),
  e2e fixes [#95](https://github.com/IrminFlow/total/pull/95), [#97](https://github.com/IrminFlow/total/pull/97), [#102](https://github.com/IrminFlow/total/pull/102).
- **Windows parity (WP 7.3)**, [#109](https://github.com/IrminFlow/total/pull/109): the Windows CI job runs every suite, the smoke against `out/` and the
  packaged `Total.exe`, e2e 01 03 46 48 and the NSIS build. Fixes: Windows auto-update (the
  installer is now `Total-Setup-<version>.exe`, the name `latest.yml` asks for — 0.11.0's asset was
  stored as `Total.Setup.0.11.0.exe`); Tally XML in UTF-16 ("Unicode") and files with a BOM / CRLF;
  company and export names that are Windows device names (CON, NUL …); file locks on rename;
  Ctrl / Alt shortcut labels; the CLI's data folder under OneDrive. See
  [docs/windows.md](docs/windows.md).
- **Performance (WP 7.1)**, [#104](https://github.com/IrminFlow/total/pull/104):
  `total-cli perf-seed` and `npm run perf` (budgets at 100k and 500k entries, `docs/perf-budgets.md`),
  a CI `perf` job, one SQLite memory map up to 2 GB, `ANALYZE` only after a migration, and the
  whole-file checks moved to a worker thread (`out/main/checkWorker.js`, a third main entry).
- **Security (WP 7.2)**, [#112](https://github.com/IrminFlow/total/pull/112): every import of the
  driver is `'better-sqlite3-multiple-ciphers'`; rebuild with
  `npx @electron/rebuild -f -w better-sqlite3-multiple-ciphers`. New channels
  `security:passphrase:on|off|change`, `security:autoLock:set`, `session:lock`, `session:activity`,
  `backup:check`, `backup:checks`; `company:open` takes `passphrase`; `users:save` takes capability
  flags. Window-open allow-list (`shared/externalLinks.ts`) and a stricter CSP. Decision record:
  `docs/security/encryption-at-rest.md`. Not encrypted: attachments, capture files, exports, logs.
- **Updater consent**, [#108](https://github.com/IrminFlow/total/pull/108): `autoDownload` and
  `autoInstallOnAppQuit` are off; the app-level setting `updates` lives in
  `<dataRoot>/app-settings.json`; channels `app:updates:get|set|act`; electron-updater's per-install
  header is replaced by a constant.
- **End-to-end tests (WP 7.4)**, [#110](https://github.com/IrminFlow/total/pull/110): scenarios
  66 to 72, local-date helpers in `scripts/lib/harness.mjs`, `run-e2e.mjs --repeat/--shard/--json`,
  `docs/e2e-coverage.md`. One app fix: Banking, Import could not import MT940 or CAMT.053 files.
- **Documentation.** WP 7.5 docs half ([#106](https://github.com/IrminFlow/total/pull/106): this
  file, `docs/ai-and-privacy.md`, migration guides, features, README); `to-do.md` and the pull
  request triage (WP 7.7, [#113](https://github.com/IrminFlow/total/pull/113)); the owner
  documents in `docs/owner/` (commit `487aea97`, direct to main, no PR).
- `backup:reveal` (viewer) and `backupStamp` local-time backup names:
  [#114](https://github.com/IrminFlow/total/pull/114).
- **Upgrade guard** (`db/migrate.ts` `assertNotNewer`, `db/preUpgrade.ts`): `migrate()` and
  `openCompanyDb` refuse a file with more applied migrations than the build knows
  (`db_newer_version`, before anything is written); backup restore (`assertValidCompanyDb`) and the
  encrypted import refuse one too. Before migrating an EXISTING file (version > 0) `openCompanyDb`
  writes `backups/pre-upgrade-<from>-to-<to>-<YYYYMMDD-HHMMSS>.db` (VACUUM INTO — keyed like the
  books —, quick-checked, fsynced, renamed); no copy → no migration (`db_upgrade_copy_failed`); the
  newest 2 are kept. The restore reopen passes `preUpgradeCopy: false`. A cached perf seed at the
  current version takes no copy; one behind takes one (correct, and large).
  [#116](https://github.com/IrminFlow/total/pull/116)
- **Small fixes** ([#118](https://github.com/IrminFlow/total/pull/118)): binning, restoring,
  purging and maturing a PDC write their audit row inside the same transaction as the change;
  company:open stops waiting for its worker quick_check after 60 s (`OPEN_QUICK_CHECK_TIMEOUT_MS`,
  reported as `not checked (timed out)` and logged; the weekly integrity_check and backup checks
  keep no limit); the unused `GSTR3B_QRMP_DUE_DAY` is gone; backup and pre-upgrade stamps share
  `localStampParts`; new dbtests for an upgrade over several migrations that fails midway (the
  runner was already correct) and for old UTC-named backups (the list reads mtime, not the name).
  Review: pre-upgrade copies are kept per source version (the newest copy of each of the 2 most
  recent), so retries of a failing upgrade — each a copy from the half-upgraded version — no
  longer prune the only copy the previous Total can open; a timed-out open quick_check stays
  visible to `stopChecks` until its thread has exited (terminate cannot interrupt SQLite); the
  on-open auto-purge of the bin commits with its summary audit row too.
- Audit entity `itc_reversal` (`gst:itcReversalApply` / `gst:itcReversalPost`). `SimpleHomeData.gst`
  has optional `pmt06` (regular, quarterly) and `composition` (`CompositionDue`), both additive. The
  `registers` screen takes optional `from` / `to`. `reportPacks.packFolderName`. New pure sentences:
  `billsToPayWhy` (`explainPeople.ts`), `byMonthBarWhy`, `pmt06Why`.
  [#120](https://github.com/IrminFlow/total/pull/120)

## [0.11.0] - 2026-10-13

Simple mode foundation. Existing books open exactly as before, in the accountant view.

### Added

- A setup wizard with plain questions (name and state, kind of business, GST registration, stock,
  start date, new or already running, "Coming from Tally?"). Ready-made accounts per business type.
  [#80](https://github.com/IrminFlow/total/pull/80)
- A simple layout: nine sidebar sections, a header with Search, the assistant and an "Accountant
  view" button; the owner switches the whole company in Settings, "How Total looks".
  [#77](https://github.com/IrminFlow/total/pull/77)
- Simple Home with plain figures for today, each with a "Why?", a "Needs attention" card and task
  buttons. [#83](https://github.com/IrminFlow/total/pull/83)
- "What you had on day one" for a business that was already running, with bill-by-bill customer and
  supplier openings. [#82](https://github.com/IrminFlow/total/pull/82)
- Plain pickers: "This is a: Customer, Supplier, Expense, ...", category tiles, a short new-product
  dialog, "Did you mean ...?" before a near-duplicate, phone and WhatsApp on parties.
  [#81](https://github.com/IrminFlow/total/pull/81)
- A save card with Undo (24 hours, only while nothing depends on the entry) and errors under the
  field that needs fixing. [#79](https://github.com/IrminFlow/total/pull/79)
- A translation layer, a plain-words glossary and a banned-word lint; only English was complete.
  [#75](https://github.com/IrminFlow/total/pull/75)

### Changed (both views)

- GST follows the registration, by date: only a regular registration charges GST; a composition
  business prints a "BILL OF SUPPLY" with the rule 5(1)(f) declaration; an unregistered business
  prints an "INVOICE" with no GST columns; GST screens are hidden for unregistered companies;
  returns and prints use the bill's own date and tax. [#76](https://github.com/IrminFlow/total/pull/76)
- Outstandings are shown as on today (or the period end if earlier). States are listed in GST code
  order. New items start with a blank GST rate. GST rates come from a dated table: 0, 5, 12, 18, 28
  (+3, 0.25) to 21 Sep 2025; 0, 5, 18 (+40, 28, 3, 1.5, 0.25) from 22 Sep 2025; 0, 5, 18 (+40, 3,
  1.5, 0.25) from 1 Feb 2026. Quarterly GST filers can choose quarterly in Company details.
- Enter in any picker selects the highlighted match and never creates; creating needs the down arrow
  or the mouse. [#81](https://github.com/IrminFlow/total/pull/81)
- Tally import no longer drops the opening balance of a ledger whose name already exists: an empty
  opening takes Tally's figure (audited), a different one is kept and warned about, and every clash
  is a warning. [#80](https://github.com/IrminFlow/total/pull/80)

### For developers

- Migrations 046 `undo_groups`, 047 `simple_category`, 048 phone and WhatsApp on parties, 049
  `opening_bills` (bill-wise openings; `services/openingBills.ts` is the one reader and writer).
- Test fix [#78](https://github.com/IrminFlow/total/pull/78).

### Upgrading

Back up first. Four database updates run on first open. There is no downgrade: restore the backup
you made before upgrading. Known limits and UNVERIFIED points (QRMP dates, GSTR-1 amendment
notifications, the 2025/2026 rate slabs read in secondary sources, the GSTR-2B format) are in the
[release notes](https://github.com/IrminFlow/total/releases/tag/v0.11.0).

## [0.10.0] - 2026-10-13

The optional AI assistant (Phase 5) and reporting and data work (Phase 6). The AI is off by default;
nothing is sent unless you accept the data notice and add your own OpenAI key. See
[docs/ai-and-privacy.md](docs/ai-and-privacy.md).

### Added

- AI core: provider layer, read and draft tools, agent loop, masking, Settings, AI.
  [#58](https://github.com/IrminFlow/total/pull/58)
- Docked chat panel (`Cmd+J`), "Explain this" on figures, Ask AI in the palette.
  [#66](https://github.com/IrminFlow/total/pull/66)
- Drafting entries from plain language (drafts open in the normal editor; the assistant saves
  nothing). [#69](https://github.com/IrminFlow/total/pull/69)
- Document capture: a bill photo or PDF becomes a purchase draft; statement categorisation.
  [#72](https://github.com/IrminFlow/total/pull/72)
- Assistants: month-end close checklist, GSTR-2B mismatches, anomalies, report from a question.
  [#71](https://github.com/IrminFlow/total/pull/71)
- Per-company AI memory (proposals only). [#70](https://github.com/IrminFlow/total/pull/70)
- MCP server (`npm run cli -- mcp`, stdio, source checkout only) and agent drafts; files dropped in
  the inbox folder now become drafts instead of posting. [#68](https://github.com/IrminFlow/total/pull/68)
- AI evaluation suite (100+ scored cases). [#73](https://github.com/IrminFlow/total/pull/73)
- Report builder, comparatives, 18 ratios, scheduled report packs, pinned reports.
  [#60](https://github.com/IrminFlow/total/pull/60)
- Excel export everywhere, whole-books export and import, import wizard with preview and undo, Busy
  and Zoho importers (both UNVERIFIED layouts), Tally orders and books-begin date.
  [#59](https://github.com/IrminFlow/total/pull/59)
- Bulk edit with preview and undo, attachments in backups, party notes and tasks.
  [#65](https://github.com/IrminFlow/total/pull/65)
- Group consolidation (AS 21 workings, explicit eliminations, inter-company differences never
  hidden). [#67](https://github.com/IrminFlow/total/pull/67)
- Docs: [#64](https://github.com/IrminFlow/total/pull/64), [#74](https://github.com/IrminFlow/total/pull/74).

### Upgrading

Ten database updates run on first open; in the upgrade test from 0.8.0 every report figure was
unchanged. Going back to 0.8.0 is not supported; restore a backup. Known limits (drafts add no
TDS/TCS, the MCP server needs a source checkout, consolidation is simplified for unrealised profit)
and UNVERIFIED items (default model names, GSTR-1 11th due date, QRMP, GSTR-2B field names, Busy and
Zoho layouts) are in the [release notes](https://github.com/IrminFlow/total/releases/tag/v0.10.0).

## [0.8.0] - 2026-10-08

Phase 4: banking, receivables, payables and cash.

### Added

- Banking: statement import (CSV/TXT, Excel, MT940, CAMT.053, pasted PDF text), learning match
  rules, bulk confirm with undo, cheque books and layouts, post-dated cheques, bulk NEFT/RTGS files.
  [#56](https://github.com/IrminFlow/total/pull/56)
- Receivables: statements, reminder letters, interest on overdue bills (posted as a debit note),
  credit holds with an audited owner override, follow-ups. [#54](https://github.com/IrminFlow/total/pull/54)
- Payables: payment planning, batch payment runs, MSME deadlines and indicative interest, s.43B(h)
  figure, Form 1 data. [#55](https://github.com/IrminFlow/total/pull/55)
- Cash and finance: cash-flow forecast, budgets by cost centre, loans and EMI schedules, forex
  revaluation and settlement. [#57](https://github.com/IrminFlow/total/pull/57)
- Gate and conventions: [#61](https://github.com/IrminFlow/total/pull/61); test fix
  [#53](https://github.com/IrminFlow/total/pull/53).

### Upgrading

Migrations 032 to 035 run on first open. Existing bank dates, cheque numbers and balances were
unchanged in the upgrade test from 0.7.0.

## [0.7.0] - 2026-10-08

Phases 2 and 3 together: manufacturing, stock, the trade cycle, pricing, tax and statutory work.

### Added

- Manufacture voucher with live profit, BOM versions, multi-level explosion, by-products and job
  work. [#37](https://github.com/IrminFlow/total/pull/37), [#40](https://github.com/IrminFlow/total/pull/40)
- One valuation pass for every stock figure (existing books unchanged, proven byte for byte); stock
  movements, stock journal, godown/batch/serial on lines, reorder, ageing, expiry, barcode labels.
  [#35](https://github.com/IrminFlow/total/pull/35), [#38](https://github.com/IrminFlow/total/pull/38)
- Sales and purchase cycle (Orders & challans, off by default): quotations, sales and purchase
  orders, delivery challans, goods receipt notes, returns, three-way match, GRNI/GDNI.
  [#41](https://github.com/IrminFlow/total/pull/41), [#43](https://github.com/IrminFlow/total/pull/43),
  [#45](https://github.com/IrminFlow/total/pull/45), [#48](https://github.com/IrminFlow/total/pull/48)
- Price lists, party-wise rates, discount schemes, tax-inclusive prices, counter billing with an
  80 mm receipt. [#50](https://github.com/IrminFlow/total/pull/50)
- TDS and TCS with effective-dated, cited rates; 26Q / 27EQ data, certificates and challans.
  [#36](https://github.com/IrminFlow/total/pull/36), [#39](https://github.com/IrminFlow/total/pull/39),
  [#44](https://github.com/IrminFlow/total/pull/44)
- GSTR-9 workings, ITC-04, fuzzy GSTR-2B matching, RCM self-invoices, ITC reversal workings.
  [#46](https://github.com/IrminFlow/total/pull/46)
- Fixed-asset register with depreciation. [#42](https://github.com/IrminFlow/total/pull/42)
- Payroll statutory: PF/EPS/EDLI, ESI, state professional tax, salary TDS, ECR.
  [#47](https://github.com/IrminFlow/total/pull/47)
- Audit trail for the MCA rule 3(1) edit log: hash-chained, append-only, retention that cannot be
  disabled. [#49](https://github.com/IrminFlow/total/pull/49)
- NIC client hardened against a fake sandbox (still never run against the real portal).
  [#52](https://github.com/IrminFlow/total/pull/52)
- Conventions: [#51](https://github.com/IrminFlow/total/pull/51).

### Changed

- Blocked credit is reported in GSTR-3B per Circular 170/02/2022 (4(A)(5) and 4(B)(1)); net ITC is
  unchanged.
- Alt+F8 / Alt+F9 open a delivery challan / goods receipt when Orders & challans is on; Ctrl+F8 /
  Ctrl+F9 are credit and debit note.

### Upgrading

Migrations 019 to 031 run on first open (the 0.7.0 release notes list them in two groups: 019 to 025 and 030, then 020, 022, 026 to 029 and 031). Manufacture vouchers saved before the new form keep
their saved costing and are not listed in the new Manufacture register. Every rate, threshold and
form is cited in the code; what could not be verified is listed in the app.

## [0.5.0] - 2026-10-07

Phase 1 of the revamp: correctness, one table everywhere, dashboard, printing, design system.

### Fixed

- **Income and expense ledgers open each financial year at zero** in statements, the trial balance
  and Masters; a stored opening counts only in the books' first year.
  [#21](https://github.com/IrminFlow/total/pull/21)
- **One definition of profit** across P&L, Year-End, balance sheet, cash flow, dashboard and CA pack;
  a closed year reports its real profit; closing journals are flagged and read-only (bin to reopen).
- **Editing a voucher no longer loses data**: invoices, manufacture entries and physical counts
  reopen in the form that created them. [#24](https://github.com/IrminFlow/total/pull/24)
- The ledger form keeps reverse-charge and ITC eligibility; NIC credentials are encrypted with the
  OS keychain and kept outside company files (backups taken before this release still hold them in
  plain text, so take a fresh backup). [#22](https://github.com/IrminFlow/total/pull/22)

### Added

- A shared table everywhere: sort, filters, grouping, saved views, keyboard navigation, export,
  smooth with 50,000 rows. [#23](https://github.com/IrminFlow/total/pull/23),
  [#26](https://github.com/IrminFlow/total/pull/26), [#27](https://github.com/IrminFlow/total/pull/27),
  [#28](https://github.com/IrminFlow/total/pull/28), [#30](https://github.com/IrminFlow/total/pull/30)
- Click a ledger's name to edit it, the rest of the row for its statement.
  [#29](https://github.com/IrminFlow/total/pull/29)
- Search with typed filters (`amt:>50000`, `date:apr`, `type:sales`, `gstin:` ...).
  [#25](https://github.com/IrminFlow/total/pull/25)
- A dashboard Gateway with reconciled figures and charts. [#31](https://github.com/IrminFlow/total/pull/31)
- Invoice templates: Classic, Compact, Modern. [#32](https://github.com/IrminFlow/total/pull/32)
- A design system with tokens, density, an Options drawer (F12) and an accessibility sweep.
  [#33](https://github.com/IrminFlow/total/pull/33)
- Masters shows ledgers under their groups [#20](https://github.com/IrminFlow/total/pull/20);
  collapsible sidebar, recurring vouchers removed [#19](https://github.com/IrminFlow/total/pull/19).
- Baseline and plan: [#12](https://github.com/IrminFlow/total/pull/12); gate
  [#34](https://github.com/IrminFlow/total/pull/34).

### Upgrading

Migration 018 runs on first open. If you closed a year on 0.4.0 the trial balance may show a small
permanent "Profit & Loss A/c (opening)" residual; the books balance and the migration's audit-log
entry explains it.
