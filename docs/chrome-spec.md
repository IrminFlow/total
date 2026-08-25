# The chrome spec

The rules for everything wrapped around a table: the header row, the toolbar, the tabs, the card
and the row. Written before the pass that applies it, so the pass is mechanical rather than
thirty-five small judgement calls.

The tables themselves are not in scope and are not to be touched. A full look at all 35 screens
in both themes produced one sentence worth keeping:

> The tables were designed; the chrome around them was assembled.

This document is the design the chrome never got.

---

## What is actually there today

Measured, not remembered:

- **32 of 40 screens use `SectionTitle`.** A shared header with a `right` slot already exists and
  is already adopted. The grammar is not missing — what is missing is a rule about what may go in
  that slot.
- **`ScreenHeader` and `PageFrame` are dead code.** Both are exported from `components/ui.tsx`
  with careful doc comments, and **nothing imports either of them**. They were written as the
  answer to this problem and never adopted. They go.
- **19 screens have a PDF export**, and the toolbar around it is different on most of them.
- **118 `variant="ghost"` buttons** across the screens. Ghost is the app's way of saying
  "unstyled text word", and it is why an export action is indistinguishable from a label.
- **Four different heading treatments** exist outside `SectionTitle` — `text-heading`,
  `text-display`, with and without margins.

---

## 1. The header row

Every screen opens with `SectionTitle`. No screen hand-rolls an `<h1>`, `<h2>` or its own flex
row. One serif title, one size, one position, so the first thing the eye lands on lands in the
same place on every screen.

The `right` slot takes **at most four groups**, always in this order, left to right:

| Slot | What goes in it | Rendered as |
|---|---|---|
| 1. Scope | period picker, "as on" date, a party or account selector | `Select` / `DateInput` |
| 2. View | filters, a search box, `ReportConfigButton` | input, then pills |
| 3. Export | PDF, CSV, XLS | **one segmented group**, see below |
| 4. Primary | the one thing this screen is for — Add employee, New voucher | `Button variant="primary"` |

A screen with nothing for a slot leaves it out. It does not leave an empty band.

**Banned:** a full-width row whose only content is one right-floated button. Four screens have
one today, each leaving about 1100px of dead space beside it. The button belongs in the title
row's `right` slot; that is what the slot is for.

**Banned:** a header row that contains a live error message. One screen puts a red string in its
toolbar. Errors belong in a toast or against the field.

## 2. Exports are one control, never three words

The pattern today is three consecutive `variant="ghost"` buttons reading `PDF` `CSV` `XLS`. At
`ghost` weight they are grey text, sitting next to other grey text that is a label, and they
change position from screen to screen.

They become **one bordered segmented control** — a single visual object that reads as "export",
with the formats as its segments. One object in a fixed place is scannable; three loose words
are not.

A disabled export renders **disabled inside that control**, not as a pair of grey words floating
alone on their own row. One screen does the latter today and it reads as a rendering fault.

## 3. One table density

Two coexist with no rule: **30px** rows on the day book, masters, trial balance, GSTR-1 and stock
summary; **44px** on collections, khata, the filing register and exceptions. Khata and
outstandings show *the same two debtors* at different heights.

**30px wins.** It is what the archetype screens use, it is what a dense ledger product should be,
and the 44px screens are taller only because a pill control inside a cell forced them. The pills
shrink; the rows do not grow.

## 4. Cards end where their content ends

`.card-fit` (`flex: 0 1 auto; min-height: 0; max-height: 100%`) rather than `flex-1`. A long
report still scrolls inside a bounded card with its header in place; a short one stops.

A trial balance that ends with its double-rule total and then continues for another 200 blank
pixels inside the same card reads as data that was cut off. A ledger ends at its ruled total —
that is the whole paper metaphor the product is built on.

Two screens use a 760px card where every other screen uses 1207px, so the page edge jumps 450px
on navigation. Every top-level card is the same width. Where a narrower reading measure is
genuinely wanted, constrain the **text inside** a full-width card.

## 5. What each colour means, and nothing else

| Colour | Means | Never means |
|---|---|---|
| `accent` (indigo) | selection, the active thing, the primary action | information, emphasis, decoration |
| `cr` (oxblood) | money or compliance is **wrong**: overdue, negative stock, unbalanced | a count, a hotkey, a whole row |
| `accel` | the letter that navigates | anything else at all |
| `warn` (ochre) | a caution the user should act on | the accent's overflow |
| `dr` (green) | cleared, matched, done | — |

Red currently does five jobs: overdue days, the hotkey letter in every nav label, sidebar count
badges, whole flagged rows, and inline errors. Stock summary paints even *positive* numbers red
when a row is flagged. When red is ambient, real red stops registering — which is precisely the
moment it is needed.

**The fix:** flag the offending cell, never the row. Move the explanation to a tooltip or a
footnote, which is a device this app already owns and uses well.

## 6. Repetition is a data-modelling leak

One screen prints the same 60-character grey sentence on all thirteen visible rows, then four
blue links per row after it. About sixty links on screen at once.

A value repeated on every row is not row data — it is a property of the screen, and it belongs in
a footnote once. Row actions collapse to the one that is used, plus an overflow.

## 7. Rules that already hold and must keep holding

- The `.kbar-row` selection bar on a `<tr>` is an **inset box-shadow, never `::before`** — a
  `tr::before` renders as a phantom first cell.
- Numerals are right-aligned, tabular and Indian-grouped. 70 screenshots turned up no exception;
  that discipline is intact and is not to be disturbed.
- Every row action is reachable by keyboard. Hover-only is a bug: `.row-action` reveals on
  `:hover`, `:focus-within` and `[data-active]`, and in keyboard-only mode hover stops revealing
  anything at all.
- Any cell with more than one action is `white-space: nowrap`, or rows of different kinds end up
  different heights.

---

## Applying this

One uninterrupted pass, not parallelised. Consistency is the entire deliverable and six agents
agreeing on a toolbar is not a thing that happens.

Order, because each step makes the next smaller:

1. Delete `ScreenHeader` and `PageFrame`. Nothing imports them.
2. Build the segmented export control, once, in `components/ui.tsx`.
3. Sweep the 19 screens with an export onto it.
4. Sweep the 8 screens that do not use `SectionTitle` onto it, and kill the orphan button rows.
5. Drop the 44px screens to 30px by shrinking their in-cell pills.
6. `.card-fit` everywhere a report card uses `flex-1`; unify the two narrow cards.
7. Red's five jobs down to one.
8. Retire the `amber` / `amberbar` / `onamber` aliases and finish the rename.

The E2E suite is the safety net for all of it: 36 scenarios drive the real built app, and a
toolbar that loses a button loses a test.
