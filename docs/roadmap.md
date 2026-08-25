# Total — improvement catalogue

Sections A-Q are grounded in the current codebase, not invented. Sections R-V were added later
and are grounded differently: in what a marketed release has to survive, and in what the Indian
SMB market is actually being audited and asked for. Effort is **S** (hours), **M** (a day or
two), **L** (a week or more). Items marked **✓** are done in this branch; **✗** means
deliberately declined, with the reason recorded.

Ordering within a section is roughly by value.

---

## A. Keyboard and navigation

1. ✓ Red-letter accelerators on all 26 sidebar screens (S)
2. ✓ Unified keyboard layer registry replacing two parallel stacks (M)
3. ✓ Tally Enter-chaining with an inline Accept bar (M)
4. ✓ Application menu; free ⌘R / F12 / ⌥⌘I from Electron's default (S)
5. ✓ `useTableNav` list navigation with Home/End/PageUp/PageDown (M)
6. ✓ List navigation on the last four screens (S)
7. ✓ `⌘F` focuses the filter box on every report rather than needing a click (S)
8. ✗ Type-to-filter: any letter typed on a list screen starts filtering (S) — conflicts with #1.
   Bare letters are nav accelerators, and the promise that `V` opens voucher entry *from any
   screen* is the whole navigation model. A list layer claiming letters would break it. `⌘F`
   (#7) is one keystroke away and does not.
9. ✓ `⌘[` / `⌘]` for back and forward through the nav stack (S)
10. ✓ Remember the last active tab per screen across sessions (S)
11. ✓ `⌘1`–`⌘9` jump to the first nine sidebar entries (S)
12. ✓ A "recent screens" ring on `⌘\`` for alt-tab style switching (S) — a tap switches to
    the other screen, holding `⌘` walks the last eight (`⇧` the other way). The ring is frozen
    for the length of a cycle, so committing a jump cannot shuffle the entries under the
    highlight while they are being read.
13. Keyboard-driven date-range picker on the period pill (S)
14. ✓ `Alt+↑/↓` moves a voucher line up or down in the grid (S) — `⌥` rather than `⌘`,
    because `⌘↑/↓` is top-and-bottom-of-document everywhere else on macOS. Which line moves is
    read off the DOM rather than tracked in state: focus already arrives by six different
    routes, and a second copy of "where the cursor is" would be wrong every time one changed.
15. ✓ `⌘D` duplicates the selected voucher into a new draft (S)
16. ✓ `⌘⌫` deletes the selected row with an undo toast (S) — the selected voucher on the Day
    Book, the focused line in the voucher grid. No confirm dialog on either: the undo is the
    confirm, and a modal between the key and the deletion turns a keyboard action back into a
    mouse one. The ticked-rows bulk delete keeps its dialog, because "did you mean all nine" is
    a question no undo answers as clearly.
17. Space toggles the expand/collapse state of a tree row (S)
18. ✓ `⌘⇧F` opens global search scoped to the current screen (S) — the same palette with the
    commands dropped and the results narrowed to what the screen is about (vouchers on the Day
    Book, ledgers and items in Masters). A screen that narrows nothing gets ⌘K's behaviour
    rather than a pretended scope.
19. ✓ Vim-style `gg` / `G` to jump to first/last row, behind a preference (S) — Settings →
    Appearance, off by default and it has to stay that way: the list layer sits above the nav
    layer, so binding `G` shadows the Gateway on every screen with a list. The preference says
    so in as many words, and ⌘1 still goes home.
20. A visible focus-ring audit: every interactive control reachable by Tab (M)
21. Shortcut conflicts surfaced in Settings when a screen shadows a nav letter (S)
22. ✗ Per-user shortcut remapping stored in the company meta (M) — declined. The uniqueness
    guard in `__tests__/accel.test.ts` can be kept honest (it would only ever check the
    defaults), so that is not the reason. The reason is that every surface in this app renders
    the shortcut it binds *from* the binding: the red letter in the sidebar, the Gateway card
    badge, the hint bar, the `?` overlay. Remapping means all of those become per-user, and the
    one thing a Tally user can rely on — that `V` is voucher entry on any machine in the office
    — stops being true. The real complaint behind this item is shadowing, and #21 addresses that
    without splitting the vocabulary.
23. ✓ `?` overlay gains a search box once it exceeds one screen (S) — matches the label, the
    keys and the group title, so "what does ⌘D do" and "how do I reach the day book" are both
    answerable. Empty groups disappear rather than leaving a heading behind.
24. ✓ Numeric keypad Enter behaves as Enter everywhere (S) — already true: every handler
    switches on `e.key`, which Chromium reports as `Enter` for NumpadEnter. The only two sites
    that read `e.code` are the ⌥R and ⌥O grid chords added under #48/#42, and they have to:
    holding Option on macOS makes the browser report ⌥R as `®`, so a `key` comparison could
    never fire. Neither is an Enter key.
25. ✓ A "keyboard only" mode that hides all hover affordances (S) — Settings → Appearance,
    beside motion and text size. One rule in `app.css` takes the reveal off `:hover` while
    leaving the keyboard-active row and `:focus-within` alone, so what is visible on screen is
    exactly what the keyboard can reach. Opacity, never `display: none` — a hidden button is
    not in the tab order.

## B. Data entry speed

26. ✓ Undo for voucher delete, offered on the toast (M)
27. Voucher templates beyond recurring: save any voucher as a named template (M)
28. ✓ Copy the previous voucher of the same type with one key (S)
29. ✓ Auto-fill the narration from the party and item names (S)
30. Inline ledger creation without leaving the picker (already partly there) (S)
31. ✓ Paste a table of lines from a spreadsheet directly into the voucher grid (M) — both
    grids. Reads tab-separated (what a spreadsheet puts on the clipboard) or CSV, and the three
    layouts a bookkeeper's sheet actually uses: name+amount, name+Dr/Cr+amount, and the classic
    debit/credit pair of columns. Only intercepted when the clipboard holds a *table*, so
    pasting one name into one cell still works. Names match exactly and never fuzzily: a
    near-match posts real money to the wrong account and looks right afterwards. An unmatched
    account keeps its amount and offers to create the ledger; a skipped row is reported with the
    reason, because a paste that silently drops three of twelve rows is found at the trial
    balance.
32. ✓ Amount field accepts arithmetic: `1200*3` yields 3,600 (S)
33. ✓ Amount field accepts `k`, `L` and `cr` suffixes (S)
34. Quantity field accepts a unit-conversion expression (`2 box` → 24 pcs) (M)
35. ✓ Remember the last-used voucher type, across sessions rather than just within one (S)
36. ✓ Warn before saving a voucher dated outside the open period (S)
37. ✓ Duplicate-number detection extended to duplicate amount+party+date (S) — already
    shipped: `findDuplicates` matches type + party + total within a ±3-day window, pre-save.
38. ✓ A "post and new" button that keeps the party and date (S)
39. Bulk edit: change the narration or cost centre on many vouchers at once (M)
40. ✓ Bulk delete to the bin from the Day Book with a confirm (S)
41. Split a voucher line across cost centres by percentage rather than amount (S)
42. ✓ Round-off line added automatically when a line is a paisa out (S) — offered rather than
    added, on a button beside the totals and on `⌥O`. Below 99 paise the difference is
    arithmetic (rupee rounding under section 170, a percentage split landing on a third of a
    paisa); at a rupee or more it is a transposed figure, and plugging it would turn a voucher
    that refuses to save into one that saves wrongly.
43. ✓ Voucher numbering series per type per financial year, configurable (M) — the prefix and
    suffix take `{FY}`, `{YY}` and `{YYYY}`, expanded against the *voucher's* date so altering
    last March's invoice reproduces last year's series. `restartFy` alone was never enough for
    rule 46(b): restarting the count produces `INV-0007` twice, a year apart. A token series
    also narrows its own scan to this year's numbers, so it genuinely restarts rather than
    relying on a mismatched prefix casting to zero.
44. ✓ Flag a gap in voucher numbering in Exceptions (S) — detection, not prevention: refusing
    to save a voucher that would leave a gap is worse than the gap. Numbers are allocated at
    save time, two people entering at once legitimately leave one when either cancels, and a
    business that has just voided an invoice must still be able to carry on.
45. ✓ Auto-save an in-progress voucher as a draft, restored after a crash (M) — the same work as
    #250. Debounced to disk, scoped by company and voucher kind, and offered back on a bar above
    the form rather than restored over whatever is on screen. New vouchers only: an alteration's
    fields come from a voucher already on the books, and that is the truth.
46. A scratchpad ledger for entries the user has not decided how to classify (S)
47. Barcode scan jumps straight to quantity on the matched item line (S)
48. ✓ Repeat-last-line key for entering many similar lines (S) — `⌥R` copies the whole last
    filled line, side and amount included: on the twenty-branch expense journal the amount is
    the field most likely to be right already, and it is one keystroke to change when it is not.
49. ✓ Party defaults: credit days, price level and cost centre applied on selection (S) —
    credit days and price level already prefilled; the cost centre was the one still typed by
    hand on every voucher, and the one that is invisible when forgotten (a missing due date
    shows up in the ageing report the same day; an unallocated line just never appears in the
    branch's P&L). Applied at build time rather than written into each row, so it cannot fall
    out of step with an edited amount, and stated on screen rather than applied invisibly.
50. ✓ Show the party's current balance inline while entering a voucher (S)

## C. Reports and analysis

51. ✓ Quarterly, half-yearly and annual period granularity (M)
52. ✓ Day Book paged at the IPC boundary (M)
53. ✓ Ledger Statement paged; Outstandings sends a summary and fetches bills on expand (M)
54. ✓ Row virtualization so a 30,000-row report scrolls without 30,000 DOM nodes (M) — windowed
    with spacer `<tr>`s (never CSS transforms, which break table layout), and only above 300
    rows, so a short report keeps find-in-page working on every line.
55. ✓ Comparative columns: this period against the same period last year (M)
56. ✓ Drill-down from any figure in P&L or Balance Sheet to its ledger (M) — already shipped:
    StatementTree opens the ledger statement on a leaf click, and the comparison view does too.
57. ✓ A time-travel Balance Sheet: a date scrubber that recomputes as-on any date (M) — the
    slider runs over the financial year the as-on date falls in, and the previous figures stay
    on screen while the new ones load rather than strobing through "Loading…".
58. ✓ Saved report views: filters, columns and period stored by name (M) — stored in the company
    database (a firm agrees on "the March view"), opaque display state only: restoring a view can
    change what is asked for, never what is computed.
59. ✓ Schedule a report to be written to a folder on a timer (M) — honoured on the next company
    open, which the screen says in as many words: an offline app has no daemon, and a missed run
    produces one current report rather than twenty-one stale ones.
60. ✓ Ratio analysis: current ratio, quick ratio, debt-equity, inventory turnover (M) — on the
    Balance Sheet, with the figures behind each one. A nil denominator reports as unknown, never
    as 0 or ∞.
61. ✓ Cash flow forecast from open bills, PDCs and recurring templates (L) — no trend line and no
    growth rate: every row can be opened. Two closing lines per week, contracted and with
    recurring, because a recurring payment against a supplier bill is also that open bill.
62. ✓ Monthly trend sparklines on every Gateway tile (S) — twelve months, baseline anchored at
    zero so a ten-rupee movement cannot fill the box and imply volatility that is not there.
63. ✓ Group-wise summary rows in the Trial Balance, collapsible (M) — by group or by primary
    group; every subtotal is computed from exactly the rows folded under it, and the export
    always carries every row whatever is collapsed on screen.
64. ✓ Multi-column Trial Balance: opening, movement, closing (S) — already shipped
65. ✓ Negative-balance highlighting on ledgers that should never be negative (S)
66. ✓ A "what changed" report between two dates for any ledger (M) — a tab on the Trial Balance,
    ranked by the size of the move rather than by name, which is exactly what the alphabetical
    list hides.
67. ✓ Export any report to XLSX rather than only CSV (M) — as SpreadsheetML `.xls`, not XLSX.
    Real XLSX is a ZIP of a dozen XML parts and would mean adding a compression dependency to an
    offline app whose export path is otherwise plain text. SpreadsheetML is one XML file Excel,
    Numbers and LibreOffice open natively, carries several named sheets, and keeps amounts as
    numbers that sum — which is the whole reason CSV was not enough.
68. ✓ Print layouts that fit A4 without cutting columns (M) — `table-layout: fixed` with wrapping
    cells, so a long narration wraps instead of pushing the amount off the sheet; over six
    columns the report goes landscape and loses a point of type rather than a column.
69. ✓ Report headers carrying the company name, GSTIN and period on every page (S)
70. ✓ A CA-facing summary pack: TB, P&L, BS, ageing in one PDF (M) — plus the same five
    statements as one workbook. The CSVs are still written beside them: whoever wants to re-total
    a column wants the column, not a picture of it.
71. ✓ Cost-centre profitability report (M) — margin per centre, and a reconciling "Not allocated"
    line so the sections cannot quietly sum to less than the company's own P&L. Suppressed
    entirely on books that use no cost centres, where it would just be the P&L mislabelled.
72. ✓ Item-wise gross margin by period (M) — a margin matrix, item by sub-period, each bucket
    valued independently through the consumption engine rather than smeared across the range.
73. ✓ Party-wise sales ranking with concentration warning (S)
74. ✓ Day Book grouped by voucher type with subtotals (S) — shipped as a summary view rather
    than in-list subtotals: the list is paged, and subtotals over a page are subtotals of an
    arbitrary slice.
75. ✓ An audit-trail report of who changed what, per voucher (S)
76. ✓ Reconciliation status column on the Day Book for bank vouchers (S)
77. ✓ Exception report: vouchers with no narration, over a threshold (S) — missing narration was
    already there; the threshold is now a parameter with a one-lakh default, because the amount
    that means "look at this" differs between a kirana shop and a distributor.
78. ✓ Report footers stating the exact query period, so a screenshot is unambiguous (S)
79. ✓ Zero-balance ledgers hidden by default with a toggle (S)
80. ✓ Percentage-of-total column on P&L lines (S)

## D. GST and statutory

81. ✓ QRMP: quarterly GSTR-1/3B, monthly PMT-06, optional IFF, state-staggered 3B date (L)
82. ✓ Composition scheme: CMP-08 and GSTR-4 rather than blocking export (M)
83. ✓ GSTR-9 annual return working papers (L) — a books-against-returns reconciliation, not
    a filled-in form. GSTR-9 has no offline utility worth targeting, and a generated annual
    return would be a confident answer to a question that needs a human.
84. ✓ GSTR-2B reconciliation improvements: fuzzy match on party name (M)
85. ✓ ITC ageing: input credit not claimed within the statutory window (M)
86. ✓ E-invoice threshold awareness by declared turnover band (S)
87. ✓ Reverse-charge ledger auto-selection on notified supplies (M)
88. ✓ Bill of supply for exempt and composition sales (M)
89. Delivery challan and job-work challan (ITC-04) (L)
90. ✓ TCS on sale of goods, section 206C(1H) (M) — detection, not automatic collection: the
    section does not apply where the buyer deducts TDS under 194Q on the same transaction, which
    the seller cannot know from their own books.
91. 26AS reconciliation against TDS entries (L)
92. GST rate-change handling: rate history per item with effective dates (L)
93. ✓ HSN summary validation against the GSTR-1 schema before export (S)
94. ✓ B2C large invoice threshold flagged automatically (S)
95. ✓ Place-of-supply auto-derivation from the party's state code (S) — already shipped
96. E-way bill distance auto-lookup from pin codes (M)
97. ✓ A filing calendar that marks a return as filed with its ARN (M)
98. ✓ Late-fee and interest calculator for delayed filing (M)
99. ✓ GST payment challan (PMT-06) tracking against liability (M)
100. ✓ Nil-return shortcut when a period has no transactions (S)
101. Amendment tables (B2BA, CDNRA) in GSTR-1 (L)
102. ✓ Export invoices with and without payment of tax, split correctly (M) — already shipped
103. ✓ SEZ supplies with and without payment, split correctly (M) — already shipped
104. ✓ Advance receipt and adjustment tables (11A, 11B) (M) — already shipped
105. ✓ A validation gate that blocks export until every error clears (S) — already shipped
106. ✓ Show the exact JSON that will be uploaded, before uploading (S)
107. NIC sandbox validation of the live-filing client (M)
108. Multi-GSTIN companies: one book, several registrations (L)
109. TDS lower-deduction certificate handling (M)
110. ✓ Professional tax slabs per state, not just one (M) — already shipped: PT_SLABS carries
     Maharashtra, Karnataka, West Bengal, Tamil Nadu, Gujarat, Andhra Pradesh, Telangana and
     Madhya Pradesh, keyed off the employee's pt_state. #177 added effective dates on top.

## E. Inventory

111. Barcode label printing to a thermal printer (M)
112. ✓ Multi-godown stock transfer voucher (M)
113. ✓ Reorder level with a purchase suggestion report (M)
114. ✓ Batch expiry tracking with a near-expiry report (M)
115. Serial-number tracking for high-value items (L)
116. ✓ Stock ageing by batch rather than by item (M)
117. ✓ Landed cost allocation across a purchase (M)
118. Standard costing with variance against actual (L)
119. Item images on the invoice and in the picker (M)
120. ✓ Alternate units of measure with conversion (M)
121. ✓ Item-wise reorder email or WhatsApp alert (S)
122. ✓ Negative-stock prevention per item, overriding the company setting in both directions (S)
123. ✓ Physical stock count sheets, printable with blank quantity columns (S)
124. ✓ Stock valuation method per item, not per company (M) — already shipped: stock_items
     .valuation_method is per item and the valuation engine honours it (weighted average or
     FIFO) when pricing every outward movement.
125. Bill of materials with scrap and yield percentages (M)
126. Sub-assembly BOMs, nested (L)
127. Job-work stock sent out and received back (L)
128. Price list versioning with effective dates (M)
129. ✓ Item groups with inherited GST rate and HSN (S)
130. ✓ Fast item entry by code rather than name (S)

## F. Banking and reconciliation

131. ✓ Per-bank statement import profiles: HDFC, ICICI, SBI, Axis, Kotak (M)
132. PDF bank statement table extraction for the top banks (L)
133. ✓ Auto-match on narration keywords, learned from past matches (M)
134. ✓ Bulk-accept all high-confidence matches (S)
135. Bank charges and interest auto-posted from matched lines (M)
136. Cheque printing with configurable layouts per bank (M)
137. Post-dated cheque calendar view (S)
138. Bounced-cheque handling with the reversal entry (M)
139. ✓ Bank balance as-per-books versus as-per-statement, per account (S) — on Banking's All
     accounts tab rather than the Gateway, where it sits beside the reconciliation state that
     explains the difference.
140. Multi-currency bank accounts with revaluation (L)
141. UPI transaction import from a CSV (M)
142. Reconciliation freeze: lock reconciled periods (M)
143. ✓ Unreconciled-items ageing report (S)
144. Split a single bank line across several vouchers (M)
145. ✓ Import the same statement twice without duplicating (S) — already shipped: a line that
     already carries a bank date is reported as alreadyReconciled, never re-matched.
146. ✓ Statement import preview showing what will change, before it changes (S) — already
     shipped as the dry-run preview modal.
147. ✓ Bank rules editable inline from the unmatched row (S)
148. ✓ Reconciliation progress bar per account (S)

## G. Receivables, payables and khata

149. ✓ A party-centric khata screen: running balance, credit limit, days overdue (M)
150. ✓ WhatsApp payment reminders via `wa.me` (S)
151. ✓ Reminder letters with configurable ageing bands (M)
152. ✓ Promised-payment date per bill with a follow-up list (M)
153. ✓ Interest on overdue bills, per party terms (M)
154. ✓ Credit-limit enforcement at voucher entry, not just a warning (S)
155. ✓ Party statement PDF, printable and emailable (S)
156. ✓ Ageing analysis by salesperson or territory (M)
157. ✓ Bad-debt provisioning entry helper (M)
158. ✓ Payment allocation suggestions when a receipt does not match one bill (M)
159. ✓ Customer credit scoring from payment history (M)
160. ✓ A daily "who to chase today" list on the Gateway (S)
161. ✓ Bulk reminder send to every overdue party (M)
162. ✓ Party phone and email (S)
163. ✓ Notes and call log per party (M)
164. ✓ Advance received tracking against future invoices (M)
165. ✓ Vendor payment scheduling by due date (M)
166. ✓ Payables ageing mirrored from receivables (S) — already shipped: Outstandings and the
     khata both take a receivable/payable side through the same allocator.

## H. Payroll

167. ✓ Salary revision history per employee (M) — derived from the audit log, which has
     recorded every employee save's full before and after all along. A separate salary-history
     table would be a second record of the same fact, free to disagree with the first.
168. ✓ Leave and attendance tracking feeding the pay run (L)
169. ✓ Loan and advance recovery from salary (M)
170. ✓ Bonus and gratuity computation (M)
171. ✓ Form 16 generation (L)
172. ✓ PF ECR file format validation before upload (S)
173. ✓ ESI return file generation (M) — already shipped as buildEsiCsv, wired to a run through
     payroll:esi.
174. ✓ Payslip email or WhatsApp delivery (S)
175. ✓ Salary bank transfer file (M) — the common shape (name, account, IFSC, amount,
     reference), deliberately not branded as any one bank's. The formats differ in ways this
     cannot verify without a real portal, and a file labelled "HDFC format" that the portal
     rejects is worse than an unlabelled one the user maps once.
176. ✓ Employee self-service payslip export (S)
177. ✓ Statutory rate table with effective dates, not hardcoded (M)
178. ✓ Full-and-final settlement workflow (M)
179. Multiple pay cycles: weekly, fortnightly (M)
180. ✓ Cost-centre allocation of salary expense (S)
181. ✓ Headcount and cost trend report (S)

## I. Invoicing and documents

182. Two or three genuinely beautiful invoice templates (M)
183. Thermal 3-inch receipt template for retail (M)
184. Bilingual invoice printing: Devanagari alongside English (M)
185. ✓ Signature and stamp images on the invoice (S)
186. Live invoice preview while editing the layout (M)
187. ✓ Proforma invoice (M) — a memorandum sales voucher, which the books already model as
     out-of-books, printed as a proforma rather than as a tax invoice.
188. Sales order and purchase order with fulfilment tracking (L)
189. Delivery note and receipt note (M)
190. ✓ Terms and conditions block, per voucher type (S)
191. ✓ QR code on the invoice, UPI payment intent (S)
192. Invoice email with the PDF attached (M)
193. WhatsApp invoice send (S)
194. Multi-page invoices with carried-forward totals (M)
195. Custom fields on a voucher, defined per company (L)
196. ✓ Document numbering with a configurable prefix and suffix (S) — already shipped:
     per-voucher-type prefix, suffix, zero-pad width and restart-each-FY.
197. ✓ Print an entire period's invoices in one job (M) — already shipped as invoice:pdfBatch,
     which renders them sequentially into one exports folder.
198. ✓ Duplicate/triplicate copy markings (S) — already shipped as configurable copyLabels,
     one printed page per label.
199. Round-off and amount-in-words in the chosen language (S)
200. ✓ Company logo, letterhead and footer configuration (S) — already shipped: logo, title,
     declaration, bank block, terms, signatory and an entered-by footer.
201. ✗ Export invoices as a zip of PDFs (S) — pdfBatch already writes one folder of PDFs, which
     is as portable as a zip on both macOS and Windows. Adding a hand-rolled archive writer to an
     accounting app to save one drag is a bad trade; revisit if a real user asks.
202. ✓ Watermark for proforma documents (S) — cancelled documents live in the bin and are not
     printable, so there is nothing there to watermark.
203. Invoice-level discount in addition to line discounts (S)

## J. AI and agents

204. ✓ Bring-your-own-key assistant grounded on tool calls (L)
205. ✓ MCP server for Claude Desktop, Claude Code and Codex (M)
206. ✓ Natural-language voucher entry producing a draft (M)
207. ✗ Not doing: document to voucher needs vision, and a bill photograph is the one payload
     Total cannot redact — the GSTIN, the PAN and the bank line are pixels, so the "never sent"
     promise every other AI feature keeps would have to be withdrawn for this one. It also needs a
     capability probe and its own consent line, because roughly half of bring-your-own-key users
     point Total at a text-only local model and would otherwise meet a confusing failure. Against
     that, the win is re-typing a bill — real, but the same bill arrives as a CSV or a Tally XML
     for most people, and both of those paths already exist and are exact (L)
208. ✗ Not doing: the deterministic pass already returns candidates WITH the reason it found them
     (a single open entry within ±₹1 and ±5 days, or up to three entries of one party summing to
     the row), so a re-ranker can only reorder a list that is usually one or two long. To do it it
     would have to send every unmatched bank narration and every candidate, and a remittance line
     carries payer names, UTR numbers and account fragments — a much larger egress than any other
     feature, on the one kind of text field redaction cannot generalise over. And a confidently
     mis-ranked top candidate is precisely the one a tired person clicks at 7pm (M)
209. ✓ GST anomaly explanation grounded on the validation output (M)
210. ✓ Month-end close checklist assistant, read-only (M)
211. ✓ Anomaly watch: flag entries unlike anything in the history (M)
212. ✓ Ask-bar in ⌘K that resolves to a report, deterministically first (M)
213. ✓ Assistant spend caps per session and per day, enforced in main (S)
214. ✓ A visible "show me exactly what would be sent" payload viewer (S)
215. ✓ Streaming cancellation from the Esc key (S)
216. ✓ Local-model presets for Ollama and LM Studio (S)
217. ✓ Assistant audit trail joining question, draft and posted voucher (S)
218. ✓ MCP write tools behind two independent switches (done) plus a rate limit (S)
219. ✓ MCP resources for the chart of accounts and the voucher schema (done) (S)
220. ✓ An agent-facing changelog resource so a model knows what changed (S)
221. ✓ Prompt-injection hardening: tool results are data, never instructions (M)
222. ✓ Redaction preview: show what the assistant will and will not send (S)
223. ✓ Assistant answers cite refs the UI can click through to (M)

## K. Performance and scale

224. ✓ Measured benchmark: 30k vouchers, every report under 100 ms (M)
225. ✗ Not doing: startup measured at 580 ms median over three cold launches, so the 1.5 MB single chunk is not costing anything worth splitting (M)
226. Lazy-load screens that most users never open (S)
227. Row virtualization on long tables (M)
228. Prepared-statement reuse across calls in hot services (S)
229. Query result caching keyed on the books' last-modified stamp (M)
230. Incremental report recomputation rather than full recompute (L)
231. Move PDF generation off the main process (M)
232. Streaming CSV export rather than building the whole string (M)
233. ✓ Debounce the global search (S) — already shipped: 150 ms, and only once the query is 2+
     characters.
234. Index review against the actual query plans (S)
235. Lazy-load the AI SDK only when the assistant is enabled (done) (S)
236. Startup time budget with a test that fails if it regresses (M)
237. Memory ceiling test on a large book (M)
238. ✓ Avoid re-fetching the whole features object on every screen (S) — already shipped: the
     nine call sites share one react-query cache entry, so they make one request between them.
239. Batch IPC calls that always happen together (M)
240. Web worker for CSV parsing on import (M)
241. Progressive rendering of very long reports (M)

## L. Reliability and data safety

242. ✓ Verify-my-backups: opens the backup read-only and foots its books (M) — stronger than
     restoring into a temp company and cheaper: it proves the books inside balance, which a
     restore alone would not.
243. ✓ Last-good-backup timestamp on the Gateway (S)
244. ✓ One-click "move my data out of a synced folder" (M) — copies, opens every company in the
     copy to prove it survived, and only then switches over. Nothing is deleted: somebody moving
     their accounts between disks should end up with two copies and a choice.
245. ✓ Backup to an external drive or folder on a schedule (M) — refuses a destination inside the
     data folder (not a second copy of anything) and, unencrypted, one that syncs to the cloud.
     A failed run says why on the Backups screen; a schedule that fails invisibly is worse than
     no schedule.
246. ✓ Restore preview: what will change before it changes (M) — counts on both sides plus the
     entries that would have to be typed again, by name. "How many" answers how bad; this
     answers what.
247. ✓ Integrity check run on a timer (S) — already shipped: the full PRAGMA integrity_check
     runs at most once every 7 days, throttled through meta, alongside the per-open quick_check.
248. ✓ Corrupt-database recovery guidance in the UI, not just an error (M) — ordered by what it
     costs to get wrong, so "copy the whole folder somewhere else, now" comes before any
     diagnosis, and derived from the actual findings: no restore step when there are no backups,
     no repair advice when the file is sound and one voucher is out of balance.
249. ✗ Transaction log of every write, replayable (L) — the audit log already is one. Every
     service write goes through `writeAudit` with the entity, the id, the action, the before and
     the after as JSON, the user and the app version, and #265 now chains it so it cannot be
     edited unnoticed. A second log would record the same events in a second place, and two logs
     that can disagree about what happened are worse than one that cannot. The one thing a
     replay engine would add over `before_json` is automated re-application, and re-applying
     writes into books that have moved on is not a recovery, it is a merge — which #254's import
     refuses to attempt for exactly the same reason.
250. ✓ Crash-safe voucher draft recovery (M) — the half-typed entry is debounced to disk and
     offered back on the next launch. Offered, not restored: replacing what somebody is typing
     with what they were typing yesterday is worse than losing yesterday's.
251. ✓ Duplicate-company detection when restoring (S) — a matching GSTIN is decisive, a matching
     name is a suspicion, and importing anyway takes a second click. The silent "acme-2" was the
     most dangerous success in the app: the user works in the copy for a week while their real
     books sit in the other one.
252. ✓ Backup retention policy configurable, 5 to 200 (S) — floored at 5, because a retention
     of 1 means the next open overwrites the only copy.
253. ✓ Encrypted backup to a user-chosen cloud folder, client-side encrypted (M) — AES-256-GCM
     with a scrypt-derived key (the existing TOTALBK1 format), passphrase in the OS keychain and
     never in the database it protects. A synced destination is refused outright without one.
254. ✓ Data export in a documented open format, guaranteed round-trip (M) — plain JSON, every
     reference by name, money still in integer paise, documented in docs/export-format.md. The
     guarantee is a test: export, import into an empty company, export again, identical file.
255. ✓ A "what would I lose" summary before a restore (S) — counted by opening the backup,
     since a backup file is the only authority on what is in it.
256. ✓ Bin auto-purge policy, configurable, with what the next purge would take shown on the
     Bin screen (S) — 0 means never, which is a policy rather than a disabled feature.
257. ✓ Company-level read-only lock for archived years (M) — a lock date closes a period and
     there is always a date after it; this closes the company. Reading, printing, exporting and
     backing up keep working, because archived books nobody can get data out of are a hostage
     rather than a record.
258. ✓ Year-end close reversal, if it was run in error (M) — the inverse of the close in the
     inverse order: lift the lock, bin the closing journal, put the lock back where it was
     (recorded at close time, since setLockDate would otherwise have destroyed the answer).
     Refused once anything is dated after the closing entry.
259. ✓ Multi-device conflict detection via a file lock and a heartbeat (M) — a claim file in the
     company folder, refreshed every 30s, so the second machine can tell a live session from a
     crash. Reported and never refused: a lock file is evidence about another machine, and that
     is exactly the kind of evidence that is sometimes wrong.

## M. Security and privacy

260. ✓ GST portal credentials moved to the OS keychain (S)
261. ✓ AI key never reaches the renderer or the data directory (S)
262. ✗ Optional at-rest encryption of the company database (L) — SQLCipher means a native
     rebuild pinned to Electron's ABI (the thing that already breaks this build most often), a
     key that has to live somewhere, and the sentence "forgot the password = the books are gone
     forever" said to a shopkeeper. Against that: the threat it answers is a stolen laptop, and
     macOS FileVault and Windows BitLocker answer that one already, for the whole disk, without
     this app being able to lose anybody's accounts. What is genuinely ours to protect — the GST
     portal password, the AI key, the backup passphrase — is in the OS keychain (#260, #261),
     outside the data folder entirely, and #253 encrypts the copies that actually leave the
     machine. Nothing here is called encryption that is not.
263. ✓ Auto-lock after a configurable idle period (S)
264. ✓ PIN attempt throttling with exponential backoff (S) — the flat thirty seconds cost an
     honest typo exactly what it cost a script working through all ten thousand four-digit PINs,
     and the script could afford it. Doubling to an hourly ceiling turns that search from an
     afternoon into more than a year; four free attempts keep a typo free. Both PIN surfaces
     (sign-in and company delete) quote the same wait from the same persisted counter.
265. ✓ Audit log tamper-evidence via a hash chain (M) — every row carries the hash of its
     contents chained onto the row before it, with the head stamped in `meta` so lopping the
     newest entries off the end is caught too. It is evidence, not prevention, and says so:
     someone who can write to the file can recompute the whole chain. It pairs with the Rule
     3(1) statement in disclosure.ts, which could say the trail cannot be switched off and could
     not say it had not been rewritten.
266. ✓ Per-user permissions finer than three roles (M) — deny-only: the role sets the ceiling and
     denials cut areas out of it ("the accountant who enters purchases but must not see what
     anyone is paid"). No grant direction on purpose — a grant would let a viewer post entries
     that the audit trail then attributes to a viewer.
267. ✓ Session timeout, as the idle auto-lock (#263) — a separate timeout on the lock screen
     itself would guard a screen that already holds nothing (S)
268. ✓ Redact sensitive fields in exported diagnostics (S) — redaction by construction rather
     than by filter: `log()` records channel names, event names and error messages and never IPC
     payloads, so there is nothing to strip. Asserting that is one thing and proving it is
     another, so `scripts/e2e/33-support-send.mjs` posts a party with a GSTIN, sends a support
     message, and reads the bytes off a recording server to check that neither the party, the
     GSTIN nor the company name is anywhere in them.
269. ✓ Content-Security-Policy audit and tightening (S) — base-uri, form-action and
     frame-ancestors do not fall back to default-src and were unset; connect-src is now stated
     rather than inherited, because every network call in the product belongs to main and one
     originating in the renderer is a bug or an attack. The audit is written down as a test, so
     the day script-src gains 'unsafe-inline' is the day CI fails.
270. ✓ Dependency vulnerability gate in CI (S) — `npm audit --omit=dev --audit-level=high` in the
     release workflow. Runtime dependencies only: this app ships a Chromium to every user, so a
     known RCE in something it bundles is a shipped RCE, while a build-tool advisory blocking a
     release only teaches people to pass --force.
271. ⏳ Signed releases and update verification (M) — blocked on procurement, not on code. The
     workflow, the hardened runtime and `build/entitlements.mac.plist` already read `CSC_LINK`,
     `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`,
     `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD`, and log a `::warning::` on every build that runs
     without them. The next tag after the certificates land is signed with no code change. See
     #341 and #342.
272. ✓ Privacy page documenting exactly what leaves the machine (S) — written as a list of
     network calls, not as a policy: that is the only form a reader can check against the app.
273. ✓ A "panic" key that locks immediately — ⌘⇧L from any screen (S)

## N. Accessibility

274. ✓ Accessible names on every control, enforced by an E2E that walks every sidebar screen (M)
275. ✓ Screen-reader announcements for row selection changes (M) — one polite live region fed by
     `useKeyNav`, keyboard moves only: a pointer sweeping a table would jam it shut
276. ✓ Live regions for toast messages, assertive while an error is showing (S)
277. ✓ Reduced-motion honoured everywhere (S) — the blanket `animation: none` also killed the
     spinner and the skeleton, the two things whose whole job is to say "still working". Now
     near-zero durations plus an opacity-only pulse, and an in-app preference sharing the same
     rules as the OS setting.
278. ✓ High-contrast theme beyond light and dark (M) — a third `[data-theme]` block: white ground,
     black ink and hairlines, every accent darkened to AAA. The header button cycles three ways.
279. ✓ Font-size preference that scales the whole type scale (M) — every step is
     `calc(Npx * var(--t-font-scale))` rather than a root font-size: Tailwind v4 sizes spacing in
     rem, so scaling the root would have inflated every gutter and undone the density.
280. ✓ Focus trap audit on every modal (S) — one `useFocusTrap`. The audit found the command
     palette had no trap at all, and that restore-on-close read `activeElement` inside an effect —
     after React had already applied a child's `autoFocus` — so no modal had ever handed focus
     back. Both fixed; the AskDrawer is docked beside the content, not over it, so it is not
     trapped on purpose.
281. ✓ Table headers associated with cells via scope (S) — 321 headers across 31 files
282. ✓ Colour is never the only signal: Dr/Cr also carry text (S) — already shipped
283. ✓ Keyboard access to every context action currently on hover (M) — one `.row-action` class
     covering hover, :focus-within, the keyboard-active row and :focus-visible, plus a renderer
     test that fails the next hand-rolled `group-hover` fade and an E2E that reads opacity.
284. ✓ Skip-to-content link (S)
285. ✓ Form errors announced, not only shown (S)
286. ✗ Minimum tap-target sizes on the LAN companion, when it exists (S) — the LAN companion does
     not exist. Nothing in this app is driven by a finger, so there is no target to size; this
     comes back with the companion rather than being invented ahead of it.
287. ✓ Language attribute set on the document (S) — already shipped; revisit when bilingual
     invoice printing (#184) lands and a second language is actually on screen.

## O. Onboarding and migration

288. ✓ Tally import reconciliation: "matched to the paise" (M)
289. ✓ Guided opening-balance entry for businesses not coming from Tally (M) — six questions in
     the words a shopkeeper would use (what is in the bank, who owes you, who you owe) instead of
     "opening balances, debit positive". The screen works out the side, creates each ledger under
     the right group, and shows the difference with the usual reason for it — missing capital one
     way, uncounted stock the other. It posts nothing: an opening balance is a property of a
     ledger, which is also why the screen can be abandoned half-done and returned to.
290. ✗ Import from Busy, Marg and Vyapar (L) — declined for now, on the grounds that a parser
     guessed at is worse than none. None of the three publishes an export schema, and no real
     export file from any of them was available to check against; a converter written from
     memory would fail silently on somebody's three years of books, which is the one failure
     mode this app cannot afford. What they all do have is CSV export, and #291 now reads that
     with a diff before anything is written. Revisit with a real file in hand.
291. ✓ Excel and CSV import of masters and opening balances (M) — the parser and the matching
     existed with no way to reach them; there is now a screen (Import → Spreadsheet) with the
     same three steps as the Tally wizard, and the preview separates "changed" from "unchanged"
     so a re-import of a corrected file reads honestly. **.xlsx itself is declined**: Excel writes
     CSV in one menu command, and the alternative is carrying a zip/shared-string/serial-date
     parser in an offline app to avoid a two-second conversion.
292. ✓ The red letters taught as a checklist step rather than as a tour (S) — a modal tour is
     dismissed and forgotten; a step that stays until the shortcut sheet has been opened is not.
293. Sample company that mirrors the user's own trade (M)
294. ✓ Checklist that survives across sessions until complete (S) — derived from the books, so
     it cannot be ticked without doing the thing and it reopens if the thing is undone.
295. ✗ Screenshots of Tally's own export dialog, per version (S) — cannot be obtained. Tally is
     licensed proprietary software; there is no copy of it here, and no legitimate source of its
     dialogs per version. Describing them from memory would put confident, possibly wrong
     instructions in front of somebody mid-migration, which is worse than the text steps the
     screen already carries. Someone with a Tally licence can take four screenshots and this
     becomes a ten-minute task.
296. ✓ Import dry-run diff: what will be created, changed, skipped (M) — the preview used to
     count what was in the file, which answers "did it parse". It now counts what would happen to
     THESE books: new against already-here, per master type, plus vouchers already imported and
     vouchers blocked by a ledger the file never defines. Read-only by construction — every
     lookup is a SELECT and no transaction is opened. The CSV path gained the same distinction
     between "changed" and "unchanged".
297. ✓ Re-import safety: never duplicate an already-imported voucher (M) — every imported voucher
     carries a fingerprint (`vouchers.import_key`): Tally's own GUID where the export has one,
     otherwise type/date/number/party plus the line count, the debit total and a hash of the
     lines. The counts and totals sit in the key in plain sight, so a hash collision alone can
     never merge two vouchers. Indexed, deliberately NOT unique: a voucher that was imported and
     then binned must be importable again, because the bin is a decision.
298. ✓ Migration report PDF for the CA to sign off (M) — every import run, who ran it, what was
     refused, what the books add up to now, and a signature block. Built from the audit trail and
     the vouchers in main, never from what the import screen happened to be holding: a report
     whose figures the caller supplies proves nothing to the person signing it. Books that do not
     balance say so in the first line rather than in a footnote of caveats.
299. ✗ Restore from a Tally backup file directly (L) — declined. A Tally backup (`TBK900.001`) is
     an undocumented proprietary container, not a database anyone outside Tally Solutions can
     read; the only honest way in is the XML export the wizard already asks for, which Tally
     itself will produce from a restored backup in three clicks. Reverse-engineering a container
     format to save those three clicks is a large amount of work whose failure mode is a
     silently mis-read set of books.
300. ✓ Import progress with a cancel button (S) — the import now yields between chunks of 25
     vouchers, which is the only reason main can service the cancel click at all (it is
     single-threaded, and the old synchronous loop could never have seen it). Cancel rolls the
     whole thing back — masters included — because everything-or-nothing is the only honest
     answer to "stop" halfway through somebody's books.

## P. Business, growth and the site

301. ✓ Pricing page with the fail-soft promise (S)
302. ✓ Offline Ed25519 licensing (M)
303. ✓ Payment integration: Razorpay or Cashfree, UPI first (M)
304. ✓ Licence delivery by email and WhatsApp (S)
305. ✓ A CA edition: free, unlimited client companies (M)
306. ✓ CA referral programme with tracked coupons (M)
307. Named beta users and testimonials on the site (S) — the component and the empty data file
     are built (`site/lib/testimonials.ts`, renders nothing while empty). Not ticked because the
     thing itself is a real person's words with their written permission, and there are none yet.
     Inventing one would be a false statement of fact about a named firm.
308. A 90-second screen recording of a real GSTR-1 export (S) — `/demo` has the slot and shows an
     honest placeholder until `NEXT_PUBLIC_DEMO_VIDEO_URL` is set, and the nine-shot script is in
     `site/content/screencast-shot-list.md`. Not ticked until somebody records it.
309. ✓ Contact page with a WhatsApp number (S)
310. ✓ SEO pages for the real queries people type (M)
311. ✓ Downloads page with checksums and signing language (S)
312. ✓ In-app feedback form posting to a real endpoint (M) — done with #345. The endpoint exists:
     `site/app/api/feedback/route.ts` stores each message as an issue in the private repo and
     forwards it by mail, and returns 503 rather than swallowing anything when no sink is
     configured. The in-app half is now the Support dialog: a message, an optional address, and
     the diagnostics tail attached by default and shown in full before anything moves.
313. ✓ Changelog surfaced in-app, not only on the site (S)
314. ✓ Update notes shown before an update is applied (S)
315. ✓ Referral or word-of-mouth tracking without telemetry (M)
316. ✓ Comparison page kept honest and current (S)
317. ✓ Trial-expiry email capture, opt-in only (S)
318. ✓ Localised pricing display (S)
319. ✓ Partner or reseller documentation (M)
320. ✓ A public roadmap page (S)

## Q. Developer experience and testing

321. ✓ Design-system lint: type scale, radii, colour tokens (S)
322. ✓ Accelerator uniqueness enforced in CI (S)
323. ✓ AI service boundaries enforced by a filesystem grep (S)
324. ✓ MCP bundle load test that catches packaging failures (S)
325. ✓ Windows unit, DB, renderer, smoke AND E2E tests in CI (M) — the Windows job runs `npm test`,
     `npm run test:db`, `npm run test:renderer`, builds the NSIS installer and gates the artefact
     on `npm run smoke`. The Playwright E2E suite is **not** among them; that is #343, and this
     entry used to claim it.
326. Visual regression snapshots of every screen, both themes (M)
327. Mutation testing on the money and GST engines (M)
328. Property-based tests for the posting rules (M)
329. A seeded large-book fixture reused across performance tests (S)
330. Lint rule banning raw SQL outside services (S)
331. Lint rule requiring `NOT_DELETED` on voucher queries (M)
332. Typed IPC channel registry generated from one source (M)
333. Renderer test coverage reporting with a floor (S)
334. ✓ E2E run time budget so the suite stays usable (S)
335. ✓ Flake detection: rerun failures and report them separately (S) — one was found by hand
     while adding #171: scenario 02 failed about half the time because `staleTime` is 5s and
     `purchaseSuggestions` was in no screen's invalidation list, so a revisit inside five seconds
     served a cached empty panel. `__tests__/invalidation.test.ts` now guards the whole class.
336. ✓ A `npm run verify` that runs everything in one command (S)
337. ✓ Pre-commit hook running typecheck and the fast tests (S)
338. Dependency freshness report in CI (S)
339. ✓ Bundle-size budget that fails on regression (S)
340. ✓ Contributor guide covering the money and date invariants (S)

---

# Added after the first pass

Sections A-Q came out of reading the code. What follows came out of two other questions: what
stops this being shippable to people who paid for it, and what does this market get audited on
that the app cannot currently answer.

**Every statutory item below must be checked against the notification in force before it is
built.** Tax law here moves faster than a release cycle — the dates cited are what was true when
this was written, and a compliance feature that is confidently wrong is worse than one that is
honestly absent.

## R. Launch readiness

The things that gate a marketed release rather than improve the product. Two have procurement
lead time measured in weeks, which makes them the first items on the list and not the last.

392. ✓ An app icon (S) — there was none at all, so every build shipped the default Electron
     one: the first thing a buyer sees after paying. Drawn as a checked-in SVG in the app's own
     colours and rasterised by `npm run icon`, which renders it through Electron because the repo
     assumes no image toolchain. The script also emits a contact sheet at 16/32/64/128, which is
     the only honest way to judge an icon that lives in a dock.

341. Apple Developer ID: enrol, then add `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`,
     `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` (S engineering, M procurement) — the
     workflow, hardened runtime and entitlements already read them and log a `::warning::` when
     they are missing, so this is an account and a wait, not a code change. Until it lands,
     macOS tells every ad click the app "cannot be opened because Apple cannot check it".
342. Windows code signing: an OV certificate or Azure Trusted Signing (S engineering, L
     procurement) — `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` are already wired. Organisation
     vetting takes one to three weeks. Unsigned NSIS installers get a full-screen SmartScreen
     block, on the platform most of this market runs.
343. ✓ The Playwright E2E suite on Windows in CI (M) — see the correction on #325. Path handling,
     the native menu, `_electron` launch and every file dialog are the places a macOS-only suite
     is blind, and they are exactly what breaks on Windows.
344. ✓ A generated 100,000-voucher book, timed through every screen, with the numbers published
     (M) — 85,840 vouchers, not 100,000: the generator posts a fixed ratio of receipts and
     purchases per invoice, so a round number of invoices does not give a round number of
     vouchers, and the numbers in `docs/performance.md` are the ones that were measured rather
     than the ones the item asked for. It found what it was meant to find. e-Invoice & e-Way does
     not settle at all inside sixty seconds on a busy machine and takes nineteen on a quiet one:
     `listSalesInvoices` returns every sales document in the period unpaginated and runs two
     correlated EXISTS subqueries per row, which is 88,000 correlated subqueries for one screen.
     Trial balance is 3.2 seconds *warm*, which is the scaling wall of #224 measured rather than
     predicted. `perf-sweep.mjs` gained `--data-dir=` so the expensive half — building the book —
     is done once and re-timed in minutes.
345. ✓ An error ring buffer attached to the feedback form, with a pre-send preview (S) — the
     Support dialog now takes a message and posts it to the site's `/api/feedback`, which had been
     waiting for a caller since it was written. A `mailto:` needs a configured mail client and
     silently does nothing on a machine without one. The log tail is attached by default and shown
     in full first, and it is safe to show by construction rather than by filtering: `log()`
     records channel and event names, never IPC payloads. `scripts/e2e/33-support-send.mjs` stands
     a recording server on localhost and asserts the bytes on the wire are character-for-character
     the characters on screen — and that no party name, GSTIN or company name is among them.
346. ✓ First-run on a machine that has never held the app (S) — `scripts/e2e/32-fresh-machine.mjs`
     points the app at a path three directories deep that does not exist, so the very first
     millisecond is under test rather than assumed. Every other scenario starts from a directory
     the harness made.
347. 1366×768 at 125% scaling, on a real ₹40,000 Windows laptop (S) — the modals, the sidebar
     and the ledger table at the size most of the market actually runs them.
348. ✓ The release steps as a script rather than a memory (S) — `npm run release -- patch` checks
     the tree is clean, on main and level with origin, runs the whole suite, versions, tags,
     pushes, and then polls GitHub until the release exists and fails loudly if it published as a
     draft or a pre-release. Both are invisible to `releases/latest`, which is what the in-app
     updater and the site's download button read, so both look perfect on the releases page and
     reach nobody. `--dry-run` stops before the two irreversible acts.
349. ✓ Relabel NIC live filing as experimental until it has run against the sandbox (S) — the
     home page, the GST docs, the comparison page and the FAQ all now lead with the offline JSON
     export, which works, and say in as many words that the live client has never met the real
     portal. See #107.
350. ✓ Uninstall and reinstall leaving the books untouched, proven by a test (S) — the second
     half of `32-fresh-machine.mjs`: post a voucher, throw away everything the installation owns
     (the whole Chromium profile — preferences, localStorage, userData), launch again over the
     same data directory, and find the company, the voucher and the amount to the paise. The
     promise is that the books are the user's; now something checks it.

## S. Statutory depth

The compliance the market is being assessed on right now. Most of these are not exotic: they are
what a CA asks for in the first meeting, and what a notice arrives about in the third.

351. ✓ MSME payment reporting under section 43B(h) (M) — a Udyam classification per party, a
     45-day payables view, and a year-end report of what will be disallowed. Payment to a micro
     or small enterprise beyond 45 days loses the deduction for that year, and the number is
     computed from exactly the FIFO allocation the collections desk already runs. The single
     highest-value statutory feature this app could add.
352. Invoice Management System actions from the 2B reconciliation (L) — IMS now sits between the
     supplier's filing and the buyer's ITC, and every invoice has to be accepted, rejected or
     pended. `recon2b` already computes the comparison; what it does not produce is the action
     list, which is the part that has to happen every month.
353. GSTR-1A, the amendment return (M) — see #101. Correcting a filed GSTR-1 stopped meaning
     "wait for next month's amendment table" and started meaning a return of its own.
354. The e-invoice reporting deadline, as a countdown (S) — registrations above the ₹10 crore
     turnover band must report an invoice to the IRP within 30 days of its date, after which the
     portal simply refuses it. `turnover.ts` already knows the band; nothing counts the days.
355. Input Service Distributor for multi-GSTIN businesses (L) — mandatory rather than optional
     now, and it only bites the companies #108 is for. Build it with #108 or not at all.
356. The reverse-charge self-invoice (M) — a registered buyer who purchases from an unregistered
     supplier has to raise the invoice themselves. `rcmAdvice` already identifies the case and
     says so; nothing produces the document, which is the thing the auditor asks to see.
357. LUT tracking for exporters (S) — the undertaking is annual, expires on 31 March, and an
     expired one silently converts a zero-rated export into a taxable supply. A date and a
     reminder, worth far more than the effort.
358. Rate history spanning the September 2025 rationalisation (M) — the move to two principal
     slabs plus a demerit rate means an item's correct rate now depends on the invoice date.
     This is the concrete case #92 exists for, and the one that will be asked about first.
359. Income-tax Act 2025 section mapping (M) — in force from 1 April 2026, which renumbers what
     `tds_sections` stores. Keep both numbers, key the correct one off the voucher date, and
     print the one the certificate needs.
360. TDS return files: 24Q and 26Q (L) — the app already holds every deduction. What it does not
     do is emit the quarterly file the RPU takes, which is the step a business pays someone else
     to do four times a year.
361. Form 16A for vendors (M) — the deduction certificate for the party you deducted from.
     Sibling of the payroll Form 16 (#171), same data, and nothing produces it.
362. A Form 3CD data pack for the tax audit (M) — clause-wise extracts rather than a filled
     form, because the form is the auditor's to sign and the data is the client's to supply.
     Same shape as the CA pack, aimed at the one week of the year that matters most.
363. Schedule III presentation of the Balance Sheet and P&L (M) — the format a company is
     required to present in, as a view over the existing statement tree rather than a second
     set of numbers.
364. Related-party transactions report (S) — a flag on the party ledger and a disclosure listing
     every voucher against it. Cheap, and currently impossible to produce without a spreadsheet.
365. A Rule 3(1) audit-trail statement (S) — the one page an auditor asks for: that the log
     exists, that it cannot be switched off, what it covers, and for which dates. The log has
     been recording faithfully all along and can say none of this about itself. Pairs with #265.

## T. Assets, borrowing and the bank

Everything a business owns and owes that is not a bill. "Fixed Assets" exists in this app as a
ledger group and nothing else — there is no register, no schedule, and no way to answer the two
questions every year-end asks.

366. ✓ A fixed asset register (M) — asset, purchase date, cost, block, location. The ledger group
     records that ₹4 lakh of machinery was bought; nothing records what the machinery is.
367. ✓ Depreciation computed both ways (L) — Companies Act (SLM or WDV over useful life, per
     asset) and Income Tax (WDV on the block of assets). They give different numbers on purpose,
     both are needed every year, and doing one and calling it depreciation is the mistake to
     avoid.
368. ✓ Asset disposal (M) — sale or scrapping, profit or loss on sale, and the block adjustment,
     which is where a hand-computed schedule usually goes wrong.
369. ✓ Capital work in progress, and capitalising it (S) — costs accumulate against a project and
     become an asset on a date. Today they land in an expense or sit in a ledger nobody revisits.
370. ✓ A loan register for money the business borrowed (M) — the EMI split into interest and
     principal, a schedule that runs to the end, and the monthly journal. Every business with a
     vehicle or a machine has one, and every one of them books the whole EMI to the loan account.
371. CMA data for a working-capital application (L) — the format banks require, generated from
     the books. A CA charges thousands for this and rebuilds it from a trial balance by hand.
     Nothing in this market produces it; the data to do so is already here.
372. ✓ The monthly stock statement for the bank (M) — stock, book debts and creditors as at
     month end, which is the return every cash-credit borrower files and most file late.
373. ✓ Drawing power, from #372 and the bank's margins (S) — the number the statement exists to
     produce, and the one the borrower actually wants to see before they file it.
374. ✓ Prepaid and accrued schedules (M) — an annual insurance premium amortised across twelve
     months, posted monthly, rather than expensed in April and explained in March.
375. ✓ A deposit register (S) — security deposits paid and received, with the date they are due
     back. Money that is genuinely the business's and is routinely forgotten.

## U. Selling: the counter, the quote and the paper

The app assumes someone entering vouchers at a desk. A large part of this market is instead
standing at a counter with a customer waiting, or printing on hardware that predates PDF.

376. ✓ Counter mode (L) — full screen, scanner first, tender and change, and one keystroke to the
     next sale. A kirana, a pharmacy or a hardware shop cannot run the voucher screen at a
     counter, and that is most of the businesses this app is otherwise right for.
377. ✓ A cash-drawer session (M) — opening float, the day's sales, the closing count, and the
     variance. Counter mode without it is a billing screen rather than a till.
378. ✓ Quotation → order → challan → invoice, each converting into the next (L) — #188 and #189
     cover the middle; the quotation is missing entirely, and it is where the sale starts.
379. ✓ Dot-matrix and continuous stationery, printed raw (M) — a large share of this market prints
     invoices on a decade-old impact printer on pre-printed multi-part stationery, and a PDF
     does not reach it. This is a genuine Tally-compatibility feature, not a nostalgia one.
380. ✓ Salesperson commission, on collection rather than on billing (M) — the party already
     carries a salesperson (#156). Commission paid on an invoice that is never collected is how
     a business pays twice for one sale, so it is computed off the receipt.
381. ✓ A counter-sale party that does not become a master record (S) — a walk-in should not leave
     a ledger behind, and a thousand of them should not make the party picker unusable.
382. ✓ A price-below-cost warning at entry (S) — the valuation is already known per item; the
     moment it is worth saying so is while the line is being typed.
383. ✓ Quantity-break and scheme discounts (M) — buy ten get one, slab rates. Priced by hand today
     and got wrong in the customer's favour about as often as the reverse.
384. ✓ Returns and exchanges at the counter (M) — a credit note is the correct accounting and a
     terrible interaction when somebody is standing there with a receipt.
385. ✓ A second screen for the customer (S) — nearly free once counter mode exists, and the thing
     that makes a small shop look like it runs a real system.

## V. Control, delegation and trust

The owner is rarely the person typing. Everything here is about what happens when they are not
at the desk — which is the normal case, and the one the app currently has least to say about.

386. ✓ An approval threshold (M) — one number, in paise. Above it, a voucher entered by an
     accountant is saved, numbered, visible to whoever typed it, and deliberately OUT of the books
     until the owner decides (`IN_BOOKS` excludes it, so every report inherits the rule). Four
     edges are load-bearing and each has its own test: an unset threshold is off but **zero is
     not** — zero means everything waits, which is a real thing to do for a week after finding
     something wrong; the limit permits an entry exactly at it; the owner's own entry never waits;
     and a company with no users has no queue. An alteration is re-gated rather than
     grandfathered, because raising an approved ₹40,000 entry to ₹4,00,000 is the move the
     threshold exists to catch. A refusal keeps the entry out of the books and clears itself the
     moment the entry is corrected.
387. ✓ Attachments on a voucher (M) — the scan lives in `<company>/attachments/`, so the folder a
     user copies, syncs and backs up carries it. **Copied, not referenced**, and the comment in
     `src/shared/attachments.ts` says why: a reference is a promise about a path on somebody
     else's disk, it breaks when Downloads is emptied or the books move machine, and it breaks
     silently — the app would go on listing a bill that is nowhere. The price is disk, so the cap
     (10 MB, 20 per voucher, PDF/image/CSV only) is stated under the button rather than sprung
     after a slow copy. The same scan attached twice is recognised by SHA-256. A file deleted
     behind the app's back is shown struck through and flagged, never quietly dropped: the app
     losing evidence has to be visible.
388. ✓ A two-person rule for a supplier's bank details (S) — an account number, IFSC or holder
     change on an existing party is parked in `bank_detail_requests` and applied only when
     somebody else confirms it. The rest of the master saves as it always did, and the toast says
     which of the two things happened, because a change that silently did not take effect would
     be worse than no rule. Two deliberate differences from #386: the owner's own change is parked
     too (the risk here is a convincing letter, not a careless entry), and a company with fewer
     than two users is exempt — a rule nobody can satisfy is a master that never gets corrected.
389. ✓ The same bank account on two parties, as an exception (S) — a new section in the
     exceptions report, comparing account numbers normalised for spacing and case (leading zeros
     kept: two accounts differing by one are two accounts). The legitimate case is real and
     common — a proprietor and their firm — so a "knowingly shared" flag on the party silences
     it, but only when EVERY party on that account carries the flag, so a third name appearing
     later speaks up again.
390. ✓ A daily digest of what changed (M) — entered, altered, binned, restored, masters touched,
     imports, exports and sign-ins for a chosen day, with who did each and what the day's entries
     came to. Built from the audit log, which had recorded all of it and shown it to nobody.
     Queried on `date(at, 'localtime')`, not UTC: audit rows are stamped in UTC and India is
     +5:30, so the plain comparison would file every entry before 5:30 am under the wrong day —
     quietly wrong every single morning.
391. ✓ Auditor mode: a read-only session that expires (M) — the owner hands over the machine for
     1 to 8 hours; the session is a viewer (so every write channel refuses it by the gate that
     already exists), it is stamped as 'Auditor' on everything it touches, a pill in the header
     counts it down, and it ends by itself. In memory only and gone on quit, on purpose: a session
     that survived a restart would be a second way into the books outliving the visit, which is
     the failure it exists to prevent.
