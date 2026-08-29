# Total: 300 product and technical improvements

This is the long-form opportunity backlog for Total after v5. Items are deliberately concrete,
customer-visible where possible, and ordered into domains rather than pretending all 300 should be
built at once. Priority markers: **P0** protects correctness or unlocks release, **P1** materially
improves daily use or revenue, and **P2** expands depth, reach, or long-term leverage.

## 1. Onboarding, setup and activation

1. **P0 — Readiness check:** verify writable data folder, free disk space, backups, clock and secure credential storage before company creation.
2. **P0 — Guided company setup:** ask only business type, GST status, state, books-from date and inventory/payroll needs, then derive sensible defaults.
3. **P0 — Opening-balance review:** show assets, liabilities and the unresolved difference before allowing normal posting.
4. **P0 — Setup progress:** keep a resumable checklist for company details, ledgers, opening stock, bank accounts, taxes and first voucher.
5. **P1 — Business templates:** offer retailer, wholesaler, service firm, manufacturer, freelancer and professional-services charts of accounts.
6. **P1 — Tally migration wizard:** sequence export instructions, file validation, import preview, reconciliation and sign-off.
7. **P1 — Spreadsheet migration wizard:** map arbitrary columns to ledgers, parties, items and opening balances with saved mappings.
8. **P1 — Demo by industry:** generate realistic books tailored to the user’s industry instead of one generic demo company.
9. **P1 — First-voucher coach:** guide a real sale or expense with contextual explanations that disappear after successful use.
10. **P1 — Setup health score:** surface missing GST details, bank ledgers, invoice identity, backup location and opening-balance issues.
11. **P1 — Accountant handoff pack:** export a setup questionnaire and re-import the accountant’s completed configuration.
12. **P2 — Prior-software selector:** adapt terminology and shortcut hints for Tally, Busy, Marg, Zoho Books, Excel or first-time users.
13. **P2 — Sample import generator:** produce correctly formatted CSV and JSON templates populated with the company’s own IDs and settings.
14. **P2 — Setup rollback points:** create named restore points before every import or major configuration step.
15. **P2 — Activation analytics:** locally measure time-to-company, time-to-first-voucher and abandoned setup steps, with opt-in sharing.

## 2. Navigation, workspace and daily operations

16. **P0 — Month-close workspace:** show bank reconciliation, GST checks, suspense, stock exceptions, backups and period lock in one flow.
17. **P0 — Universal command actions:** create vouchers, change dates, export reports, open companies and run backups from Command K.
18. **P0 — Shortcut conflict detector:** prevent configurable mnemonics from colliding within the same screen or global scope.
19. **P1 — Custom home layout:** let users reorder Gateway tiles, hide unused sections and choose compact or comfortable density.
20. **P1 — Saved workspaces:** switch between Bookkeeper, Owner, GST, Collections, Inventory and Payroll screen arrangements.
21. **P1 — Continue working:** restore the last company, screen, report filters, selection and scroll position after restart.
22. **P1 — Global recent records:** reopen recently viewed vouchers, ledgers, parties, items and reports, not only screens.
23. **P1 — Cross-company switcher:** move between companies without returning to the company picker while preserving each session state.
24. **P1 — Quick date language:** support “today”, “last Friday”, “Q2”, “last FY” and Indian date shorthand consistently.
25. **P1 — Batch action tray:** collect selected vouchers or parties for export, print, tag, review or reversal.
26. **P1 — Personal task inbox:** allow notes, due dates and links to vouchers, parties, returns and reports.
27. **P2 — Workspace profiles by user:** synchronize pinned screens and density preferences across companies on the same machine.
28. **P2 — Focus mode:** temporarily hide unrelated navigation during voucher entry, reconciliation or return preparation.
29. **P2 — Screen history timeline:** provide forward/back navigation across drilled reports and records with meaningful labels.
30. **P2 — Morning digest:** generate a local daily summary of cash, overdue bills, deadlines, exceptions and scheduled work.

## 3. Voucher entry and accounting controls

31. **P0 — Duplicate detection:** warn on duplicate supplier invoice number, date, party and amount before posting.
32. **P0 — Suspicious-entry checks:** flag unbalanced taxes, round amounts, unusual ledgers, future dates and reversed debit/credit patterns.
33. **P0 — Explicit reversal:** create linked reversal vouchers with reason, author and original-voucher traceability.
34. **P0 — Draft vouchers:** allow incomplete entries to be saved outside posted books and resumed safely.
35. **P0 — Voucher validation summary:** show all blocking errors and warnings together, linked to the exact fields.
36. **P1 — Voucher duplication:** clone a prior voucher while clearing identifiers and recalculating dates, taxes and bill references.
37. **P1 — Entry templates:** save reusable line patterns for rent, utilities, payroll, bank charges and recurring journals.
38. **P1 — Smart ledger defaults:** remember narration, tax treatment, cost centre and bill behavior per party without silent posting.
39. **P1 — Split payment helper:** allocate one receipt or payment across bills, discounts, write-offs and advances visually.
40. **P1 — Attachment bundle:** associate invoices, receipts, emails and delivery documents with each voucher.
41. **P1 — Voucher comments:** keep non-accounting review notes separate from narration and the immutable audit trail.
42. **P1 — Approval threshold:** require owner approval for vouchers above an amount or involving sensitive ledgers.
43. **P1 — Copy lines from clipboard:** parse tabular rows into voucher lines with preview and validation.
44. **P2 — Compound entry assistant:** guide asset purchase, loan repayment, import purchase and advance adjustment workflows.
45. **P2 — Keyboard macro recorder:** capture safe entry sequences without allowing macros to bypass validation or approval.

## 4. Receivables, collections and customer credit

46. **P0 — Collections queue:** rank overdue invoices by amount, age, customer history and promised payment date.
47. **P0 — Promise-to-pay tracking:** record amount, date, owner and outcome against a customer without changing books.
48. **P0 — Credit-limit enforcement:** warn or block invoices beyond customer limit or overdue-policy rules with override reason.
49. **P1 — Customer timeline:** combine invoices, receipts, credit notes, reminders, promises and notes chronologically.
50. **P1 — Statement generator:** create branded customer statements by date range with opening, activity and closing balance.
51. **P1 — Reminder drafts:** generate email or WhatsApp-ready payment reminders with invoice details and payment instructions.
52. **P1 — Reminder cadence:** schedule manual-review reminders at configurable overdue intervals.
53. **P1 — Dispute status:** mark invoices under dispute, assign a reason and exclude them from normal reminder runs.
54. **P1 — Collection ownership:** assign parties to staff and show workload, follow-ups due and collected amount.
55. **P1 — Receipt suggestion:** match incoming money to open invoices using amount, date, reference and payer clues.
56. **P1 — Customer ageing trend:** compare ageing buckets over months and highlight deterioration.
57. **P1 — Average collection days:** calculate customer and company-level DSO with transparent drill-down.
58. **P2 — Customer risk bands:** derive explainable low/medium/high risk from lateness, disputes and exposure.
59. **P2 — Early-payment terms:** model discounts, expiry dates and realized financing cost.
60. **P2 — Collections forecast:** project expected receipts from due dates, payment behavior and explicit promises.

## 5. Payables, purchasing and supplier management

61. **P0 — Supplier due queue:** rank payable bills by due date, discount deadline, amount and available cash.
62. **P0 — Payment-run drafts:** select bills, preview bank impact and create reviewable payment vouchers in a batch.
63. **P0 — Three-way match:** compare purchase order, goods receipt and supplier invoice quantities, rates and taxes.
64. **P1 — Purchase requisitions:** capture internal requests and approval before creating purchase orders.
65. **P1 — Purchase orders:** track ordered, received, billed, cancelled and outstanding quantities.
66. **P1 — Goods receipt notes:** receive stock independently from the supplier invoice and preserve variance history.
67. **P1 — Supplier price history:** show last rate, average rate and recent trend while entering a purchase.
68. **P1 — Supplier comparison:** compare landed price, payment terms, delivery performance and rejection rate.
69. **P1 — Debit-note workflow:** raise and link debit notes for shortages, quality rejection and rate differences.
70. **P1 — Expense approval inbox:** route employee or department expenses for approval before posting.
71. **P1 — Payment advice:** generate supplier-wise remittance documents listing settled bills and deductions.
72. **P1 — Advance management:** track supplier advances, pending adjustment and ageing.
73. **P2 — Reorder-to-PO:** convert approved stock suggestions into grouped supplier purchase-order drafts.
74. **P2 — Vendor onboarding:** collect tax, bank and contact details with duplicate and compliance checks.
75. **P2 — Supplier concentration:** identify dependency risk by purchase share, category and replacement availability.

## 6. Banking, cash and treasury

76. **P0 — Learned reconciliation rules:** remember reviewed description-to-ledger mappings with confidence and easy rollback.
77. **P0 — Reconciliation completeness:** distinguish book-only, bank-only, matched, ignored and timing-difference items clearly.
78. **P0 — Opening bank difference:** explain any mismatch between statement opening balance and book balance before matching.
79. **P1 — Multi-format statement import:** support bank-specific CSV, XLSX, OFX, QIF and MT940 mappings.
80. **P1 — Rule builder:** match by text, amount range, direction, account and date, then propose ledger and narration.
81. **P1 — Transfer matching:** identify both sides of inter-bank transfers and link the contra voucher.
82. **P1 — Bank-charge extraction:** split charges and taxes from settlement deposits or payment-gateway payouts.
83. **P1 — Cheque lifecycle:** track issued, deposited, cleared, bounced, cancelled and stale cheques.
84. **P1 — Cash denomination count:** reconcile physical cash by denomination and post approved differences.
85. **P1 — Daily cash position:** combine bank balances, cash, expected receipts and payments across accounts.
86. **P1 — Cash-flow forecast:** project 13 weeks using open bills, payroll, recurring entries and manual scenarios.
87. **P1 — Payment file export:** generate reviewable bank upload files for supported formats without storing online banking credentials.
88. **P2 — Optional bank feeds:** connect a user-selected provider with scoped consent and retain CSV as a permanent fallback.
89. **P2 — Liquidity scenarios:** model delayed collections, major purchases, loans and tax payments side by side.
90. **P2 — Idle-cash alerts:** identify sustained excess or shortfall thresholds without giving investment advice.

## 7. GST, TDS and Indian compliance

91. **P0 — GST readiness centre:** centralize missing GSTIN, HSN/SAC, place-of-supply, rate and reverse-charge issues.
92. **P0 — Books-to-return bridge:** drill every GSTR-1 and GSTR-3B value down to vouchers and tax lines.
93. **P0 — Return freeze:** snapshot prepared return data and show subsequent book changes before export or filing.
94. **P0 — Filing acknowledgement store:** attach ARN, filing date, status and submitted JSON to the period.
95. **P1 — GSTR-2B reconciliation:** match supplier invoices by GSTIN, number, date, taxable value and tax with tolerance rules.
96. **P1 — ITC action queue:** classify missing, mismatched, blocked, reversed and follow-up credits.
97. **P1 — E-invoice status centre:** track pending, generated, cancelled and failed IRNs with retry-safe requests.
98. **P1 — E-way bill lifecycle:** track generation, extension, cancellation, vehicle updates and expiry warnings.
99. **P1 — TDS applicability helper:** suggest sections and thresholds while requiring user confirmation.
100. **P1 — TDS return workspace:** reconcile deductions, challans, deductees and return records by quarter.
101. **P1 — Compliance calendar:** include GST, TDS, PF, ESI and configurable state obligations with status and ownership.
102. **P1 — LUT/export workflow:** distinguish export with payment, without payment, SEZ and deemed export treatments.
103. **P2 — Multi-GSTIN entities:** support registrations by state with registration-specific numbering, stock and returns.
104. **P2 — Notice evidence pack:** export relevant returns, vouchers, reconciliations, attachments and audit history for a period.
105. **P2 — Tax-rule content packs:** version effective dates and explanations separately from deterministic calculation code.

## 8. Reports, analysis and management insight

106. **P0 — Universal report drill-down:** every amount should open the exact contributing voucher set.
107. **P0 — Report provenance:** show as-of date, filters, accounting basis, generated time and data freshness on every export.
108. **P0 — Saved report views:** preserve filters, columns, sorting, comparisons and date logic per company.
109. **P1 — Budget vs actual:** compare by month, ledger group, cost centre, project and branch.
110. **P1 — Rolling comparison:** support previous month, quarter, year, prior FY and custom comparison ranges.
111. **P1 — Variance explanations:** decompose changes into customers, suppliers, items, price, quantity and timing.
112. **P1 — Ratio definitions:** expose formulas and drill-downs for liquidity, leverage, margins, turns and collection days.
113. **P1 — Owner dashboard:** show cash, sales, margin, collections, payables, stock and compliance without accounting jargon.
114. **P1 — Accountant dashboard:** prioritize suspense, negative stock, unusual entries, unreconciled banks and tax exceptions.
115. **P1 — Cost-centre P&L:** compare teams, stores, projects and departments with allocation transparency.
116. **P1 — Branch consolidation:** combine companies or branches with eliminations and currency translation.
117. **P1 — Schedule III statements:** produce configurable company-format financial statements and notes mappings.
118. **P2 — Scenario reports:** save base, conservative and growth assumptions without affecting posted books.
119. **P2 — Report annotations:** attach explanations to a period or row and include selected notes in exports.
120. **P2 — Portable report pack:** generate one indexed PDF/ZIP containing statements, schedules and supporting ledgers.

## 9. Inventory, fulfillment and manufacturing

121. **P0 — Negative-stock prevention:** warn or block by item, godown and date, including backdated consequences.
122. **P0 — Stock audit trail:** explain each quantity and value movement from source vouchers.
123. **P0 — Valuation reconciliation:** tie closing stock reports to financial statements and identify differences.
124. **P1 — Batch and expiry:** track batch, manufacture date, expiry and near-expiry stock actions.
125. **P1 — Serial numbers:** manage unique serials through purchase, transfer, sale, return and warranty.
126. **P1 — Multiple godowns:** support transfers, in-transit stock, reservations and location-wise availability.
127. **P1 — Reorder planner:** use reorder level, lead time, sales velocity, open orders and safety stock.
128. **P1 — Stock count sessions:** freeze a count scope, scan/count offline, review variance and post adjustment.
129. **P1 — Barcode labels:** design and print item, batch, price and serial labels in common sheet formats.
130. **P1 — Sales reservation:** reserve available stock for confirmed orders and expose shortages before invoicing.
131. **P1 — Manufacturing orders:** plan BOM consumption, output, scrap, by-products, work-in-progress and completion.
132. **P1 — BOM versions:** retain effective dates, revisions and costing history for manufactured items.
133. **P1 — Landed cost:** allocate freight, duty, insurance and clearing charges across imported stock.
134. **P2 — Demand forecast:** estimate item demand with seasonality, promotions and manual overrides.
135. **P2 — Slow/non-moving actions:** classify inventory and recommend transfer, discount, return or procurement pause.

## 10. Payroll and workforce accounting

136. **P0 — Payroll preflight:** identify missing attendance, salary structure, bank details, statutory IDs and negative net pay.
137. **P0 — Payroll lock:** freeze approved runs and require an explicit supplementary or reversal run for changes.
138. **P0 — Payroll-to-books tie-out:** reconcile gross, deductions, employer costs, payables and bank amount.
139. **P1 — Attendance import:** map biometric or spreadsheet attendance with validation and exception review.
140. **P1 — Leave management:** track balances, accrual, carry-forward, encashment and unpaid leave.
141. **P1 — Salary revisions:** future-date changes and retain complete component history.
142. **P1 — Employee loans/advances:** schedule deductions, interest, pauses and final settlement.
143. **P1 — Reimbursements:** capture claims, approval, taxable treatment, payment and attachment.
144. **P1 — Contractor payments:** manage non-payroll payees, TDS, work periods and certificates.
145. **P1 — Full and final settlement:** calculate notice, leave, gratuity, recovery and outstanding advances.
146. **P1 — Payslip delivery pack:** generate encrypted PDFs or a local export bundle without requiring cloud email.
147. **P1 — Statutory workspaces:** reconcile PF, ESI, PT and TDS deductions to challans and filing periods.
148. **P2 — Shift and overtime rules:** support configurable calendars, weekly offs, holidays and approval.
149. **P2 — Department payroll analysis:** compare headcount, gross cost, overtime and employer cost over time.
150. **P2 — Workforce provisioning:** import joiners and leavers in a validated batch with effective dates.

## 11. Sales documents and customer operations

151. **P0 — Document conversion chain:** convert quotation → order → delivery challan → invoice without duplicate entry.
152. **P0 — Numbering integrity:** preview sequence effects and prevent accidental duplicates across document series.
153. **P1 — Quotation builder:** support validity, optional items, terms, taxes, discounts and revision history.
154. **P1 — Sales orders:** track ordered, allocated, delivered, invoiced, cancelled and backordered quantities.
155. **P1 — Delivery challans:** support job work, approval, returns and invoice conversion.
156. **P1 — Proforma invoices:** clearly distinguish non-posting proformas from tax invoices.
157. **P1 — Recurring invoices:** generate a preview batch with exceptions and customer-specific schedules.
158. **P1 — Price lists:** manage wholesale, retail, customer-specific and date-effective pricing.
159. **P1 — Discount authority:** enforce maximum discount by user role, item or customer.
160. **P1 — Sales returns:** trace returned quantities and values back to original invoice lines.
161. **P1 — Warranty register:** link serials, invoice date, coverage and service outcomes.
162. **P1 — Custom document fields:** add validated fields without changing core accounting semantics.
163. **P2 — Customer portal bundle:** generate a secure offline package of invoices, statements and receipts.
164. **P2 — Route/territory reporting:** analyze sales, collections and returns by salesperson or geography.
165. **P2 — Subscription contracts:** track plan, billing cycle, escalation, pause, renewal and invoice drafts.

## 12. Collaboration, review and internal controls

166. **P0 — Maker-checker policy:** require different users to create and approve selected voucher types or thresholds.
167. **P0 — Permission matrix:** configure view, create, edit, approve, export, backup and settings rights by role.
168. **P0 — Sensitive-field masking:** hide salary, bank account, tax ID or margin fields from restricted users.
169. **P0 — Audit integrity verification:** detect missing, reordered or altered audit entries with a hash chain.
170. **P1 — Review inbox:** assign voucher questions, owners, due dates and resolution status.
171. **P1 — Period sign-off:** record preparer, reviewer, approvals, outstanding issues and evidence.
172. **P1 — Export permissions:** separately control PDF, spreadsheet, JSON mirror and full-data export.
173. **P1 — Temporary access:** grant time-limited accountant or auditor access on the device.
174. **P1 — Session dashboard:** show signed-in users, lock status and last activity for shared installations.
175. **P1 — Change comparison:** display exact before/after fields when reviewing altered masters or vouchers.
176. **P1 — Policy exceptions:** require a reason and approval when overriding lock, credit or validation warnings.
177. **P2 — Review bundle exchange:** export encrypted questions and evidence for offline accountant collaboration.
178. **P2 — Department boundaries:** restrict cost centres, branches, godowns or voucher types by role.
179. **P2 — Evidence retention:** set document-retention policies with warnings before any purge.
180. **P2 — Control report:** summarize overrides, deleted drafts, reversals, late postings and privileged actions.

## 13. Import, export and migration

181. **P0 — Universal import preview:** show creates, updates, skips, warnings and errors before touching books.
182. **P0 — Atomic import batches:** guarantee full rollback when any row in a committed batch fails.
183. **P0 — Import reconciliation:** compare source totals, imported totals and rejected records by period and type.
184. **P0 — Idempotent imports:** recognize a previously imported file and prevent duplicate posting.
185. **P1 — Mapping profiles:** save reusable column, ledger, tax, unit and date mappings by source.
186. **P1 — Error workbook:** export rejected rows with exact reason and stable source row identifiers.
187. **P1 — Busy import:** support masters and voucher migration from available Busy formats.
188. **P1 — Zoho Books import:** map contacts, items, invoices, bills, payments and opening balances.
189. **P1 — Marg import:** support common master and transaction exports used by retail businesses.
190. **P1 — Generic journal import:** accept validated debit/credit rows with grouping into balanced vouchers.
191. **P1 — Attachment import:** connect source document files to imported vouchers by filename/reference mapping.
192. **P1 — Full portable export:** produce a documented, versioned JSON package independent of SQLite internals.
193. **P2 — Migration dry-run report:** estimate unsupported fields, duplicate risk and manual cleanup before import.
194. **P2 — Schema migration CLI:** upgrade old portable JSON packages with a report of every transformation.
195. **P2 — Exit guarantee:** document and test exports sufficient to leave Total without vendor assistance.

## 14. AI, OCR and safe automation

196. **P0 — Citation requirement:** every AI claim about the books must link to exact report rows or vouchers.
197. **P0 — Context inspector:** show and allow removal of every data field before it is sent to a provider.
198. **P0 — Provider boundary tests:** verify base URL, TLS policy, timeout, response size and malformed response handling.
199. **P0 — Proposal-only writes:** keep AI-created vouchers inert until human validation and approval.
200. **P1 — Invoice OCR inbox:** extract supplier, number, date, GSTIN, items and taxes into a review screen.
201. **P1 — Receipt capture:** extract merchant, date, amount and tax from images with duplicate detection.
202. **P1 — Ledger suggestion:** rank possible ledgers using party history and narration while showing the evidence.
203. **P1 — Reconciliation assistant:** explain top bank matches and why alternatives ranked lower.
204. **P1 — Variance narrator:** describe material changes with cited numbers and no uncited conclusions.
205. **P1 — Natural-language search:** find vouchers and reports through constrained indexed search, not generated SQL.
206. **P1 — Draft reminder writer:** create editable collection messages grounded in selected invoices.
207. **P1 — Local model option:** support compatible localhost providers for OCR, classification and summaries.
208. **P2 — Per-task routing:** choose separate providers/models for OCR, extraction, analysis and writing.
209. **P2 — Evaluation harness:** score extraction accuracy, citation validity and voucher-draft correctness on fixed fixtures.
210. **P2 — Feedback learning:** remember accepted ledger suggestions locally without training on or uploading book data.

## 15. Integrations, MCP and extensibility

211. **P0 — Versioned MCP contract:** publish stable tool schemas, errors and capability metadata per app version.
212. **P0 — MCP permission scopes:** separate company listing, mirror reads, attachment reads and proposal creation.
213. **P0 — MCP audit log:** record client, tool, company, timestamp and proposal ID without logging secrets.
214. **P1 — Live mirror freshness:** expose generated time and a safe user-approved refresh operation.
215. **P1 — Scoped API tokens:** issue revocable local tokens constrained by company, action and expiry.
216. **P1 — Plugin manifest:** declare version, permissions, screens, imports, exports and compatibility.
217. **P1 — Importer SDK:** let partners add formats without direct database access.
218. **P1 — Report extension API:** expose audited report primitives and drill-down contracts rather than SQL.
219. **P1 — Webhook outbox:** queue optional external events with retry, signature and customer-visible payload.
220. **P1 — Local automation scheduler:** run backups, mirror exports and report packs with visible history.
221. **P2 — Payment-provider settlement adapters:** reconcile gateway payouts, fees, refunds and withholding.
222. **P2 — Ecommerce order adapters:** import orders, cancellations, returns, taxes and settlement references.
223. **P2 — Logistics export adapters:** generate shipment-ready documents without making logistics a core dependency.
224. **P2 — Plugin sandbox:** isolate third-party code with explicit filesystem, network and company permissions.
225. **P2 — Compatibility test kit:** provide fixtures and validation tools for third-party integrations.

## 16. Data safety, privacy and security

226. **P0 — Backup verification:** open every automatic backup read-only and run integrity checks before marking it valid.
227. **P0 — Restore preview:** show company, version, period, size and integrity before restoring into a new slug.
228. **P0 — Atomic config writes:** use temporary files, fsync where needed and rename for every mutable JSON setting.
229. **P0 — Secret inventory:** enumerate where API keys, NIC credentials and PIN material are stored and verify encryption.
230. **P0 — Safe diagnostics preview:** display and redact the exact support payload before submission.
231. **P1 — Encrypted portable backup:** create password-protected archives with recovery guidance and strength checks.
232. **P1 — Backup destinations:** support local folder, external disk and user-mounted cloud folder without embedding a cloud SDK.
233. **P1 — Recovery drill:** periodically prompt owners to verify that one backup can be restored successfully.
234. **P1 — Data-path health:** warn about read-only folders, failing disks, network volumes and unavailable destinations.
235. **P1 — Privacy centre:** centralize network features, provider endpoints, consent, diagnostics and retention.
236. **P1 — Attachment encryption:** optionally encrypt stored source documents using platform-protected keys.
237. **P1 — Clipboard protection:** clear sensitive copied values after a configurable interval.
238. **P2 — Tamper-evident exports:** sign report packs and portable exports with a locally managed identity.
239. **P2 — Backup rotation policies:** support daily, weekly, monthly and year-end retention with space forecasts.
240. **P2 — Threat-model release gate:** review IPC, navigation, filesystem, update, MCP and provider boundaries every release.

## 17. Performance, resilience and scale

241. **P0 — Startup budget:** measure cold start, company open and first interactive screen in CI against fixed limits.
242. **P0 — Large-book fixtures:** test realistic companies with millions of voucher lines and years of history.
243. **P0 — Query-plan regression:** capture critical SQLite query plans and fail on accidental full scans.
244. **P0 — Crash-safe writes:** prove voucher, migration, import and approval transactions survive forced termination.
245. **P1 — Route-level code splitting:** load heavy payroll, GST and import screens only when opened.
246. **P1 — Virtualized reports:** keep large day books, ledgers and stock lists responsive without rendering every row.
247. **P1 — Background report work:** move expensive computation off the renderer while preserving deterministic results.
248. **P1 — Query cancellation:** stop obsolete report and search work when filters or screens change.
249. **P1 — Progressive report rendering:** show totals and first rows early while clearly marking incomplete data.
250. **P1 — Database maintenance:** expose integrity check, optimize, checkpoint and size diagnostics safely.
251. **P1 — Low-disk mode:** block risky imports, preserve writes and guide cleanup before disk exhaustion.
252. **P1 — Corruption recovery:** isolate damaged companies, preserve originals and attempt recovery into a copy.
253. **P2 — Worker pool limits:** prevent exports, PDFs, OCR and reports from starving interactive entry.
254. **P2 — Memory budgets:** track renderer/main memory on large workflows and fail CI on material regressions.
255. **P2 — Performance profiler pack:** export anonymized timing and query diagnostics for user-approved support cases.

## 18. Accessibility, language and inclusive design

256. **P0 — Keyboard completion tests:** complete onboarding, voucher posting, reports, reconciliation and restore without a mouse.
257. **P0 — Focus-order audit:** guarantee visible, logical focus across dialogs, tables, pickers and dynamic validation.
258. **P0 — Contrast gate:** test light/dark themes and all semantic states against WCAG contrast requirements.
259. **P0 — Screen-reader names:** label every input, table, status, chart and icon-only control meaningfully.
260. **P1 — Font-size controls:** support larger text without clipping financial tables or dialogs.
261. **P1 — Reduced motion:** respect OS preference and keep all information available without animation.
262. **P1 — Color-independent status:** pair red, amber, green and debit/credit colors with text or symbols.
263. **P1 — Hindi interface:** translate navigation and help while keeping standard accounting terms discoverable.
264. **P1 — Regional invoice labels:** support customer-facing document labels in selected Indian languages.
265. **P1 — Indian number formats:** consistently support lakh/crore grouping and an optional international grouping mode.
266. **P1 — Accessible export templates:** generate tagged, selectable-text PDFs with sensible reading order.
267. **P2 — Voice-friendly commands:** expose stable accessible names for OS dictation and voice-control systems.
268. **P2 — Dyslexia-friendly option:** provide increased spacing and alternate typography without changing document output.
269. **P2 — Locale-aware help:** tailor GST, payroll and invoice guidance by state and registration type.
270. **P2 — Accessibility issue reporter:** attach focused element metadata and a screenshot with user consent.

## 19. Support, education, growth and commercial operations

271. **P0 — Support case ID:** return a trackable reference and retain submission status locally.
272. **P0 — Diagnostic consent:** separate message, logs, company metadata and screenshot consent into explicit choices.
273. **P0 — Offline support bundle:** save an encrypted ZIP when internet submission is unavailable.
274. **P1 — Contextual help:** explain the current field or report using the company’s enabled features and terminology.
275. **P1 — Searchable help centre:** index documentation inside the app so core help works offline.
276. **P1 — Guided troubleshooting:** diagnose update, database ABI, backup, provider and filing configuration issues.
277. **P1 — In-product release notes:** show customer-visible changes once, linked to relevant screens.
278. **P1 — Feature discovery:** surface shortcuts or capabilities after related work, with dismiss and never-show options.
279. **P1 — Feedback board:** let users submit, vote, follow status and receive release linkage through the support backend.
280. **P1 — Onboarding cohort dashboard:** opt-in aggregate activation and retention without uploading accounting data.
281. **P1 — Referral codes:** attribute referrals without requiring the accounting app to remain online.
282. **P2 — Partner mode:** support accountants managing many local client folders with clear isolation.
283. **P2 — Training company packs:** provide exercises, expected outcomes and resettable sample books.
284. **P2 — Certification program:** create structured product training for accountants and implementation partners.
285. **P2 — Transparent pricing/licensing:** cache entitlement locally with generous offline grace and permanent data export.

## 20. Engineering, release and operational quality

286. **P0 — Signed macOS builds:** configure Developer ID signing, hardened runtime, entitlements and notarization verification.
287. **P0 — Signed Windows builds:** add trusted code signing and verify installer/uninstaller behavior on clean profiles.
288. **P0 — Upgrade matrix:** test every release from the previous public version with real migrated company fixtures.
289. **P0 — Rollback-safe migrations:** back up, migrate transactionally, verify and preserve a recoverable pre-upgrade copy.
290. **P0 — Update-feed contract:** verify latest-version metadata, public assets, hashes and architecture before publishing.
291. **P0 — Release smoke installation:** install the actual DMG/ZIP/EXE, launch, create, post, backup, restore and uninstall.
292. **P1 — Property-based accounting tests:** generate vouchers to prove balance, allocation, tax, FX and valuation invariants.
293. **P1 — Import fuzzing:** fuzz XML, CSV, JSON, MCP, support and AI response boundaries with resource limits.
294. **P1 — Visual regression suite:** compare critical screens and PDFs in light/dark and common display sizes.
295. **P1 — Dependency policy:** automate security, license, native ABI and abandoned-package checks.
296. **P1 — Crash reporting:** offer opt-in redacted crash envelopes with a visible payload and local fallback.
297. **P1 — Feature flags:** ship reversible migrations and staged UI exposure without remote control of core books.
298. **P2 — Reproducible build evidence:** record source revision, dependency lock, toolchain, hashes and signing provenance.
299. **P2 — Chaos suite:** terminate during backups, imports, migrations and exports to verify recovery guarantees.
300. **P2 — Release scorecard:** block publication unless correctness, accessibility, performance, security, restore and packaging gates pass.

## Recommended build sequence

### Wave A — public v5 release gate

Build items 31, 35, 91–94, 106–108, 121–123, 166–169, 181–184, 196–199,
226–230, 241–244, 256–259 and 286–291. This wave prioritizes accounting correctness,
explainability, recovery, accessibility and signed distribution.

### Wave B — daily-work advantage

Build items 16–26, 36–43, 46–57, 61–72, 76–87, 95–102, 109–117 and 151–162.
This wave makes Total materially faster for operators, accountants and owners.

### Wave C — inventory, payroll and controlled automation

Build items 124–133, 136–147, 170–176, 185–192, 200–207 and 211–220. This wave
deepens operational coverage while keeping automation reviewable and permissioned.

### Wave D — scale and ecosystem

Build the remaining P2 items only after usage evidence supports them. Their architecture should be
reserved early, but they should not delay the correctness and daily-work advantages above.

## Selection rule

For each release, choose work using five weighted signals: customer minutes saved (30%), financial
or compliance risk removed (25%), frequency across active companies (20%), commercial leverage
(15%), and implementation/maintenance cost (10%, inverse). No item bypasses the non-negotiable
release gates for balanced books, drill-down provenance, backup/restore and human approval of
automated accounting writes.
