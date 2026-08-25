# Synthetic migration fixtures

These small, deterministic exports exercise Total's Busy, Marg, Zoho Books and generic spreadsheet importer contracts. The DB test maps each source file, posts it through the transactional import service, reconciles rows and debit/credit totals, then links the result to Total's checksummed migration certificate.

Run the fixture suite with:

```bash
node scripts/test-db.mjs migrationAcceptance
```

The ordinary migration-workbench suite separately covers CSV, TSV and generated XLSX containers, including corrupt and oversized workbooks.

Passing synthetic fixtures proves importer behavior only. Public-release acceptance still needs representative customer exports and a named reviewer comparing opening balances, vouchers, receivables, payables, stock, taxes and attachments.
