# The Total books format

A file your accounts can be read out of without Total.

Everything else this app exports answers somebody else's question. A CSV is a report. A Tally XML
is what Tally will swallow. A `.totalbak` is a SQLite database that this build of this application
can open. None of them is "here are my books, in a form I can still read in ten years" — and a
business whose accounting software is the only thing that can read its accounting data does not
own its accounts.

So: plain JSON, one file, every reference by name, and this page.

Written by **Settings → Backups → Open export**, or the `export:portable` IPC channel. Read back by
**import** on the same panel, which creates a *new* company from the file.

## The guarantee

Export, import into an empty company, export again — the two files are identical, byte for byte
apart from the `exportedAt` stamp. That is not a claim in a document; it is
`src/main/services/portable.dbtest.ts`, which fails the build otherwise, and it is checked in the
end-to-end suite against a real running app (`scripts/e2e/31-data-safety.mjs`).

## What is in it, and what is not

| In | Out |
|---|---|
| Groups, ledgers, opening balances | Payroll runs, employees, attendance |
| Voucher types, units, stock groups, stock items, godowns | Fixed assets and depreciation |
| Vouchers with their lines and inventory lines | Budgets, cost-centre allocations, bank rules |
| The company's name, state, GSTIN, PAN, address, first FY | The audit trail, users and PINs, GST filing records |

The list is stated in every file it writes, under `coverage`, so a reader in ten years does not
have to find this page to know what is missing. Anything not in the table is not in the file: this
is the **books**, not the application's state. For everything, use an encrypted backup — that is a
copy of the database, and it is what a restore restores.

Vouchers in the bin are not exported, nor are post-dated ones that have not matured, nor optional
(memorandum) ones. The file holds exactly what the trial balance shows, which is the only version
of the books that can be checked against anything.

## Shape

```json
{
  "format": "total-books",
  "version": 1,
  "exportedAt": "2026-04-01T10:00:00.000Z",
  "coverage": ["groups", "ledgers", "opening balances", "..."],
  "company": { "name": "Acme Traders", "stateCode": "27", "gstin": null, "pan": null, "address": "", "booksFrom": 2025 },
  "groups":       [{ "name": "Cash-in-hand", "parent": "Current Assets", "nature": "asset", "affectsGrossProfit": false }],
  "ledgers":      [{ "name": "Cash", "group": "Cash-in-hand", "openingBalance": 100000, "gstin": null,
                     "stateCode": null, "address": null, "taxType": null, "gstRate": null, "hsn": null }],
  "voucherTypes": [{ "name": "Receipt", "kind": "receipt", "numbering": "auto", "prefix": "R" }],
  "units":        [{ "name": "Numbers", "symbol": "Nos", "decimals": 0, "uqc": "NOS" }],
  "stockGroups":  [{ "name": "Hardware", "parent": null }],
  "stockItems":   [{ "name": "Widget", "group": "Hardware", "unit": "Numbers", "hsn": "8482", "gstRate": 18,
                     "cessRate": null, "openingQtyMilli": 10000, "openingValue": 500000 }],
  "godowns":      ["Main Location"],
  "vouchers": [
    {
      "type": "Receipt", "number": "R1", "date": "2026-04-01",
      "party": null, "narration": "Counter sale", "reference": "REF-9",
      "lines": [
        { "ledger": "Cash",  "drCr": "dr", "amount": 55500 },
        { "ledger": "Sales", "drCr": "cr", "amount": 55500 }
      ],
      "inventory": [
        { "item": "Widget", "godown": null, "qtyMilli": 2000, "ratePaise": 50000, "amount": 100000, "direction": "out" }
      ]
    }
  ]
}
```

## The rules a reader can rely on

**Money is an integer number of paise.** `55500` is ₹555.00. There are no decimals anywhere in
this file and never will be: a rupee written as a float is a rupee that can be out by a paisa, and
a trial balance out by a paisa is indistinguishable from one out because of a real bug.

**Quantities are integer thousandths** (`qtyMilli`). `2000` is 2. `1500` is 1.5 kg.

**Dates are ISO `YYYY-MM-DD`**, with no clock attached. `booksFrom` is a financial-year start
year: `2025` means FY 2025-26, which runs 1 April 2025 to 31 March 2026.

**Amounts are always positive; the side is `drCr`.** There are no negative amounts. A voucher
balances when its debits equal its credits, exactly, in integers — and an importer that finds one
that does not must refuse the file rather than import books that do not foot. This one does.

**References are by name, never by number.** Row ids are an implementation detail of whichever
database happened to write the file; names are what the business calls things. Names are unique
within their kind, case-insensitively.

**Order is canonical.** Everything is sorted by name, except vouchers, which are sorted by date,
then type, then number; and groups, which come parents-first so an importer can insert them in
file order. This is what makes two exports comparable.

## Reading one yourself

The whole file is a single JSON object, so anything can read it. To foot the books in it:

```bash
jq '[.vouchers[].lines[] | select(.drCr == "dr") | .amount] | add' books.json
jq '[.vouchers[].lines[] | select(.drCr == "cr") | .amount] | add' books.json
```

Those two numbers are equal in any file this app has written. If they are not, the file has been
edited, and Total will refuse to import it.

## Versions

`version` is `1`. A build reads only the version it knows and says so plainly rather than guessing
at a file from the future. When a field is added, the version goes up and this page gains a
section; fields are not silently repurposed, because a document format whose meaning drifts is a
document format that cannot be trusted at ten years' distance, which is the only distance at which
this one matters.
