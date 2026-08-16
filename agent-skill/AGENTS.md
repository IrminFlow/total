# Total — agent access to the books in this folder

This folder (`~/Documents/total/` unless `TOTAL_DATA_DIR` overrides it) holds the books of the
**Total** accounting app. You (an AI agent / script) can read the books as CSV/JSON and post
entries — but **never** edit `company.db` files directly (they are live SQLite databases; the app
may have them open). Use the two supported surfaces below. Every write goes through the exact same
validation as the app's own UI (zod schema + double-entry posting rules + period lock) and is
audit-logged as `agent-cli` / `agent-inbox`.

## Ground rules

- **Amounts are integer paise** (₹1 = 100 paise). `150000` means ₹1,500.00. Never send floats.
- **Quantities are integer milli-units** (`qtyMilli`, 1000 = 1 unit).
- **Debits must equal credits** — the app rejects everything else.
- Dates are `YYYY-MM-DD`. Vouchers dated on or before the company's lock date are rejected.

## Layout

```
total.json                      company registry: [{ slug, name, ... }]
AGENTS.md                       this file
voucher.schema.json             JSON schema for the voucher shape accepted below
companies/<slug>/
  company.db                    SQLite — DO NOT TOUCH
  agent/                        read mirror (regenerate with the CLI `export` command)
    ledgers.csv / ledgers.json  all ledgers with ids, groups, opening balances (paise)
    items.csv                   stock items with ids, units, HSN
    vouchers-<FY>.json          e.g. vouchers-2025-26.json — full vouchers per financial year
    trial-balance.json          { asOn, rows, totalDebit, totalCredit } (paise)
    outstandings.json           { receivable, payable } bill-wise, with ageing buckets
    meta.json                   schemaVersion, generatedAt, voucherTypes (id -> name/kind), files
  inbox/                        write drop-folder (only processed while the app runs with the
                                Agent bridge setting ON — otherwise use the CLI `post` command)
    <anything>.json             voucher (or array of vouchers) matching voucher.schema.json
    <anything>.csv              masters import (ledger or item CSV, template headers)
    processed/<ts>-<file>       success — file is moved here
    failed/<file> + <file>.error.txt   failure — error text explains exactly what to fix
```

## CLI (works whether or not the app is running)

Run from a checkout of the Total repo (`npm run cli -- <command>`):

```
npm run cli -- companies
npm run cli -- export        --company <slug> [--what masters|vouchers|reports|all] [--format csv|json|all] [--from YYYY-MM-DD --to YYYY-MM-DD]
npm run cli -- post          --company <slug> --file voucher.json     # single object or array
npm run cli -- import-masters --company <slug> --file x.csv --kind ledgers|items
npm run cli -- trial-balance --company <slug> [--as-on YYYY-MM-DD]
npm run cli -- next-number   --company <slug> --type <name-or-id>
npm run cli -- create-company --name "My Co" --state 27
npm run cli -- init-agent-docs
```

Output is JSON on stdout; a non-zero exit code means at least one item failed (the JSON says which
and why). Set `TOTAL_DATA_DIR` to point at a different data root.

## Posting a voucher — worked example

1. `export --company demo-traders --what masters` then read `agent/ledgers.json` for ledger ids and
   `agent/meta.json` → `voucherTypes` for the voucher type id.
2. Write `voucher.json` (this one is balanced — 150000 dr == 150000 cr, i.e. ₹1,500 cash sale):

```json
{
  "voucherTypeId": 5,
  "date": "2025-07-15",
  "narration": "Cash sale — posted by agent",
  "lines": [
    { "ledgerId": 1, "drCr": "dr", "amount": 150000 },
    { "ledgerId": 12, "drCr": "cr", "amount": 150000 }
  ]
}
```

3. `post --company demo-traders --file voucher.json` → `[ { "index": 0, "ok": true, "id": 42, "number": "5", ... } ]`
   (on failure: `{ "ok": false, "error": "Voucher does not balance: ..." }` — fix and retry).
4. Verify: `trial-balance --company demo-traders` — `totalDebit` always equals `totalCredit`.

Full field reference: `voucher.schema.json` in this folder.
