# What happens next

Written 25 August 2026. State at the time of writing: **279 of 392 roadmap items done** (269
built, 10 declined with a reason on the line), 98 commits on `t3code/revamp-ledgers-shortcuts`,
PR #2 open. All four harnesses green.

Two things changed the shape of this plan today. The accent colour moved from amber to indigo,
which is a token change but touches every screen. And a full visual review of all 35 screens in
both themes came back with a verdict worth quoting, because it is the thing to fix:

> The tables were designed; the chrome around them — toolbars, scrollbars, card sizing, the dark
> palette, and the two overworked accent colours — was assembled.

That is the whole UI problem in one sentence. The report screens are good and should be left
alone. Everything wrapped around them is inconsistent because it was written screen by screen
over months, and the fix is one deliberate pass, not thirty-five small ones.

---

## Phase 1 — the recolour (done today)

Indigo replaces amber as the signature: the selection bar, the active tab, the active nav item
and the primary button.

- The accent is two tokens, not one. `--t-accent` is for text and hairlines and clears 4.5:1
  against paper; `--t-accent-bar` is for solid fills and can be brighter because what sits on it
  is white. One value for both is how an accent ends up either too pale to fill with or too dark
  to read.
- Dark's selection is an **opaque** mix rather than the accent at low alpha. A translucent
  colour takes its hue from whatever is behind it, which is exactly how the old amber selection
  came out olive on navy.
- Dark's neutrals moved from navy to a true grey. Navy made the app a different product after
  dark, and warming it would now fight a cool accent.
- Links and row actions dropped from a true blue to a slate. With an indigo signature a blue
  link is a second accent competing with the first, and the day book had sixty on screen at once.
- The old `amber` / `amberbar` utility names stay mapped to the new tokens while branches
  written before the change land. They come out in phase 3.

Also fixed today, all from the same review: sales rows in the day book were a line taller than
every other row (two action buttons wrapping); a scrollbar thumb was parked permanently in the
sidebar on all 70 screenshots; report cards stretched to fill the viewport so a finished
statement ended with its double-rule total and then 230 pixels of blank card; coloured figures
lost contrast the moment the cursor landed on them; completed checklist steps were struck
through, which made a card of finished work read as a card of mistakes; and a negative GST tile
printed a minus sign for what is actually a refund.

---

## Phase 2 — restart the six feature lanes (blocked until the limit resets)

Six worktree-isolated lanes were running when the account hit its session limit. Their worktrees
are intact with uncommitted work; they resume with context rather than starting over.

| Lane | Items | Where it stopped |
|---|---|---|
| J — AI and agents | 18 | running its suites |
| S — Statutory depth | 14 | writing IPC schemas |
| K + Q — Performance, dev experience | 23 | the ledger statement screen |
| I + D — Invoicing, GST | 20 | migration landed, fanning out |
| E + F + B + A — Inventory, banking, entry, keyboard | 28 | the invoice quantity grid |
| H + O + T — Pay cycles, sample companies, CMA data | 3 | demo trade profiles |

The two inside those lanes that are correctness bugs rather than missing features, and which I
want landed first:

- **QRMP.** Filers under ₹5 crore turnover — most of this market — file quarterly, and
  `compliance.ts` models only monthly deadlines. The app is showing those users the wrong due
  dates today.
- **Composition dealers.** `gst/validate.ts` currently *blocks* them with an error telling them
  to go elsewhere.

---

## Phase 3 — the chrome pass (one uninterrupted sweep, after the lanes land)

Deliberately not run in parallel with the feature lanes: it touches every screen file, and so do
they. Doing both at once buys a day of wall-clock and pays for it in merge conflicts I resolve by
hand.

Ranked by how much each one is responsible for the app looking unfinished:

1. **One toolbar grammar.** Every screen improvises its header row today. Export actions render
   as unstyled grey words — indistinguishable from labels — and the same action sits in a
   different place on the next screen. Some screens have a full-width band whose only content is
   one right-floated button, leaving 1100px of dead space. One spec: title and view tabs left,
   filters centre, exports as one segmented control, primary action far right. `Masters` already
   does this correctly and becomes the reference.
2. **One table density.** Two coexist with no rule: 30px rows on the day book and masters, 44px
   on collections and khata. Khata and outstandings show the same two debtors at different
   heights. 30px is right for this product.
3. **Retire the `amber` aliases** and finish the rename.
4. **Red's five jobs.** Red currently means overdue, hotkey letter, sidebar count, whole flagged
   row, and inline error. Reserve it for "money or compliance is wrong" and nothing else. Stock
   summary paints even *positive* numbers red when a row is flagged.
5. **Card widths.** Year-end and Import from Tally use a 760px card where every other screen uses
   1207px, so the page edge jumps 450px on navigation. Constrain the text inside a full-width
   card, not the card.
6. **The Gateway loses the paper.** It is a wall of pure-white cards edge to edge, so the cream
   ground that gives every other screen its identity is invisible and it reads as a generic SaaS
   dashboard.
7. **e-Invoice row noise.** The same grey sentence repeats thirteen times down the screen and
   each row carries four links. Eligibility becomes a chip; actions collapse to one plus an
   overflow.
8. **Voucher-entry footer hints** duplicate the F-key bar below them. Collapse into `?`.

Not touching: the report tables, the serif-title-and-footnote voice, the day book and masters
table archetypes, or the numerals. Those are the best things in the app.

---

## The declines, reviewed

Twenty roadmap items are marked ✗ rather than done, each with its reasoning on the line. All
twenty were re-read on 25 August 2026 to ask a single question: **has the reason expired?**

One had. ISD (#355) was declined because multi-GSTIN did not exist; multi-GSTIN landed that
morning, so the reason stopped being true and the item shipped that evening. That is the whole
point of writing the reason down rather than just the verdict — a decline with a stated cause is
a decline that can be re-opened by evidence, and one without is just a thing nobody did.

None of the other nineteen has expired, and they fall into three shapes:

- **Blocked on an artefact nobody here has.** A real Busy or Marg export file (#290), a Tally
  backup in its proprietary format (#299), screenshots of Tally's own export dialog (#295).
  Each was declined because a parser guessed at is worse than none, and that is still true.
- **Declined on a measurement**, and the measurement was taken after the work that would have
  changed it. All six performance items (#225, #229, #230, #231, #239, #240, #241) were re-timed
  *after* pagination landed, which is the change most likely to have made them worth doing. It
  did not.
- **Declined on a principle the product still holds.** Bare letters belong to navigation (#8,
  #22). A bill photograph cannot be redacted (#207). A statement PDF has no table in it (#132).
  Encryption that can lose somebody's books is not a feature (#262).

The next review should ask the same question rather than re-litigating the reasoning: what has
changed since, and does anything here now have what it was waiting for?

---

## Phase 4 — the launch gates that are code

- **#344** a generated 100,000-voucher book timed through every screen, with the numbers
  published. It is both the QA gate and a marketing asset. Deliberately not run yet: it saturates
  this machine and the feature lanes need it.
- **#341, #342, #271** signing and notarization — see `HUMAN.md`. Blocked on certificates, not on
  code.
- **#347** one session on a real cheap Windows laptop — also `HUMAN.md`.

---

## How the work is parallelised, and why it is six

Six lanes is the width that works here, and the constraint was never the machine — it was the
account's session limit, which is what stopped all six at once. The rules that keep six lanes
from destroying each other:

- **Each lane owns a section of the roadmap**, and sections were paired so that two lanes rarely
  need the same service file. Where they do overlap it is in `ipc.ts` and `client.ts`, which
  conflict predictably and merge mechanically.
- **Migrations are the one genuine hazard.** They apply *by array position* — `migrate.ts`
  records `MAX(id)` and resumes from that index, and nothing keys on a name or a checksum. Two
  lanes both taking "the next free number" is the one merge that can silently skip a migration
  on every existing database. `migrationHashes.ts` is the order pin that catches it, and the test
  compares whole arrays so an insertion shows up as one shifted block rather than fifty
  individually-wrong lines.
- **Every lane must leave all four harnesses green** before it reports, so a merge is a merge and
  not a debugging session.
- **A reviewer runs over the statutory work separately.** The last pass found seven real bugs,
  including §87A marginal relief being applied to the old tax regime where it does not exist — a
  gross salary of ₹5,50,100 computed ₹104 of tax against the law's ₹13,020. That is the class of
  error a user does not find out about from the app.

The one thing I will not parallelise is the chrome pass. Consistency is the entire deliverable,
and six agents agreeing on a toolbar is not a thing that happens.
