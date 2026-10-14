# Moving from Tally

Total reads two XML files that Tally exports: **Masters** and **Day Book / Vouchers**. The import
is best-effort: it applies what it can, skips what it cannot, and lists every skip as a warning.
Code: `src/shared/tally.ts` (parser) and `src/main/services/tallyImport.ts` (apply). Test it on a
copy before you rely on it; the parser was written against exports from the Tally versions we had,
and files from other versions or heavily customised companies may differ (unverified beyond that).
The import is deliberately thin: it brings the chart of accounts, the stock list and the vouchers'
ledger and stock lines, and **nothing bill-wise** (see "What does not import").

## Before you start

1. Take a backup of the Total company you will import into (Settings, Backups). Total also takes
   its own backup just before a real import (`pre-tally-import`, `tally:import` in `src/main/ipc.ts`).
   The screen's preview step is parse-only and writes nothing, so it takes none.
2. In Tally, export **Masters** (groups, ledgers, units, stock items) and then the **Day Book**
   for the period you want, both as XML. One file per export.
3. Decide where to import:
   - **A new company.** At first launch the setup wizard asks "Coming from Tally?". If you answer
     yes, Total creates the company **without** the ready-made accounts, because your Tally books
     are the chart of accounts. It opens the Import from Tally screen after setup.
   - **An existing company.** System, "Import from Tally". Existing ledgers are merged (below).

## Order

Import **Masters first, then vouchers.** A voucher that mentions a ledger Total does not have is
skipped with the warning "unknown ledger ... (import masters first)".

## What imports

| From Tally | In Total |
|---|---|
| Groups (custom ones; Tally's standard groups already exist) | Account groups. A group whose parent is not found is skipped with a warning. |
| Ledgers with opening balances, GSTIN and state | Ledgers (name, group, opening balance, GSTIN, state; no address, PAN, credit terms or bill-wise detail). Tally writes debits as negative amounts; Total converts that, so a Tally debit opening is a Total debit (dr-positive). A ledger whose group is not found goes under Suspense A/c with a warning. |
| Units | Units. |
| Stock items with HSN, GST rate and opening quantity and value | Stock items. An item whose unit Total cannot find gets Total's first unit; it is skipped (with a warning) only if Total has no units at all. |
| Vouchers (sales, purchase, receipt, payment, journal, contra, credit and debit notes ...) | Vouchers, each posted through the normal save (`saveVoucher`), so the posting rules, lock dates and the audit log apply; one exception: the rule that a composition or unregistered company cannot post GST lines is skipped, so history imports as it was. A voucher type Total does not have is created. What is kept: date, number, type, party, narration, the optional (memorandum) flag, ledger lines and stock-item lines. A stock line whose item is not in Total is dropped without a warning, so import Masters first. |
| Delivery and receipt notes | Stock-only challans and GRNs. Ledger entries on them are not imported (they move stock only), with a warning. |
| Sales and purchase orders | Quotations and orders (`trade_docs`). |
| Books-begin date (`BOOKSFROM`, else the first real voucher's financial year) | Sets the company's first year, but only while the company has no vouchers and only an owner can change it; otherwise it warns. |

## What does not import

- **Job-work orders**: skipped.
- **Bill-wise detail.** Vouchers are saved with no bill references, and opening balances come in as one
  figure per ledger, so Tally's bill-by-bill outstandings are not recreated. Afterwards Outstandings
  settles receipts and payments against invoices oldest first on its own; for exact bills use the
  "Opening bills" import target or "What you had on day one" (see
  [from a spreadsheet](from-a-spreadsheet.md)).
- **Cost centres, godowns, batches, TDS details, currencies, references and instrument numbers on
  vouchers**: not carried (the import saves them empty).
- **Optional (memorandum) vouchers** are imported with the optional flag and do not count when working
  out the books-begin date.
- Anything the file does not carry. Check the warnings list, then compare the trial balance with
  Tally's on the same date.
- Tally-specific features with no Total equivalent (for example Tally's own security levels or
  reports) are out of scope.
- Godown and due date are read for lines of sales and purchase orders where the file carries them;
  how well other combinations import has not been tested beyond the files we had (**unverified**).

## Merge rules (when a name already exists)

Applies to ledgers (names compared without regard to upper or lower case). Groups, units and stock
items that already exist by name are left exactly as they are, without a warning (a stock item's
opening quantity and value from Tally are not merged into an existing item):

- **The existing ledger is kept; nothing is duplicated.**
- If the existing ledger's opening balance is empty (zero), it takes Tally's opening balance. This is
  written to the audit log and shown as a warning.
- If it already has a different opening balance, the existing one is kept, and a warning tells you
  to check it against Tally.
- If Tally has it under a different group, it stays where it is, with a warning.

## After the import

1. Read the warnings list.
2. Compare the trial balance as on one date with Tally's. Compare Outstandings by party (the bill
   list will differ, see above).
3. Check the books-begin date and financial year in Company details.
4. If something is wrong and you imported into a copy, delete the copy and try again after fixing the
   source. If you imported into a live company, restore the backup you took.

## Going the other way

Total can write Tally XML (masters and vouchers) in the CA pack, so a CA who stays on Tally can take
the books back. Round-trip fidelity against a live Tally is **unverified**. See
[for a CA receiving a backup](for-a-ca.md).

Related: [Busy, Zoho and spreadsheets](from-a-spreadsheet.md), [features](../features.md).
