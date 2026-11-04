# Total: the reset plan

Written 2 November 2026, after v0.12.0. Goal: a small, solid, fast app. GST math you can trust, real GST
portal filing, and an AI that does the bookkeeping from your invoices, with you approving each step.

## 1. Where we are (honest numbers)

| | |
|---|---|
| App code | ~330,000 lines (engine 90k, main 128k, UI 115k) |
| Screens | 98, in two parallel UIs (simple and accountant) |
| Back-end services | 122 files, 452 IPC channels |
| Database migrations | 114 |
| Test files | 497 unit/DB + 73 end-to-end scenarios |
| Open to-do items | 110 (bugs, UNVERIFIED tax points, owner decisions) |
| Installer | ~130 MB DMG |

**What went wrong.** The tech stack is not the problem. The problem is breadth. We built Tally's whole
feature list, then a second "simple" UI on top of it, and every feature now has two front doors. Rules like
"save card", "hand-off", "carry-back" and "always open the full app" exist only to bridge the two UIs.
Meanwhile the parts that matter most are still unproven:

- **GST filing never reaches the portal.** GSTR-1 and GSTR-3B are exported as JSON files that you upload by hand.
- **E-invoice has never run.** The client was built from NIC's published spec, but it has never talked to the real NIC portal (no credentials yet).
- **AI has never had a live run.** It is OpenAI only, needs a pasted API key, has only run against a mock, and its model ids are unverified.
- **Tax rounding is inconsistent.** The invoice calculation rounds tax per rate group, while the return extraction rounds per line.
- **Tax rules are still unchecked.** About 25 tax points are marked UNVERIFIED and no CA has reviewed them.

## 2. Architecture and tech stack (plain words)

Total is a desktop app. Everything runs on the user's computer and the data never leaves it, except the
AI and GST calls the user turns on.

```
┌──────────────────────── Electron app (one process tree) ───────────────────────┐
│  Renderer (the window)          Preload            Main (the "server")          │
│  React 19 + Tailwind 4   ──►  safe bridge  ──►  Zod-checked IPC handlers         │
│  Zustand (UI state)          (window.total)     services/ (business logic)      │
│  React Query (data cache)                       SQLite file per company         │
│                                                  (SQLCipher-capable driver)      │
│                                                  AI calls (openai SDK)           │
│                                                  NIC e-invoice client            │
│  src/shared/: pure TypeScript engine used by both sides: money in paise,       │
│  GST calculation, returns builders, posting rules, payroll, Tally parser        │
└──────────────────────────────────────────────────────────────────────────────────┘
Site: Next.js 16 on Vercel (download page, update feed).
Builds: electron-vite → electron-builder → DMG / ZIP / Windows installer on GitHub Releases.
Tests: Vitest (engine, DB, UI) + Playwright driving the real built app.
```

| Layer | Tool | Verdict |
|---|---|---|
| Shell | Electron 37 | Right for an offline desktop app; heavy (~130 MB). Tauri is smaller but would mean a rewrite. **Keep.** |
| UI | React 19, Tailwind 4, Zustand, React Query | Mainstream and fine. **Keep.** |
| Data | SQLite (better-sqlite3-multiple-ciphers), one file per company | Fast and correct for single-user books. **Keep.** |
| Validation | Zod on every IPC call | Good. **Keep.** |
| Engine | Pure TS, integer paise, tested | The strongest part of the codebase. **Keep and harden.** |
| AI | `openai` SDK, key pasted per app | Too narrow. **Replace with a provider layer (Phase 4).** |
| GST filing | JSON export, hand upload; NIC client untested | The weakest part. **Rebuild on a GSP (Phase 3).** |

So the stack stays. We cut scope, merge the two UIs, and finish the parts that earn money.

## 3. Principles for every phase

1. **Fewer, finished features beat many half-proven ones.** Anything not in the core list below is hidden, then deleted.
2. **One UI.** Plain by default, with a "Details" panel where the accountant's fields live. No second shell.
3. **Every GST number is proven.** It is backed by a hand-worked fixture and, where possible, a portal or offline-tool validation, and a CA signs it off.
4. **The AI proposes and you approve.** It never posts on its own. Every change goes into a review queue you accept in one click.
5. **Speed is a feature.** Launch in under 2 s, every screen under 200 ms on 100k entries (budgets already exist).

**Core features we keep:** sales and purchase bills, money in and out, bank import and reconciliation, stock
(simple), parties and outstandings, GST (GSTR-1, 3B, 2B match, e-invoice, e-way bill), reports (P&L,
balance sheet, trial balance, day book, ledger), backups, Tally import, AI, roles, and Hindi.

**Candidates to strip.** Each is hidden behind a feature switch first. It is deleted after one release unless real users ask for it:

- Group consolidation
- Report builder and scheduled report packs
- MCP server and inbox posting
- Budgets and cost centres
- Multi-currency and forex revaluation
- Loan schedules
- Fixed-asset register (biggest service, 1,700 lines)
- Trade-cycle quotations, orders and challans (keep the plain bill)
- Payroll statutory (PF, ESI, PT): hard to keep correct, needs an HR adviser
- Interest on overdue bills
- Cheque books, post-dated cheques (PDC) and bulk bank payment files
- AI memory and AI evals tooling (fold into the new AI layer)
- Year-end repair tool

The final cut is an owner decision. Default: hide everything above in Phase 1, and decide per item at the end of Phase 6.

## 4. Phases

### Phase 1: Cut and stabilise (≈1–2 weeks)
- Add a "removed features" switch and hide the strip list. Data stays readable and nothing is deleted from anyone's books.
- Close or explicitly drop all 110 to-do items. Fix the simple and accountant bugs that remain in kept features.
- Delete dead code, stale branches and unused dependencies. Target: −25% lines of code.
- Make CI fast and green on every job, and fix the Windows passphrase-test timeouts at their root.
- **Done when** the kept feature set has zero known bugs and the e2e suite is flake-free over 3 runs.

### Phase 2: Bulletproof GST and basic calculation (≈2–3 weeks)
- Use one rounding rule everywhere (invoice, return, e-invoice, print): tax rounded per line, totals as sums, all in BigInt. No float anywhere in percentages or FX.
- Build a golden fixture set of about 200 hand-worked invoices: intra and inter-state, SEZ, export, RCM, composition, notes, advances, discounts and cess. Each one pins the bill, GSTR-1 row, 3B box and e-invoice JSON.
- Validate GSTR-1 and 3B JSON against GSTN's published schema and the official offline tool in CI.
- Get a CA to review the UNVERIFIED list and resolve each point. Fix s.17(5) blocked ITC, goods advances (N. 66/2017) and MSME acceptance dates.
- Bundle the HSN/SAC master with dated rates, so HSN search becomes real.
- **Done when** every fixture matches across all four outputs and the CA signs the list.

### Phase 3: Real GST portal integration (≈3–4 weeks; needs a GSP contract)
- Pick a GSP partner, for example ClearTax, Masters India, IRIS or Quicko. Direct GSTN access is for large taxpayers only, so we go through a GSP. This is an owner decision with a cost per call.
- Add one `gstGateway` module in main with an adapter per GSP, a sandbox mode and the existing NIC client folded in. Credentials go in the secret store.
- **E-invoice:** generate and cancel the IRN, and print the signed QR.
- **E-way bill:** generate, extend and cancel.
- **GSTR-1:** save, check status, file with EVC/OTP, and show the ARN.
- **GSTR-3B:** save and offset liability. Filing confirmation is still done by the user on the portal if the GSP can't do it.
- **GSTR-2B:** fetch it automatically by month and feed the existing matcher.
- **Share:** PDF plus a WhatsApp, e-mail or link button on every bill.
- Write a contract test per GSP endpoint, run against the sandbox in a manual CI workflow.
- **Done when** a test GSTIN on the sandbox does bill → IRN → e-way → GSTR-1 file → 2B fetch end to end.

### Phase 4: The AI bookkeeper (≈3–4 weeks)
- **Provider layer:** any OpenAI-compatible endpoint (OpenAI, OpenRouter, Groq, Azure, local Ollama or LM Studio). The user picks a preset or pastes a base URL and key. The current code already takes a base URL, so this extends it.
- **Sign in with ChatGPT:** OpenAI previewed it in 2025 for third-party apps, but there is no public developer OAuth yet (UNVERIFIED as of today). Ship the API-key path now and add ChatGPT sign-in behind a flag the day OpenAI opens it.
- **One agent with real tools,** replacing today's split between Ask Total, the chat panel, capture and drafting:
  - *Read:* every report, a party's balance, GST position, stock.
  - *Propose:* create or edit a bill, payment, party or product, categorise bank lines, match 2B, prepare GSTR-1, generate an e-invoice, share a bill, tidy masters (merge duplicates, fix groups).
  - Every proposal lands in an **Approval queue**. It shows the change in plain words with the accounts behind "Details", and you approve one item or the whole batch. Each approval goes through the same save path as a manual entry, so locks, roles and GST rules still apply.
- **Invoice inbox:** drop PDFs or photos, or forward e-mail to a watched folder. The AI extracts the data (our own code recomputes every figure), matches the supplier by GSTIN, and proposes the purchase and payment.
- **"Organise my workspace" commands:** for example "Book all of October's bills", "File GSTR-1 for October", or "Send reminders to everyone 30 days late". These become a plan of proposals in the queue.
- Keep the guardrails that matter: masking, the outbound log and the cost meter. Our code checks every figure the AI quotes. Drop the rest.
- **Done when** 50 real invoices go from upload to approved purchase entries with zero figure errors, and the evals run live in CI weekly.

### Phase 5: One UI, rebuilt for speed and calm (≈3–4 weeks)
- Merge the simple and accountant shells into one shell. Kill hand-off, carry-back and the per-screen view override.
- Use about 25 screens, not 98: Home, Sell, Buy, Money, Bank, Stock, People, GST, Reports, AI, Settings, each with list, detail and new.
- Rebuild the design system: one type scale, spacing and colour tokens, components in `kit/`, and dark mode checked. Keyboard first: ⌘K for everything, Enter to save, Esc to back out.
- Home becomes a task feed: what to do today, AI proposals waiting, GST due, cash.
- Perceived speed: skeletons, optimistic saves, no layout shift, and a cold launch under 2 s.
- **Done when** a first-time user does sale → purchase → GST check without help in under 10 minutes (real test with 5 people).

### Phase 6: Hardening and release 1.0 (≈2 weeks)
- Upgrade test: open copies of real 0.10, 0.11 and 0.12 books and compare every report before and after.
- Sign the builds: an Apple Developer ID and a Windows certificate give silent updates and no warnings.
- Get a native-speaker review of Hindi and Hinglish.
- Delete for good the features hidden in Phase 1 that nobody asked for.
- Write docs: one short user guide, plus an architecture page for developers.
- **Done when** 1.0 is tagged, updates install silently, and the to-do list is empty or deferred on purpose.

## 5. What the owner must supply

| Needed for | Item |
|---|---|
| Phase 2 | A CA for the GST review (about 2 sessions) |
| Phase 3 | GSP contract and sandbox credentials; a test GSTIN |
| Phase 4 | An AI API key (or OpenAI's sign-in when available); 50 real invoices with consent |
| Phase 5 | 5 first-time testers |
| Phase 6 | Apple Developer ID, Windows signing certificate, a Hindi reviewer |
| Phase 1 and 6 | Decisions on the strip list |

## 6. Order and rules of work
- Phases run in order. Phases 2 and 4 can overlap once Phase 1 is done.
- Every PR gets a review and green CI before it merges. Nothing is published until the owner tests the build and says go.
- Each phase ends with a short demo build on the owner's laptop.
