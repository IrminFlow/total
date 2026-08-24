---
name: total-books
description: Read and post entries into the Total accounting app's books (offline, ~/Documents/total). Use when asked to record transactions, import ledgers/items, check balances or receivables, or reconcile books managed by Total. Reads CSV/JSON mirrors; writes go through Total's own validation (double-entry, period lock) via the CLI or the inbox drop-folder.
---

# Total books — agent access

Total is a fully offline double-entry accounting app (Electron + SQLite). Its data root is
`~/Documents/total/` (or `$TOTAL_DATA_DIR`). You never touch the SQLite files — you read the
CSV/JSON **mirrors** and write through two validated surfaces (CLI, inbox). Every write runs the
exact same zod schema + posting validation + period lock as the app's UI and is audit-logged as
`agent-cli` / `agent-inbox`.

For MCP-capable clients, prefer `npm run mcp` from a source checkout, or run the installed
`/Applications/Total.app/Contents/Resources/total-mcp.mjs` with Node on macOS. First issue a
company-bound, expiring token in Total → Settings → Agent access and supply it as
`TOTAL_MCP_TOKEN`; set `TOTAL_MCP_CLIENT` to a descriptive client name. The server exposes a
versioned capability contract and separately scoped mirror, attachment, refresh-request and
proposal tools. Proposals land in `companies/<slug>/proposals/` and cannot affect the books until a
signed-in accountant approves the exact JSON in Total. A refresh request is likewise inert until
an owner approves it in the app.

## Non-negotiables

1. **Amounts are integer paise** (₹1 = 100 paise): `150000` = ₹1,500.00. Never floats, never rupees.
2. **Quantities are integer milli-units** (`qtyMilli`: 1000 = 1 unit).
3. **Debits must equal credits — the app rejects everything else.** Sum of `dr` line amounts must
   exactly equal sum of `cr` line amounts in every voucher.
4. Dates are `YYYY-MM-DD`; a voucher dated on or before the company's lock date is rejected.
5. Never open/edit `companies/<slug>/company.db` — it may be live in the app.

## Finding companies

- Registry: `<data-root>/total.json` → `companies: [{ slug, name, stateCode, gstin }]`.
- Or run `npm run cli -- companies` from the Total repo checkout.

## Reading the books (mirror: `companies/<slug>/agent/`)

Regenerate first if stale (`generatedAt` in `meta.json`): `npm run cli -- export --company <slug>`.

| File | Contents |
|---|---|
| `ledgers.csv` / `ledgers.json` | Every ledger: id, name, group, opening balance (paise), GSTIN, HSN |
| `items.csv` | Stock items: id, name, unit, HSN, GST rate, opening qty (milli) / value (paise) |
| `vouchers-<FY>.json` | Full vouchers per financial year (e.g. `vouchers-2025-26.json`), lines in paise |
| `trial-balance.json` | `{ asOn, rows, totalDebit, totalCredit }` — totals always tie |
| `outstandings.json` | `{ receivable, payable }` bill-wise with 0-30/31-60/61-90/90+ ageing buckets |
| `meta.json` | `schemaVersion`, `generatedAt`, **`voucherTypes` (id → name/kind — needed for posting)**, file list |

## Writing — CLI (preferred; works app-open or app-closed)

From the Total repo checkout (`npm run cli -- help` for everything):

```bash
npm run cli -- post --company <slug> --file voucher.json         # single voucher or array
npm run cli -- import-masters --company <slug> --file x.csv --kind ledgers|items
npm run cli -- next-number --company <slug> --type <name-or-id>
npm run cli -- trial-balance --company <slug> [--as-on YYYY-MM-DD]
npm run cli -- export --company <slug>                           # refresh the mirror
```

Results are JSON on stdout, one result object per voucher: `{ "index": 0, "ok": true, "id": 42,
"number": "5", "date": "...", "total": 150000 }` or `{ "ok": false, "error": "why" }`. Non-zero
exit code = at least one failure. Partial success is possible for arrays — retry only the failures.

### Voucher JSON shape (full reference: `voucher.schema.json` in the data root)

Minimal balanced example — ₹1,500 cash receipt against a sales ledger:

```json
{
  "voucherTypeId": 3,
  "date": "2025-07-15",
  "narration": "Cash sale — posted by agent",
  "lines": [
    { "ledgerId": 1, "drCr": "dr", "amount": 150000 },
    { "ledgerId": 12, "drCr": "cr", "amount": 150000 }
  ]
}
```

- `voucherTypeId`: from `meta.json` → `voucherTypes` (kinds: sales, purchase, receipt, payment,
  contra, journal, credit_note, debit_note, stock_journal, physical_stock).
- `ledgerId`: from `ledgers.json`. `partyLedgerId` for sales/purchase/receipt/payment parties.
- Optional: `number` (omit → auto), `reference`, `billRefs` (`{kind: "new"|"against", name,
  amount, dueDate}`), `inventory` (`{stockItemId, qtyMilli, ratePaise, amount, direction}`),
  `tds`, `currencyCode`+`exchangeRate`.
- A file may contain one voucher object **or an array** of them.

## Writing — inbox drop-folder (only while the app is running with Settings → Agent bridge ON)

Drop into `companies/<slug>/inbox/`:

- `*.json` — voucher (or array). **Atomic per file**: one bad voucher rolls back the whole file.
- `*.csv` — masters import; header row decides ledgers vs items (use the same headers as
  `import-masters` templates: `Name,Group,Opening Balance,...` / `Name,Group,Unit,HSN,...`).
  **Atomic per file** too: one bad row rolls back the entire CSV.
- Keep drops under **5 MB** (bigger files are rejected — split into smaller batches), and prefer
  writing atomically: write to a temp name outside `inbox/`, then rename in. The watcher tolerates
  in-place writers by re-reading while the file is still changing, but rename is race-free.

Outcomes (watch the folder):

- Success → file moves to `inbox/processed/<timestamp>-<file>`.
- Failure → file moves to `inbox/failed/<file>` and `inbox/failed/<file>.error.txt` says exactly
  what to fix (validation messages, line numbers for CSV). Nothing was applied.

If a dropped file just sits there, the app isn't running or the Agent bridge toggle is off — use
the CLI instead.

## Error semantics (both surfaces)

- Unbalanced voucher → rejected: "debits (X) and credits (Y) differ by Z paise".
- Unknown `ledgerId`/`voucherTypeId` → rejected with the id named.
- `date <= lock date` → "Books are locked up to YYYY-MM-DD" (ask the user before changing locks).
- Zod shape errors name the exact field path, e.g. `lines.0.amount: Expected integer`.

## Verify after writing

Always close the loop: re-run `trial-balance` (totals must tie and move by exactly what you
posted) or re-`export` and read `vouchers-<FY>.json` back.

## Install as a Claude Code skill

Copy this folder to `~/.claude/skills/total-books/` (keep SKILL.md at its root). The companion
files `AGENTS.md` + `voucher.schema.json` are also written into the data root by
`npm run cli -- init-agent-docs`, so agents pointed only at `~/Documents/total` self-discover
this contract.
