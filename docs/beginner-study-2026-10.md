# Beginner study, October 2026 (WP 10.8) — proxy run

**Status: a proxy, not the real study.** Plan §7 WP 10.8 asks for five or more first-time users per
preset (owner decision D5: the owner recruits them). Until they are found, this study stands in:
one scripted persona per preset drives the **built app** on a scratch data folder, through the
simple screens only, using only what each screen offers. A script can't be confused, bored or
misread a sentence, so this finds the stuck points a code change can remove (missing answers,
dead ends, wrong tax, duplicates) — not the ones only real people find. Read the "Deferred to the
real study" list before relying on any number here.

- Driver: `~/.claude/total-orch/study-10.8/study.mjs` over the journey steps shared with e2e 60
  (`scripts/e2e/lib/beginner-journey.mjs`) and the counters in `scripts/e2e/lib/journey-metrics.mjs`.
- Before the fixes: main at `860f012d` + PR #105 (Hindi), run 14 Oct 2026. After: this branch.
- Screenshots: `~/.claude/total-orch/shots-10.8/pre/<persona>/` and `…/post/<persona>/`
  (one per step, `-STUCK-at` where a step did not finish). They are not in the repo.

## Personas

| # | Persona | Preset | GST | Stock | Start | Language | Habit tested |
|---|---|---|---|---|---|---|---|
| P1 | Kirana owner (Ramesh Kirana) | retail | not registered | yes | already running | हिन्दी | photographs bills on the phone; types "Sharmaji Store" for a customer who exists as "Sharma Stores" |
| P2 | Freelance designer (Anita Designs) | services | "not sure" | no | fresh | English | new customer from the picker; card payment for software; asks "5000 Bluebird" |
| P3 | Small manufacturer (Shree Namkeen) | manufacturer | regular, quarterly | yes | already running | English | GST bill for raw material, part paid |
| P4 | Restaurant (Punjabi Dhaba) | restaurant | composition | yes | fresh | Hinglish | daily UPI settlement in the bank; gas cylinder bought for cash |
| P5 | Trader with udhaar (Agarwal Traders) | trader | regular, monthly | yes | already running | Hinglish | sells on credit; enters the same supplier bill twice |
| P6 | Home tuition teacher (Saraswati Classes) | other | not registered | no | fresh | हिन्दी | monthly fees on credit, part paid by UPI |

Every persona: setup → (openings, if already running) → a sale → a purchase → money in → money
out → a bank statement → (a return, a stock count, with stock) → "how much GST do I owe" →
a reminder → a backup.

## What was measured

- **Done unaided**: ✓ the step finished with what the screen said; ◐ finished, but only after the
  screen asked for something first (an error under a field, "add a bank account"); ✗ not done —
  stuck, or done with a wrong result the persona could not know was wrong.
- **Wrong tax**: the persona accepted a GST outcome that is wrong for them (tax lines in an
  unregistered business, no GST on a regular business's taxable bill, a GST answer for the wrong
  period).
- **Duplicates**: the same bill twice, or the same party twice under a near name.
- **Corrections**: Undo / Edit after a save (none were needed in either run).

## Before the fixes

| Step | P1 kirana | P2 freelancer | P3 manufacturer | P4 restaurant | P5 trader | P6 tutor |
|---|---|---|---|---|---|---|
| Setup | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Openings | ✓ | — | ✓ ¹ | — | ✓ ¹ | — |
| Sale | ✓ ² | ◐ add a bank | ✗ **no GST** ¹ | ✓ | ✗ **no GST** ¹ | ✓ ² |
| Purchase | ✓ ³ | ◐ supplier asked | ✗ **no GST on a GST bill** ¹ | ◐ supplier asked | ✗ **no GST on a GST bill** ¹ | ◐ supplier asked |
| Money in | ✓ | — (paid at sale) | ◐ add a bank | — | ◐ add a bank | ◐ add a bank |
| Money out | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Bank | ✓ | ✓ | ✓ | ✓ ⁴ | ✓ | ✓ |
| Return | ✓ ⁵ | — | ✓ | — | ✓ | — |
| Stock count | ✓ | — | ✓ | — | ✓ | — |
| GST answer | ✓ | ✓ | ✗ **last month, ₹0** | ✓ | ✗ **last month, ₹0** | ✓ |
| Reminder | ✗ no button, no reason | — (paid) | ✗ no button, no reason | — | ✗ no button, no reason | ✗ no button, no reason |
| Backup | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Trap | ✗ **"Sharmaji Store" created** | ✗ "5000 Bluebird" not understood | — | — | ✓ same bill refused | — |
| **Unaided** | **11 / 13 (85 %)** | **7 / 8 (88 %)** | **8 / 12 (67 %)** | **7 / 7 (100 %)** | **9 / 13 (69 %)** | **8 / 9 (89 %)** |

¹ The opening products got no GST rate (the stock step never asked), so a regular business's first
sale carried no GST and its GST purchase claimed none — the save card said nothing was wrong and
Home's GST tile said "nothing to pay". ² "₹X due by 14 Oct 2026" (today) for a customer with no
days to pay. ³ The phone-camera habit: no "snap a bill" (AI off — by design) and nothing on the
screen says a photo can't be used. ⁴ The UPI settlement had to be answered as "other money in" →
the Sales tile; it worked, but a counter-sales choice would read better. ⁵ The kept credit was
called "paid in advance".

Totals before: **wrong tax 4** (P3 + P5: sale and purchase each) **+ 2 wrong GST answers**, **1
duplicate party**, 0 corrections, 4 errors shown (all "pick the supplier", all corrected at once).
Journey metrics (clicks / screens): P1 99 / 25, P2 67 / 14, P3 93 / 22, P4 57 / 9, P5 107 / 25, P6 68 / 15.

## Ranked issues

| # | Issue | Personas | Kind | Fixed |
|---|---|---|---|---|
| 1 | Opening products of a regular business have no GST rate → first sale with no GST, GST purchase claims none, silently | P3, P5 | wrong tax | ✓ the stock step asks each new product's rate (dated slabs); Sell / Buy say when a product has none |
| 2 | "How much GST do I owe" shows last month (₹0) while this month's bills are elsewhere; a business started today is told about last month ("file it as soon as you can") | P3, P5, gate | wrong answer / stuck | ✓ periods start with the books (Taxes, Home tile, Home checks); the running month's files wait for its month end |
| 3 | A customer with udhaar but nothing late has no reminder and no reason | P1, P3, P5, P6 | stuck | ✓ the page says nothing is late and points at Statement |
| 4 | "Sharmaji Store" created next to "Sharma Stores" | P1 | duplicate | ✓ "Did you mean …?" sees through "ji" and plural s |
| 5 | "5000 Bluebird" → "I can't answer that yet" | P2 | stuck | ✓ asks which way, two answers to press |
| 6 | "Books and bank agree" while the statement's closing balance differs (gate) | gate | wrong answer | ✓ compares the statement's own balance too |
| 7 | Kept credit called "paid in advance" / "paid ahead" | P1, gate | wording | ✓ "a credit of ₹X to use on the next bill" |
| 8 | "Due by <today>" for a party with no days to pay | P1, P3, P5, P6 | wording | ✓ "no due date is set" |
| 9 | Backups opened the full app's tab (vouchers, ledgers, SHA-256) | all, gate | jargon | ✓ a plain Backups screen; the full tab behind it |
| 10 | Selling more than in stock costs it at zero — the warning didn't say the profit will be wrong; nothing on Home until next month | gate | silent error | ✓ the warning says so; Home lists products below zero today |
| 11 | Viewer sees Save and learns only after pressing it | review 9.2 / 9.3 | dead end | ✓ a plain note instead of Save |
| 12 | "Loss −₹1,150.00"; header year "01-Apr-26 → 31-Mar-27"; HSN "needed" and "Optional" | gate | wording | ✓ |
| 13 | Rent bill with GST previewed as "Purchase bill" | review 9.4 | wording | ✓ "Bill … for Rent" |
| 14 | Quick bill shows a GST column to an unregistered shop | review 9.2 | wording | ✓ |
| 15 | Record a purchase of a cash expense needs a supplier (Money out doesn't) | P2, P4, P6 | extra step | deferred (◐ — the error is under the field and the persona recovered) |
| 16 | Restaurant's UPI settlement is "other money in", not "counter sales" | P4 | wording | deferred |
| 17 | No photo path without AI for a phone-camera user | P1 | expectation | deferred (AI feature by design) |

## After the fixes

Same personas, same steps, this branch (run 15 Oct 2026; the GST rows re-run after the
running-month line landed).

| Step | P1 kirana | P2 freelancer | P3 manufacturer | P4 restaurant | P5 trader | P6 tutor |
|---|---|---|---|---|---|---|
| Setup | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Openings | ✓ | — | ✓ GST rate asked | — | ✓ GST rate asked | — |
| Sale | ✓ "no due date set" | ◐ add a bank | ✓ GST ₹90 | ✓ | ✓ GST ₹112.50 | ✓ |
| Purchase | ✓ ³ | ◐ supplier asked | ✓ GST ₹200 claimed | ◐ supplier asked | ✓ GST ₹250 claimed | ◐ supplier asked |
| Money in | ✓ | — | ◐ add a bank | — | ◐ add a bank | ◐ add a bank |
| Money out | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Bank | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Return | ✓ "credit of ₹50 … next bill" | — | ✓ | — | ✓ | — |
| Stock count | ✓ | — | ✓ | — | ✓ | — |
| GST answer | ✓ | ✓ | ✓ RUNNING-P3 | ✓ | ✓ RUNNING-P5 | ✓ |
| Reminder | ✓ "nothing is late yet" | — | ✓ "nothing is late yet" | — | ✓ "nothing is late yet" | ✓ "nothing is late yet" |
| Backup | ✓ plain screen | ✓ | ✓ | ✓ | ✓ | ✓ |
| Trap | ✓ "Did you mean Sharma Stores?" | ✓ "did Bluebird pay you, or …?" | — | — | ✓ same bill refused | — |
| **Unaided** | **13 / 13 (100 %)** | **8 / 8 (100 %)** | **12 / 12 (100 %)** | **7 / 7 (100 %)** | **13 / 13 (100 %)** | **9 / 9 (100 %)** |

Totals after: **wrong tax 0** (was 4) and **wrong GST answers 0** (was 2), **duplicates 0** (was 1),
corrections 0, errors shown 3 (the same "pick the supplier", each corrected at once — deferred
issue 15). Clicks are unchanged within one or two per persona (P1 98, P2 67, P3 93, P4 57,
P5 107, P6 68): the fixes add answers on the screens, not steps.

"Unaided" still counts ◐ as done: the screen asked for something and the persona could answer it
there. A ✓ for the reminder means the page now says why there is nothing to send — whether a real
udhaar shopkeeper accepts "nothing is late yet" or wants a polite "please pay" before the due date
is a question for the real study (D5).

## Deferred to the real study (D5)

- Everything a script can't feel: reading speed, which words are misunderstood, where people look
  first, whether Hinglish reads naturally (D6), how long a step takes for a real shopkeeper.
- Five people per preset as planned; this run has one scripted persona per preset.
- Phone-first users: whether "snap a bill" without an AI key should offer something (attach a
  photo to a typed bill?).
- Restaurants: a counter-sales answer for a bank line (UPI settlement).
- A cash expense through Record a purchase without a supplier ("walk-in supplier"), or a pointer to
  Money out.
- From the reviews, not fixed here: the money list names the supplier, not the category, for a
  GST-bill expense; Cancel from a hand-off returns an empty simple form; the tour card can cover
  part of Home (click-outside ends it); dialog-scoped toasts over the Save bar (not reproduced on
  this build — 10.5 lifts the stack above the bar).
