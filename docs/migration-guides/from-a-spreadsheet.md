# Moving from a spreadsheet (and Busy or Zoho)

Total reads Excel (`.xlsx`) and CSV files through the import wizard (WP 6.3). Code:
`src/shared/xlsx/` (reader and writer), `src/shared/dataImport/` (what each sheet means) and
`src/main/services/dataImport.ts` (apply). The wizard is under System, "Import from Excel / CSV /
Busy / Zoho Books".

## What you can bring in

Each kind of data is a "target" with its own columns (`src/shared/dataImport/targets.ts`):

- **Masters:** account groups, ledgers, parties (customers and suppliers), units, stock groups,
  godowns, stock items, batches, price lists, price levels, cost centres, voucher types.
- **Balances:** opening balances, opening bills (bill-by-bill openings for a party), opening stock.
- **Transactions:** vouchers, quotations and orders, bank statement lines.

## The usual route

1. **Start with a sample.** Export a few rows from Total (Export books to Excel, below) and put your
   data in the same layout. This is the most reliable way to get column names right.
2. **Run the wizard.** Pick the file, pick the target. Total detects the header row and proposes a
   column mapping you can change.
3. **Read the preview.** The preview is a real dry run: it runs the same code as the real import and
   rolls it back, so the counts and errors (posting rules, duplicate numbers, a locked period) are the
   real ones.
4. **Choose the duplicate rule** (skip, update or create) and whether to create missing ledgers.
5. **Choose what to do about opening balances that do not match.** After every step of the run, debits
   and credits of the openings must be equal. Options: **stop** (the whole run is refused and nothing
   is kept; this is the default), post the difference to a **suspense** account, or **leave** it (the
   balance sheet then shows "Difference in Opening Balances").
6. **Apply.** The whole run is one transaction; each record is applied in its own savepoint, so a bad
   row is reported and the rest go in.
7. **Undo** is available for the batch. It removes or restores what the import created and leaves
   records you have edited since alone.

Every voucher goes through the normal save, so an import cannot store something the screens would
refuse, and it appears in the audit log.

## Opening balances, bill by bill

A party's opening can be split into bills (Opening bills target). The bills must add up to the party's
opening on its side; the writer refuses otherwise. Bills with no number become "Opening", "Opening 2",
... in date order. This is what makes Outstandings and reminders work bill by bill from day one. For
a simple-mode company the same data is entered in plain steps (Settings, "What you had on day one").

## Busy and Zoho Books

The wizard has importers for Busy (from its export templates) and Zoho Books. Both are marked
**unverified**: Busy layouts vary by installation and Zoho columns beyond the GST fields come from
published sample exports. Check the preview carefully and import a small period first
(`src/shared/dataImport/busy.ts`, `zoho.ts`).

## Round trip: export the whole books to Excel

System, "Export books to Excel" writes the whole company as one workbook. Importing it into a new
company gives the same books: a test compares a canonical dump of every table before and after
(`src/main/services/booksFidelity.dbtest.ts`). Fields without a column ride in a "... (JSON)" cell
so nothing is lost. Records are matched by their exported Source ID first, then by type and number
within the financial year. This is also the way to take a copy of a company to another computer or to
hand books to someone who is not running Total.

## Every list can be exported

Every table screen exports its current view to Excel (money is kept exact, not rounded through
floating point) or CSV.

## What to check afterwards

1. Trial balance against the spreadsheet's totals as on one date.
2. Outstandings by party.
3. Stock summary against your count.
4. The import batch's warnings.

Related: [from Tally](from-tally.md), [for a CA](for-a-ca.md), [features](../features.md).
