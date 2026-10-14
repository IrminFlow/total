# For a CA who has been sent a Total backup

You have been given a Total backup by a client. This page covers opening it, checking it, and
reporting on it. Total runs on macOS; for Windows see docs/windows.md (WP 7.3, not yet written at the
time of this page).

## Opening it

You need Total installed (the GitHub releases page has the macOS DMG).

- **An encrypted backup** (the client used Settings, Backups, "Export encrypted..."): on the screen
  where you pick a business, choose **Import encrypted backup...** and type the passphrase the client
  gave you. It creates a company in your own copy. Your copy is separate from the client's.
- **A plain backup** (the automatic and "Back up now" copies in the company's folder): Total has no
  "open this backup file as a new company" button. Settings, Backups, "Restore..." (owner only,
  type RESTORE) replaces the books of the **open** company with a backup from that company's own
  list, keeping a pre-restore copy. So ask the client for an **encrypted export**, which is the
  route that creates a separate company on your computer. The help article
  ["Backups"](../../src/renderer/src/help/en/backups.md) lists the current steps.
- Do not copy a backup into `~/Documents/total/companies/` by hand unless you know the app version
  matches. The database is upgraded on first open and an older Total cannot read it back (this
  by-hand route is not a supported feature; it is unverified).

Secrets (the client's AI key, e-invoice credentials) are never in a backup, so you cannot see them and
nothing can call out on the client's behalf from your copy.

## Reading the books in the usual way

Switch the company to accountant view if it opens in simple mode (Settings, "How Total looks", if you
are the owner; otherwise use the "Accountant view" button on a screen). Then:

- **Trial balance, P&L, balance sheet, cash flow** are all computed from the vouchers at the moment
  you open them. There are no stored balances to disagree with.
- **Ledger statements and Day book** drill from any total to the voucher.
- **GST**: GSTR-1 and 3B workings, GSTR-2B reconciliation, GSTR-9 workings, ITC-04. The client's
  "I've filed" marks (ARN and date) are in the simple Taxes screen.
- **TDS and TCS** screens carry the section, rate and its source citation for every rate.
- **Outstandings** are bill by bill; Payables show MSME dues.

## Checking the audit trail

Total keeps an edit log meant to meet the MCA rule 3(1) requirement. The Audit trail (Settings, Audit
trail, and System, Audit trail) lists
every change with before and after values, who made it, and a per-row hash check. The log is
append-only and hash-chained, so a change to an old row breaks the chain, and the screen says so.
Retention cannot be switched off while the "audit trail required" setting is on (the default). The
chain makes edits to the company file evident; it cannot prevent them, because the file is an ordinary
SQLite database on the client's computer (the pack's verification summary says the same). Compare the
chain head hash across exports.
Whether this satisfies your professional view of the audit trail requirement is your judgement; the
code and the sources are in `src/main/services/audit.ts` and `src/shared/auditChain.ts`.

## The CA pack

Reports, "For your CA" (or Registers, CA pack in the full app) writes a folder you can take away:
day book, trial balance, P&L, balance sheet, sales and purchase registers, outstandings, GSTR-1 JSON,
TDS 26Q and TCS 27EQ data when present, a ledger-wise CSV, an audit-trail CSV with a verification
summary (`audit-trail-verification.txt`, "VERIFIED" or "BROKEN" and the chain head hash), and Tally
masters and vouchers XML so you can continue in Tally (`src/main/services/caPack.ts`; the exact
file list can grow; whether the XML imports cleanly into every Tally version is **unverified**).

## Giving a CA access without a backup

Settings, "People & roles" lets the owner add users with a role (owner, accountant, viewer) and a PIN.
A viewer can read everything and change nothing. The AI helper and the MCP server are off by default
and separately controlled; see [AI and privacy](../ai-and-privacy.md).

## Things to know when you review

- Profit for any period is defined once (`pnlLedgerAmounts` in `src/main/services/reports.ts`) and
  excludes year-end closing journals. Income and expense ledgers open each financial year at zero.
- A closed year's closing journal is read-only; moving it to the bin reopens the year.
- Vouchers are deleted into a bin, not removed; a restore is possible.
- Rates and due dates are cited in the code; anything not checked against the official text is marked
  UNVERIFIED there and listed in [CHANGELOG.md](../../CHANGELOG.md).

Related: [from Tally](from-tally.md), [from a spreadsheet](from-a-spreadsheet.md).
