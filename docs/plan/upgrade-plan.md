# Total: upgrade plan to 1.0

Approved by the owner on 4 November 2026. Built from the 2 Nov draft (archived as `docs/plan/2026-11-02-reset-plan-draft.md`) and the owner's answers below.

## Context

Total 0.12.0 has a very wide feature list, and its most valuable parts are still unproven. GST never reaches the portal, the e-invoice client has never run live, the AI has only run against a mock, rounding differs between the bill and the return, and about 25 tax points are UNVERIFIED. Two agents are already cutting low-value features and hunting bugs in the core flows. This plan takes the app from there to a 1.0 that both shop owners and their accountants can trust, in about 3 months.

## Owner decisions (4 Nov)

| Question | Answer |
|---|---|
| Users | **Owners and accountants equally** |
| UI | **Keep two modes** (simple + accountant), polish them; no merge |
| GST portal | **Full GSP integration, sandbox only** until there is billing; live filing is off in 1.0 |
| Business model | **Free for now**; no billing code; users bring their own AI key |
| AI bookkeeper v1 | Read bills → entries; questions + tasks; create and share sales invoices; prepare (and, via the GSP, file) returns |
| AI providers | Any OpenAI-compatible key + base URL (presets + local Ollama/LM Studio); ChatGPT sign-in later, behind a switch |
| Removed features | The cut stands (forex included); **the Day book goes too**, and its links open the all-entries register for that date |
| Timeline | **~3 months to 1.0** |
| Platform | **Mac first**; Windows stays CI-tested (unsigned) until after 1.0 |
| CA / Hindi reviewer | **Not yet.** UNVERIFIED points are shown in the app as "check with your CA", and Hindi/Hinglish ship as "beta" |

## Rules for every phase

- Every PR gets a review and green CI before it merges. Nothing is tagged or released without the owner's go.
- **Figures in existing books never change silently.** Any change that moves a reported number comes with an upgrade-diff report (old vs new, per company), and the owner signs it off.
- A few agents at a time, and no heavy builds running in parallel (the laptop is limited).
- The AI and the GSP only **propose**. Every write goes through the same save path a person uses (`saveVoucher` / `simple:post`), so locks, roles and GST rules apply.
- Each phase ends with a demo build on the owner's laptop.

## Phases

### Phase 1: Land the cut, stabilise (weeks 1–2)
- Merge the removal branch and the bug-hunt fixes. Remove the Day book.
- Upgrade Electron to a current major (~50 security alerts) in its own PR, after the cut merges.
- Work through `docs/plan/phase1-triage.md` (every `to-do.md` item has a verdict).
- Triage all ~110 `to-do.md` items: fix, drop or defer each one on purpose. Section 2's sign-offs were accepted by the owner on 4 Nov.
- Remove dead code, unused dependencies and stale branches. CI goes green on every job, and e2e passes 3 runs in a row with no flakes.
- **Done when** the kept features have no known bugs, `to-do.md` has no item without a decision, and CI is green.
- **Owner supplies:** account housekeeping (Actions quota, CodeRabbit, Vercel).

### Phase 2: GST you can trust (weeks 3–5)
- **One rounding rule** for bills, returns, e-invoices and prints: tax per line, totals as sums, BigInt only. Run the upgrade diff on the demo books and the owner's test books before merging.
- **Golden fixtures**: about 150 hand-worked bills (intra/inter-state, SEZ, export, RCM, composition, notes, advances, discounts, cess). Each one pins the bill, its GSTR-1 row, the 3B box and the e-invoice JSON.
- Validate GSTR-1, 3B and e-invoice JSON against GSTN/NIC's published schemas in CI.
- The UNVERIFIED list becomes an **in-app badge** ("check with your CA") wherever such a rule affects a figure or a date. The list is kept ready for a CA later (`docs/owner/09-questions-for-your-ca.md`).
- Bundle a dated **HSN/SAC master** (owner decision D4), so HSN search and rate suggestions are real.
- **Done when** every fixture matches across all four outputs, the schemas validate, and the owner signs the rounding diff.

### Phase 3: AI bookkeeper (weeks 5–9)
- **Provider layer** (`src/main/ai/provider.ts` already takes `baseURL`): presets for OpenAI, OpenRouter, Groq, Gemini's OpenAI endpoint and Ollama/LM Studio, or a custom URL. Models are picked from the endpoint's list, never hard-coded (this fixes the unverified `gpt-6.1-sol` default). Users bring their own key.
- **One agent, one approval queue.** It joins today's chat, Ask Total (still the no-key fallback), capture and drafting. Its tools:
  - *Read*: reports, a party's balance, GST position, stock.
  - *Propose*: purchase and payment from a bill, a sales invoice, money in/out, bank-line categories, 2B fixes, a prepared GSTR-1/3B.
  - *Tasks*: "book October's bills" or "remind everyone 30 days late" become a plan of proposals.
- The queue shows each proposal in plain words in simple mode, and as accounts plus Dr/Cr in accountant mode. You approve one, or all of them.
- **Bill inbox**: drop PDFs or photos, or use a watched folder. The existing capture pipeline (`src/main/ai/capture/`) reads them, our code recomputes every figure, and the supplier is matched by GSTIN.
- **Share**: invoice PDF to WhatsApp (the existing `wa.me` link), e-mail, or the macOS share sheet.
- **Returns**: the AI prepares GSTR-1/3B through the existing services and lists problems. Filing goes through Phase 4's gateway (sandbox).
- Keep masking, the outbound log, the cost meter and the figure check (`numbers.ts`). Drop the rest of the old guard code.
- **Done when** 50 real bills go from upload to approved entries with zero figure errors on one live provider plus one local model, and the evals run live on demand.
- **Owner supplies:** one AI key, and 50 real bills (with consent).

### Phase 4: GST portal via a GSP, sandbox only (weeks 7–10, alongside Phase 3)
- Choose **one GSP with an open sandbox** (shortlist: Masters India, Sandbox.co.in, IRIS, ClearTax; the deciding factors are sandbox access without a contract, the API surface, and later pricing).
- Build one `gstGateway` module in main with a GSP adapter. The existing NIC client (`services/nic.ts`) is folded in. Credentials go in the secret store, and a **live switch stays off** in 1.0.
- What it covers:
  - IRN generate/cancel + signed QR on the print
  - e-way bill generate/extend/cancel
  - GSTR-1 save → status → file (EVC/OTP)
  - GSTR-3B save
  - automatic GSTR-2B fetch into the existing matcher
- Contract tests against the sandbox run in a manual CI workflow.
- **Done when** a sandbox GSTIN runs bill → IRN → e-way → GSTR-1 filed → 2B fetched, end to end, from both modes and from the AI queue.
- **Owner supplies:** sign-up with the chosen GSP and sandbox credentials, and a test GSTIN.

### Phase 5: Polish both modes, speed (weeks 10–12)
- Keep two modes and make them feel like one product: a shared design-token pass, the same component kit, the same keyboard rules (⌘K, Enter saves, Esc backs out). Fix the hand-off and carry-back bugs that remain, and close the deferred gaps (a payment made now is not carried into the editor).
- Make the AI queue and GST gateway first-class in **both** modes. Multi-currency and forex stay cut (4 Nov decision); existing foreign-currency data keeps reporting as before.
- **Speed:** cold launch under 2 s, and every screen within the `docs/perf-budgets.md` budgets on 100k entries. Add skeletons and stop layout shift.
- **Done when** the e2e beginner journey (60) and an accountant journey pass in both themes, and the perf budgets pass in CI.
- **Owner supplies:** a 30-minute self-test of both modes. Real testers if any can be found (optional).

### Phase 6: Harden and ship 1.0 (weeks 12–13)
- Upgrade test: open real 0.10, 0.11 and 0.12 books and compare every report before and after.
- A signed and notarised Mac build gives silent updates. Windows ships unsigned, CI-tested only, labelled "preview".
- Hindi and Hinglish are labelled "beta". In-app "check with your CA" badges cover the remaining UNVERIFIED rules.
- Remove for good the hidden features nobody asked for. Write a short user guide and an architecture page.
- **Done when** the owner tests the build and says go, 1.0 is tagged, and the Mac update installs silently.
- **Owner supplies:** an Apple Developer ID, and the release go.

## After 1.0 (not in this plan)
Live GSP filing plus billing (a paid "connected" plan), a CA review of the UNVERIFIED list, a native Hindi review, real Windows testing plus a signing certificate, and ChatGPT sign-in once OpenAI opens it.

## Main risks

| Risk | Mitigation |
|---|---|
| A GSP gives no sandbox without a contract | Shortlist by sandbox access first. As a fallback, use the NIC e-invoice sandbox directly for IRN/e-way |
| Rounding unification moves old figures | Upgrade diff plus owner sign-off. Bills that were already filed are never re-derived |
| AI misreads bills | Our code recomputes every figure, nothing posts without approval, and the 50-bill test gates the phase |
| Two modes double the work for every new feature | Shared services and intents (`simple:post`). New UI goes into both modes in the same PR |
| No CA review before 1.0 | Badges in the app plus the CA question list. Nothing is presented as verified |
| 3 months is tight with Phases 3 and 4 running in parallel on a limited laptop | Phase 4 can slip after 1.0 (it is sandbox-only anyway). Phase 3 is the 1.0 must-have |

