# Features

What Total does, section by section, for someone deciding whether it fits. Total is a Mac desktop app
(Electron) that keeps one SQLite file per company on your computer. It has two views of the same
books: **simple mode** (plain words, a short sidebar) and the **accountant view** (every screen, in
accounting terms). Any simple screen has an **Accountant view** button; see
[moving to simple mode](migration-guides/from-0.10-to-simple-mode.md).

Windows: see docs/windows.md (WP 7.3, not yet written). CI builds a Windows installer, but this
repository does not yet document or support it as a release target (unverified end to end).

Some sections below describe screens that are merged but not yet in a tagged release; the
[changelog](../CHANGELOG.md) says which. Tax rules and rates are cited in the code, and anything not
checked against the official text is marked UNVERIFIED there. Total prepares figures and files; you file
on the government portals. Privacy: [AI and privacy](ai-and-privacy.md).

## Simple mode

The simple sidebar has nine sections. Stock appears only when you keep stock.

### Home
Today's cash and each bank, money in and out today, what customers owe and what you owe, profit this
month and this year so far, and (for a regular GST registration) GST to pay. Every figure has a "Why?"
sentence and a link to the report behind it. A "Needs attention" card lists overdue bills and
month-end checks. Four buttons start the common jobs. An empty company shows the next setup step.
Screens: Home (the Gateway), "What you had on day one" (Openings).

### Sell
Make a bill for products or just an amount, to a named or cash customer, paid in full, partly, by
cash, UPI, card, bank transfer, or on credit. A quick bill for walk-in counter sales (shown when you keep stock), a sales list,
and Return a sale (give money back or keep it as credit). After saving, a card offers Print, PDF,
Share and Undo (for 24 hours, while nothing depends on it). Screens: Make a bill, Quick bill, Sales
list, Return a sale.

### Buy
Record a supplier's bill with its number and date, products or just an amount, paid now or later. The
same supplier and bill number twice in a year is refused. A business that cannot claim GST books the
GST as cost. "Snap a bill" (photo or PDF to a purchase draft) needs the optional AI helper and opens the full app's Capture screen. Screens:
Record a purchase, Purchase list, Return a purchase.

### Money
Money in (from a customer, owner's money, a loan, other income), Money out (to a supplier, an expense,
drawings, a loan), and Move money between cash and bank. Open bills are listed oldest first and ticked
as far as the amount goes. Bank: drop a statement file, answer "What is this?" for each line, and see
whether the bank agrees with your books in one sentence. PDF statements cannot be read yet. Screens:
Money in, Money out, Move money, Money in and out (list), Bank.

### Stock
Products with quantity on hand, worth, selling price and a "Running low" flag; a page per product;
count your stock and record the difference; Made goods (make a product from materials).
Shown only when you keep stock. Screens: Products, a product page, Count your stock, Made goods.

### People
Every customer and supplier with what they owe or are owed, late bills, days they take to pay, phone
and WhatsApp, a page per person, a reminder to send, and "bills to pay" for suppliers. Screens:
People, Person.

### Reports
"How is my business doing" for this month, last month, this year or dates you pick, as one column from
sales to profit, with the change from the previous period; cash in the next 30 days; who owes me and
whom I owe; sales and purchases by month; and a "For your CA" list (trial balance, P&L the accountant's
way, balance sheet, cash flow, CA pack, Excel). Screens: Reports and the report pages.

### Taxes
For a regular GST registration: GST collected, GST on purchases (and how much awaits GSTR-2B
confirmation), and the cash to pay, with the GSTR-1 and GSTR-3B dates; five steps to file (bills that
may be missing, supplier bills against GSTR-2B, prepare the files, the portal steps, mark as filed
with ARN and date). Composition and unregistered businesses see only what applies to them. TDS and TCS
show if you turned them on. Quarterly filers are supported; the GSTR-3B date by state is partly
UNVERIFIED. Screens: GST to pay and file.

### Settings
Business details, bills and printing, backups, people and roles, features ("Turn on" cards), how Total
looks (simple or accountant view, theme, language), the AI helper, and Advanced (the full Settings).
Hindi and Hinglish are complete for simple mode but machine-drafted and pending native review.
Screens: Settings and its simple pages.

### Ask Total
Type a question ("who owes me?", "profit this month", "stock of rice") or a short entry ("paid 2,500
rent in cash") with `Cmd+J`. It answers from the same figures the screens show, with no key and no
network, understands some Hinglish, and asks which Ramesh you mean instead of guessing. If you added
an AI key, harder questions can go to the AI helper. Screen: the Ask Total panel.

### Help
A first-run tour, empty states that explain what to do, and a built-in help panel (`?` or `Cmd+/`) with
16 offline articles. Screens: Help & tour, the help panel.

## Accountant view

The sidebar sections of the full app (`NAV_SECTIONS` in `src/renderer/src/lib/screens.ts`):

### Gateway, Voucher entry, Day book, Masters
A dashboard with reconciled figures; the Tally-style voucher editor (sales, purchase, payment, receipt,
journal, contra, credit and debit notes, stock journal, physical stock) with live GST and keyboard
entry; the day book; ledgers, groups, stock items, units, godowns, currencies, price levels. Counter
billing is a barcode-first POS. Manufacture is the production voucher (BOM versions, by-products, job
work).

### Orders and challans (off by default)
Quotations, sales and purchase orders, delivery challans and goods receipt notes, returns, the linked
chain, pending reports, three-way match, GRNI/GDNI. Turn it on in Features.

### Books
Trial balance, Profit & Loss, Balance sheet, Cash flow, Stock summary and movements, Stock journal,
Fixed assets with depreciation, Year-end close, Registers. Everything is computed from vouchers at the
moment you open it.

### Analysis
Outstandings with ageing, Credit control, Payables (with MSME tracking), Group consolidation, Cost
centres, Budgets, Cash-flow forecast, Loans and EMIs, Forex, Report builder, Ratio analysis, Assistants
(month-end checklist, GSTR-2B mismatches, anomalies) and Exceptions.

### Banking
Reconciliation, statement import (CSV, Excel, MT940, CAMT.053, pasted PDF text), cheque books and
post-dated cheques, bulk payment files, and document capture (bills to purchase drafts, needs the AI
helper).

### Payroll (off by default)
Employees, salary structures, monthly pay runs with PF, ESI and professional tax, salary TDS, payslips.

### GST
GSTR-1, GSTR-3B, GSTR-9 workings, ITC-04, ITC reversal workings, GSTR-2B reconciliation, e-invoice and
e-way bill JSON for the government offline tools (optional live filing is experimental and never run
against the real portal), TDS, TCS.

### System
Settings, the audit trail (an append-only, hash-chained edit log), import from Excel/CSV/Busy/Zoho,
export books to Excel, import from Tally, company details, users and roles, backups (including
encrypted export), and the optional AI and agent (MCP) settings. See [migration guides](migration-guides/from-tally.md).
