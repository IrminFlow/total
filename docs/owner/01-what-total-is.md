# Total — what it is, who it is for, and everything it does

*15 October 2026 · written for the owner · plain English*

This document explains Total from the top: what it is, who it is for, the two ways of using it, everything each way can do, what makes it different, and what it cannot do yet. It ends with a short word list.

The latest tagged version is 0.11.0 (13 October 2026). Much of what is described below is already merged into the main code but not yet in a tagged release. The changelog's "Unreleased" section lists those parts.

---

## 1. The short answer

**Total is an accounting app for small Indian businesses that works fully offline.** It runs on a Mac today, and a Windows version is built and tested automatically. There is no cloud and no online account. You do not sign up for anything. All of a business's books sit on the owner's own computer, in a folder called `Documents/total`. One file holds one business.

**Why it was built.** Tally is the standard accounting software in India. It is powerful and correct, but it expects you to know accounting. Most shopkeepers do not. Two plans in the repository set the direction:

- The first plan (7 October 2026) set out to make Total as complete and correct as Tally. That meant GST returns, stock, manufacturing, banking, payroll, an audit trail and optional AI.
- The second plan (13 October 2026, "Simple for everyone") set the goal: *someone who has never used Tally, and knows no accounting, law or tax, can run a shop, trade, practice or small factory in Total without a course.* The books, GST and the audit trail must stay exactly as correct as before.

**Who it is for.**

- Shopkeepers and retailers
- Traders and wholesalers
- Service businesses (consultants, agencies, repair shops, clinics)
- Restaurants and food businesses
- Small manufacturers who make goods from materials
- The accountants and CAs (chartered accountants) who look after these businesses' books and taxes

---

## 2. The two modes

You asked for "a professional mode for people who want full control and a basic mode for people who want easy finance". **Total already has exactly this.**

| What you asked for | What it is called in the app today |
|---|---|
| Basic mode (easy finance) | **Simple** mode |
| Professional mode (full control) | **Accountant** mode, also called "the full app" or "Accountant view" |

**How a business gets its mode.**

- When someone creates a new business, the **setup wizard** asks a few plain questions. By default the new business starts in Simple mode.
- On the last step there is a choice: "I have an accountant — show the full app". Picking it starts the business in Accountant mode instead.
- Businesses made before Simple mode existed open in Accountant mode, exactly as they always did. Nothing changed for them.
- The owner can switch a business between the two at any time in **Settings → How Total looks**. Only the owner can do this.

**Moving between them screen by screen.**

- Every Simple screen has an **Accountant view** button. It opens the same thing in the full app, for example the full bill editor with your answers already filled in. This is a one-off by default.
- On most screens a small menu beside it offers **"Always open the full app for this"** if a user prefers the full screen for one job. Reports and Taxes do not have that menu yet.
- Every full-app screen reached from Simple mode has **Back to simple**, which returns to the matching Simple screen with the same bill, person or report.

**A naming decision for you.** The app calls the modes "Simple" and "Accountant". You might prefer "Basic" and "Professional". Things to weigh:

- "Simple / Accountant" tells a shopkeeper who the full app is *for*. It says "your accountant uses this one", which reassures beginners.
- "Basic / Professional" may sound more neutral. But "Basic" can feel like a cut-down product, and Simple mode is not cut down. It writes the same complete books.
- Renaming is a text change in the app, help articles, Hindi and Hinglish translations, and documents. Nothing has been renamed. This is your call.

The rest of this section describes each mode in full.

---

### 2A. Simple mode (the basic, easy one)

Simple mode uses plain words. Accounting words are banned from its screens, and an automatic check enforces this. The banned words include voucher, ledger, journal, Dr/Cr, sundry and godown. The sidebar has up to nine sections, and the Stock section shows only for businesses that keep stock.

#### Getting started

- **Setup wizard.** It asks for the business name and state, then the type of business: retail, trader, services, manufacturer, restaurant or other. Then it asks about GST: regular, composition, not registered, or "not sure", which it explains. Then whether you keep stock, and when your books start.
  - Each business type comes with a **preset**: a ready set of accounts, units (such as "Plate" for a restaurant) and features switched on or off. Nobody has to build a chart of accounts.
  - It asks "Coming from Tally?" and can open the Tally import straight after.
  - The language (English, Hindi or Hinglish) is asked first. On a computer set to Hindi, the wizard starts in Hindi.
  - "Try with sample data" makes a demo business called Demo Traders to play with.
- **What you had on day one.** A business that is not starting fresh enters what it already had: cash, bank balances, what customers owed, what it owed suppliers, stock, loans and equipment. Each customer's old bills can be entered one by one. Total then works out the owner's money so the books balance, and says this in one sentence before saving.
- **First-run tour.** Four steps over Home show + Sale, Money in, who owes you, and Back up now. It runs once and can be replayed from Help.

#### Home

- Tiles show today's cash and each bank, money in and out today, what customers owe you, what you owe, and profit this month and this year so far.
- For a regular GST business, a tile shows GST in three separate figures: GST on your sales, GST on your purchases (and how much the government portal has not yet confirmed), and the cash still to pay.
- **Every figure has a "Why?" link.** It shows a sentence that explains the number. For example, "₹4,200 is what 3 customers still owe you; the oldest is Ramesh, 12 days." A link opens the full report behind it. These sentences are worked out from the figures by the app, never written by AI.
- A **"Needs attention"** card lists late bills, month-end checks, products running low or below zero, and a reminder when the last backup is over a week old.
- Four buttons start the daily jobs: + Sale, + Purchase, + Money in, + Money out.
- An empty business shows one card, "Nothing recorded yet", with the next setup step instead of a row of ₹0 tiles.
- An **Ask Total** search box sits on Home.

#### Sell

- **Make a bill.** Bill products or "just an amount" to a named customer or a walk-in "Cash customer". Then answer "Paid how?": Cash, UPI, Card, Bank transfer, On credit, or Partly paid.
  - Prices come from the price list. You can type prices with or without GST.
  - The total updates as you type and uses the same sums the full app uses.
  - GST shows only when the business's registration charges GST on that date. The bill heading follows the law: "Tax invoice", "Bill of supply" for composition, or "Invoice" for unregistered businesses.
- **Quick bill.** A fast counter screen for walk-in sales, for businesses with stock.
- **Sales list.** Every bill with its total, what has been paid, what is still due and what was returned. Each bill has its own page with Print, Record a payment and Return items.
- **Return a sale.** Pick the bill and what came back, give a reason, and choose to give the money back or keep it as credit for the next bill.

#### Buy

- **Record a purchase.** Enter the supplier, their bill number and date, and the products, an expense or just an amount. Then answer "Paid now?".
  - "Does the bill show GST?" is asked only of a business that can claim GST back.
  - A business that cannot claim GST has the GST counted as part of the cost automatically.
  - The same supplier and bill number twice in one year is refused, with a link to the bill already recorded.
- **Purchase list** with what is still to pay, and a page per bill.
- **Return a purchase.**
- **Snap a bill.** Photograph or drop a PDF of a bill and get a draft purchase. This needs the optional AI helper. The photo or PDF is sent to the AI service as the file itself, and it cannot be hidden first (see section 4).

#### Money

- **Money in.** From a customer, the owner, a loan, other income, or a refund from a supplier.
- **Money out.** To a supplier, an expense (with "Do you have a GST bill?" where it matters), the owner (drawings, "not a business expense"), or salary.
- The customer's or supplier's open bills are listed oldest first and ticked as far as the amount goes. You can change the ticks. Money for a bill not yet made is kept as an advance.
- **Move money** between cash and bank.
- **Money in and out** list, with a page per entry.
- **Bank.** Drop the bank's statement file (CSV or Excel). For each line Total suggests what it was, such as "Already recorded", a customer, a supplier, bank charges or the owner. You accept or answer. One sentence then says whether the bank and your books agree. No AI is needed. AI can help with leftover lines if it is switched on.

#### Stock (only when you keep stock)

- **Products.** Quantity on hand, what it is worth, the selling price, and a "Running low" flag. Each product has a page with its history in words and a Change price button.
- **Count your stock.** Enter what you counted, and Total records the difference.
- **Made goods.** Make a product from materials using its recipe. Total refuses if there is not enough material and works out the cost of what was made.

#### People

- Every customer and supplier with what they owe or are owed, late bills, and how many days they take to pay. Lists can be filtered to customers, suppliers, owes you, you owe, or late.
- Each person has a page with their balance in words, their open bills ("25 days overdue", "due in 3 days"), phone and WhatsApp numbers, a statement, and buttons to record money or make a bill.
- **Reminders.** A polite message in English, Hindi or Hinglish. Copy it, copy a short SMS version, or open it in WhatsApp. Total itself sends nothing. WhatsApp opens on the computer with the message filled in.
- **Put on hold.** The owner can stop new credit to a customer.
- **Bills to pay.** Every supplier bill, latest first, with totals due this week and this month.

#### Reports

- **How is my business doing.** For this month, last month, this year or chosen dates. It is one column from sales to profit, compared with the period before, and every line has a "Why?".
- **Cash in the next 30 days.** Expected money in and out.
- **Who owes me** and **Whom I owe.**
- **By month.** Sales and purchases per month.
- **For your CA.** Shortcuts to the accountant's reports: trial balance, balance sheet, P&L, cash flow, CA pack and Excel export.

#### Taxes

- **Regular GST business.** The three GST figures, the GSTR-1 and GSTR-3B due dates, and five steps to file:
  1. Check for bills that may be missing.
  2. Compare supplier bills with what the portal shows (GSTR-2B).
  3. Prepare the files.
  4. Follow the portal steps.
  5. Mark "I've filed" with the ARN (the filing receipt number) and date.
- Total always says it *prepared* the file. You file on the government portal yourself.
- **Composition** businesses see their CMP-08 and GSTR-4 dates. **Unregistered** businesses are told there is nothing to file.
- **TDS / TCS** cards appear only if those features are on.
- Quarterly filers are supported. Preparing the quarterly files is still done in the full app.

#### Ask Total

- Press ⌘J, or use the box on Home, and type a question. For example: "who owes me?", "profit this month", "stock of rice", "kitna udhaar hai", or a short entry like "paid 2,500 rent in cash".
- **It needs no AI key and no internet.** It answers from the same figures the screens show, and the answers have figure chips you can click.
- It understands English, Hinglish and some Hindi, including typing mistakes.
- If a name matches more than one person, it asks "Which Ramesh?" instead of guessing.
- An entry request is offered as a prefilled form. Nothing is saved until you press Save.
- If it cannot answer, it suggests three questions and matching help articles. If the AI helper is on, harder questions go to it.

#### Help

- A help panel (press ? or ⌘/, or the Help button) with 16 offline articles. All 16 are in Hindi and the six most used are in Hinglish.
- Every empty list explains its purpose in one line, with one button to fill it and a "Learn how" link.

#### The AI helper, in plain words (optional)

- Found in Settings → AI helper. It explains what the helper is: an AI service you pay for separately, with nothing sent until you turn it on.
- It shows a summary of what is sent and hidden, then lets you paste a key, check it, and turn the helper on.
- It shows this month's spend, in rupees if you have set a dollar rate, otherwise in dollars.
- Answers say "Answered by the AI service" and which figures they used. A suggested entry becomes "Save this as a bill?" and goes through the normal Simple form.

#### Safety nets in every flow

- **Save card.** After each save, a card says in sentences what happened and where the person now stands. It offers Print, PDF, Share and **Undo**.
- **Undo.** Moves the saved entries to the bin together. It is available for 24 hours, as long as nothing else depends on them and the period is not locked. After that the card says "Edit instead".
- **Plain errors under the field.** Each error says what went wrong and what to do. Technical detail sits behind "Details".
- **Plain pickers.** When creating a new account, the app asks "This is a: Customer / Supplier / Expense / Income / Bank / Cash / Loan / Other…". It asks "Did you mean …?" when a similar name exists. Pressing Enter never creates something by accident.
- **Expense tiles with icons** for picking what money was spent on.

#### Settings (simple)

Business details, Bills & printing, **Backups** (with an automatic check that each backup can actually be restored), People & roles, **Features** ("Turn on" cards for orders, payroll, TDS, multi-currency and so on), the AI helper, **How Total looks** (mode, light or dark theme, language), **Lock and safety**, Help & tour, and Advanced (the full Settings).

**Lock and safety** offers:

- An optional passphrase that encrypts a business's books on disk.
- Locking the app with ⌘L. This needs people set up under People & roles, each with a PIN. It signs the person out. It is separate from the passphrase, which is what encrypts the books.
- Automatic locking after a set idle time (same requirement).

**If you turn on the passphrase, read this about backups.** A single backup file cannot be opened on its own, because the key that opens it sits beside the books. To keep a safe recovery copy, copy the whole business folder, or export a portable `.totalbak` file. The `.totalbak` has its own passphrase: write it down and keep it away from the laptop. If the passphrase is lost, nobody can open the books.

#### Language

- The whole of Simple mode is available in **English, Hindi and Hinglish**.
- Amounts in words follow the language, for example "एक लाख बीस हज़ार रुपये मात्र".
- Prints of bills, receipts and statements can be in Hindi, with a proper Hindi font built in.
- The Hindi and Hinglish text was drafted by machine and is waiting for a native speaker's review.

#### Comfort

- Works by keyboard: ⌘↵ saves, ⌘N starts a new entry, Esc closes one layer at a time, / jumps to search.
- Sized for small laptop screens. The sidebar shrinks to icons on small windows.
- Checked for screen readers and colour contrast in both light and dark themes.

---

### 2B. Accountant mode (the professional, full-control one)

This is the full app. It is built to match what an accountant expects from Tally, with keyboard-first entry and every report.

#### Daily entry and masters

- **Voucher entry** of every kind: sales, purchase, payment, receipt, journal, contra (cash and bank moves), credit and debit notes, stock journal, and physical stock. GST is worked out live as you type.
- **Counter billing.** A point-of-sale screen that works with barcode scanners.
- **Day book.** Every entry by date.
- **Masters.**
  - Ledgers (accounts) and groups: the chart of accounts.
  - Stock items, units and godowns (stock places).
  - Currencies and price levels.
- A dashboard (the Gateway) with figures that agree with the reports.

#### GST and other taxes

- **GSTR-1, GSTR-3B and GSTR-9 workings**, ITC-04, ITC reversal workings, and HSN summaries.
- **GSTR-2B reconciliation** against your purchase books.
- **e-invoice and e-way bill files** for the government's offline tools.
  - Optional live filing through the NIC portal is built, but it has never been run against the real portal. It is experimental.
- **TDS and TCS.** Rates and thresholds are dated and cited. The app has a deduction workbench and return working files.
- The rule that only a regular GST registration charges GST, applied by the date of each bill.

#### Invoicing and printing

- Professional bills with your logo and layout, through a **print designer**.
- PDF, batch PDF, statements of account and reminder letters.

#### Inventory and manufacturing

- One consistent stock valuation, worked out at the moment you look.
- Stock summary and stock movements.
- **Manufacture** from a bill of materials (BOM, the recipe), with versions, by-products and job work.
- Expiry dates, batch details and barcode labels.

#### Trade cycle (switch on in Features)

- Quotations, sales orders and purchase orders.
- Delivery challans and goods receipt notes.
- Returns, the full linked chain from order to bill, pending reports, three-way match, and goods-received-not-invoiced reports.

#### Banking

- Statement import: CSV, Excel, MT940, CAMT.053 and pasted PDF text.
- Bank reconciliation (BRS).
- Cheque books and cheque printing.
- Post-dated cheques.
- Bulk payment files for the bank.
- **Document capture.** Bills become purchase drafts. This needs the AI helper.

#### Receivables and payables

- Outstandings with ageing, bill by bill.
- Credit control with credit holds.
- Statements, reminders, and interest on late payment (with GST on interest handled correctly).
- **Payables.** Payment runs that pay many suppliers at once. MSME tracking covers the 45-day payment rule and the interest owed.

#### People and pay (switch on in Features)

- Payroll: employees and salary structures.
- Monthly pay runs with PF, ESI and professional tax.
- Salary TDS and payslips.

#### Planning and analysis

- Cost centres and budgets with budget-versus-actual.
- Cash-flow forecast.
- Loans and EMI schedules.
- Multi-currency and foreign-exchange revaluation.
- Ratio analysis.
- A **report builder** for custom reports, which can be saved, pinned and sent as scheduled packs.
- **Group consolidation** of several companies, with inter-company items removed openly.

#### Books and year-end

- Trial balance, Profit & Loss, Balance sheet, Cash flow and registers.
- Fixed assets with depreciation.
- **Year-end close**, with closing entries that cannot be edited.
- Period locks.
- A bin for deleted entries.
- A **CA pack** to hand to the auditor.

#### Assistants (no AI needed)

- **Month-end close checklist.** Bank reconciled, GST prepared, TDS paid, stock below zero, and more.
- **GSTR-2B mismatches**, with suggested fixes as drafts.
- **Anomalies.** Duplicate bills, back-dated entries, wrong GST rates and unusual amounts.
- **Exceptions** report.

#### Control and audit

- **Audit trail.** Every change is logged with before and after, in a log that cannot be edited. It is built to meet the Companies Act rule that accounting software must keep an edit log (rule 3(1) of the Companies (Accounts) Rules). A CA has not yet confirmed that it satisfies the rule, and some of the rule's wording is marked UNVERIFIED.
- **Users, roles and PINs**: owner, accountant and viewer.
- Fine-grained switches per user: may post entries, may see profit, may export, may manage AI.

#### Moving data in and out

- **Tally XML import.**
- Excel / CSV import, including from Busy and Zoho.
- **Export the whole books to Excel and back without loss.**
- Encrypted backup files.

#### AI (optional, off by default)

- An **AI assistant** panel that answers questions about the books and can "Explain this" for any figure.
- **Memory** of preferences, such as which account rent is usually paid from.
- **Capture** of bills from photos and PDFs.
- **Drafting** of entries. The AI only ever writes a *draft*; a person opens it and saves it.
- Every answer's figures are checked against the data the AI actually saw, and doubtful ones are flagged.
- An **MCP server**, a way for other AI tools on the same computer to read the books. It is off by default and controlled per business.

---

## 3. How the two modes work together

- **One set of books.** Simple and Accountant modes are two views of the same business file. There is no copy and no syncing between them.
- **Every Simple entry is a real accounting entry.** When a shopkeeper makes a bill in Simple mode, Total fills in the same form the full bill editor uses and saves it the same way. There is no second, simpler kind of book-keeping underneath.
- **The same rules apply in both.** Period locks, credit holds, GST rules, stock rules and user roles all apply.
- **The accountant opens the same business in the full app.** A CA can sit with the owner and press Accountant view on any screen. Or the CA can open the business on their own and see every Simple entry as a normal voucher they can edit, report on and file from.
- **Figures come from the same calculations.** Home's "Who owes me" is the same calculation as the Outstandings report. "How is my business doing" is the same as the Profit & Loss. The GST tile matches GSTR-3B. Tests check these against each other for the cases they cover. There are a few known small exceptions, such as paise-level rounding differences between a bill and its return in GST, and two stock reports that use different dates. They are listed in `to-do.md` section 4.
- **Moving between the modes keeps your place.** Going one way carries a half-filled form into the full editor. Coming back opens the same bill, person or report.

---

## 4. What makes Total different

- **Fully offline.** It works with no internet. Your data never leaves your computer unless you switch on AI or live e-invoice filing. One exception is the update check: when the app starts it asks whether a newer version exists. It is on by default and you can turn it off in Settings. Nothing is downloaded or installed without a click (`docs/ai-and-privacy.md` has the details).
- **No subscription, no account.** You install it and use it.
- **Exact money.** Every amount is stored as a whole number of paise, never as a decimal that can drift. Reports are worked out fresh from the entries every time, never from stored totals that can go stale.
- **Every figure explains itself.** "Why?" sentences and links take you from any number on Home to the report and entries behind it.
- **Tax rules are cited, not guessed.** Rates and due dates carry the official source next to them. Anything that could not be checked against the official text is clearly marked UNVERIFIED.
- **Honest wording.** Total says it "prepared" a GST file, never that it "filed" it. Credit waiting for the portal's confirmation is not called claimable. One known exception: in Simple mode a purchase can count GST as claimable even where the law blocks the credit (section 17(5) of the GST Act). The checks for this are in Accountant view, so have your accountant review the GST on purchases.
- **Hindi and Hinglish**, including bills and amounts in words.
- **AI is optional and private.**
  - Off by default.
  - You bring your own key.
  - Tax numbers (GSTIN, PAN) and bank account numbers in the text that is sent are hidden first. This is not complete. A photo or PDF of a bill is sent as the file itself and cannot be hidden. Item names, ordinary account names, notes and amounts can also be sent. `docs/ai-and-privacy.md` lists exactly what leaves.
  - Every message sent is logged by size and fingerprint, never its content.
  - Ask Total works with no AI at all.
- **Simple and complete.** A beginner can use it without training, and the same books stand up to a CA's review.
- **Safe to make mistakes.** Undo, the bin, plain errors, and backups that are checked automatically.

---

## 5. What Total does not do yet

- **Builds are not signed.** The app is not yet signed with an Apple Developer ID or a Windows certificate. So macOS shows a warning on first open, Windows shows a SmartScreen warning, and updates are not fully automatic on Mac. The app offers the download instead. This needs certificates only you can buy.
- **Live e-invoice / e-way bill filing has never run against the real government portal.** No test credentials exist yet. Treat it as experimental. The offline files for the government tools are the safe path.
- **Some tax rules are marked UNVERIFIED.** Examples: some of the 2025/2026 GST slab details, quarterly GSTR-3B dates for some states, TDS deposit dates under the new rules, payroll ceilings, and MSME details. A CA should confirm these before anyone relies on them.
- **Hindi and Hinglish were drafted by machine.** They need a native speaker's review. A few small messages, state names and preset account names are still in English. The full app (Accountant mode) is in English only.
- **No mobile app** and no web version.
- **No cloud sync** between computers. Moving a business means a backup file.
- **Windows is built and tested automatically, but not yet checked on a real Windows PC.** That includes the installer, printing, Hindi print fonts and screen scaling.
- **The AI has only been tested with a practice (mock) version.** It has not been tried with a real AI key.
- **Simple mode gaps.** For example:
  - Quarterly GST file preparation, deducting TDS, and editing recipes or reorder levels still need the full app.
  - PDF bank statements cannot be read.
  - Changes made in the full editor are not carried back to the half-filled Simple form.
  - A viewer (someone who may only look) now sees a short note instead of Save in the main Sell, Buy, Money, Stock and Bank screens. A few other forms may still show Save and then say "no permission" (`to-do.md` section 4).
- **Selling before the purchase is entered** values that sale's cost at ₹0. Total warns about this but does not fix it later.
- **Speed on very large books.** Opening takes about 6.5 seconds against a 2-second goal. With half a million entries, some reports take over three seconds on your laptop.
- **Encryption covers the books only.** Attachments, captured bill files, exports and logs are not encrypted.
- **Real beginner testing.** The "first-time user" study was done with scripted stand-ins. Five or more real first-time users per business type are still needed.

A full list, with pointers, is in `to-do.md` at the top of the repository.

---

## 6. Glossary

1. **Books.** The complete record of a business's money: every sale, purchase, payment and receipt.
2. **Voucher (entry).** One recorded transaction, such as a bill, a payment or a receipt. Simple mode just calls it an entry.
3. **Ledger (account).** A named bucket that money is counted in, such as Cash, Rent or a customer's name.
4. **Double-entry.** Every transaction is recorded in two places that balance, for example cash goes up and sales go up. This is what keeps books checkable.
5. **Debit / Credit (Dr / Cr).** The two sides of every entry. Simple mode replaces them with "owes you" and "you owe".
6. **GST.** Goods and Services Tax, India's tax on sales. A business collects it on sales and can usually claim back what it paid on purchases.
7. **GSTIN.** A business's 15-character GST registration number.
8. **GSTR-1 / GSTR-3B.** The two regular GST returns. GSTR-1 lists your sales. GSTR-3B sums up the tax and the cash to pay.
9. **GSTR-2B.** The government's statement of GST your suppliers have reported, which decides how much tax you can claim back.
10. **Composition scheme.** A simpler GST option for small businesses. They pay a flat small rate, cannot charge GST on bills, and cannot claim it back.
11. **TDS / TCS.** Tax Deducted at Source and Tax Collected at Source. These are income-tax amounts a business keeps back from, or adds to, certain payments and passes to the government.
12. **e-invoice / e-way bill.** Government registration of a bill (e-invoice) and a permit to move goods (e-way bill), issued through the NIC portal.
13. **Outstandings.** Bills not yet fully paid: what customers owe you and what you owe suppliers.
14. **Bank reconciliation (BRS).** Checking your books against the bank's statement line by line so both agree.
15. **Trial balance / Balance sheet / P&L.** The accountant's three core reports.
    - The trial balance lists every account's balance and proves the books balance.
    - The balance sheet shows what the business owns and owes.
    - The Profit & Loss shows what it earned and spent over a period.
