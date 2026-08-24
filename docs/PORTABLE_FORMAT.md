# Total portable package — schema v1

The portable JSON export is the product's exit guarantee. It can be created from **Company details → Export portable JSON** without vendor assistance and opened with any JSON tool.

## Contract

- `schema`: always `total.portable`.
- `schemaVersion`: currently `1`.
- `company`: legal identity and financial-year settings.
- `entities`: arrays of masters, vouchers, voucher lines, inventory movements, bill references, tax periods, sales/purchase documents, payroll results and audit evidence.
- `manifest.counts`: row count for every exported entity.
- `manifest.sha256`: content identity for integrity checks.
- Amounts are integer paise. Quantities are integer thousandths. Derived balances are intentionally absent and can be recomputed from `voucher_lines`.

PIN hashes, provider credentials and session tokens are excluded. File attachments remain ordinary files in the company folder; attachment lineage is exported as metadata.

## Offline schema upgrade

```sh
node scripts/migrate-portable.mjs old-package.json upgraded-v1.json
```

The CLI never opens or edits a company database. It writes a new package and prints every transformation plus entity counts.

## Leaving Total

The package contains the accounting records needed to reconstruct ledgers, vouchers, inventory, open bills, GST evidence and audit history. CSV/PDF exports remain available for human-readable handoff, while this JSON package provides the complete machine-readable handoff.
