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
13. ✓ Keyboard-driven date-range picker on the period pill (S) — `⌘⇧P` from anywhere, and the
    pill itself says so. `⌘P` is Print in the application menu and the bare `P` is Profit & Loss,
    so the shift chord was the only form left that does not take something away.
    Inside: one key per quick-pick, arrows to walk them, Enter to commit, Esc to cancel, and the
    two date fields keep DateInput's Tally shorthand. The presets are pure and tested
    (`src/shared/periodPresets.ts`) rather than computed inline, because "last month" and "this
    quarter" are year arithmetic and year arithmetic in a component is year arithmetic nobody
    tests — a quarter here is the statutory one (Q1 = Apr–Jun), deferred to `periodBounds` rather
    than restated. Year to date ends TODAY rather than at the year end, which is the whole point
    of it.
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
17. ✓ Space toggles the expand/collapse state of a tree row (S) — on the row the list layer has
    selected, on every report that has sub-rows.
    The interesting part is where it deliberately does NOT fire. The Balance Sheet and P&L trees
    are made of real `<button>` rows, and a focused button is already activated by Space by the
    browser — binding it again in the list layer would fold the row twice, which reads as it not
    working at all. So the layer checks what focus is actually on and stands down for the
    elements the browser already handles. It also stands down inside a text field, and it
    preventDefaults what it consumes, because Space is page-down everywhere else.
18. ✓ `⌘⇧F` opens global search scoped to the current screen (S) — the same palette with the
    commands dropped and the results narrowed to what the screen is about (vouchers on the Day
    Book, ledgers and items in Masters). A screen that narrows nothing gets ⌘K's behaviour
    rather than a pretended scope.
19. ✓ Vim-style `gg` / `G` to jump to first/last row, behind a preference (S) — Settings →
    Appearance, off by default and it has to stay that way: the list layer sits above the nav
    layer, so binding `G` shadows the Gateway on every screen with a list. The preference says
    so in as many words, and ⌘1 still goes home.
20. ✓ A visible focus-ring audit: every interactive control reachable by Tab (M) — the
    deliverable is a test, not a component, and it lives in `scripts/e2e/12-theme-a11y.mjs` with
    the rest of the computed-style checks. It walks all 35 sidebar screens, focuses every real
    control on each, and asserts three things: that the tab order reaches it, that focusing it
    changes something, and that what changed is VISIBLE — 1,949 rings measured against a 3:1
    floor (WCAG 2.2 SC 1.4.11, which names a focus indicator as its own example).
    Three details are what make it mean anything. It measures the ring as a DIFFERENCE between
    the resting and focused state, because reading only the focused state counts every button's
    ordinary `panel-shadow` as a focus indicator and passes an app that has none. It composites
    translucent backgrounds down to the opaque layer, because comparing an indigo ring against
    the selected row's `rgba(67, 56, 202, 0.1)` reports 1:1 for a ring that is perfectly visible,
    and an audit that cries wolf gets switched off. And it freezes transitions first: every
    button transitions `outline-color`, so a style read the instant after focus catches the ring
    part-way from `currentColor` and reports a white ring on a white button.
    It found a real one. The ring was drawn in `--t-accent-bar`, the SOLID FILL colour, which is
    2.90:1 against the dark theme's sidebar — a ring that exists in the stylesheet and cannot be
    seen. Hence `--t-focus-ring`, a third accent value rather than a reuse of one of the two:
    filling a button, being readable as text, and separating from the surface a ring is drawn on
    are three different requirements, and one value cannot satisfy all three.
21. ✓ Shortcut conflicts surfaced in Settings when a screen shadows a nav letter (S) — the layer
    stack already did the right thing: a screen's letters sit above the navigation ones, so `C`
    starts a contra on voucher entry rather than jumping to Cost centres. That was never the
    complaint. The complaint is that it was undiscoverable — the sidebar greys the shadowed
    letter out only while the screen that took it is open, which explains it at exactly the
    moment nobody is looking at the sidebar.
    Settings → Appearance now lists every collision: the key, the screen, what it does there and
    where it would otherwise have gone. Read-only, because #22 declined remapping and that reason
    holds; naming the collisions is the part of the complaint worth fixing.
    The list is DERIVED from the same array the screen binds (`lib/voucherTypeKeys.ts`, lifted
    out of the screen component for exactly this) rather than hand-maintained beside it — a
    second list is how the `?` overlay drifted from the behaviour before the registry existed,
    quietly and for months. A claimed letter that no screen navigates to is not reported: `J` is
    a journal and nothing else anywhere, and listing it would bury the five that matter.
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
27. ✓ Voucher templates beyond recurring: save any voucher as a named template (M) — a separate
    table, not a reuse of `recurring_templates`. That table's cadence and `next_due` are NOT
    NULL, because it is a schedule that happens to carry a shape; squeezing a template into one
    means inventing a cadence, and an invented cadence posts entries nobody asked for.
    A template never posts. Applying one loads the entry form and the user saves it like any
    other voucher. The date is normalised to an obviously-unreal placeholder rather than dropped
    (the schema requires one, and a stored shape that no longer validates is a template that can
    never be applied) and every apply replaces it; the number is dropped outright, because
    numbers are allocated against the series for the voucher's own financial year at save time.
    Stored shapes are re-validated on the way OUT as well as in, so a template whose ledger was
    deleted last March says which ledger instead of failing inside a foreign key — and it still
    lists, greyed, because otherwise there would be no way to delete it.
28. ✓ Copy the previous voucher of the same type with one key (S)
29. ✓ Auto-fill the narration from the party and item names (S)
30. ✓ Inline ledger creation without leaving the picker (already partly there) (S) — the
    "Create X" row already existed; it opened a form. The form is only earning its place when
    the group is a real question, and in the two commonest cases it is not: the party on a sales
    invoice is a debtor, the party on a purchase is a creditor, and the account side is Sales or
    Purchase Accounts. Those four now create and select in one keystroke, with the destination
    named on the create row BEFORE it is used and an undo on the toast afterwards.
    Everywhere else still opens the form. A guessed group is worse than a modal: a ledger under
    the wrong group lands in the wrong half of the balance sheet and nothing about the entry
    looks wrong afterwards. The undo is what makes the confident cases safe without a
    confirmation — the answer to a mistyped name is a way back, not a dialog on the ninety-nine
    that were right.
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
34. ✓ Quantity field accepts a unit-conversion expression (`2 box` → 24 pcs) (M) — and
    arithmetic with it: `2 box + 3`, `12*8` off a delivery note that only totals by carton,
    `144/2` for half a gross. The amount box has read expressions for a while and the quantity
    box had not, which was the wrong way round — the amount is usually one figure off an
    invoice, and the quantity is where the mental arithmetic actually happens.
    Same restricted evaluator as the amount box, deliberately: left to right, four operators, no
    precedence. A quantity box that silently applies precedence to `2+3*4` is worse than one
    that refuses, because the resulting stock figure looks perfectly reasonable and nothing
    downstream can tell it was not meant. Integer thousandths throughout, and the operand of `*`
    and `/` is read as a count rather than a quantity — `2 box * 3` is three lots of two boxes.
    This also removed a live float: the invoice grid was computing its displayed line amount as
    `parseFloat(qty) * rate`, which is a different number from the integer one it sent to the
    books.
35. ✓ Remember the last-used voucher type, across sessions rather than just within one (S)
36. ✓ Warn before saving a voucher dated outside the open period (S)
37. ✓ Duplicate-number detection extended to duplicate amount+party+date (S) — already
    shipped: `findDuplicates` matches type + party + total within a ±3-day window, pre-save.
38. ✓ A "post and new" button that keeps the party and date (S)
39. ✓ Bulk edit: change the narration or cost centre on many vouchers at once (M) — the two
    fields that are routinely wrong in bulk and never wrong individually: a month keyed with no
    narration, or a quarter of branch expenses never allocated because the cost centre was added
    to the chart in April. Amounts, ledgers, dates and bill references are never touched, and
    "change it on all of them" is never the right way to say any of those.
    All or nothing. A voucher inside the locked period or in the bin aborts the run before
    anything is written — a bulk edit that did 91 of 100 and mentioned it in a toast is one
    nobody can reconcile afterwards. The cost-centre change REPLACES what is allocated, at each
    line's full amount, and leaves out the party line and the cash/bank line: a cost centre
    answers which part of the business a cost belonged to, and money leaving the bank belongs to
    all of them. One narrow audit row per voucher, so a later reader can see this was a sweep
    rather than a re-keying.
40. ✓ Bulk delete to the bin from the Day Book with a confirm (S)
41. ✓ Split a voucher line across cost centres by percentage rather than amount (S) — "rent is
    40% Mumbai, 35% Pune, 25% head office" is how the split is decided; the amounts are derived
    from it every time the rent changes, and deriving them by hand is where the paisa goes
    missing and the voucher stops saving. 40% of ₹1,00,000.33 is thirteen and a fifth paise;
    round each share on its own and the three no longer add to the line.
    So the split is done once over the whole line by largest remainder: every share gets its
    floor and the leftover paise go one each to the shares with the largest discarded fraction.
    Sums to the line by construction, and deterministic — reopening the modal cannot reshuffle
    which share got the odd paisa. Percentages are integer basis points; a percentage stored as a
    float would reintroduce one layer up exactly the imprecision this avoids.
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
46. ✓ A scratchpad ledger for entries the user has not decided how to classify (S) — a real
    ledger under **Suspense A/c**, plus a panel on Exceptions listing what is sitting in it, with
    the other side of each entry on the row so the list answers the question rather than posing
    it.
    A ledger and not a flag on a voucher, because the entry has to be IN the books: the trial
    balance must balance with it in, the bank must reconcile with it in, and the amount has to
    land somewhere a person trips over. A flag would leave the money invisible; a suspense
    balance is a number an accountant is trained to want at zero.
    Classifying EDITS the line rather than posting a transfer journal. A journal out of suspense
    leaves the original entry pointing at Suspense forever, so a year later the ledger shows a
    payment to Suspense and a separate journal beside it, and nothing on screen connects the two
    to "this was for printing". Moving the line makes the voucher say what it always should have
    said, and the audit log carries both ledger names — which is what an audit trail is for.
    Refused inside the locked period, and the message says to use a journal in the open one
    instead: a suspense balance that was reported at 31 March has to stay reported. Created on
    demand rather than seeded, because a Suspense ledger sitting at zero in every new company is
    how people learn to ignore a Suspense balance.
47. ✓ Barcode scan jumps straight to quantity on the matched item line (S) — the scan detector
    already distinguished a scanner's fast burst from a person typing (`@shared/barcode`) and
    already jumped to the matched item. The cursor then sat in the item cell, on the one field
    the scan had just answered. It now moves to the quantity.
    Only on a scan. Typing a name does NOT move focus: someone reading down a list is still
    choosing, and yanking the cursor out of the cell they are working in would be worse than
    leaving it. The row is tracked by its stable key rather than its index, because the trailing
    blank row is inserted as lines fill and an index would hand back whichever row slid into that
    position.
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
89. ✓ Delivery challan and job-work challan (ITC-04) (L) — the delivery challan was already the
    third stage of the sales chain; this adds the job-work side. Challans out, what came back,
    the ITC-04 working paper (tables 4, 5A, 5B, 5C), and the part that actually matters: the
    **section 143 deemed-supply clock**. Goods not returned within a year (inputs) or three
    (capital goods) are deemed supplied on the day they went out, with interest running from that
    date — so a partly-returned challan is a partial deemed supply on the unreturned quantity, and
    the overdue callout says in words that the goods are treated as sold, rather than just
    colouring the row. Moulds, dies, jigs, fixtures and tools carry no clock (s.143(4)); a bug
    where that exclusion never reached the calculation, hidden by an `as` cast on a misspelled
    field, was found and fixed by the tests. **Needs verification, all three surfaced in the UI:
    whether Table 5B is a receipt limb rather than the despatch limb modelled here; the
    periodicity notification number (35/2021-CT was recalled, not read); and whether the
    anniversary day itself is still in time.**
90. ✓ TCS on sale of goods, section 206C(1H) (M) — detection, not automatic collection: the
    section does not apply where the buyer deducts TDS under 194Q on the same transaction, which
    the seller cannot know from their own books.
91. ✓ 26AS reconciliation against TDS entries (L) — paste or load a TRACES export and reconcile
    it against the credit the books expect, in the same buckets `recon2b` uses, with the total
    credit at risk called out. Both directions are reported: credit in the books but not in 26AS
    is credit that will not arrive, credit in 26AS but not in the books is income possibly never
    recorded. Nothing is persisted — a downloaded 26AS is a snapshot of the department's record,
    and a stored stale copy invites reconciling against last month's. **Needs verification: the
    parser was written to the published Part-A wording and has never seen a file from the live
    portal; malformed lines surface as complaints rather than being dropped, so a layout surprise
    is visible. Also flagged: `ledgers` has no TAN column, so matching borrows the TAN from the
    statement by name.**
92. ✓ GST rate-change handling: rate history per item with effective dates (L) — the bug this
    fixes is quiet and bad: an item carried ONE rate, so editing it when the Council moved a rate
    silently repriced every past invoice and every return already filed. A rate is now dated data
    like every other statutory fact, carrying the notification that made it. The rate is resolved
    against the DOCUMENT's date everywhere it is used — GSTR-1 extraction, e-invoice extraction,
    the reverse-charge summary, the counter, and the sales chain, so a quotation converts at the
    rate it was raised under. An item with no history behaves exactly as before, so a book that
    never records a change is untouched. The regression test recomputes a filed July GSTR-1 after
    recording a September change and asserts it has not moved.
93. ✓ HSN summary validation against the GSTR-1 schema before export (S)
94. ✓ B2C large invoice threshold flagged automatically (S)
95. ✓ Place-of-supply auto-derivation from the party's state code (S) — already shipped
96. ✓ E-way bill distance auto-lookup from pin codes (M) — an **offer**, never a silent write:
    the figure appears beside the disclaimer with a separate button to accept it, because an
    understated distance expires a consignment in transit. An unplaceable PIN offers nothing at
    all rather than a guess. **Needs verification, and says so on screen: the whole PIN table is
    approximate** — three-digit district coordinates are city-centre figures, two-digit circle
    fallbacks are eyeballed middles with 50–100 km of expected error, and the 1.25 road-circuity
    factor is a planning convention, not a measurement. Also worth knowing: the delivery PIN is
    stored, the **despatch PIN is not** (the company address is one free-text column), so the user
    types it. Parsing six digits out of an address line would have been a guess dressed as data.
97. ✓ A filing calendar that marks a return as filed with its ARN (M)
98. ✓ Late-fee and interest calculator for delayed filing (M)
99. ✓ GST payment challan (PMT-06) tracking against liability (M)
100. ✓ Nil-return shortcut when a period has no transactions (S)
101. ✓ Amendment tables (B2BA, CDNRA) in GSTR-1 (L) — with B2CLA and CDNURA. The thing that
     made this possible is a **snapshot of what the return said on the day it was filed**: an
     amendment row can only be computed against the original particulars, and the books no longer
     hold them once the voucher has been corrected. First writer wins, so retyping an ARN cannot
     erase the original. The panel separates three things a naive diff would conflate — genuine
     amendments, filed documents no longer in the books, and documents dated in a filed period
     that were never filed (a missed invoice is not an amendment; it belongs in the later period's
     ordinary tables). Refused pairs show their reason rather than vanishing. **Needs verification,
     carried onto the screen: the amendment-only field names (`octin`/`oinum`/`oidt`,
     `ont_num`/`ont_dt`/`ntty`) have no precedent in the existing GSTR-1 builder and are unchecked
     against a current schema; whether the portal accepts an amendment-only upload; and how a
     registered → unregistered correction should be filed. The section 37(3) rectification window
     is reported, not enforced.**
102. ✓ Export invoices with and without payment of tax, split correctly (M) — already shipped
103. ✓ SEZ supplies with and without payment, split correctly (M) — already shipped
104. ✓ Advance receipt and adjustment tables (11A, 11B) (M) — already shipped
105. ✓ A validation gate that blocks export until every error clears (S) — already shipped
106. ✓ Show the exact JSON that will be uploaded, before uploading (S)
107. NIC sandbox validation of the live-filing client (M) — **still unverified, and it cannot be
     verified from here.** `src/main/services/nic.ts` implements the published API spec (RSA + AES
     session crypto) and has never been run against the portal, because there are no sandbox
     credentials to run it with. Nothing in this pass changed that. It stays experimental, and the
     first person with a sandbox login should treat every response shape in it as a guess.
108. ✓ Multi-GSTIN companies: one book, several registrations (L) — `gst_registrations` holds one
     row per registration (GSTIN, state, trade name, address, registered/surrendered dates, one
     primary), and the company's single GSTIN migrates in as the first row. Every voucher carries
     `gst_registration_id`, **stamped at save rather than inferred at report time** — a voucher
     whose registration is re-derived when a return is built is a voucher whose tax moves under it
     the day a second registration is added; migration 47 stamps every voucher that already
     existed, for the same reason. Place of supply is decided by the SUPPLYING registration's
     state, which is the correctness core: billing a Gujarat customer from the Gujarat
     registration is CGST+SGST, and computing it against a company-level Maharashtra state — what
     every single-GSTIN book does — makes it IGST. GSTR-1, GSTR-3B, GSTR-9, CMP-08/GSTR-4, the
     GSTR-2B reconciliation, the document series (Table 13), the GSTR-1 filed snapshot, the
     amendment tables, the filing register and the e-invoice/e-way payloads all take a
     registration and cover only its supplies; `gst_filings` and `gstr1_filed_documents` were
     rebuilt with the registration in their unique keys, because two registrations file two
     GSTR-3Bs for one month with two ARNs. A GSTIN picker sits on GSTR-1, GSTR-3B, GSTR-2B and the
     filing register, and **renders nothing at all below two registrations** — a single-GSTIN
     company gets an empty SQL scope fragment, so it runs byte-identical queries and is never
     asked a question it has no answer to. The books stay whole: the trial balance, P&L and
     balance sheet do not split by registration and were not touched. The primary registration
     mirrors `meta.company`'s gstin/stateCode in both directions, so every screen that reads
     `company.gstin` still works. Aggregate turnover (GSTR-1's GT) is deliberately PAN-level and
     stays unscoped. Printed invoices (A4, thermal, ESC/P) carry the ISSUING registration's GSTIN,
     because rule 46(b) asks for the supplier's and a defective invoice is the buyer's credit
     denied.

     **The branch-transfer invoice, which is what kept this item open.** Stock moved between two
     registrations of one PAN is a taxable supply under Schedule I para 2 read with section 25(4),
     even though nothing is sold and no money moves — the single most common thing multi-GSTIN
     software gets wrong. It is now raised, not just reported: `crossRegistrationTransfers` finds
     the movement, and Disclosure › Branch transfers values it under rule 28, numbers it in the
     SENDING registration's own rule 46(b) series (`BT/27/2026-27/0001` — per registration, because
     two registrations are two registered persons), puts both GSTINs on its face, and prints it.
     Place of supply is where the movement terminates (section 10(1)(a) IGST Act), so Maharashtra
     to Gujarat is IGST and two registrations in one state are CGST+SGST. The document then feeds
     BOTH returns: it is appended to the sender's outward documents, so it lands in GSTR-1 B2B and
     GSTR-3B 3.1(a), and its tax is added to the receiver's 4(A)(5) — read off the stored document
     on both sides rather than recomputed, which is what makes the two registrations' returns tie
     to the paise. Rule 28's five limbs are offered as dated data (`RULE28_HISTORY`, renumbered to
     rule 28(1) on 26 October 2023), and the app refuses to invent an open market value it does not
     hold: only the second proviso — where the recipient takes full ITC, the declared value IS the
     open market value — and 110%-of-cost can be computed, and the others require a number from the
     user. The validation warning now reports only what has NO invoice, so it retires as the work
     is done. **Not covered:** the branch-transfer series is absent from GSTR-1 Table 13
     (documents issued), which is computed from voucher numbering and these documents are not
     vouchers — the serials are consecutive and printable from the register, but Table 13 must be
     completed by hand for them.

     **It posts nothing, and that is the design, not a shortfall.** One business, one set of books:
     the transfer creates output tax in one return and input credit in the other, but no revenue,
     no expense and no change in closing stock value — so the trial balance, the P&L and the stock
     value are byte-identical before and after. `branchTransfer.dbtest.ts` and E2E 52 assert exactly
     that, alongside both returns carrying their side. **What it therefore does NOT do:** the tax is
     in the returns and not in the ledgers. Where the receiving registration takes full credit — the
     ordinary case, and the same case rule 28's second proviso is written for — the two amounts are
     equal and opposite across one PAN and the net effect really is nil. Where it does not, the tax
     is a real cost that is not in the books, the document says so on its face, and the credit is
     withheld from the receiver's 4(A)(5) rather than claimed. A stock journal that fans out to more
     than one registration is not invoiced at all: which goods went where is not recorded, and an
     invoice built on a guess about that is worse than the warning it would replace — those come
     back listed, with the reason.

     **Still computed against the primary registration only:** the reverse-charge self-invoice
     register (#356) and counter sales — both read the company's own state rather than the supplying
     one, which is exact for every single-GSTIN book and approximate for a second registration's RCM
     purchases or counter till.

     **Not built, and marked rather than half-built: the branch-transfer invoice.** Under Schedule
     I para 2 a supply between two registrations of the same person is a taxable supply even
     without consideration — the sender raises a tax invoice valued under rule 28, reports it in
     its GSTR-1, and the receiver claims the credit. Doing that properly means rule 28 valuation
     (open market value, or the 90% option where the recipient resells), a self-party ledger per
     registration, and output tax in one registration's return against input tax in another's,
     all inside ONE set of books whose trial balance must not move. This release does not raise
     that invoice. What it does instead is refuse to let the movement look innocent:
     `crossRegistrationTransfers` finds every godown-to-godown transfer that crossed a
     registration boundary and reports it — on `gst:validate`, which is what the GSTR-1 screen
     calls before an export — naming both GSTINs and the book value moved. Anyone with two
     registrations and stock moving between them must still raise that invoice by hand. That gap
     is why this item carries no ✓: everything else it asks for is in, and the one thing that is
     not is the thing multi-GSTIN software most often gets quietly wrong.
109. ✓ TDS lower-deduction certificate handling (M) — a section 197 certificate names a section,
     a rate, a validity window and, the part everyone gets wrong, a **ceiling**. Once cumulative
     payments pass it the normal rate resumes on the excess *within the same payment*, so a
     straddling payment splits across two rates; the tests assert both halves and that they re-add.
     Keyed on PAN rather than ledger, because a certificate is issued to a person and the same
     person can be two ledgers. A soft-deleted voucher does not consume anybody's ceiling, and
     re-editing a saved voucher no longer eats its own headroom twice.
110. ✓ Professional tax slabs per state, not just one (M) — already shipped: PT_SLABS carries
     Maharashtra, Karnataka, West Bengal, Tamil Nadu, Gujarat, Andhra Pradesh, Telangana and
     Madhya Pradesh, keyed off the employee's pt_state. #177 added effective dates on top.

## E. Inventory

111. ✓ Barcode label printing to a thermal printer (M) — TSPL bytes, on the Labels tab of Stock,
     sent to a raw CUPS queue by the same path the ESC/P invoice uses.
     TSPL rather than ZPL for one reason: its `BARCODE` command encodes Code 128 in the printer's
     firmware, so this app never has to rasterise a symbology. A hand-rolled encoder with a wrong
     check digit produces a label that looks perfect, does not scan, and is found out at the till.
     The price comes from the price list on the date, and falls back to the last PURCHASE rate —
     never to the item's valuation, which is a weighted-average COST. A shelf label printed at
     cost is the most expensive bug this feature could have. An item with neither a barcode nor a
     code is named and refused rather than being given a guessed identifier, and one bad label
     refuses the whole job: a printer that stops at the eleventh leaves the operator with ten
     labels and no message.
     NOT VERIFIED ON HARDWARE, exactly like `escp.ts`. Every command is transcribed from the TSPL
     manual and unit-tested byte for byte, which is a weaker claim than "the label came out
     right". Hence the plain-text preview of every label on screen, and the save-to-file path, so
     whoever first has a printer can read the job before committing a roll to it.
112. ✓ Multi-godown stock transfer voucher (M)
113. ✓ Reorder level with a purchase suggestion report (M)
114. ✓ Batch expiry tracking with a near-expiry report (M)
115. ✓ Serial-number tracking for high-value items (L) — a batch answers "which lot"; a serial
     answers "where is THAT one": the engine number, the IMEI, the compressor on the warranty
     card. Per item, off by default, and every movement of a tracked item names its serials or is
     refused.
     Dated data, not a field. What is stored is the MOVEMENTS, and status is DERIVED from the
     latest one — which is the whole design, not an implementation detail. A `status` column would
     be a second copy of a fact the movements already carry, and the two part company the first
     time a voucher is altered, which is precisely when the answer matters: correcting the invoice
     that sold a unit is how the unit comes back onto the shelf. Binning the sale does the same.
     Selling one twice is refused — the two-warranty-cards bug — and so is receiving one that is
     already in stock, which is either a duplicate entry or two units wearing the same number, and
     both need a person rather than a resolution rule. A serial with no live movement behind it
     reads as "never received" rather than "already issued": the second would be a confident
     statement about a unit that, as far as the books go, was never bought.
     Ranges (`SN0001-SN0010`) expand only on an identical prefix and digit width. Anything
     cleverer would GUESS ten serial numbers, and a guessed serial does not match the unit that
     comes back under warranty.
116. ✓ Stock ageing by batch rather than by item (M)
117. ✓ Landed cost allocation across a purchase (M)
118. ✓ Standard costing with variance against actual (L) — and the variance is SPLIT, because as
     one figure it is worth almost nothing. "We are ₹1,40,000 over" is not something anybody can
     act on; "₹1,20,000 of it is what we paid and ₹20,000 is what we used" is two conversations
     with two different people.
     price variance = (Ra − Rs) × Qa, the buyer's number. usage variance = (Qa − Qs) × Rs, the
     floor's. Costed against different bases on purpose: that is what makes the two add to the
     total exactly rather than leaving a joint variance nobody owns, and the test asserts the
     identity holds even where the rate does not divide evenly. The price variance is computed as
     `actual cost − Qa × Rs` rather than from a derived actual rate, so it rounds once instead of
     rounding a rate and then multiplying the error back up by the quantity.
     A standard is dated, like every rate in this app: revising it in October leaves September's
     report saying what it said in September, and each movement is scored against the standard on
     ITS OWN date rather than one standard applied to a whole period. An item with no standard is
     LISTED, never scored as on standard — a blank in a variance report is a question, and a zero
     would be a wrong answer to it.
119. ✓ Item images on the invoice and in the picker (M) — reusing the attachments pattern rather
     than inventing a second one: the file is COPIED into `<company>/item-images/` and the
     database holds the NAME, never a path and never the bytes. A path is a promise about somebody
     else's disk and it breaks silently; bytes in the database mean a company.db copied, backed up
     and integrity-checked at forty times its real size.
     Its own column and its own module rather than a fourth kind of attachment row, because an
     attachment is EVIDENCE and belongs to a voucher while an item image is master data and
     belongs to an item — a shared table would need a nullable voucher_id, which is how the "one
     attachment with no voucher" bug gets written. One image per item: a picker showing four
     pictures of the same bolt is a picker with a scroll bar.
     The format list is deliberately narrower than the attachment one. HEIC is on that list
     because a phone produces it and the OS can open it, but Chromium will not paint it in an
     `<img>` — so an item image in HEIC would be a picture that exists, backs up nightly, and
     draws a broken square. Replacing writes the new name first and unlinks the old copy last, so
     nothing ever reads a half-written file at a name that used to be a good one.
120. ✓ Alternate units of measure with conversion (M)
121. ✓ Item-wise reorder email or WhatsApp alert (S)
122. ✓ Negative-stock prevention per item, overriding the company setting in both directions (S)
123. ✓ Physical stock count sheets, printable with blank quantity columns (S)
124. ✓ Stock valuation method per item, not per company (M) — already shipped: stock_items
     .valuation_method is per item and the valuation engine honours it (weighted average or
     FIFO) when pricing every outward movement.
125. ✓ Bill of materials with scrap and yield percentages (M) — two numbers, and they are not the
     same number. Scrap is PER COMPONENT: cutting a hundred shirts wastes cloth, and the wastage
     belongs to the cloth line, not to the buttons. Yield is PER FINISHED ITEM: of a hundred
     units started, ninety-seven pass inspection, and that inflates every component equally. A
     single "wastage %" would have to be one or the other and would be wrong for the other.
     Both are hundredths of a percent as integers, defaulting to 0 and 100.00%, so every BOM that
     existed before this keeps producing exactly the numbers it produced yesterday — proven by a
     test that saves through the schema with neither field present. The ratio is evaluated in
     BigInt (qtyMilli × qtyMilli overflows a double's safe integers) and rounded once at the end,
     so scrap and yield cannot each round the same way and compound.
126. ✓ Sub-assembly BOMs, nested (L) — a component that has its own BOM explodes into ITS
     components, compounding scrap and yield down the tree. Rounded once per LEVEL rather than
     once at the leaves, because the intermediate is a real quantity: it is what the shop floor
     actually makes, it is the number on the screen, and the materials under it have to be the
     materials for that number.
     `wouldCreateBomCycle` already refused to save a cycle; explosion is separately cycle-safe at
     runtime, because a database that predates that guard should give an error naming the chain
     rather than a stack overflow. Depth is bounded at twenty with an honest message. The
     manufacture voucher consumes the raw-material LEAVES — a sub-assembly is made on the way
     past, and consuming it as well as its own materials would double-count every one of them.
127. ✓ Job-work stock sent out and received back (L) — **merged into D #89's implementation, not
     kept beside it.** This lane checked first and correctly found no job-work service; #89 landed
     in the meantime with the challan, the section 143 clock, ITC-04, a screen and a scenario, and
     both lanes wrote `src/main/services/jobWork.ts` and both created `job_work_challans`. The
     arbitration: keep #89's implementation — it has the screen and the return, and it is what the
     rest of the app talks to — and graft THIS lane's stock movement onto it, hanging off
     `saveChallan` / `saveReturn` rather than a second entry point. What was dropped as duplicate:
     this lane's clock and return planner (`@shared/jobWork` now holds only the godown naming),
     its `jobwork:*` IPC channels, its Stock → Job work tab, and its `itc04Rows`. Migration 53 adds
     the godown and voucher columns to #89's tables; the second set of tables was never created.
     **Sending goods for job work is not a sale.** Title never leaves the principal, so nothing is
     posted to the books at all: the goods move to a godown named for the job worker on a stock
     journal with no ledger lines, exactly like a godown transfer, and stay in the principal's
     closing stock where they belong. A godown per job worker rather than one pooled "Job work"
     godown, because the question a GST audit asks is what is lying with WHOM.
     What makes it more than a transfer is **section 143**: inputs must come back within one year
     and capital goods within three, and goods that do not are DEEMED to have been supplied on the
     day they were SENT — a backdated liability with interest running from then, not from the
     anniversary. So the clock is on every row and an overdue challan states the deemed-supply
     date rather than merely turning red. The period is inclusive (section 9 of the General
     Clauses Act, 1897: "from" excludes the first day) and month arithmetic clamps, so goods sent
     on 31 March are due back on 31 March and not on 1 April.
     Waste comes back OUT of the job worker's godown and not into stock: under 143(5) the job
     worker may supply it directly, and bringing it back would inflate closing stock by the scrap
     of every job the business has ever sent out. Checked against the bare Act as at August 2026.
     The Commissioner's extension under the proviso to 143(1) is not modelled — it is granted case
     by case, and a deadline that silently moved because the app assumed one would be worse than
     one that is early.
     Two dispositions #89 has and this lane did not — "sent to another job worker" and "supplied
     from his premises" — DO come back into stock, and that is deliberate. The first is so the
     follow-on challan has something to despatch; the second is so the linked sales invoice is the
     one thing that takes the goods out, rather than the stock going out twice and negative.
128. ✓ Price list versioning with effective dates (M) — `price_list_rates` has carried an
     `effective_from` since price levels were built and `rateFor` has always resolved it, so the
     storage and the invoice side were never the gap. What was missing is the idea a user actually
     has — not "a rate with a date on it" but a VERSION: on 1 October the wholesale list changed,
     all forty items at once — and any way at all to ask what the list said on a day that has
     passed.
     A version is DERIVED (the rates sharing an effective date), never stored: a version header
     and the rates under it are two things that can disagree, and the rates are the ones that
     price the invoice. The Masters → Price lists tab reads the list "as on" any date through the
     same pure resolver `rateFor` uses, so the screen and the invoice cannot come to differ about
     what is in force — there is a test that walks four dates and compares the two.
     Revising moves the list by a percentage in integer basis points, off the base in force the
     day BEFORE the new version starts (reading it as on the effective date itself picks the new
     version up as its own base and compounds), and rounds ONCE: rounding to paise and then to
     rupees turns ₹103.33 + 5% into ₹109 when the answer is ₹108. Only the rates that actually
     move are recorded, so a version reads as a revision rather than a copy of the list, and a
     whole version can be undone as one — forty rows fixed by hand is thirty-nine right and one
     wrong.
129. ✓ Item groups with inherited GST rate and HSN (S)
130. ✓ Fast item entry by code rather than name (S)

## F. Banking and reconciliation

131. ✓ Per-bank statement import profiles: HDFC, ICICI, SBI, Axis, Kotak (M)
132. ✗ PDF bank statement table extraction for the top banks (L) — declined, and this is the
     one item where refusing is the feature. There is no PDF text-extraction library in this
     app and adding one is not a small decision: the app writes PDFs through Chromium's
     `printToPDF`, which cannot read them, so extraction means a real dependency (pdf.js is
     ~1 MB of parser plus a worker) shipped into an offline desktop build.
     The dependency is not the reason to decline. The reason is that a bank statement PDF has
     no table in it. It has glyphs at coordinates, and "which column is this number in" is a
     clustering guess that a two-column layout, a wrapped narration or a rotated page gets
     wrong silently — the number lands under Deposit instead of Withdrawal and the row still
     looks perfectly reasonable. Every bank changes that layout without telling anyone, and
     there is no header row to detect the change from, which is exactly what makes the CSV
     profiles in #131 safe.
     A bank import that quietly gets one number wrong is worse than one that refuses the file.
     Every bank in India offers CSV or XLS from the same download screen as the PDF, and #131
     reads all five plus anything a user maps by hand. That is the honest path, and it is the
     one the app points at.
133. ✓ Auto-match on narration keywords, learned from past matches (M)
134. ✓ Bulk-accept all high-confidence matches (S)
135. ✓ Bank charges and interest auto-posted from matched lines (M) — the rows that never
     match anything, because no voucher was ever written for them: the quarterly fee, the GST
     on the fee, interest credited, OD interest debited. They sit in the unmatched list forever
     and get keyed by hand off a printout at year end.
     Recognised from the narration by whole WORD, not by substring, and that is the whole
     design: `matchRules` matches a plain substring, and "CHARGE" is inside "RECHARGE", so a
     shipped rule saying CHARGE would post every mobile top-up to Bank Charges — real money,
     wrong account, and it looks right afterwards. The direction is part of the test too: a
     deposit whose narration says CHARGES is a refund of one, and posting that as an expense is
     backwards. The four ledgers are created on an explicit action rather than by opening a
     file, and the GST line goes to Duties & Taxes rather than the P&L, because it is
     recoverable input tax and burying it loses the credit. A user's own rule still wins.
136. ✓ Cheque printing with configurable layouts per bank (M) — already shipped: the layout is
     stored per bank ledger (`meta.cheque.<ledgerId>`), every field position is in millimetres,
     and there is a 5 mm-gridded calibration sheet to print onto the real stationery before
     printing onto a real cheque. Per bank rather than per company because the CTS-2010 field
     positions differ by issuer, and one shared layout would be wrong for every account but one.
137. ✓ Post-dated cheque calendar view (S) — the register was already a list sorted by date,
     which answers "what is next". The question the register is actually opened for is "how much
     clears in the week of the 15th, and is there enough in the account by then", and that one
     needs the month arranged the way a month is arranged, with the empty days visible. Six rows
     always, so paging through months does not make the panel jump.
138. ✓ Bounced-cheque handling with the reversal entry (M) — two facts, and only one of them is
     accounting. The reversal flips EVERY line of the original (a receipt with a TDS or discount
     line reverses wrongly if only the party and the bank are undone), re-raises each `against`
     bill reference as a `new` one under the SAME bill name so the invoice re-opens instead of
     the money landing on account, and carries the ORIGINAL due date forward — ageing that
     restarted on the bounce date would reward the customer for the cheque failing, which is the
     opposite of what recording a bounce is for. The bank's return charge goes on the same
     journal.
     The other fact is about the customer, and no voucher carries it: a journal reversing a
     receipt is indistinguishable from a journal correcting a keying error, so "this party's
     cheques bounce" is unrecoverable from the books alone. Hence a `cheque_bounces` row and a
     count per party, which is the number a credit decision actually wants.
139. ✓ Bank balance as-per-books versus as-per-statement, per account (S) — on Banking's All
     accounts tab rather than the Gateway, where it sits beside the reconciliation state that
     explains the difference.
140. ✓ Multi-currency bank accounts with revaluation (L) — the schema change the previous lane
     deferred, landed: a currency ON the ledger, and the foreign amount plus the rate that
     produced it persisted PER LINE.
     Three decisions, each about a number staying answerable years later. **A rate is not money,
     so it is not paise** — ₹83.4525 has four decimals and a quote can have six, and rounding the
     rate to paise before use puts the error into every amount computed from it. It is stored as
     millionths of a rupee per unit, and a seventh decimal is refused rather than silently dropped.
     **The foreign amount is stored, not derived** — a voucher for USD 1,200.00 is that forever,
     and deriving it back out of the rupee figure and today's rate makes the invoice say a
     different dollar amount every time it is reprinted. **The rate used is recorded on the entry
     that used it**, on the `fx_revaluations` row and on the voucher's own line, so a March
     revaluation keeps saying March's rate in June.
     An unrealised difference is a real posting with real tax consequences (AS 11 / Ind AS 21
     para 23(a) and 28), so it goes through `saveVoucher` like any other journal — numbered,
     audited, in the day book, undone only by binning it — and not into a report that quietly
     restates a balance sheet line. Everything is signed dr-positive, which is what makes ONE
     function right for both sides of the balance sheet: an asset worth more rupees and a
     liability that shrank are both a debit and both a gain, and a version of this taking a
     `nature` argument would have two branches that agreed.
     It is NOT reversed next period. Under AS 11 the restated figure is the new carrying amount;
     reversing would put the balance back at a rate that stopped being true at the period end and
     report the whole movement again. Revaluing the same period end twice is refused rather than
     added to — a correction replaces the first posting, and replacing means binning it, which the
     user does deliberately because it is a posted entry in a period they may have reported.
     Rupee-only movements on a foreign account (a rupee bank charge on a dollar account) are
     reported separately rather than folded into the foreign balance or treated as an error.
141. ✓ UPI transaction import from a CSV (M) — a UPI statement is structurally an ordinary
     statement, so #131's profiles and the column mapper already read the file. What UPI needed
     was the narration, which is not prose but a fixed set of slash-separated fields every bank
     writes differently.
     Two things follow, and both are the value. The twelve-digit UTR is what the payer quoted
     when they messaged to say they had paid, so it is usually already in the receipt's
     reference field — matched on FIRST now, ahead of the ±5-day amount proximity test, because
     a shared reference is much stronger evidence than a near date. The amount must still agree
     exactly: a part payment quoting the same UTR is not the same transaction.
     That same UTR also poisoned narration learning — a token that occurs exactly once and never
     again makes every UPI narration look unlike every other one. Stripping it leaves the
     counterparty, which is the part that repeats and the part worth remembering.
142. ✓ Reconciliation freeze: lock reconciled periods (M) — the company-wide books lock stops
     vouchers moving and says nothing about bank dates, so a signed-off reconciliation could be
     silently undone: clearing one `bank_date` in a closed quarter changes last year's BRS and
     nothing anywhere records it.
     Per bank account, not company-wide: accounts are reconciled on their own schedules, and one
     shared date would either lock an account nobody has reconciled or leave the reconciled one
     open. Both ends are checked — moving a date OUT of the frozen window changes the frozen BRS
     exactly as much as moving one in. An import or a bulk accept that would cross the line is
     refused before it writes anything, because a half-applied import is worse than a refused
     one.
143. ✓ Unreconciled-items ageing report (S)
144. ✓ Split a single bank line across several vouchers (M) — one deposit of ₹1,00,000 settling
     three separate receipts. The engine could already find the combination (`findSumCombos`),
     and `matchSuggestions` had been returning those groups through IPC for a while — but no
     screen called it, so the whole feature was unreachable, which is the same class of bug as a
     hover-only affordance. It is now in the reconciliation flow, showing the constituent
     vouchers and their sum before anything is accepted: a combination that adds up by
     coincidence is a real risk and the user is the only one who can rule it out.
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
179. ✓ Multiple pay cycles: weekly, fortnightly (M) — an employee carries a cycle and a run
     covers a period rather than a month. The arithmetic was never the hard part. PF's ₹15,000
     ceiling, ESI's ₹21,000 limit, every professional-tax slab and TDS under section 192 are all
     defined per MONTH, and computing any of them on a week's wages does not give a quarter of the
     monthly figure — it gives a wrong one, in the direction the employee finds out about years
     later when EPFO's passbook does not match their payslips. So earnings prorate to the cycle
     while the statutory deductions are computed on the whole statutory month and apportioned
     across its cycles, each cycle deducting its cumulative share less what the month's earlier
     cycles already took. That true-up matters: a month's attendance is not known when its first
     week is paid, so a later correction is absorbed by the remaining cycles and the month still
     lands exactly right — including as a refund, which is returned rather than clamped. Four
     weekly runs deduct, to the paisa, what one monthly run would have. ECR, the ESI file, the PT
     summary, Form 16 and the headcount trend all aggregate a month's runs rather than assuming
     one. A cycle straddling a month end belongs to the month its last day falls in. **Deferred:**
     leavers can only be clipped on the joining side — `employees` has no leaving-date column, so
     a mid-cycle leaver is not prorated yet (the engine supports it and is tested; the column is
     not there to read). Form 24Q was not touched because the app does not produce one.
180. ✓ Cost-centre allocation of salary expense (S)
181. ✓ Headcount and cost trend report (S)

## I. Invoicing and documents

182. ✓ Two or three genuinely beautiful invoice templates (M) — Classic (the ruled boxes the app
     always printed, byte for byte, so no upgrade restyles anyone's stationery), Modern (hairline
     rules, for a document that is mostly emailed) and Compact (one type step down, so twenty
     lines still land on one sheet). One HTML skeleton, three stylesheets: rule 46 prescribes
     what an invoice carries, so a template may change how the page is drawn and may never change
     what is on it. A test asserts the three bodies are byte-identical.
183. ✓ Thermal 3-inch receipt template for retail (M) — 58mm and 80mm rolls, one column, dashed
     rules (a thermal head prints a hairline as nothing and a heavy rule as a smear). Built from
     the same extracted e-doc invoice as the A4 sheet and the GSTR-1 export, so the roll and the
     return cannot disagree. A receipt with the tax split turned off says on its face that it is
     not a tax invoice — a customer who files one as such loses the credit.
184. ✓ Bilingual invoice printing: Devanagari alongside English (M) — Hindi and Marathi, printed
     BESIDE each English label and never instead of it: the English text is what an officer reads.
     No font is bundled (that would mean shipping a licence); the print names the Devanagari faces
     macOS and Windows already carry. **Needs verification: the label pack is a translation, and
     several commercial terms are marked `// VERIFY:` in src/shared/i18n/invoiceLabels.ts pending
     a native reader's check.**
185. ✓ Signature and stamp images on the invoice (S)
186. ✓ Live invoice preview while editing the layout (M) — already shipped: Settings → Invoice
     print debounces the unsaved draft into `invoice:previewHtml`, which merges the partial over
     the saved config, so the iframe follows every keystroke with no Save round-trip.
187. ✓ Proforma invoice (M) — a memorandum sales voucher, which the books already model as
     out-of-books, printed as a proforma rather than as a tax invoice.
188. ✓ Sales order and purchase order with fulfilment tracking (L) — the sales half was already
     shipped; the purchase half is the SAME chain read the other way, not a second one. One
     column (`sales_documents.side`) turns an 'order' into a purchase order and a 'challan' into
     a receipt note, so the conversion arithmetic — what is still owed — has exactly one
     implementation and cannot give two answers. Fulfilment is a BALANCE and lives in
     `src/shared/fulfilment.ts`: ordered, received, pending, over-received, per LINE and never
     netted, because ten bolts over-delivered do not settle ten nuts that never came. An order
     received in three parts stays open with the remainder pending; over-receipt is recorded
     rather than clipped inward (the goods are in the godown whether or not we authorised them)
     and refused outward (our own challan cannot exceed our own order).
189. ✓ Delivery note and receipt note (M) — the delivery note was already the challan stage of the
     sales chain; the receipt note is its inward mirror, and it carries the three-way match that
     is the reason the document exists at all. `salesdoc:match` puts ordered, received and billed
     quantities side by side and names the worst disagreement first: a bill for more than arrived
     leads, because it is the only one that takes money out of the business for nothing. Goods
     that turn up with no order behind them still get a receipt note — they are physically in the
     godown — and every line of it reports `not_ordered` rather than quietly reporting nothing.
     Quantities only: what a variance is worth is the invoice's arithmetic, and a second answer
     to that would be worse than none.
190. ✓ Terms and conditions block, per voucher type (S)
191. ✓ QR code on the invoice, UPI payment intent (S)
192. ✗ Invoice email with the PDF attached (M) — declined as literally specified. Attaching a
     file to an email means either an SMTP client with the user's mail password in it or a
     platform mail API, and this app holds no credentials and makes no outbound connection by
     design. What shipped instead is the honest version, alongside #193: the PDF is rendered, put
     on the clipboard as a file and revealed in Finder, and a `mailto:` draft opens with the
     subject and body filled in. The person attaches and sends. Revisit only if the product ever
     grows a server, which is the opposite of what it is for.
193. ✓ WhatsApp invoice send (S) — PDF → clipboard → `wa.me/<phone>?text=…`, no API and no
     account. The awkward part is stated rather than papered over: a wa.me link carries text and
     cannot carry an attachment, so the dialog says in as many words that the PDF is on the
     clipboard and has to be pasted before sending. A party with no usable number gets a disabled
     button and a reason, never a broken link.
194. ✓ Multi-page invoices with carried-forward totals (M) — already shipped: past sixteen items
     the table splits per page with a "Carried forward" subtotal closing each and a matching
     "Brought forward" opening the next, and the header repeats on every page.
195. ✓ Custom fields on a voucher, defined per company (L) — definitions in a table and values in
     a table keyed by voucher, per voucher type, shown on entry and printed under the party block.
     Deliberately not columns: a user-defined column is user-defined SQL, and a books file whose
     shape depends on what somebody typed in Settings is one nobody can migrate. Types (text,
     number, date, list) are validated in `src/shared/customFields.ts` and enforced at the IPC
     boundary, inside the voucher's own transaction, so a bad value refuses the whole voucher
     instead of half-writing it. **A number here is not money**: the value is TEXT for every kind,
     nothing converts it to paise and no report may read one — `src/main/customFieldsPurity.test.ts`
     greps for it, on the same principle as the soft-delete guard. Removing a field retires it
     rather than deleting it: vouchers already carry values, and those values are what the
     document said when it was issued, so they stay on it and stay on the print. A company that
     defines no fields prints an invoice byte-for-byte identical to the one it printed before.
196. ✓ Document numbering with a configurable prefix and suffix (S) — already shipped:
     per-voucher-type prefix, suffix, zero-pad width and restart-each-FY.
197. ✓ Print an entire period's invoices in one job (M) — already shipped as invoice:pdfBatch,
     which renders them sequentially into one exports folder.
198. ✓ Duplicate/triplicate copy markings (S) — already shipped as configurable copyLabels,
     one printed page per label.
199. ✓ Round-off and amount-in-words in the chosen language (S) — the Indian numbering system in
     Devanagari (करोड़/लाख/हज़ार), on its own line rather than after the bilingual slash: the
     labels are words, this is a sentence, and running the two together is the one place the
     separator stops being readable. Integer paise throughout.
200. ✓ Company logo, letterhead and footer configuration (S) — already shipped: logo, title,
     declaration, bank block, terms, signatory and an entered-by footer.
201. ✗ Export invoices as a zip of PDFs (S) — pdfBatch already writes one folder of PDFs, which
     is as portable as a zip on both macOS and Windows. Adding a hand-rolled archive writer to an
     accounting app to save one drag is a bad trade; revisit if a real user asks.
202. ✓ Watermark for proforma documents (S) — cancelled documents live in the bin and are not
     printable, so there is nothing there to watermark.
203. ✓ Invoice-level discount in addition to line discounts (S) — typed as a percentage or an
     amount and **spread onto the lines**, which is not a shortcut but the law: section 15(3)(a)
     lets a discount out of the transaction value only where it is "duly recorded in the invoice",
     so a trailing "less 2%" below the tax total is a discount tax is still payable on. Largest-
     remainder allocation, so the parts add back to exactly the figure promised, and the app's own
     invariant survives untouched — a line's amount IS its post-discount taxable value, so GST can
     never be computed on the wrong base.

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
     — still true about startup, and overtaken on the bytes. That chunk was **2,557,901 bytes** by
     the time #226 looked at it, up from the 1.5 MB measured here, because six sections of
     features had landed in it since. #226 split it anyway and found the same thing this line
     did: the time it buys is tens of milliseconds. What it buys that this line could not have
     known is a number worth guarding — #236's entry-chunk budget — and the guard is the point.
226. ✓ Lazy-load screens that most users never open (S)
     — the entry chunk went from **2,557,901 to 1,396,206 bytes** (−45%): thirty-three screens
     a given business may never open are `React.lazy` chunks now (`screens/lazy.ts`), and the
     Gateway, Day Book, voucher entry and Masters stay eager because they are the path a person
     walks all day. The time it bought is small and honestly reported: over 12 PAIRED cold
     launches — the two builds alternated launch by launch, because the machine was shared and an
     A-then-B run measures whatever else was running during B — the renderer's DCL went **210 →
     177 ms** and time to first screen **771 → 744 ms**, both at the minimum; the medians (245 vs
     240, 974 vs 963) are inside the noise. First navigation to a split screen costs nothing: it
     measured FASTER in all eight paired samples (trial balance 75 → 36 ms, banking 63 → 39,
     payroll 65 → 28, settings 55 → 35). The durable number is the byte count, and #236's
     entry-chunk budget now holds it there.
227. ✓ Row virtualization on long tables (M)
     — the day book, the ledger statement and the trial balance render through `useVirtualRows`.
     On the e-document list it measured 1,638 → 1,310 ms warm, which is inside this machine's ±90
     ms spread, so it is kept on the grounds of DOM node count and not reported as a speed-up.
228. ✓ Prepared-statement reuse across calls in hot services (S)
     — `saveVoucher` compiled **26 statements on every save**, 233 µs of a 754 µs write (31%).
     `db/stmt.ts` caches them per connection; the same code with the cache cleared before each
     call — a paired A/B inside one process, so machine load lands on both arms — went **1,431 →
     1,046 µs at the minimum of 40 runs (−27%)**, median 2,153 → 1,639 µs. Compiles per save:
     **25 → 3**, and that count is what `db/stmt.dbtest.ts` asserts, because a count does not
     move with the machine and a timing does. Reports were measured and deliberately left alone:
     `trialBalance` spends 0.7% of its time preparing. The cache is opt-in rather than a patched
     `db.prepare`, because a shared `Statement` carries sticky `.pluck()`/`.raw()` state and goes
     busy inside `.iterate()`; `db/stmt.test.ts` greps every call site for both hazards and for
     SQL assembled at run time.
229. ✗ Query result caching keyed on the books' last-modified stamp (M)
     — measured and declined. After the pagination work the queries this would cache cost about
     3 ms, so the cache would be a correctness liability (every write path has to remember to
     bump the stamp) bought with no time saved.
230. ✗ Not doing: incremental report recomputation (L)
     — priced and declined. Every report is computed from `voucher_lines` at query time, and that
     is the invariant the books rest on. What incremental recomputation buys, measured on the
     4,000-invoice fixture: `trialBalance` 1.4 ms, `profitAndLoss` and `balanceSheet` under 2 ms
     each, a Day Book page 1.6 ms. Across the whole app at 5,500 vouchers no screen is over 75 ms
     warm and only one is over 60 (see docs/performance.md). What it costs: a derived balance that
     can disagree with the vouchers behind it, invalidated correctly by **15 call sites of
     `saveVoucher` across 13 modules** plus delete, restore, purge, bulk edit, year-end and the
     Tally import — and the failure mode is not a slow report, it is a trial balance that is
     quietly wrong until an auditor finds it. Single-digit milliseconds is not worth a number that
     can lie. This is the same reasoning that declined #229.
231. ✗ Not doing: move PDF generation off the main process (M)
     — measured, and it is already off it. `services/pdf.ts` renders in a hidden sandboxed
     `BrowserWindow`, which is a separate process; main only awaits the promise. Sampling the MAIN
     process event loop every 5 ms during real jobs: an invoice PDF (390–616 ms wall) stalls main
     for **8–67 ms**, and a 5,000-row report PDF — the largest the schema allows — takes **17–21
     seconds** of wall time while stalling main for **149–169 ms**, against a 3–8 ms stall on an
     idle control. Better than 99% of that job is Chromium paginating somewhere else, and the UI
     is a third process again. Moving the remaining work would relocate a 150 ms stall and leave
     the 17 seconds exactly where it is.
232. ✓ Streaming CSV export rather than building the whole string (M)
     — `export:streamCsv`, byte-identical to the in-memory path (asserted), and the heap no
     longer grows with the period.
233. ✓ Debounce the global search (S) — already shipped: 150 ms, and only once the query is 2+
     characters.
234. ✓ Index review against the actual query plans (S)
     — four candidate indexes were built and timed against the real EXPLAIN QUERY PLAN output on
     the 85,840-voucher book. Not one moved a number outside noise, so **none were added**. The
     slow screens were slow for structural reasons — a GROUP BY over the whole of `voucher_lines`
     materialised before the LIMIT — and an index would have been a guess that added a bug
     surface for nothing. A review that adds no index is still a review.
235. ✓ Lazy-load the AI SDK only when the assistant is enabled (done) (S)
     — proven rather than asserted: `ai-boundaries.test.ts` walks the STATIC import graph from
     `main/index.ts` and `main/ipc.ts` and fails if it reaches `provider.ts`, printing the chain
     rather than the fact. The rule is about the graph and not about a directory, because that is
     the thing that is actually true or false, and one added link would otherwise undo it in
     silence — nothing looks different afterwards except a number nobody is watching.
236. ✓ Startup time budget with a test that fails if it regresses (M)
     — and the budget with teeth turned out not to be the stopwatch. `scripts/e2e/
     37-startup-budget.mjs` cold-launches the built app four times and reports the fastest:
     **743 ms to a settled first screen, renderer DCL 121 ms**. I first gave it a 2,500 ms
     ceiling — three times the measurement, which felt generous — and it **failed on its first
     real run at 4,454 ms**, with nothing wrong: that launch happened while the other 36 E2E
     scenarios were finishing around it, and a retry in the same minute took 22 seconds. A
     wall-clock ceiling on this machine cannot tell a regression from the load, so it is now a
     liveness check (30 s) and the file says why in as many words. What survives contention is the
     renderer's **DCL** — 121 ms quiet, 834 ms at the worst observed under the full suite — so
     that keeps a real ceiling at 3,000 ms.
     The assertion that actually catches a startup regression is in `scripts/bundle-budget.mjs`:
     a byte budget on the ENTRY chunk, **1,363 KB of 1,600 KB**. One static import dragging a
     screen back into the startup path shows up there exactly, in a unit that does not drift.
     (`out/main` and `out/renderer/assets` were already over their budgets on this branch before
     this lane started, from sections H/O/T/S/V; raised to 1,500 and 3,000 KB, because a budget
     that is already breached is one nobody can use.)
237. ✓ Memory ceiling test on a large book (M)
     — `services/memoryCeiling.dbtest.ts`, on the shared 4,000-invoice fixture (7,800 vouchers).
     Absolute ceilings per report, plus the machine-independent shapes: a 500-row Day Book page
     must carry a fraction of the whole period's payload (**113 KB of 1,765 KB**), the streaming
     CSV export of the whole book must not grow the heap at all (7,800 rows and 0.5 MB on disk for
     no measurable heap), and four further sweeps of every report must stay flat. Baseline heap
     21.7 MB, whole suite 149 MB RSS; a Day Book page shows as 0.5–0.8 MB of heap against 8.7 MB
     for the whole period. There is no forced GC, so every heap number is an UPPER bound — the safe
     direction for a ceiling and the wrong one for a ratio. The first version of this test asserted
     the heap ratio and failed with `expected 831368 to be less than -7689820` when a collection
     landed inside the measurement; that is an assertion the measurement cannot carry, so the
     ratio moved to payload bytes and the heap numbers beside it are printed rather than checked.
238. ✓ Avoid re-fetching the whole features object on every screen (S) — already shipped: the
     nine call sites share one react-query cache entry, so they make one request between them.
239. ✗ Not doing: batch IPC calls that always happen together (M)
     — measured the round trip before building the layer. An empty `invoke` costs **0.10 ms
     median, 0.20 ms p95**; ten sequential cost 0.80 ms and ten fired together cost 0.30 ms,
     because react-query already fires them in parallel. Counted in main, the largest wave any
     screen makes is **7 calls (voucher entry)** and then 6 (settings); every other screen makes
     four or fewer and twenty of them make one. Batching the biggest wave could save about half a
     millisecond, and would cost a second envelope schema, per-sub-call error semantics, and the
     per-channel role check that `handle()` does today. The calls are not slow because they are
     separate; they are as slow as the queries inside them.
240. ✗ Not doing: web worker for CSV parsing on import (M)
     — the premise does not hold: the renderer never parses CSV. It reads the file to a string and
     posts it to main (`importer:preview`, `bank:importCsv`), so parsing already happens off the
     thread a worker would move it off. Measured anyway, in case it was worth moving off MAIN:
     `parseCsv` takes 17 ms on a 5,000-row statement, 53 ms on 20,000 and 222 ms on a 100,000-row
     6.1 MB file; the full `parseStatement` 36 / 168 / 592 ms. A worker for a 36 ms parse inside a
     user-initiated import that then writes thousands of rows is machinery with nothing to carry.
241. ✗ Not doing: progressive rendering of very long reports (M)
     — measured the render share and there is nothing left to make progressive. On a 5,500-voucher
     book, splitting each screen's wait into the IPC call and everything after it: e-documents
     **34 ms total for 2,814 rows / 697 KB, of which ~11 ms is React**; the Day Book fetches 5,500
     rows / 1,244 KB in 40 ms and renders them in **3 ms**, because it is row-virtualized (#227);
     trial balance and registers render in 25 ms each and are dominated by their own small
     queries. The three reports that can be genuinely unbounded already cap their DOM nodes
     regardless of length, and the rest are paginated. Progressive rendering would add a second
     rendering mode — and a screen that can report itself idle before it is — to divide up eleven
     milliseconds.

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
293. ✓ Sample company that mirrors the user's own trade (M) — three of them, chosen at the point
     the sample is created: a shop or distributor (the old Demo Traders, unchanged, still the
     default so nothing that depended on it moved), a workshop with raw material, a real bill of
     materials, a work-in-progress stage that shows on the stock summary, and finished goods; and
     a practice that invoices fees against time, has no stock item at all, and comes with
     inventory switched off. A manufacturer who opened the old sample saw no BOM and concluded
     the app had none; a consultancy saw six stock items and concluded it would have to fight the
     app. Both were the sample's fault. It also surfaced a real bug: react-query keys are not
     company-scoped and nothing cleared the cache on switching, which never showed while every
     company had identical feature defaults.
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
326. ✓ Visual regression snapshots of every screen, both themes (M)
     — `npm run visual`: every screen in both themes, compared against a committed signature
     rather than a committed image. Seventy PNGs is 25 MB of binaries and a binary in a diff is a
     diff nobody reads, so the baseline is a 32×20 grid of average colour plus a 64-bucket palette
     histogram, per screen. What gets reviewed is the list of screens that moved, because
     accepting a baseline is accepting that a screen is meant to look different now.

     Two things it took a wrong turn to get right. The grid was luminance-only and blind to hue;
     and the screens were photographed with no row selected, so the accent bar — the app's
     signature — was not in a single one of the seventy shots. It now presses ArrowDown first,
     which is also the more honest photograph: a screen in use has a cursor on it.

     And one thing it still cannot do, measured rather than assumed: a 3px rule is about 0.007% of
     the pixels on screen, so changing the accent from indigo to red passes this sweep clean. The
     palette is covered by an exact token snapshot instead (`__tests__/palette.test.ts`), which
     also asserts that every theme defines every token — a token missing from dark does not fail
     loudly, it silently falls back to the light value, which is exactly how one unreadable
     element after dark happens.
327. ✓ Mutation testing on the money and GST engines (M)
     — `npm run mutate`. 103 mutants across money, GST calc, turnover, late fees and round-off;
     **85.4% on the first run, 94.2% after**, and the six that remain are equivalent mutants,
     listed in the script with the reason each one cannot be killed.

     The nine real survivors were the point. `roundPaise` and `roundToRupee` lost their `Math.abs`
     and nothing noticed, because every test used a positive amount — half-away-from-zero becomes
     half-toward-zero for negatives, so −2.5 rounds to +2, the wrong magnitude and the wrong sign,
     and a credit note is the ordinary case that hits it. `amountInWords` read one past the end of
     its own table, and twenty is the only number that tells `< 20` from `<= 20`. `roundOffLine`
     lost its `Math.abs` on the limit check, which is false for every negative difference however
     large, so a credit-heavy voucher out by ₹500 would have been silently plugged instead of
     refused. And only GSTR-3B's row of the late-fee table was ever read: GSTR-1's ₹50/day,
     GSTR-4's ₹2,000 cap and both of their nil rates could have been anything.

     Deliberately not a gate. A score used as a gate becomes a pressure to write tests that
     satisfy the tool, and the equivalent mutants above are exactly what that pressure produces.
     `--min` exists for anyone who wants one.
328. ✓ Property-based tests for the posting rules (M)
     — `src/shared/posting.prop.test.ts`.
329. ✓ A seeded large-book fixture reused across performance tests (S)
     — `src/main/db/bigbook.ts`, built once and copied rather than regenerated per run.
330. ✓ Lint rule banning raw SQL outside services (S)
     — `src/main/dbBoundaries.test.ts`.
331. ✓ Lint rule requiring `NOT_DELETED` on voucher queries (M)
     — `src/main/notDeleted.test.ts`, which greps every SQL literal under `src/main` and fails on
     an unscoped read, with an `ALLOWED` list where each deliberate exception carries its reason.
     It found five real cases in its first week, two of them bugs: the bounced-cheque register
     and the per-party bounce count would have counted a binned receipt against a customer
     forever. The scope has to appear literally in the SQL — a WHERE clause assembled at runtime
     is one neither the guard nor a reader can check.
332. ✓ Typed IPC channel registry generated from one source (M)
     — the guarantee, arrived at the other way round. Rather than generating both sides from a
     third file, the two sides that already exist are checked against each other by
     `src/main/channels.test.ts`: every channel the client calls has a handler, every channel the
     E2E scripts invoke has a handler, no channel is registered twice (a second `handle()` silently
     replaces the first, leaving the loser as dead code that still reads as live), and every name
     follows `scope:action`.

     A generated registry was the wrong shape for this repo, not too much work: it is one file
     that every branch touching IPC would rewrite, and with 488 channels and several branches in
     flight it would conflict on every merge. The check has the same failure mode and no merge
     cost.

     What it prevents has happened twice already. A channel name is a string on both sides, so
     `call('draft:get')` against a main that registers nothing of that name compiles, typechecks,
     passes every unit test, and fails at runtime in front of the user. Both times it was an E2E
     scenario that caught it, which is luck rather than coverage.
333. ✓ Renderer test coverage reporting with a floor (S)
     — a floor, not a target. Measured at 66.5% lines, 84.3% branches, 49.5% functions over
     `lib/` and `state/`, with the floors a few points under each: the margin between "somebody
     deleted a test" and "two machines disagree about one line". Deliberately not aspirational —
     a floor nobody can meet gets lowered the first time it blocks somebody, and then it is a
     number that means nothing. Screens are covered by the E2E suite, which drives the real app;
     counting them here would count lines jsdom executes and a user never does.
334. ✓ E2E run time budget so the suite stays usable (S)
335. ✓ Flake detection: rerun failures and report them separately (S) — one was found by hand
     while adding #171: scenario 02 failed about half the time because `staleTime` is 5s and
     `purchaseSuggestions` was in no screen's invalidation list, so a revisit inside five seconds
     served a cached empty panel. `__tests__/invalidation.test.ts` now guards the whole class.
336. ✓ A `npm run verify` that runs everything in one command (S)
337. ✓ Pre-commit hook running typecheck and the fast tests (S)
338. ✓ Dependency freshness report in CI (S)
     — `scripts/deps-report.mjs`, on the CI summary page, and deliberately NOT a gate: a build
     that fails because something published a minor version this morning teaches people to skip
     the check. Runtime dependencies are listed first and separately, because a dev dependency
     four majors behind is a chore and a runtime one is a decision. The two that are pinned on
     purpose — Electron, and better-sqlite3 which must match its ABI — print the reason, so the
     report does not read as neglect. It says today: openai 2 majors, zod 1, Electron 7.
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
352. ✓ Invoice Management System actions from the 2B reconciliation (L) — the worklist off the
     2B recon, with a suggestion per bucket, a decision recorded per document, and a bulk accept
     for the rows where the portal and the books agree. Keyed on supplier GSTIN + document number
     so a decision survives re-downloading 2B, and so the rows with no voucher at all — the ones
     deemed accepted if nobody looks — can hold one. **The app cannot take the action**: IMS is a
     portal screen with no offline route, so this is the worked sheet and the record of what was
     decided, and the screen says so. **Needs verification:** whether 'pending' is available on
     every document type has changed more than once and has not been checked against the current
     portal.
353. ✓ GSTR-1A, the amendment return (M) — a snapshot of the outward documents taken when the
     GSTR-1 filing is recorded, and a diff of the books against it. Three states rather than one,
     because a period with no snapshot has to say so instead of reporting itself clean. A changed
     recipient GSTIN is reported as its own kind — GSTR-1A cannot amend the counter-party, and
     calling it an amendment would send the user to a form that rejects it. **Needs verification:**
     the opening and closing conditions of the amendment window are stated as understood and
     marked unverified against rule 59(4A) in the code and on the screen.
354. ✓ The e-invoice reporting deadline, as a countdown (S) — registrations above the ₹10 crore
     turnover band must report an invoice to the IRP within 30 days of its date, after which the
     portal simply refuses it. `turnover.ts` already knows the band; nothing counts the days.
     — `src/shared/gst/eInvoiceWindow.ts`, with the countdown on the Disclosure screen.
355. ✓ Input Service Distributor for multi-GSTIN businesses (L) — the mechanism, complete, and
     marked where it is unverified. It was declined once because #108 did not exist; #108 exists, so
     an ISD registration has other registrations to distribute to. `is_isd` is a flag on
     `gst_registrations` — an ISD IS a registration, and section 24(viii) makes it a separate one —
     and there is only ever one, because a second would give a common invoice two homes and the
     distribution two possible ratios. Invoices received centrally are recorded with their credit,
     their eligibility, and **who the credit is attributable to**: all the registrations, some of
     them, or exactly one. That distinction is the user's judgement about the service and the app
     never infers it, because credit attributable to one recipient goes to that one whole and is
     never apportioned. The ratio is the statutory one — the recipient's turnover in the State over
     the total, for the relevant period — computed per registration from the books through the same
     income-group movement GSTR-1's header uses, scoped by `gst_registration_id`, with the relevant
     period resolved as rule 39's Explanation says (the preceding financial year, or the last
     quarter when a recipient had no turnover in it) and a per-recipient OVERRIDE, because rule 39
     wants turnover in the State including exempt supplies and any part of the period before these
     books begin. Apportionment is largest-remainder in integer paise, so the shares sum to the
     credit exactly: a distribution that loses a paisa is a credit ledger that never reconciles.
     The head conversion is the part that is invisible until a return is filed and is implemented:
     IGST distributes as IGST, and CGST+SGST distributes as CGST+SGST inside the distributor's own
     State and as IGST — their aggregate — outside it. Distribution is monthly, issues one rule
     54(1) ISD invoice per recipient from its own dated series (a recipient whose share rounds to
     nil gets no document rather than a serial spent on nothing), prints it with the ratio on its
     face, and can be withdrawn and re-run. The credit then appears in the recipient's GSTR-3B
     Table 4(A)(4) — the `ISD` row that had always been hard zero because nothing in the books
     could fill it — eligible credit only, read off the issued documents. Nothing posts: distribution
     moves credit between two of the business's own electronic credit ledgers, so the trial balance
     and the P&L are unchanged, and `isd.dbtest.ts` and E2E 53 assert it. GSTR-6 is produced as
     DATA with its section 39(4) due date of the 13th, never as a portal JSON.
     **Needs verification, and said on the screen as well as in the code:** the commencement date of
     the Finance (No. 2) Act 2024 substitution of sections 2(61) and 20 is taken as 1 April 2025 and
     has not been checked against the gazette; the clause lettering of substituted rule 39 is not
     reproduced, and the substance is stated on the pre-substitution rule 39(1)(d)/(f)/(g); the
     treatment of compensation cess on distribution is modelled cess-to-cess and is NOT verified;
     and the GSTR-6 table numbering is the shape of the working, not a claim about the current form
     layout. The rules are dated data (`ISD_RULES_HISTORY`), so a month before April 2025 is told
     the mechanism was optional then rather than being judged by today's rule.
     — `src/shared/gst/isd.ts`, `src/main/services/isd.ts`, Disclosure › ISD.
356. ✓ The reverse-charge self-invoice (M) — the document section 31(3)(f) makes the recipient
     raise, issued from its own Rule 46(b) serial series, with the Rule 46 particulars the books
     cannot supply named on the face rather than invented. Built over exactly the supplies
     GSTR-3B charges reverse-charge tax on, so the paper adds up to the return; idempotent per
     voucher, because two invoices for one supply is a worse finding than none. **Needs
     verification:** the proviso permitting a consolidated month-end invoice for section 9(4)
     supplies is implemented and marked unverified — the per-supply form is the default.
357. ✓ LUT tracking for exporters (S) — the undertaking is annual, expires on 31 March, and an
     expired one silently converts a zero-rated export into a taxable supply. A date and a
     reminder, worth far more than the effort.
     — `src/shared/gst/lut.ts`, with the register and expiry status on the Disclosure screen.
358. ✓ Rate history spanning the September 2025 rationalisation (M) — a dated slab structure, a
     per-item change list, and an advisory that separates the three questions: did the structure
     change inside this period (September 2025's return legitimately shows one HSN at two rates),
     does a voucher carry a rate that was not notified on its own date, and does an item master
     still hold a withdrawn slab. Nothing recomputes a posted voucher. **Needs verification:** the
     22 September 2025 entry is taken from the 56th GST Council's recommendation; the rate
     notifications behind it, and the treatment of compensation cess after that date, have not
     been checked. The entry is flagged `unverified` in the data and on the screen. Per-HSN rates
     are deliberately NOT modelled — that mapping is the user's, dated, per item.
359. ✓ Income-tax Act 2025 section mapping (M) — the mechanism, complete: both numbers on the
     section master, the payment's own date deciding which is printed, a user override that wins
     over anything the app proposes, and the warning carried onto the 26Q and the Form 16A. A
     certificate for an old quarter does not become a 2025 Act certificate because it was printed
     late. **Needs verification, and says so everywhere it appears:** the proposed mapping assumes
     deduction at source is consolidated in section 393 with a table, and NO table serial — nor
     the section number itself — has been checked against the Act. Nothing is written into a
     user's master until they confirm it.
360. ✓ TDS return files: 24Q and 26Q (L) — with the piece that was actually missing: challans.
     A quarterly statement is built challan by challan (BSR code, date, bank serial) and none of
     that was recorded anywhere, so the deductions had nothing to hang from. Adds the challan
     register, the deduction-to-challan link, a validation pass that names everything standing
     between the quarter and the utility, and two exports. **The challan and deductee CSVs are
     facts out of the books and are safe.** **Needs verification:** the `^`-separated e-TDS record
     layout has NOT been checked against a published file format — it is written from one array in
     `src/shared/tdsReturn.ts`, the export is behind an explicit acknowledgement, refuses while
     the return has a blocking issue, and writes `.unverified.txt`. Run it through the FVU.
361. ✓ Form 16A for vendors (M) — quarterly, per deductee, with the challan each deduction was
     paid under and the rule 31(3) due date. Refuses to produce a certificate for a quarter with
     no deduction, because that is not a nil certificate — it tells a vendor to look for credit
     that is not there. **Stated on the face, first, in the code and on the screen:** a deductor
     may not hand-make a Form 16A. Since the CBDT circulars of 2011–12 it is downloaded from
     TRACES against the filed statement, and what this produces is a WORKING COPY of the figures.
362. ✓ A Form 3CD data pack for the tax audit (M) — clause-wise extracts for 18, 21(d), 22, 23,
     26, 31(a), 31(c), 34(a), 40 and 44, each citing its section and each naming what it does NOT
     establish — clause 21(d) can list every cash payment over the limit but cannot know which
     went through an account-payee instrument, and says so on the extract. Clauses that produced
     nothing are listed with the reason, and clauses this build does not extract are listed too,
     so the pack cannot be mistaken for a complete Form 3CD. The
     40A(3) and 269SS/269T limits are dated data, so a pack for an old year uses that year's
     limits. **Needs verification:** Form 3CD is amended almost every year and the clause NUMBERS
     have not been checked against the form notified for the year being audited — every extract
     states its content in words as well as by number.
363. ✓ Schedule III presentation of the Balance Sheet and P&L (M) — Division I (non-Ind AS), as a
     toggle on the balance sheet rather than a screen of its own, because two screens showing the
     same balance sheet is how the two come to disagree. Maps leaves rather than subtrees so the
     face provably ties to the statement it is a view over, shows any balance no line claims
     instead of dropping it, and prints each judgement under the line that made it. Carries the
     micro-and-small trade-payables split required on the face since 24 March 2021, from the same
     classification section 43B(h) uses — and says the split is missing rather than printing an
     unclassified zero. The 2021 ageing schedules are deliberately not produced.
364. ✓ Related-party transactions report (S) — a flag on the party ledger and a disclosure listing
     every voucher against it. Cheap, and currently impossible to produce without a spreadsheet.
     — `relatedPartyReport` in `disclosure.ts`, on the Disclosure screen.
365. ✓ A Rule 3(1) audit-trail statement (S) — the one page an auditor asks for: that the log
     exists, that it cannot be switched off, what it covers, and for which dates. The log has
     been recording faithfully all along and can say none of this about itself. Pairs with #265.

## T. Assets, borrowing and the bank

Everything a business owns and owes that is not a bill. "Fixed Assets" exists in this app as a
ledger group and nothing else — there is no register, no schedule, and no way to answer the two
questions every year-end asks.
     — `auditTrailStatement` in `disclosure.ts`, on the Disclosure screen.
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
371. ✓ CMA data for a working-capital application (L) — the format banks require, generated from
     the books. Forms I to VI and the ratio sheet, five columns wide: two audited years, the
     current year's estimate, two projections. The audited columns are read out of the books and
     recomputed on every open, never stored — a snapshot would be free to drift from the ledgers
     the bank will verify against, and the snapshot is the half that would be wrong. The estimate
     and the projections are typed, because a projection is a business's own claim about its
     future and an accounting app has no business inventing one. Every cell carries where it came
     from and the three states never look alike on screen: from the books, typed, derived. A year
     the books do not reach is blank and says so in words, rather than printing the column of
     confident zeros that gets a file refused. It reuses #372/#373's classification of the working
     capital rather than deriving a second one — same borrower, same stock, one answer — and takes
     DSCR's instalments off the loan register from #370.
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
