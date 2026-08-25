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
20. A visible focus-ring audit: every interactive control reachable by Tab (M)
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
46. A scratchpad ledger for entries the user has not decided how to classify (S)
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
112. ✓ Multi-godown stock transfer voucher (M)
113. ✓ Reorder level with a purchase suggestion report (M)
114. ✓ Batch expiry tracking with a near-expiry report (M)
115. Serial-number tracking for high-value items (L)
116. ✓ Stock ageing by batch rather than by item (M)
117. ✓ Landed cost allocation across a purchase (M)
118. Standard costing with variance against actual (L)
119. Item images on the invoice and in the picker (M)
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
127. Job-work stock sent out and received back (L)
128. Price list versioning with effective dates (M)
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
140. Multi-currency bank accounts with revaluation (L)
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
226. Lazy-load screens that most users never open (S)
227. ✓ Row virtualization on long tables (M)
     — the day book, the ledger statement and the trial balance render through `useVirtualRows`.
     On the e-document list it measured 1,638 → 1,310 ms warm, which is inside this machine's ±90
     ms spread, so it is kept on the grounds of DOM node count and not reported as a speed-up.
228. Prepared-statement reuse across calls in hot services (S)
229. ✗ Query result caching keyed on the books' last-modified stamp (M)
     — measured and declined. After the pagination work the queries this would cache cost about
     3 ms, so the cache would be a correctness liability (every write path has to remember to
     bump the stamp) bought with no time saved.
230. Incremental report recomputation rather than full recompute (L)
231. Move PDF generation off the main process (M)
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
326. Visual regression snapshots of every screen, both themes (M)
327. Mutation testing on the money and GST engines (M)
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
332. Typed IPC channel registry generated from one source (M)
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
355. ✗ Input Service Distributor for multi-GSTIN businesses (L) — declined here, as the item
     itself says: ISD distributes common input credit from one registration to the others on the
     same PAN, and a company with one GSTIN has nothing to distribute to. Multi-GSTIN (#108) is
     not built, so an ISD screen would be a form with no second registration to name, an ISD
     invoice with no recipient, and a GSTR-6 nobody could file. Build it with #108.
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
