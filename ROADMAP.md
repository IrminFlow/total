# Total v5 roadmap

Last updated: 28 August 2026.

This is the current product and delivery roadmap. [docs/BACKLOG_300.md](docs/BACKLOG_300.md) remains the exhaustive numbered opportunity catalogue, while [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) provides historical implementation detail. Current execution ownership belongs in [TASKS.md](TASKS.md), and external actions belong in [HUMAN.md](HUMAN.md).

## Status model

| Status | Meaning |
| --- | --- |
| Implemented | Code, schema, and ordinary automated tests exist on the v5 branch. |
| CI verified | The relevant automated branch gates pass on GitHub. |
| Staging verified | The isolated staging service or artifact passed the stated live check; production is unchanged. |
| Configuration pending | Code exists, but a production account, credential, or deployment is missing. |
| Acceptance pending | The feature needs real service, migration, installer, or role-based acceptance. |
| Release pending | Implementation is accepted but has not been published as a signed public release. |
| Later | Intentionally scheduled after v5.0. |
| Excluded | Not part of the approved v5 scope. |

A feature is not “production complete” merely because it is implemented. Production completion requires the necessary configuration, acceptance, signing, and release states for that feature.

## Product principles

1. Core accounting works offline with no account.
2. SQLite is authoritative; JSON is the portable and agent-readable boundary.
3. Money stays in integer paise and quantities in integer thousandths.
4. Reports derive from voucher lines and drill back to evidence.
5. AI drafts and explains; it does not autonomously post books.
6. Optional network services can be disabled without rolling back accounting.
7. Secrets stay outside books, mirrors, backups, renderer state, diagnostics, and support payloads.
8. Keyboard operation, accessibility, recovery, migration, and release integrity are product features.

## v5.0 release scope

### Desktop foundation

| Feature | What it does for users | Current state | Remaining work |
| --- | --- | --- | --- |
| macOS and Windows desktop | Runs the same local books on both supported desktop platforms. | Implemented and CI verified | Signed-candidate and installed-artifact acceptance. |
| Local-first company storage | Keeps one SQLite database per company in a user-controlled data directory. | Implemented and CI verified | Ongoing restore and migration acceptance. |
| Append-only migrations | Upgrades old companies without rewriting historical schema steps. | Implemented and CI verified from every historical version | Validate against final signed candidate. |
| Integrity and recovery | Checks database health, snapshots before risky changes, retains backups, and verifies restore packages. | Implemented and CI verified | Human restore drill on candidate. |
| Secure Electron boundary | Uses sandboxing, context isolation, validated IPC, navigation controls, and restricted permissions. | Implemented and security-gated | Final review and signed package inspection. |
| Feature kill switches | Disables AI, MCP, uploads, telemetry, and staged updates without changing books. | Implemented and CI verified | Production configuration exercise. |

### Information architecture and design system

| Feature | Explanation | Current state | Remaining work |
| --- | --- | --- | --- |
| Financial-workstation shell | Groups work into Home, Create, Sales, Purchases, Banking, Inventory, Parties, Compliance, Payroll, Reports, and Automation. | Implemented | Role-based human acceptance. |
| Tailwind design tokens | Centralizes color, typography, density, focus, tables, forms, states, and light/dark parity. | Implemented | Continue reducing isolated legacy styles. |
| Radix interaction primitives | Provides accessible dialogs, popovers, tooltips, focus trapping, and dismissal behavior. | Implemented and renderer-tested | Expand to any remaining custom overlay during maintenance. |
| Phosphor icon system | Keeps one coherent icon language throughout the application. | Implemented | Audit new screens during final review. |
| Amber selection cursor | Preserves Total’s recognizable high-speed table and list selection behavior. | Implemented and E2E verified | None for v5.0. |
| Red mnemonic letters | Makes the keyboard shortcut letter visible in navigation and task labels. | Implemented and E2E verified | Human discoverability check. |
| Light, dark, reduced motion | Supports comfortable long-duration desktop use and accessibility preferences. | Implemented and visual-contract verified | Human contrast and motion acceptance. |

### Keyboard and command architecture

| Feature | Explanation | Current state | Remaining work |
| --- | --- | --- | --- |
| Typed command registry | Defines command IDs, contexts, labels, routes, shortcuts, permissions, and feature requirements once. | Implemented | Keep every new command registered centrally. |
| Gateway mnemonics | Bare keys open frequent tasks; `V` opens Voucher Entry. | Implemented and E2E verified | Human keyboard acceptance. |
| Voucher mnemonics | `C/P/R/J/S/U/N/D/K/H` select Contra, Payment, Receipt, Journal, Sales, Purchase, Credit Note, Debit Note, Stock Journal, and Physical Stock. | Implemented | Final cross-platform modifier check. |
| Context priority | Modal, editor, voucher, screen, then global context prevents accidental shortcut activation while typing. | Implemented and tested | Continue collision tests as commands grow. |
| Command palette | Searches commands, books, recent records, periods, and company actions from every screen. | Implemented | Large-book search acceptance. |
| Shortcut help and customization | Shows bindings, supports compatible legacy function keys, and detects collisions. | Implemented | Human discoverability session. |

### Accounting entry and controls

| Feature | Explanation | Current state | Remaining work |
| --- | --- | --- | --- |
| Complete voucher set | Supports routine financial, invoice, note, stock, and physical-count transactions. | Implemented and extensively tested | Role-based acceptance. |
| Integer accounting | Posts exact paise with balanced debit and credit validation. | Implemented and property-tested | None beyond regression gates. |
| Autosaved drafts | Restores interrupted voucher work without posting partial accounting. | Implemented | Long-duration and crash acceptance. |
| Form undo | Reverses unposted edits without altering audit history. | Implemented | Human workflow check. |
| Soft-delete bin | Removes posted vouchers from ordinary books while allowing controlled recovery. | Implemented and database-tested | Candidate backup/restore check. |
| Linked reversals | Preserves the original voucher and posts an auditable reversing transaction. | Implemented | Accountant acceptance. |
| Duplicate and suspicious-entry warnings | Detects likely duplicate references, dates, amounts, party direction, and tax anomalies before posting. | Implemented | Tune against accepted real workflows. |
| Maker-checker and roles | Separates preparation, approval, sensitive actions, and viewing. | Implemented and E2E verified | Multi-role human acceptance. |
| Period locks and month close | Prevents unauthorized changes after controlled closing checks. | Implemented | Accountant and owner acceptance. |
| Comments and templates | Adds review discussion and reusable editable drafts without changing print narration or auto-posting. | Implemented | Human acceptance. |

### Reports and management information

| Feature | Explanation | Current state | Remaining work |
| --- | --- | --- | --- |
| Monthly and quarterly registers | Shows Sales and Purchase activity by month or Indian FY quarter: Q1 Apr-Jun, Q2 Jul-Sep, Q3 Oct-Dec, Q4 Jan-Mar. | Implemented, export-tested, and E2E verified | Human report acceptance. |
| Quarterly drill-through | Opens Day Book with the exact quarter dates and voucher kind. | Implemented and tested | None beyond regression. |
| Shared report toolbar | Standardizes periods, comparison, saved views, columns, export, and print. | Implemented | Continue migration of remaining reports. |
| Core statements | Provides Day Book, Ledger, Trial Balance, Profit and Loss, Balance Sheet, Stock Summary, and outstandings. | Implemented | Migration reconciliation and accountant acceptance. |
| Comparisons and annotations | Supports prior periods, custom comparisons, explanatory notes, and voucher drill-down. | Implemented | Human management-report acceptance. |
| Budgets and cost centres | Compares actuals with budgets across ledger and operating dimensions. | Implemented | Business-owner acceptance. |
| Consolidation and Schedule III | Combines companies with reviewed rates, eliminations, and presentation mappings. | Implemented | Accountant acceptance with representative structures. |
| Forecasts and scenarios | Produces cash forecasts and non-posting management scenarios with visible assumptions. | Implemented | Validate assumptions with owners. |
| Portable report packs | Exports indexed statements and evidence with manifests and signing support. | Implemented | Signed candidate round-trip acceptance. |

### Receivables, sales, and communication

| Feature | Explanation | Current state | Remaining work |
| --- | --- | --- | --- |
| Bill-wise outstandings and ageing | Tracks open customer and supplier balances through the same allocation logic used by books. | Implemented | Migration reconciliation. |
| Collections workspace | Ranks overdue work, owners, promises, disputes, reminders, DSO, and risk signals. | Implemented | Bookkeeper and owner acceptance. |
| Contact directory | Stores multiple business contacts and delivery preferences. | Implemented | Import and communication acceptance. |
| Quotes, orders, invoices, delivery, returns | Maintains the sales-document chain and its accounting handoff. | Implemented | Industry workflow acceptance. |
| Statements and reminders | Creates reviewed customer statements and reminder drafts. | Implemented | Real SMTP/WhatsApp provider work remains later unless configured. |
| UPI and payment instructions | Adds payment directions and QR support to invoice flows. | Implemented where locally generatable | Verify templates with users. |
| Communication outbox | Preserves preview, approval, status, retry, and evidence even without a live provider. | Implemented | Real provider delivery acceptance when enabled. |

### Procurement and payables

| Feature | Explanation | Current state | Remaining work |
| --- | --- | --- | --- |
| Requisitions and purchase orders | Controls demand, approvals, supplier selection, ordering, receipt, close, and cancellation. | Implemented and E2E verified | Procurement-user acceptance. |
| Goods receipts | Records accepted and rejected quantities independently from financial invoices. | Implemented and E2E verified | Representative partial-delivery acceptance. |
| Three-way matching | Compares PO, GRN, and supplier invoice without receiving stock twice. | Implemented and database/E2E tested | Real workflow acceptance. |
| Supplier intelligence | Shows price history, lead time, delivery, rejection, concentration, and sole-source risk. | Implemented | Validate with representative supplier data. |
| Payment runs and advice | Reviews exact bills, cash impact, bank output, posting, and supplier advice. | Implemented | Bank-format and owner acceptance. |
| Vendor verification | Retains contact, tax, bank, Udyam, duplicate signals, masking, and owner verification. | Implemented | Security and procurement acceptance. |
| Debit-note claims | Prepares evidence-linked claims for rejection, shortage, and rate differences. | Implemented | Accountant acceptance. |

### Banking and treasury

| Feature | Explanation | Current state | Remaining work |
| --- | --- | --- | --- |
| Multi-format statement import | Normalizes CSV, XLSX, OFX, QIF, and MT940 through one preview pipeline. | Implemented | More representative Indian bank samples. |
| Reconciliation rules | Suggests explainable matches and learns only from reviewed outcomes. | Implemented | Bank-user acceptance and false-positive tuning. |
| Transfers, charges, and GST extraction | Prepares linked adjustments without rewriting original transactions. | Implemented | Accountant acceptance. |
| Cheque lifecycle | Tracks issue, deposit, clearing, bounce, cancellation, and stale instruments. | Implemented | Bank workflow acceptance. |
| Cash controls | Compares denomination counts with books and posts only an approved difference. | Implemented | Owner acceptance. |
| Payment files | Exports reviewed generic NEFT, HDFC, and ICICI files for verified beneficiaries. | Implemented | Bank-format acceptance; no live transmission. |
| Optional bank-feed adapter | Stores revocable read-only consent and imports statements. | Adapter implemented | Real provider agreements and credentials are later. |

### Inventory and manufacturing

| Feature | Explanation | Current state | Remaining work |
| --- | --- | --- | --- |
| Stock and valuation | Tracks items, units, godowns, movements, negative-stock controls, and weighted-average value. | Implemented and tested | Migration and large-book reconciliation. |
| Batches and serials | Tracks identity, expiry, availability, and traceability. | Implemented | Industry acceptance. |
| Replenishment | Creates reviewed reorder suggestions and editable purchase-order drafts. | Implemented and E2E verified | User tuning. |
| BOM and manufacturing | Consumes components and receives finished goods at reviewed cost. | Implemented | Manufacturing-user acceptance. |
| Landed cost and traceability | Allocates additional cost and follows movement from source to sale or production. | Implemented | Representative import/manufacturing acceptance. |

### Payroll and workforce

| Feature | Explanation | Current state | Remaining work |
| --- | --- | --- | --- |
| Employees and salary history | Stores departments, effective-dated salary structures, and employment state. | Implemented | Payroll-user acceptance. |
| Attendance and leave | Applies reviewed attendance and leave to monthly calculations. | Implemented | Policy acceptance. |
| Payroll posting and payslips | Calculates earnings, deductions, employer costs, payable balances, and balanced journal posting. | Implemented and E2E verified | Representative payroll reconciliation. |
| Loans, reimbursements, contractors, final settlement | Manages common workforce obligations and their book impact. | Implemented | Payroll/accountant acceptance. |
| PF, ESI, PT, and TDS workspaces | Provides deterministic control views and offline evidence. | Implemented | Verify applicable state/company policies. |

### GST and compliance

| Feature | Explanation | Current state | Remaining work |
| --- | --- | --- | --- |
| GST calculations | Computes CGST, SGST, IGST, cess, HSN, place of supply, and registration scope from reviewed vouchers. | Implemented and heavily tested | Accountant acceptance. |
| GSTR-1 and GSTR-3B | Builds returns, freezes snapshots, records adjustments, and exports offline-tool data. | Implemented | Representative return reconciliation. |
| GSTR-2B reconciliation | Retains import evidence and tracks missing, mismatched, blocked, and reversed ITC. | Implemented | Representative 2B file acceptance. |
| GST action centre | Surfaces missing data, deadlines, differences, and export readiness. | Implemented | Accountant acceptance. |
| e-Invoice and e-Way offline exports | Produces reviewed JSON for government offline tools. | Implemented | Offline-tool import acceptance. |
| TDS and compliance calendar | Tracks deductions, challans, acknowledgements, statutory work, and custom deadlines. | Implemented | Payroll/accountant acceptance. |
| NIC and GST online APIs | Would transmit directly to government services. | Excluded from v5.0 | Separate future project only. |

### Migration and portability

| Feature | Explanation | Current state | Remaining work |
| --- | --- | --- | --- |
| Tally XML migration | Imports masters, openings, vouchers, stock, and tax data with warnings and pre-import recovery. Semantically equivalent exports are rejected even when XML formatting or master order differs. | Implemented and deduplication-tested | Real representative reconciliation. |
| Busy, Marg, Zoho, and spreadsheet workbenches | Maps exported source shapes into reviewed proposals and evidence. Attachments link only after one unique active-voucher match and use managed, checksummed storage. | Implemented and attachment-safety-tested | Source-specific customer acceptance samples. |
| Dry run and rejected-row evidence | Shows exact mappings, validation failures, counts, and balances before apply. | Implemented | Human migration acceptance. |
| JSON mirror and proposals | Gives agents and users stable, versioned, checksummed data without permitting direct book mutation. | Implemented | Round-trip and corruption fuzz expansion. |
| Portable company packages | Supports complete export, reconstruction, verification, and exit. | Implemented | Clean candidate round-trip acceptance. |

### AI, OCR, and agent access

| Feature | Explanation | Current state | Remaining work |
| --- | --- | --- | --- |
| OpenAI provider | Uses the official SDK and Responses API in the Electron main process. | Implemented | Real-key capability test and model evaluation. |
| OpenAI-compatible provider | Supports configurable HTTPS endpoints and explicit loopback HTTP for local models. | Implemented | Broader compatibility fixtures. |
| Codex/ChatGPT device login | Runs official Codex CLI device authentication without Total reading or storing ChatGPT credentials. | Implemented | Test on installed machines with Codex CLI. |
| Context preview and cited answers | Shows selected local context, sends only approved categories, and requires citations for book claims. | Implemented and tested | Provider evaluation on accepted corpus. |
| Voucher proposals | Converts natural language or documents into balanced reviewable drafts. | Implemented | Expanded malformed-response and approval E2E tests. |
| AI Operator | Plans navigation, book search, voucher proposals, and approved-folder file work. Plans are retained briefly in the main process and bound to company, user, action index, action hash, expiry, and one-time approval token. | Implemented and binding-tested | Installed-app and provider acceptance. |
| Offline OCR | Uses bundled Tesseract English data when no provider is available. | Implemented and parser-tested | Reviewed image corpus and accuracy evidence. |
| Document inbox | Stores checksummed attachments and reviewable extraction results. | Implemented | More formats, rotations, and language acceptance. |
| MCP server | Exposes scoped read and proposal tools over stdio with local pairing and active-role enforcement. | Implemented and protocol-tested | Client setup acceptance for Claude and Codex. |

### Encrypted collaboration

| Feature | Explanation | Current state | Remaining work |
| --- | --- | --- | --- |
| Encrypted envelopes | Encrypts review documents with AES-256-GCM and signs device envelopes with Ed25519. The relay verifies registered device keys; the client quarantines invalid envelopes and continues past poison rows. | Implemented, cryptography-tested, and staging deployed | Run real two-device acceptance. |
| Review-only lanes | Syncs proposals, drafts, comments, and tasks without syncing books or posting. | Implemented | Real no-write verification. |
| Offline merge and conflicts | Uses vector clocks and deterministic field merges while retaining visible conflicts. | Implemented | Concurrent-edit acceptance. |
| Team invitations | Provides owner-created, expiring, revocable, single-use hashed invitation codes. | Implemented | Real two-user acceptance. |
| Separate recovery-key exchange | Keeps backend membership separate from decryption material. | Implemented | Human secure-sharing acceptance. |
| Session refresh | Refreshes expiring Supabase access tokens only against the configured Supabase origin, persists rotation in OS-protected storage, retries one 401, and requires reconnection after revocation. | Implemented and tested | Real expiry/revocation acceptance. |
| Supabase backend | Stores ciphertext envelopes and routing metadata under membership RLS. The isolated `cewz…qmlx` staging project has migrations through `collaboration_devices`, `total-sync` v9 and `total-intake` v10; anonymous sync returns HTTP 401. | Staging verified | Real two-user acceptance and a separate production decision/deployment. |

### Support, feedback, and website

| Feature | Explanation | Current state | Remaining work |
| --- | --- | --- | --- |
| Shared support form | Collects category, severity, message, reply details, explicit diagnostics consent, and safe installation metadata. Case status uses a private receipt token whose hash is stored by the site. | Implemented, site-tested, and staging verified | Production delivery acceptance. |
| Offline support outbox | Queues app submissions and preserves attachments until the user approves retry. | Implemented | Network-failure acceptance. |
| Redacted diagnostics | Limits automatic diagnostics to allowlisted version, platform, schema, integrity, and redacted logs. | Implemented and security-tested | Final privacy acceptance. |
| Vercel Blob case store | Keeps durable cases, tracking events, rate controls, retention indexes, holds, and exact deletion. | Implemented | Production Blob configuration and evidence. |
| Supabase intake copy | Stores support and feedback rows behind service-role-only Edge Function access. | Staging deployed at `total-intake` v10 | Production deployment and deletion procedure. |
| Resend notifications | Notifies support without becoming the system of record. | Implemented as optional | Verified domain and delivery acceptance. |
| Feedback voting and following | Captures requests and engagement without exposing private book data. | Implemented, route-tested, and synthetic staging idea/vote/follow verified | Production acceptance. |
| Privacy, security, AI-data, support, docs | Publishes the essential trust and help pages. | Implemented and Vercel-preview verified | Owner/legal-risk decision and production check. |

### Release and operations

| Feature | Explanation | Current state | Remaining work |
| --- | --- | --- | --- |
| Branch test packages | Builds unsigned macOS and Windows installers with non-publishable manifests. The compiled staging profile uses only `total-v5-staging.vercel.app` for app/site services and disables update checks; the ASAR contract rejects production-origin leakage. | Implemented and CI verified | Use for testing only. |
| Protected candidate build | Builds signed candidates in protected GitHub environments without publishing. | Implemented | Signing credentials and candidate run. |
| Immutable promotion | Publishes the accepted candidate bytes without rebuilding or manual tagging. | Implemented and contract-tested | Execute after acceptance. |
| Clean-environment matrix | Uses hosted macOS and Windows runners for install, upgrade, backup/restore, uninstall, and data preservation. | Implemented in release workflow | Run against signed candidate. |
| Staged channels | Supports internal, beta, and stable cohorts with deterministic percentages and kill switches. | Implemented and tested | Production rollout exercise. |
| Update and download routes | Serve release metadata and private-repository downloads without exposing the GitHub token. | Implemented and site-tested | Final production live check. |

## v5.1 roadmap

These items begin only after v5.0 stabilizes:

- Expand offline OCR languages and document types using reviewed corpora.
- Improve bank classification, duplicate detection, and reconciliation explanations from accepted feedback.
- Add saved management packs and approved scheduled exports.
- Expand customer statement and reminder automation while retaining review queues.
- Add industry-specific setup packs and migration certificates based on actual cohort needs.
- Increase corrupted-file fuzzing and long-duration soak coverage.
- Add more approved import profiles for Indian banks and accounting products.
- Improve AI evaluation tooling for prompt injection, citations, accounting validity, and provider regressions.

## v5.2 roadmap

These are optional extensions, not promises for the first public release:

- Broaden encrypted collaboration beyond review work only after the proposal lane proves safe.
- Add optional encrypted backup to user-owned cloud storage.
- Add hosted customer and supplier portals with strict tenant isolation.
- Add accountant practice monitoring across client companies without centralizing live books by default.
- Evaluate conflict-safe shared editing for selected non-posted records.
- Evaluate a desktop companion capture workflow only if user research justifies it. Total is not currently a mobile app.

## Provider-dependent future work

These features need commercial agreements, credentials, or external product decisions:

- Real bank feeds
- Payment gateway reconciliation
- SMTP delivery from user-owned accounts
- WhatsApp Business messaging
- Shopify, WooCommerce, marketplace, and courier connectors
- Direct payment initiation
- Hosted multi-tenant portals
- Additional AI providers with provider-specific capabilities

Each connector must preserve preview, consent, retry, audit, secret isolation, offline fallback, and exact deletion behavior.

## Explicit exclusions

- NIC live filing and online GST portal APIs
- Autonomous AI posting
- Arbitrary shell, SQL, credential, or unrestricted filesystem access for AI
- Mandatory cloud accounts
- Replacing SQLite with JSON as the live accounting database
- A Tauri rewrite for v5
- A native mobile application in the current desktop release

## Release completion definition

v5.0 is complete only when:

1. the final PR has received the owner-requested full review;
2. all confirmed findings are corrected;
3. full automated gates pass on the final commit;
4. required Supabase and Vercel services are configured or explicitly excluded from launch claims;
5. production support and real two-user collaboration receive their required acceptance;
6. representative migrations reconcile or unsupported claims are removed;
7. signed macOS and Windows candidates pass hosted install and upgrade acceptance;
8. human acceptance is recorded honestly for available roles;
9. the owner records the free-beta legal-risk decision if qualified review is unavailable;
10. the exact accepted artifacts are promoted, downloaded, verified, and staged through the rollout channels.

No checklist may be satisfied with fabricated evidence or configuration-shaped placeholders.
