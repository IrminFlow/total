# Total, simple for everyone: master plan (Phases 8–10)

Date: 2026-10-13 · Status: awaiting "implement" · Baseline: main `191180ab` (0.10.x), last migration 045 (capture)

**Inputs:**
- CLAUDE.md hard rules.
- The 7-phase roadmap (`2026-10-07-total-revamp-roadmap.md`).
- The computer-use UX audit (`~/.claude/total-orch/ux-audit.md`). 12 of its screenshots were viewed: 02, 07, 14, 18, 23, 32, 36, 41, 49, 52, 60, 65.
- The outside GPT source review (`/tmp/total-orch/gpt-opinion.md`, present and read).
- Spot reads of `features.ts`, `seed.ts`, `counter.ts`, `onboarding.ts`, `domain.ts` (CompanyInfo) and `migrations.ts` (the ai_drafts `source` CHECK).

**Where the GPT review and the UX audit disagree, and what this plan follows:**
- **GST headline.** The audit wants one "You owe ₹Z by 20 Nov" figure. GPT warns that output minus booked input is not a promise. *Followed GPT:* collected / awaiting confirmation / to pay are shown separately. GPT's QRMP due dates are also adopted over the audit's fixed 11th / 20th.
- **AI without a key.** The audit suggests a bundled or hosted AI relay. GPT says basic operation must not depend on AI. *Followed GPT:* Ask Total is deterministic, BYO key stays optional, and nothing hosted is promised.
- **Tax-engine fixes.** GPT calls the rounding contract and transaction-time GST facts release blockers. The audit does not. *Split:* the registration-aware guard is WP 8.0. The other GPT engine items (rounding, transaction-time GST facts and the rest in the §8 risk row) go to Phase 7 and gate 1.0, not 0.11 / 0.12, because they change engine meaning and must not ride on a UI phase.
- **Opening balances.** The audit's setup asks for opening cash and bank. GPT adds "fresh vs continuing". *Followed both:* the wizard asks fresh vs continuing first.
- **Wording.** Both glossaries are merged in `shared/simple/glossary.ts`. Where they differ, the audit's shopkeeper wording wins in simple mode ("Money in" over "Money received"), and GPT's precision rules ("prepared", never "filed") win everywhere.

**Goal (owner):** someone who has never used Tally, and knows no accounting, law or tax, can run a shop, trade, practice or small factory in Total without a course. The books, GST, TDS and the audit trail must stay exactly as correct as they are today. The simple layer drives the same engine.

---

## 0. Ground rules

### 0.1 The one architectural rule
The simple layer is **UI plus a pure intent mapper**. A simple flow asks plain questions and turns the answers into an *intent* (`shared/simple/intents.ts`). The intent is mapped to the editor's own form state through the existing `shared/voucherEdit/` mapping, the same way WP 5.3 drafting does. It is then saved through `saveVoucher` inside one transaction.

There is **no new posting path, no new voucher kind and no stored balance**. Every simple screen has an "Accountant view" that opens the full editor or report with the same state. Whatever the simple screen saved, the full editor loads and round-trips unchanged.

### 0.2 Invariants
Every CLAUDE.md hard rule applies unchanged (integer money, query-time reports, pure `shared/`, Zod IPC, appended migrations, `NOT_DELETED` / `MOVES_STOCK`, `pnlLedgerAmounts`, one valuation pass, `resolvePrice`, `writeAudit` + `auditCoverage`, cited tax rules, AI opt-in and main-only network). **New invariant: Accountant view is byte-identical in behaviour** for existing companies and for any company switched to it. The only exceptions are the WP 8.0 fixes, which are listed and need owner sign-off.

### 0.3 Gate for every WP
- The roadmap §0.4 gate: typecheck, unit, db, renderer, build, smoke, the relevant e2e, a fresh reviewer, and the orchestrator driving the feature.
- **Plus a computer-use review.** The reviewer drives the built app on a scratch `TOTAL_DATA_DIR` as a first-time user, saves screenshots to `/tmp/total-ux/wp<id>/` and **views them**. The review fails if any of these appears on a simple-mode screen:
  - accounting vocabulary from the §1 banned list;
  - a dead end;
  - an error that does not point at its field.
- Every simple flow ships its own e2e scenario, numbered 46 onward.
- The **existing e2e suite (01–45) must stay green unchanged**. The harness creates companies in accountant mode (WP 8.1).

### 0.4 Gate for every phase
- The roadmap §0.5 gate, plus the upgrade test. Open a 0.10 company and a Demo Traders copy. Both must open in accountant mode with an identical sidebar and identical TB, P&L, BS and GSTR-3B totals.
- A "no-ledger-knowledge" journey: e2e 60 grows each phase.

### 0.5 Release train

| Phase | Version | Depends on |
|---|---|---|
| 8 Foundation: mode, shell, setup, language, seeding | 0.11.0 | 6 |
| 9 The simple flows | 0.12.0 | 8 |
| 10 Guidance, Ask Total (no key), Hindi, polish | 1.0.0, released together with Phase 7 hardening | 9, 7 |

---

## 1. Design principles

1. **Task-first language.** Use "I sold", "I bought", "Money in", "Money out", "Move money" and "What do I owe the government". Screens are named after what the user wants done.
2. **Zero accounting vocabulary in simple mode.** These words are banned from simple-mode strings and lint-checked in WP 8.2: voucher, ledger, journal, contra, Dr/Cr, particulars, narration, sundry, group, ITC, set-off, ageing, BRS, godown, BOM, SOA.
   - Acronyms that the law makes unavoidable (GST, GSTIN, HSN, TDS) are written out the first time they appear on a screen.
3. **Three questions decide the defaults:** what kind of business, GST registered (regular / composition / no / not sure), and do you keep stock. Everything else has a sensible default and can be changed later.
4. **Progressive disclosure.** Simple mode is the default for new companies. "Accountant view" is today's app.
   - The owner switches the mode per company.
   - Any user can open the accountant view from any simple screen; that choice is remembered per screen, per user.
5. **Every number explains itself in one sentence**, for example "₹4,200 is what 3 customers still owe you; the oldest is Ramesh, 12 days". The sentence is computed, never written by a model, and links to the full report.
6. **Undo everywhere.** Every save toast has an Undo button, which moves the saved entries to the bin. Corrections are "Edit" or "Undo", never "pass a reversing journal".
7. **Plain errors that point at the field.** Each error says what happened and what to do, sits under the field, and is gone once the field is fixed. Technical detail goes behind "Details".
8. **Hindi- and Hinglish-ready.** Every simple-mode string goes through `t()` from day one. English ships first; Hindi and Hinglish are complete in Phase 10.
9. **Keyboard is still fast.** Every simple screen has shortcuts (⌘N new, ⌘↵ save, F-keys kept in accountant view), and the palette (⌘K, labelled "Search") reaches every task.
10. **Never claim what we did not do.** Total "prepared" a GST file; it did not "file" it. Credit "awaiting confirmation" is not "claimable". Experimental NIC filing is labelled as such.

---

## 2. Information architecture

### 2.1 Mode model
- **Company default:** meta `ui` = `{ mode: 'simple' | 'accountant', setup: { businessType, gst, stock }, startedFresh }`.
  - It is written by setup and audited as a company update.
  - It is changed by the owner only (Settings → "How Total looks").
  - **A missing `ui` key means accountant.** That one rule covers every existing company and every backup.
- **Per-screen override:** each simple screen has an "Accountant view" toggle (localStorage, keyed by company + screen + user) that opens the mapped full screen with the same state. The full screen has a "Back to simple" toggle.
- **Screen registry:** `lib/screens.ts` entries gain `modes: ('simple' | 'accountant')[]` and `simpleSection`. The accountant sidebar is generated from exactly the current data. A renderer snapshot test proves it is unchanged.

### 2.2 Simple shell (sidebar ≤ 10 entries, task buttons on Home)

| Entry | Contents |
|---|---|
| **Home** | Today's money in / out; "Customers owe you ₹X"; "You owe suppliers ₹Y"; next GST due "₹Z by 20 Nov" (registered only); cash + bank; setup progress; big buttons: + Sale, + Purchase, Money in, Money out |
| **Sell** | Make a bill (cash / UPI / card / credit), Quick bill (Counter), sales list, sale returns, quotations (when Orders is on) |
| **Buy** | Record a purchase or expense bill, purchase list, purchase returns, Snap a bill (only when AI is ready) |
| **Money** | Money in, Money out, Move money, Bank (import + "What is this?"), All entries (Day book) |
| **Stock** | Products with quantity and value, stock count, low stock, "Made goods" (manufacturer preset) |
| **People** | Customers and suppliers with balance, phone, statement, reminder |
| **Reports** | How is my business doing (one-column profit), Cash, Who owes me / Whom I owe, Sales and purchase by month, GST summary; a "For your CA" group (TB, BS, P&L T-form, Cash flow, CA pack export) |
| **Taxes** | GST: "You owe ₹X by date" + steps to file; TDS / TCS only when switched on |
| **Settings** | Business details (Company details moves here), Bills & printing, Backups, People & roles, Features ("Turn on" cards), How Total looks (mode, language, theme), Advanced |

### 2.3 Where every current sidebar item goes
Tags: **D1** = day one, visible in simple mode. **L** = later, one level down inside a simple entry. **A** = accountant-only, reachable through the accountant view or Settings → Advanced. Feature-gated items show only when their feature is on.

| Current item | Tag | Simple home |
|---|---|---|
| Gateway | D1 | Home (simple Home is new; the dashboard stays in the accountant view) |
| Voucher entry | D1 | Split into Sell / Buy / Money tasks; the full editor is the accountant view |
| Counter | D1 | Sell → Quick bill |
| Day book | D1 | Money → All entries |
| Masters | L | People (parties), Stock (items), Settings → Advanced → Accounts (chart) |
| Manufacture | L (feature) | Stock → Made goods |
| Trial balance | A | Reports → For your CA |
| Profit & Loss | D1 | Reports → How is my business doing (T-form = accountant view) |
| Balance sheet, Cash flow | L | Reports → For your CA |
| Stock summary | D1 | Stock |
| Stock movements | L | Stock → product → History |
| Stock journal, Fixed assets | A | accountant view |
| Year-end close | L | Home card in April: "Start the new year" |
| Registers | L | Sell / Buy → lists |
| Outstandings | D1 | People / Reports → Who owes me (as on **today**) |
| Credit control, Payables | L | People → reminders / Bills to pay |
| Group consolidation, Combined view, Cost centres, Budgets, Loans, Forex, Report builder, Ratios | A | accountant view / Advanced |
| Cash forecast | L | Reports → Cash (next 30 days) |
| Assistants, Exceptions | L | Home "Needs attention" card (close checklist + anomalies, plain words) |
| Reconciliation | L | Money → Bank (import first) |
| Document capture | L | Buy → Snap a bill (AI ready only) |
| Payroll | A (feature) | Money → Salaries when Payroll is on |
| GSTR-1, GSTR-3B | D1 if registered | Taxes → GST |
| GSTR-2B recon | L | Taxes → GST → "Check supplier bills" |
| e-Invoice & e-Way | A (feature) | Sell → bill → "e-invoice" only if turned on |
| TDS, TCS | A (feature) | Taxes → TDS / TCS when on |
| Settings | D1 | Settings |
| Audit trail | A | Settings → Advanced → Change history |
| Import, Export, Import from Tally | L | Settings → Data (Tally import is also offered during setup) |
| Back up now, Switch company | D1 | sidebar footer |

---

## 3. The simple flows and their engine mapping

All flows save through a new write channel, **`simple:post`**.
- It takes an intent and a `clientId` (idempotent, like payment runs). In one transaction it builds 1–2 editor form states with the shared mapping and calls `saveVoucher` for each. Lock dates, roles, credit hold, negative-stock settings and closing-journal rules all apply.
- It is mapped in `auditCoverage.ts`. Its audit rows are the normal voucher rows.
- Undo bins every voucher of the intent together, and Restore brings them back together (like the forex revaluation/reversal pair).

| Flow | Asked | Defaulted | Posts (existing engine) |
|---|---|---|---|
| **Make a bill** | Customer (optional for cash: walk-in via `ensureWalkIn`); items or "just an amount"; quantity / price; **Paid how?** Cash / UPI / Card / Bank / Credit (udhaar) | Date = working date. Price: `resolvePrice` (item's saved price). Sales ledger: seeded "Sales" (services preset: "Service income"). Paid how: Cash for walk-in, Credit for a named customer. Due date = bill date + the party's credit days | **Sales voucher** via `buildInvoicePayload`. With items: inventory lines move stock (`moves_stock`) when inventory is on. "Just an amount": accounting-mode invoice, ledger line + `computeGst` (the capture path). **GST:** regular → existing calc (rate from item / ledger, place of supply from the customer's state, CGST+SGST vs IGST). Composition / unregistered → no tax lines and a "Bill of supply" print title (WP 8.0). Credit → bill ref New Ref. Paid now → **receipt voucher** in the same transaction, Dr cash / bank (UPI and card map to the accounts chosen in setup, as in Counter), Cr customer, Agst Ref to the new bill. This is the `counterCheckout` pattern, generalised |
| **Record a purchase** | Supplier; their bill number + date; what was bought: items (stock) or a category (expense); amounts as printed; "Does the bill show GST?" (registered only); Paid now? | Purchase ledger: seeded "Purchases". Input tax ledger via `pickTaxLedger` (Input side). ITC eligibility = eligible, RCM = no (both changeable in the accountant view only) | **Purchase voucher** (item or accounting mode) with the supplier invoice no. / date fields the GST registers use. Duplicate rule as in capture: same supplier + bill no. in the FY is refused with a link to the existing bill. Paid now → **payment voucher** Agst Ref in the same transaction |
| **Money in** | Who paid (a customer, or "Other": owner put money in / loan taken / other income / refund); amount; into Cash or which bank / UPI | Customer bills ticked **oldest first**; any extra → "advance". The question "Is this for a bill you haven't made yet?" sets the existing advance flag (its GSTR-1 treatment is unchanged and cited where it is implemented) | **Receipt voucher**: Dr cash / bank, Cr customer with Agst Ref allocations / On Account. "Other" → Cr Capital Account ("Owner's money"), Loans (Liability), or an income category ledger |
| **Money out** | Paid to: a supplier / an expense (category picker) / owner took money / salary (Payroll on); amount; from Cash or a bank; for an expense, "Do you have a GST bill?" | Supplier bills ticked oldest first. Category → its seeded ledger. TDS banner appears only if TDS is on and the existing eligibility rules fire | Supplier → **Payment** Dr supplier Agst Ref, Cr cash / bank. Expense without a GST bill → **Payment** Dr category ledger. Expense **with** a GST bill (registered) → accounting-mode **Purchase** (input tax captured) + **Payment** in one intent. Owner → Dr Drawings (under Capital Account) |
| **Move money** | From, to, amount | Today | **Contra**: Dr destination, Cr source |
| **Sale / purchase return** | Which bill (search by customer / number); which lines and quantities; refund money or keep as credit | Lines and rates from the original bill | **Credit / debit note** linked as a `return` (WP 2.5 rules), with the tax adjustment from the editor calc and stock back in. Refund → payment / receipt in the same intent |
| **Bank** | Pick a statement file; for each unmatched line, "What is this?" | Existing parsers and matcher. Suggestions from the WP 5.4 categoriser chain: rules → WP 5.6 memory → narration history → named party. The residual goes to the model **only if AI is ready**; otherwise the user picks from the candidates | Accepted lines become `draft_voucher` drafts with `payload.bankLine`. Saving one goes through `voucher:save`, and `reconcileSavedDraft` reconciles the line (a confirmed match). The simple screen offers plain choices (Customer paid / Supplier paid / Expense: category / Transfer / Owner) and bulk accept. BRS becomes one sentence: "Books and bank agree" or "3 entries differ: see them" |
| **Opening setup** | Fresh start, or continuing a business? If continuing: cash in hand; each bank balance; customers who owe you (name, amount, optional bill no. / date); suppliers you owe; stock on hand (product, quantity, cost); loans | Books-begin = start of the chosen FY. Opening bills dated books-begin (the receivables opening-bill rule) | Ledger opening balances + opening bill refs + item opening quantity / value through the existing masters services (audited). The Dr ≠ Cr difference is shown as "Owner's money at the start: ₹X" and posted to the Capital Account opening **only after the user confirms**. Nothing is silently zero |
| **GST answer** | Month (or quarter under QRMP) | Filing frequency from setup (`meta gstProfile`) | Read-only over `gstr3b()` set-off and `gstr1()`. The headline shows three figures **separately**: "GST you collected ₹A", "GST on purchases ₹B, of which ₹C awaits confirmation in GSTR-2B" (when no 2B is imported for the period: "not checked yet"), and "To pay in cash ₹D by <date>". The date comes from a corrected, cited `compliance.ts` (QRMP and the TDS March due date, WP 9.9). Steps: 1 missing bills (close checklist items), 2 check supplier bills (2B), 3 prepare files (existing JSON exports), 4 upload / pay on gst.gov.in (static, cited steps), 5 "I've filed": the user records ARN / date as a mark. **Unregistered:** "You are not registered for GST, so there is nothing to file." **Composition:** shows CMP-08 / GSTR-4 as reminders only (UNVERIFIED until cited) |
| **How is my business doing** | Period (this month / last month / this year) | none | Sales − cost of goods sold (opening stock + purchases − closing stock) − expenses = profit, in one column, built from `pnlLedgerAmounts` + the closing stock the P&L already uses (one valuation pass). A dbtest asserts profit equals `profitAndLoss` net profit for every period. Plus cash + bank (TB basis), dues, and the change vs the previous period. Every line has its sentence and an "accountant view" link |

---

## 4. Seeding and defaults

### 4.1 Presets
`shared/simple/presets.ts` is pure data.

| Preset | Features on | Extra seeded accounts | Unit | Home default |
|---|---|---|---|---|
| Kirana / retail shop | inventory, bill-wise | Shop expenses, Packing | Pcs / Kg | Quick bill |
| Trader / wholesaler | inventory, bill-wise | Freight inward, Commission | Pcs / Kg | Make a bill (credit) |
| Services / freelancer | bill-wise (no inventory) | Service income, Software & subscriptions, Travel, Professional fees | Nos | Make a bill (amount only) |
| Manufacturer | inventory, bill-wise, manufacture visible | Labour charges, Wages payable, Factory power, Raw material purchases | Pcs / Kg | Make a bill |
| Restaurant / food | inventory (optional), bill-wise | Kitchen supplies, Gas, Delivery commission | Plate / Nos | Quick bill |
| Other | bill-wise | none | Nos | Make a bill |

- **Every preset seeds:** Sales, Purchases, Rent, Electricity, Salary & wages, Transport, Phone & internet, Bank charges, Repairs, Office expenses, Owner's money (Capital Account), Drawings, Discount given / received, Rounding.
- Each seeded ledger sits under its correct Tally group, carries a `simple_category` key (one additive migration in Phase 8, nullable, no meaning in any report), a plain label, an icon and its `ledgerClass` purpose. This keeps WP 5.6 memory checks consistent.
- The category → group map lives in `shared/simple/categories.ts`, unit-tested against `ledgerClass`. A new category asks only for its name and one question: "Day-to-day cost / Stock you sell / Something you'll use for years". That maps to Indirect Expenses / Purchase Accounts or Direct Expenses / Fixed Assets.

### 4.2 GST defaults
- **Unregistered:**
  - The GST fields, tax lines, GST menu and GST and TDS cards are hidden everywhere.
  - Items carry no rate.
  - The WP 8.0 guard refuses tax lines on new saves.
- **Composition:** the same, plus a "Bill of supply" print title. Composition returns are reminders only.
- **Regular:**
  - The item dialog has a plain rate picker. Its rates come from a cited, effective-dated rate table (WP 8.4 adds one if none exists; never from memory).
  - The default is blank and required, not 18%.
  - HSN is searched by product name from a bundled, cited HSN list (owner decision D4).
- **"Not sure":** treated as unregistered, plus a Home card: "Ask your CA whether you need GST registration", with no turnover number unless cited.

### 4.3 Modules off by default for new companies
- TDS, TCS, payroll, cost centres, multi-currency, manufacturing, orders and e-invoice are **off** for new companies.
- These values are written explicitly at setup. **`DEFAULT_FEATURES` is not changed**: a company with no `features` meta keeps today's behaviour, which is why this is safe for existing books.
- Settings → Features shows each module as a "Turn on" card with one line on who needs it. Examples:
  - "TDS: you deduct tax when paying contractors, rent or professionals above the limits. Your CA will tell you."
  - "Payroll: you pay monthly salaries and want payslips."

---

## 5. Guidance layer
- **First-run tour:** 4 steps over the simple Home (make a bill, money in, see who owes you, back up). Skippable, re-runnable from Help.
- **Empty states that teach:** every simple screen has a one-line purpose and one primary action. Examples:
  - Bank: "Import your bank statement (PDF / CSV / Excel) and Total matches it."
  - Taxes, unregistered: "Not registered for GST, nothing to file."
- **"Why?" popovers:** `kit/Why.tsx`, with text computed by `shared/simple/explain.ts` from the same figures (e.g. "Profit is higher than sales minus purchases because ₹1.54 L of stock you bought is still on the shelf").
- **Help panel:** offline articles in `src/renderer/src/help/{en,hi}/*.md`, opened with ? or ⌘/, context-linked from each screen. No network.
- **Ask Total (no API key needed):** a deterministic assistant in `src/main/assist/`.
  - It covers the top ~30 questions: who owes me, what do I owe, GST due, profit / sales / expenses for a period, cash in hand, open X, how do I Y.
  - It uses the WP 5.5 deterministic phrase mapper (`reportBuilder/nl.ts`), the search service for names, `parseAmountText` / `resolveDateText`, and the existing read services. Answers are templated sentences with the same figure chips.
  - Entry requests ("paid 2,500 rent in cash") become `ai_drafts` with `source 'assistant'` and `payload.origin 'ask-total'` (the existing CHECK, so no table rebuild). They open in the simple flow.
  - Anything unrecognised gets "I can't answer that yet; try these", plus help search.
  - If the user has their own key and AI is on, the same box escalates to the model with every existing WP 5.x rule. **No hosted service is promised.**

---

## 6. Migration and compatibility
- **Existing companies:** no `ui` meta, so accountant mode. Their sidebar, features and behaviour are unchanged (snapshot test). The owner may switch to simple mode; that writes meta only, never books.
- **New companies:** the setup wizard writes `ui.mode = 'simple'` unless the user picks "I have an accountant / show the full app".
  - The sample-data company opens in simple mode.
  - The e2e harness (`lib/harness.mjs` `createCompany`, the Demo seeding in e2e 02) passes `mode: 'accountant'`, so e2e 01–45 run unchanged.
- **Engine, reports and audit:** nothing changes meaning.
  - One additive migration: `ledgers.simple_category` (nullable; asserted "last" in its test; never read by reports; included in booksExport fidelity).
  - New write channels: `simple:post`, `simple:setup`, `simple:openings`, `ui:mode:set`, `gstProfile:set`, `assist:draft`. All are mapped in `auditCoverage.ts`; `ui`, `gstProfile` and `simple_setup` are added to `auditEntities.ts` where needed.
- **Round trip:** a dbtest saves every intent type through `simple:post`, loads each voucher in its full editor and saves it unchanged. The tables must be identical (extends `voucherEdit.dbtest.ts`).

---

## 7. Work packages

### Phase 8: Foundation (0.11.0)

**WP 8.0 Correctness fixes that apply in both modes** (deliberate behaviour changes, owner sign-off D1)
- What:
  - Pass `gstRegistrationType` into the invoice computation context. New saves with tax lines in an unregistered or composition company are refused with a plain message. An existing voucher that already carries tax still round-trips unchanged; a warning shows in the accountant view.
  - Composition / unregistered print title "Bill of supply".
  - Outstandings "as on" defaults to today.
  - State list order 01 → 38.
  - Remove placeholders that look like data (GSTIN, vehicle no., HSN 8471).
  - Purchase placeholder copy ("Being goods sold…" on Purchase).
  - Item unit default Pcs, GST default blank.
  - Compliance cards show only applicable deadlines.
- Files: `shared/voucherEdit/invoice.ts`, `services/vouchers.ts`, `shared/compliance.ts` (applicability only), `print/render.ts`, `Outstandings.tsx`, `CompanySelect.tsx`, item / ledger dialogs.
- Tests:
  - dbtest: unregistered and composition saves are refused; legacy taxed vouchers round-trip.
  - e2e 46-unregistered-sale.
- Must not change: GST calc for regular companies; existing vouchers; the snapshot tests.

**WP 8.1 Mode model and simple shell**
- What:
  - meta `ui` with the "missing means accountant" rule.
  - Registry `modes` / `simpleSection`.
  - Simple Shell variant (≤10 entries) and the per-screen Accountant-view toggle with state hand-off.
  - "Search ⌘K" label; Company details under Settings.
  - Harness `mode` option.
- Files: `lib/screens.ts`, `components/Shell.tsx`, `state/stores.ts`, `services/config.ts`, `ipc.ts`, `auditCoverage.ts`, `scripts/e2e/lib/harness.mjs`.
- Tests:
  - Renderer snapshot: the accountant sidebar is identical to 0.10.
  - Mode switch audited.
  - e2e 47-mode-switch.
- Must not change: the accountant shell, nav persistence keys, e2e 01–45.

**WP 8.2 i18n scaffold and plain-language catalogue**
- What:
  - `shared/i18n/` with `t(key, vars)`, catalogues `en`, `hi`, `hinglish` (en complete, hi / hinglish stubs falling back to en), Indian number formatting kept in `money.ts`.
  - `shared/simple/glossary.ts` from the audit and GPT tables.
  - A lint test: simple-mode components contain no raw string literals and no banned words.
- Tests: catalogue key parity; banned-word lint; renderer language switch.
- Must not change: accountant screens' strings (they are not migrated in this plan).

**WP 8.3 Presets, seeding and the setup wizard**
- What:
  - `shared/simple/presets.ts` and `categories.ts`; the migration `ledgers.simple_category`.
  - `services/companySetup.ts` applies a preset through the masters services, with audit, inside the create transaction.
  - Wizard: name, state, business type, GST (regular / composition / no / not sure; GSTIN only if regular or composition; filing frequency monthly / quarterly), stock yes / no, start date in plain words ("When do you want to start recording? Start of this financial year (1 Apr 2026) / Today / Earlier…").
  - Features are written explicitly.
  - Tally import is offered as "Coming from Tally?".
- Tests:
  - Unit: preset → ledgers / groups / ledgerClass consistency.
  - dbtest: each preset seeds the expected rows, audit chain valid, TB zero.
  - e2e 48-setup-presets.
- Must not change: `seedCompany` output for the accountant path; `DEFAULT_FEATURES`.

**WP 8.4 Plain pickers and quick-create**
- What:
  - The new-account dialog asks "This is a: Customer / Supplier / Expense / Income / Bank / Other…" (full group list behind Other), pre-picked from context.
  - Phone on parties.
  - Category picker with icons.
  - Item quick-create with unit, selling price (default price level via the pricing service) and the plain GST rate picker from a cited rate table.
  - Fuzzy "Did you mean Sales?" before creating a near-duplicate name.
- Files: `components/masters/*`, `services/masters.ts`, `shared/simple/categories.ts`, `shared/gst/` rate table (with sources + UNVERIFIED).
- Tests: renderer tests for context defaults; unit tests for fuzzy match; dbtest that a quick-created ledger lands in the right group.
- Must not change: `LedgerFormModal` in the accountant view; `resolvePrice` order.

**WP 8.5 Field errors, save card, undo**
- What:
  - `kit/Field` error slot and `useFormErrors`.
  - A mapping from `saveVoucher` / Zod error codes to field paths and plain `t()` messages.
  - Toasts close with their dialog.
  - Save card: "Bill ₹1,180 saved. Received ₹500 by UPI. Ramesh still owes ₹680." with Print / PDF / Share / New / **Undo** (bin, grouped for multi-voucher intents).
- Tests: renderer tests for error placement; dbtest that undo bins and restores an intent pair.
- Must not change: server validation rules; bin semantics.

**WP 8.6 Simple Home**
- What:
  - Tiles and sentences from the dashboard service (as on today).
  - Task buttons.
  - Setup progress from `onboarding.ts`, with plain step labels (keyed by id, so the logic is unchanged).
  - A "Needs attention" card from the close checklist and anomalies.
  - Applicable deadlines only.
- Tests: renderer; e2e 49-home (figures equal the dashboard service).
- Must not change: the accountant Dashboard; `onboarding.ts` step logic.

**WP 8.7 Opening setup**
- What: the §3 opening flow. The `simple:openings` channel writes ledger openings, opening bills and item openings in one transaction through existing services; confirm-the-difference step.
- Tests:
  - dbtest: the openings TB balances after confirmation; opening bills age from books-begin.
  - e2e 50-openings.
- Must not change: opening-balance semantics; the year-opening rules.

Order: 8.0 ∥ 8.2 → 8.1 → 8.3 → {8.4, 8.5, 8.7} → 8.6 → gate → 0.11.0.

### Phase 9: The simple flows (0.12.0)

**WP 9.1 Intent layer and `simple:post`**
- What: `shared/simple/intents.ts` (Zod + pure mapping intent → `voucherEdit` form states for sale, purchase, money in / out, move, return); main `services/simplePost.ts` (one transaction, idempotent `clientId`, saves via `saveVoucher`); grouped undo.
- Tests:
  - Unit: every intent maps to balanced form states.
  - dbtest: the round trip through the full editor; lock / role / credit-hold refusals surface as field errors.
- Must not change: `saveVoucher`; voucherEdit mappings (only consumed).

**WP 9.2 Make a bill (Sell)**
- What: item and amount-only modes, Paid how, walk-in, due date, print / share (OS share sheet / PDF; no network), negative-stock warning in words; Quick bill entry point.
- Tests: e2e 51-make-a-bill (cash, UPI, credit; registered and unregistered).

**WP 9.3 Record a purchase (Buy)**
- What: stock / expense, bill no. + date, "bill shows GST", paid now, duplicate refusal, Snap a bill link when AI is ready.
- Tests: e2e 52-purchase; a dbtest that GSTR-3B ITC equals the accountant-entered equivalent.

**WP 9.4 Money in / out / move**
- What: oldest-first allocation, advance question, Other sources (owner / loan / income), expense with a GST bill → purchase + payment intent, drawings.
- Tests: e2e 53-money; a dbtest that allocations equal the Outstandings allocation.

**WP 9.5 Returns**
- What: from the original bill, `return` links, refund or credit.
- Tests: e2e 54-returns; dbtest that stock and GST reverse; I1–I7 hold.

**WP 9.6 Bank, simple**
- What: import-first screen, "What is this?" over the WP 5.4 categoriser (works without a key), bulk accept, the one-sentence BRS.
- Tests: e2e 55-bank-simple with AI off; a dbtest that a saved draft reconciles.

**WP 9.7 Stock and Made goods**
- What: product list (one valuation pass), stock count → physical-stock voucher, low stock; Made goods → the WP 2.2 manufacture voucher (recipe = BOM, "labour already recorded?").
- Tests: e2e 56-stock-simple.

**WP 9.8 People**
- What: customer / supplier list with balance and phone; statement (existing print kind); reminder text copied for WhatsApp / SMS (no network); credit days.
- Tests: e2e 57-people.

**WP 9.9 Plain reports and Taxes**
- What:
  - One-column profit with its equality dbtest; cash; dues; by-month.
  - GST answer and steps.
  - `meta gstProfile` (frequency).
  - `compliance.ts` corrected for QRMP and the TDS March date, **with citations and an UNVERIFIED list**.
  - The "I've filed" mark.
  - TDS / TCS answers when on.
- Tests: unit tests for the due dates against cited fixtures; e2e 58-taxes.
- Must not change: `gstr1` / `gstr3b` figures or exports.

**WP 9.10 Accountant-view hand-off for every simple screen**
- What: state hand-off both ways, and the remembered per-screen choice.
- Tests: e2e 59-handoff (simple → full editor shows the same voucher; full → simple).

Order: 9.1 → {9.2, 9.3, 9.4} → {9.5, 9.6, 9.7, 9.8} → 9.9 → 9.10 → gate → 0.12.0.

### Phase 10: Guidance, Ask Total, Hindi, polish (1.0.0 with Phase 7)

- **WP 10.1 Ask Total (deterministic, no key):** `src/main/assist/`, the panel's default mode when AI is off, BYO-key escalation unchanged. Tests: a unit question corpus (≥ 60 phrasings, en + Hinglish); a dbtest that figures equal the services; e2e 60.
- **WP 10.2 "Why?" sentences for every Home / Report / Taxes figure:** `shared/simple/explain.ts`. Tests: each sentence's figures equal its source.
- **WP 10.3 Tour, empty states and the help panel:** offline articles, context links.
- **WP 10.4 Hindi and Hinglish complete:** catalogue parity, Devanagari fonts in print, amount in words in Hindi (lakh / crore). Native-speaker review (D6).
- **WP 10.5 Keyboard, accessibility and window-size pass for the simple shell:** the AI panel does not dock by default under 1600 px.
- **WP 10.6 AI panel in plain words:** tokens, model ids and tool names go behind Details; plain key setup; notice summary first.
- **WP 10.7 Site and messaging:** reposition away from "Tally-grade" toward "easy books"; qualify "fully offline" (optional AI / NIC); Windows story aligned with WP 7.3.
- **WP 10.8 Beginner study and fixes:** 5+ first-time users per preset (D5); measure unaided completion, wrong tax choices, duplicates and corrections; fix the top issues. e2e 60 "no ledger knowledge" covers setup → openings → sale → purchase → money → bank → GST answer.

Order: {10.1, 10.2, 10.3} → 10.4 → {10.5, 10.6, 10.7} → 10.8 → joint gate with Phase 7 → 1.0.0.

---

## 8. Risks
| Risk | Mitigation |
|---|---|
| The simple layer drifts from the engine | Only intents → voucherEdit; round-trip and equality dbtests; no new posting code |
| The WP 8.0 GST guard breaks existing unregistered companies that already charged GST | Guard applies to new / changed tax only; unchanged re-save passes; accountant-view warning; owner decision D1 |
| Wrong defaults (rates, due dates, registration limits) presented as advice | Cited tables, UNVERIFIED lists, "ask your CA" wording, no numbers from memory |
| GPT-review release blockers outside this plan (transaction-time GST facts, one rounding contract, BigInt intermediates, pre-migration snapshot, MSME acceptance date) | Hand them to Phase 7 as WPs before 1.0. The simple layer must not ship 1.0 on top of them unresolved |

## 9. Things only the owner can supply
- Beginner testers (shopkeeper, trader, freelancer, manufacturer) for WP 10.8.
- A Hindi reviewer.
- A CA review of presets, category → group mapping, composition handling and the GST answer wording before 1.0.
- An HSN / rate source decision (D4).
- An OpenAI key as a CI secret (unchanged).

---

## Decisions needed from the owner (defaults let work start now)

| # | Decision | Proposed default |
|---|---|---|
| D1 | Allow WP 8.0 to change behaviour in **both** modes (GST guard for unregistered / composition, Outstandings as-on today, placeholders, unit / GST defaults) | Yes. They are correctness fixes; existing vouchers round-trip unchanged |
| D2 | Mode for the sample-data company and for new companies | Simple for both; "show the full app" choice in setup |
| D3 | Who may switch a company's mode | Owner only (any user can open the accountant view per screen) |
| D4 | HSN search by product name needs a bundled HSN list | Bundle the CBIC HSN / SAC list with its source and date; if not supplied, a code-only field with a "find HSN" link to the CBIC site |
| D5 | Recruiting 5+ beginner testers for WP 10.8 | Owner recruits; until then the computer-use reviewer stands in |
| D6 | Hindi via a native reviewer (machine-drafted first) | Yes. Hinglish ships as "beta" if no reviewer |
| D7 | Phase 7 hardening items raised by the GPT review are prerequisites for 1.0 | Yes. Schedule them in Phase 7 alongside Phases 8–9 |
