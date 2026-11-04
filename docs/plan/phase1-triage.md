# Phase 1 triage of `to-do.md`

4 November 2026. Every open item in `to-do.md` gets one verdict:

- **Fix P1**: fixed in Phase 1.
- **P2–P6**: moved to that phase of `upgrade-plan.md`.
- **Gone**: the feature is removed or hidden by the cut, so the item closes with it.
- **Accept**: the current behaviour stays on purpose. The default in brackets in `to-do.md` holds.
- **Owner**: needs an answer (asked on 4 Nov, answers recorded below).

Removed in the cut: group consolidation, report builder + packs, MCP + inbox, budgets, loans, AI evals tooling, year-end repair. Hidden: forex / multi-currency, cost centres, cheque books / PDC / bulk files, interest on overdue bills, fixed assets, quotations / orders / challans, payroll statutory. **Also removed: the Day book** (owner, 4 Nov). Links that opened it open the all-entries register filtered to the same date.

## 1. Owner decisions

| Item | Verdict |
|---|---|
| D1 WP 8.0 correctness, D2 simple mode by default, D3 owner switches mode | Accept |
| D4 bundle the HSN / SAC list | **P2** (in the plan) |
| D5 real beginner testers, D6 Hindi reviewer | Accept for 1.0 (Hindi "beta"); after 1.0 |
| D7 Phase 7 hardening is a 1.0 prerequisite | Accept (done) |
| Negative stock costs a sale at ₹0 | Accept: warning only (owner, 4 Nov) |
| Change price with no default level | Accept |
| Binning a closing journal moves the lock | Accept |
| Backup check after the open reply | Accept (done differently in #175) |
| AI cost in US dollars without a forex rate | P3 (a USD rate field in the AI settings, since forex is hidden) |
| "Usual cost" stored but unread | Accept, and later P3 (the AI can prefill purchases from it) |
| No tour for full-form companies | Accept |
| Old local branches and old GitHub branches | Delete (owner, 4 Nov), with merged `p1/*` branches |
| #172 2B matching on the live GSTIN; import without snapshot columns clears it | Accept |
| v0.6.0 / v0.9.0 never tagged | Accept |

## 2. Figure / rule sign-offs

All of these already shipped in v0.12.0 (22 Oct). **The owner accepted every one on 4 Nov.**

| Item | Verdict |
|---|---|
| #85 outstandings: named credits | Accepted |
| #93 amount-only bill rate from posted tax | Accepted |
| #93 interest GST rate side effect | Gone (interest hidden) |
| #94 due dates (3B 22nd/24th, TDS 30 Apr, PMT-06, CMP-08, GSTR-4) | Accepted |
| #107 bin closing journal moves lock | Accept (as section 1) |
| #112 new SQLite driver | Accepted |
| Circular 170 3B tables | Accepted |
| Payroll EPF / ESI rounding | Gone (payroll statutory hidden) |
| TDS thresholds migration 020 | Accepted |
| #172 re-save re-freezes tax facts | Accepted |
| Year-end: stock part of profit stays on the BS line | Accepted |

## 3. Things only the owner can supply

All go to the plan's "Owner supplies" lists: AI key + 50 bills (P3); GSP sandbox instead of NIC credentials (P4); Apple Developer ID (P6); Windows certificate, a Windows PC, a Hindi reader and a CA (after 1.0); importer fixtures (after 1.0).

- **Account housekeeping** (Actions quota, CodeRabbit, Vercel): Owner.
- **Pre-0.5 backups with NIC secrets in plain text**: Accept (release-note line only).

## 4. Bugs and limitations

### Simple mode
| Item | Verdict |
|---|---|
| GST-bill expense preview says "Purchase bill" for rent | Fix P1 (check: WP 10.8 `facts.forWhat` may already cover it) |
| Bank sentence vs the statement's closing balance | Fix P1 (check: WP 10.8 tone `balance` may already cover it) |
| Stock counts go to the default place only | Accept (one place per product in simple mode) |
| Count of a never-stocked product valued ₹0 | Fix P1 (ask for a cost per unit) |
| People: parties under imported groups ("Trade Receivables") show no balance | **Fix P1** (also wrong in the accountant Outstandings) |
| Hand-off: a "paid now" payment isn't in the editor | P5 |
| Taxes: PMT-06 amount full-app only | Accept (QRMP edge case) |
| Home profit "Purchases" includes direct expenses; advance tax has no Why | P5 |
| Ask Total leftovers | P3 (folded into the new agent) |
| No credit days = overdue the next day | Fix P1 (no credit days = no due date) |
| s.17(5) blocked ITC counted as claimable | **P2** |
| Beginner leftovers: photo without AI key, restaurant UPI settlement | P3 (photo) / P5 (UPI settlement) |
| Hindi leftovers (preset names, reminder bodies) | P6 |

### Accountant
| Item | Verdict |
|---|---|
| Pre-0.6 manufacture vouchers not in the register | Accept |
| TDS: purchase returns don't reduce the threshold; 26Q is RPU input | P2 |
| Trade cycle leftovers, TCS LRS, cash & finance leftovers | Gone / Accept |

### GST
| Item | Verdict |
|---|---|
| Rounding per group vs per line; float intermediates | **P2** (in the plan) |
| Advance GST on goods (N. 66/2017) | P2 |
| MSME from bill date, not acceptance | P2 |
| Blended rate for several rate-less lines; discounts under Sales | P2 |
| Off-slab implied rate is only a warning | P2 |
| "Exported JSON" = prepared | P4 (the GSP gives real filing status) |

### Windows
All Windows items: after 1.0 (Mac first). Windows CI stays green, but the flaky Windows dbtests are fixed only if they block merges.

### AI
| Item | Verdict |
|---|---|
| Figure check can't prove sign or period | P3 |
| No live run of escalation, key rejection or capture | P3 |

### Performance
| Item | Verdict |
|---|---|
| Launch 6.5 s vs 2 s | P5 |
| 500k reports > 3 s; SQLite on the main thread | P5 |

### Security
| Item | Verdict |
|---|---|
| Exports / logs / capture inbox not encrypted | Accept |
| Audit chain can't prevent tampering | Accept (by design) |
| Signed macOS update unverified | P6 |

## 5. UNVERIFIED tax points
All go to P2: each becomes an in-app "check with your CA" badge where it touches a figure or date. Points for hidden or removed features (fixed assets, payroll, receivables interest, forex / loans, consolidation, MSME interest) close with the feature. Busy / Zoho header spellings: Accept.

## 6. Deferred engineering
| Item | Verdict |
|---|---|
| Site FAQ "nothing leaves the machine" is false with AI on | Fix P1 (one sentence) |
| Server-side table paging | Accept |
| Encrypt exports / logs | Accept |
| CLI ignores the data-folder pointer | Fix P1 |
| Deferred e2e coverage (NIC sandbox etc.) | P4 |
| CHANGELOG Unreleased leftovers | Fix P1 |
| TDS / TCS / credit-hold override in simple intents; TDS only as a hint | P5 |
| gst.gov.in from the app | P4 |
| Help simple-only; accountant screens English | Accept |
| GPT review P3 / P6 / P7 | P2 (calc) / P4 (filing evidence) / P6 (upgrade recovery) |

## 7. Dependencies
| Item | Verdict |
|---|---|
| Electron 37 → current major (~50 security alerts) | **Fix P1** (owner, 4 Nov), after the cut merges |
| vitest 3 → 5 | P1 if time, else P6 |
| No upstream fix (sprintf-js etc.) | Accept, re-check with Electron |
| site/ next / sharp bumps | Fix P1 (security, small) |

## 8. Test gaps
Live AI → P3; live sandbox → P4; 500k / packaged perf → P5; Windows-only paths → after 1.0; CI e2e 18–20 min → Accept (shard if it grows).
