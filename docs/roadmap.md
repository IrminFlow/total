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
12. A "recent screens" ring on `⌘\`` for alt-tab style switching (S)
13. Keyboard-driven date-range picker on the period pill (S)
14. `Alt+↑/↓` moves a voucher line up or down in the grid (S)
15. ✓ `⌘D` duplicates the selected voucher into a new draft (S)
16. `⌘⌫` deletes the selected row with an undo toast (S)
17. Space toggles the expand/collapse state of a tree row (S)
18. `⌘⇧F` opens global search scoped to the current screen (S)
19. Vim-style `gg` / `G` to jump to first/last row, behind a preference (S)
20. A visible focus-ring audit: every interactive control reachable by Tab (M)
21. Shortcut conflicts surfaced in Settings when a screen shadows a nav letter (S)
22. Per-user shortcut remapping stored in the company meta (M)
23. `?` overlay gains a search box once it exceeds one screen (S)
24. ✓ Numeric keypad Enter behaves as Enter everywhere (S) — already true: every handler
    switches on `e.key`, which Chromium reports as `Enter` for NumpadEnter. Verified no site
    switches on `e.code`.
25. A "keyboard only" mode that hides all hover affordances (S)

## B. Data entry speed

26. ✓ Undo for voucher delete, offered on the toast (M)
27. Voucher templates beyond recurring: save any voucher as a named template (M)
28. ✓ Copy the previous voucher of the same type with one key (S)
29. ✓ Auto-fill the narration from the party and item names (S)
30. Inline ledger creation without leaving the picker (already partly there) (S)
31. Paste a table of lines from a spreadsheet directly into the voucher grid (M)
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
42. Round-off line added automatically when a line is a paisa out (S)
43. Voucher numbering series per type per financial year, configurable (M)
44. ✓ Flag a gap in voucher numbering in Exceptions (S) — detection, not prevention: refusing
    to save a voucher that would leave a gap is worse than the gap. Numbers are allocated at
    save time, two people entering at once legitimately leave one when either cancels, and a
    business that has just voided an invoice must still be able to carry on.
45. Auto-save an in-progress voucher as a draft, restored after a crash (M)
46. A scratchpad ledger for entries the user has not decided how to classify (S)
47. Barcode scan jumps straight to quantity on the matched item line (S)
48. Repeat-last-line key for entering many similar lines (S)
49. Party defaults: credit days, price level and cost centre applied on selection (S)
50. ✓ Show the party's current balance inline while entering a voucher (S)

## C. Reports and analysis

51. ✓ Quarterly, half-yearly and annual period granularity (M)
52. ✓ Day Book paged at the IPC boundary (M)
53. ✓ Ledger Statement paged; Outstandings sends a summary and fetches bills on expand (M)
54. Row virtualization so a 30,000-row report scrolls without 30,000 DOM nodes (M)
55. ✓ Comparative columns: this period against the same period last year (M)
56. ✓ Drill-down from any figure in P&L or Balance Sheet to its ledger (M) — already shipped:
    StatementTree opens the ledger statement on a leaf click, and the comparison view does too.
57. A time-travel Balance Sheet: a date scrubber that recomputes as-on any date (M)
58. Saved report views: filters, columns and period stored by name (M)
59. Schedule a report to be written to a folder on a timer (M)
60. Ratio analysis: current ratio, quick ratio, debt-equity, inventory turnover (M)
61. Cash flow forecast from open bills, PDCs and recurring templates (L)
62. Monthly trend sparklines on every Gateway tile (S)
63. Group-wise summary rows in the Trial Balance, collapsible (M)
64. ✓ Multi-column Trial Balance: opening, movement, closing (S) — already shipped
65. ✓ Negative-balance highlighting on ledgers that should never be negative (S)
66. A "what changed" report between two dates for any ledger (M)
67. Export any report to XLSX rather than only CSV (M)
68. Print layouts that fit A4 without cutting columns (M)
69. ✓ Report headers carrying the company name, GSTIN and period on every page (S)
70. A CA-facing summary pack: TB, P&L, BS, ageing in one PDF (M)
71. Cost-centre profitability report (M)
72. Item-wise gross margin by period (M)
73. ✓ Party-wise sales ranking with concentration warning (S)
74. ✓ Day Book grouped by voucher type with subtotals (S) — shipped as a summary view rather
    than in-list subtotals: the list is paged, and subtotals over a page are subtotals of an
    arbitrary slice.
75. ✓ An audit-trail report of who changed what, per voucher (S)
76. ✓ Reconciliation status column on the Day Book for bank vouchers (S)
77. Exception report: vouchers with no narration, over a threshold (S)
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
112. Multi-godown stock transfer voucher (M)
113. ✓ Reorder level with a purchase suggestion report (M)
114. ✓ Batch expiry tracking with a near-expiry report (M)
115. Serial-number tracking for high-value items (L)
116. ✓ Stock ageing by batch rather than by item (M)
117. Landed cost allocation across a purchase (M)
118. Standard costing with variance against actual (L)
119. Item images on the invoice and in the picker (M)
120. ✓ Alternate units of measure with conversion (M)
121. Item-wise reorder email or WhatsApp alert (S)
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

131. Per-bank statement import profiles: HDFC, ICICI, SBI, Axis, Kotak (M)
132. PDF bank statement table extraction for the top banks (L)
133. Auto-match on narration keywords, learned from past matches (M)
134. Bulk-accept all high-confidence matches (S)
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
147. Bank rules editable inline from the unmatched row (S)
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
206. Natural-language voucher entry producing a draft (M)
207. Document to voucher: photograph a bill, extract, draft (L)
208. Bank reconciliation AI re-ranker behind the deterministic pass (M)
209. GST anomaly explanation grounded on the validation output (M)
210. Month-end close checklist assistant, read-only (M)
211. Anomaly watch: flag entries unlike anything in the history (M)
212. Ask-bar in ⌘K that resolves to a report, deterministically first (M)
213. Assistant spend caps per session and per day, enforced in main (S)
214. A visible "show me exactly what would be sent" payload viewer (S)
215. Streaming cancellation from the Esc key (S)
216. Local-model presets for Ollama and LM Studio (S)
217. Assistant audit trail joining question, draft and posted voucher (S)
218. MCP write tools behind two independent switches (done) plus a rate limit (S)
219. MCP resources for the chart of accounts and the voucher schema (done) (S)
220. An agent-facing changelog resource so a model knows what changed (S)
221. Prompt-injection hardening: tool results are data, never instructions (M)
222. Redaction preview: show what the assistant will and will not send (S)
223. Assistant answers cite refs the UI can click through to (M)

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
244. One-click "move my data out of a synced folder" (M)
245. Backup to an external drive or folder on a schedule (M)
246. Restore preview: what will change before it changes (M)
247. ✓ Integrity check run on a timer (S) — already shipped: the full PRAGMA integrity_check
     runs at most once every 7 days, throttled through meta, alongside the per-open quick_check.
248. Corrupt-database recovery guidance in the UI, not just an error (M)
249. Transaction log of every write, replayable (L)
250. Crash-safe voucher draft recovery (M)
251. Duplicate-company detection when restoring (S)
252. ✓ Backup retention policy configurable, 5 to 200 (S) — floored at 5, because a retention
     of 1 means the next open overwrites the only copy.
253. Encrypted backup to a user-chosen cloud folder, client-side encrypted (M)
254. Data export in a documented open format, guaranteed round-trip (M)
255. ✓ A "what would I lose" summary before a restore (S) — counted by opening the backup,
     since a backup file is the only authority on what is in it.
256. ✓ Bin auto-purge policy, configurable, with what the next purge would take shown on the
     Bin screen (S) — 0 means never, which is a policy rather than a disabled feature.
257. Company-level read-only lock for archived years (M)
258. Year-end close reversal, if it was run in error (M)
259. Multi-device conflict detection via a file lock and a heartbeat (M)

## M. Security and privacy

260. ✓ GST portal credentials moved to the OS keychain (S)
261. ✓ AI key never reaches the renderer or the data directory (S)
262. Optional at-rest encryption of the company database (L)
263. ✓ Auto-lock after a configurable idle period (S)
264. PIN attempt throttling with exponential backoff (already partly there) (S)
265. Audit log tamper-evidence via a hash chain (M)
266. Per-user permissions finer than three roles (M)
267. ✓ Session timeout, as the idle auto-lock (#263) — a separate timeout on the lock screen
     itself would guard a screen that already holds nothing (S)
268. Redact sensitive fields in exported diagnostics (done) (S)
269. Content-Security-Policy audit and tightening (S)
270. Dependency vulnerability gate in CI (S)
271. Signed releases and update verification (config done) (M)
272. ✓ Privacy page documenting exactly what leaves the machine (S) — written as a list of
     network calls, not as a policy: that is the only form a reader can check against the app.
273. ✓ A "panic" key that locks immediately — ⌘⇧L from any screen (S)

## N. Accessibility

274. ✓ Accessible names on every control, enforced by an E2E that walks every sidebar screen (M)
275. Screen-reader announcements for row selection changes (M)
276. ✓ Live regions for toast messages, assertive while an error is showing (S)
277. Reduced-motion honoured everywhere (partly done) (S)
278. High-contrast theme beyond light and dark (M)
279. Font-size preference that scales the whole type scale (M)
280. Focus trap audit on every modal (partly done) (S)
281. ✓ Table headers associated with cells via scope (S) — 321 headers across 31 files
282. ✓ Colour is never the only signal: Dr/Cr also carry text (S) — already shipped
283. Keyboard access to every context action currently on hover (M)
284. ✓ Skip-to-content link (S)
285. ✓ Form errors announced, not only shown (S)
286. Minimum tap-target sizes on the LAN companion, when it exists (S)
287. ✓ Language attribute set on the document (S) — already shipped; revisit when bilingual
     invoice printing (#184) lands and a second language is actually on screen.

## O. Onboarding and migration

288. ✓ Tally import reconciliation: "matched to the paise" (M)
289. Guided opening-balance entry for businesses not coming from Tally (M)
290. Import from Busy, Marg and Vyapar (L)
291. Excel and CSV import of masters and opening balances (M)
292. ✓ The red letters taught as a checklist step rather than as a tour (S) — a modal tour is
     dismissed and forgotten; a step that stays until the shortcut sheet has been opened is not.
293. Sample company that mirrors the user's own trade (M)
294. ✓ Checklist that survives across sessions until complete (S) — derived from the books, so
     it cannot be ticked without doing the thing and it reopens if the thing is undone.
295. Screenshots of Tally's own export dialog, per version (S)
296. Import dry-run diff: what will be created, changed, skipped (M)
297. Re-import safety: never duplicate an already-imported voucher (M)
298. Migration report PDF for the CA to sign off (M)
299. Restore from a Tally backup file directly (L)
300. Import progress with a cancel button (S)

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
312. In-app feedback form posting to a real endpoint (M) — the endpoint exists:
     `site/app/api/feedback/route.ts` stores each message as an issue in the private repo and
     forwards it by mail, and returns 503 rather than swallowing anything when no sink is
     configured. The in-app half is the other half of this item.
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
344. A generated 100,000-voucher book, timed through every screen, with the numbers published (M)
     — #224 measured 30k and #329 asks for the fixture; this is the stress pass at three times
     that, and the artefact doubles as marketing. A report that is fine at 30k and unusable at
     100k is a report that fails during an evaluation, which is the worst possible moment.
345. An error ring buffer attached to the feedback form, with a pre-send preview (S) — launch
     week reaches machines nobody has seen, and a `mailto:` is not a channel. The preview is the
     point: diagnostics the user has read are diagnostics the user will send.
346. First-run on a machine that has never held the app (S) — no company, no data directory, no
     keychain entry, no `~/Documents/total`. Every existing test starts from a seeded state.
347. 1366×768 at 125% scaling, on a real ₹40,000 Windows laptop (S) — the modals, the sidebar
     and the ledger table at the size most of the market actually runs them.
348. The release steps as a script rather than a memory (S) — verify, tag, push, and then assert
     the release published rather than drafted. A draft release is invisible to `releases/latest`,
     which is what the in-app updater and the site both read.
349. Relabel NIC live filing as experimental until it has run against the sandbox (S) — the site
     currently sells "live IRN and e-way bill generation" for a client that has never met the
     real portal. Lead with the offline JSON export, which works. See #107.
350. Uninstall and reinstall leaving the books untouched, proven by a test (S) — the promise is
     that the data is the user's and lives in their Documents folder. Nothing checks it.

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

386. An approval threshold (M) — a voucher above a stated amount, entered by an accountant,
     waits for the owner. The roles exist; what is missing is the idea that some entries are a
     decision rather than a keystroke.
387. Attachments on a voucher (M) — the scan or photograph of the bill, stored under the company
     folder and carried into the backup. "Where is the physical bill" is a daily question and
     there is currently no answer in the app at all.
388. A two-person rule for a supplier's bank details (S) — changing an account number on a
     supplier master is the single highest-value fraud available in this market, and it is
     currently one field and one click.
389. The same bank account on two parties, as an exception (S) — either a data error or exactly
     the fraud #388 guards against. The exceptions report is already the place this belongs.
390. A daily digest of what changed (M) — what was entered, altered and binned yesterday, for
     the owner who was not there. Built from the audit log, which has recorded all of it and
     shows it to nobody unless asked.
391. Auditor mode: a read-only session that expires (M) — narrower than #266's permissions and
     answering a different question. Handing an auditor the owner's PIN is what happens instead.
