# Table platform (`components/table` + `lib/table`)

One table for every list and report screen. `lib/table/` is pure TypeScript with no React:
sort, filter, group, view state and export, all unit-tested in `__tests__/table/logic.test.ts`.
`components/table/` is the React layer: `DataTable`, its toolbar, header popovers and the
`useTableView` persistence hook.

The Exceptions screen (`screens/Exceptions.tsx`) is the smallest working example.

## 1. Define columns once, at module level

```tsx
import { DataTable, defineColumns } from '../components/table'

const COLUMNS = defineColumns<DayBookRow>([
  { id: 'date', header: 'Date', kind: 'date', value: (r) => r.date, className: 'text-muted' },
  { id: 'type', header: 'Type', kind: 'enum', value: (r) => r.kind,
    options: [{ value: 'sales', label: 'Sales' }, { value: 'purchase', label: 'Purchase' }] },
  { id: 'number', header: 'No.', kind: 'text', value: (r) => r.number, width: 110 },
  { id: 'account', header: 'Account', kind: 'text', value: (r) => r.account, hideable: false,
    text: (r) => r.account + (r.isOptional ? ' [Optional]' : ''),        // export/quick-filter text
    cell: (r) => <>{r.account}{r.isOptional && <OptionalBadge />}</> },   // custom rendering
  { id: 'narration', header: 'Narration', kind: 'text', value: (r) => r.narration, defaultHidden: true },
  { id: 'debit', header: 'Debit', kind: 'money', value: (r) => r.debit, aggregate: 'sum' },
  { id: 'credit', header: 'Credit', kind: 'money', value: (r) => r.credit, aggregate: 'sum' }
])
```

Declare columns at module level, or wrap them in `useMemo`. The table memoises its sorted and
filtered model on the identity of `columns`, so an inline array re-sorts every row on every
hover.

### Column kinds and what `value` must return

| kind       | `value(row)` returns        | sorts             | filter operators                  | default format                       |
|------------|-----------------------------|-------------------|-----------------------------------|--------------------------------------|
| `text`     | string                      | case-insensitive, numeric-aware ("Inv 9" < "Inv 10") | contains, starts with, equals, is empty | as is            |
| `money`    | **integer paise**           | by paise          | =, ≥, ≤, between (typed in rupees, parsed with `parseRupees`) | `<Money>` / `formatPaise` |
| `quantity` | **integer thousandths**     | numeric           | =, ≥, ≤, between (`parseMilli`)   | `formatMilli(v, decimals ?? 3)`      |
| `date`     | ISO `'YYYY-MM-DD'`          | chronological     | on, before, after, between (Tally smart dates: `7`, `7/4`, `t`) | `toDisplayDate` |
| `number`   | plain number (counts, %)    | numeric           | =, ≥, ≤, between                  | `String(v)`                          |
| `enum`     | option value (string)       | by value          | one-of (checkboxes)               | option label                         |

`null`, `undefined` and `''` mean "no value". They sort last in both directions and match
"is empty". Floats never touch amounts: money stays in paise from the accessor through
aggregation to `formatPaise`.

### Other column fields

- `text(row)`: display, export and quick-filter text. Defaults to the kind's formatter.
- `cell(row)`: a custom React cell. Sorting, filtering and export still use `value` and `text`.
- `align`: by default money, quantity and number align right, everything else left.
- `signed` (money): renders "1,234.00 Dr/Cr", like `<Money signed>`.
- `decimals` (quantity): 0 to 3.
- `sortable`, `filterable`, `hideable`: all default to true. Use `hideable: false` for the
  identifying column.
- `groupable`: defaults to true for text, enum and date columns.
- `groupKey(row)`: groups by something other than the cell text, e.g.
  `(r) => r.date.slice(0, 7)` for months.
- `defaultHidden`, `width` (px), `minWidth`.
- `aggregate`: `'sum'`, or `(rows) => rawValue` for honest totals that skip some rows. DayBook,
  for example, doesn't count optional or post-dated rows:
  `(rows) => rows.filter(inBooks).reduce((s, r) => s + r.debit, 0)`.
- `className` / `headerClassName`: extra cell classes, for example `'text-muted'`.

## 2. Render it

```tsx
<Panel>
  <DataTable
    viewId="daybook"                 // persisted per company + screen; omit = in-memory only
    legacyReportKey="daybook"        // seeds hidden columns from the old useReportConfig toggles
    testId="daybook"                 // tbody → rows-daybook, headers → sort-daybook-<id>
    columns={COLUMNS}
    rows={rows}
    rowKey={(r) => r.voucherId}
    rowAttrs={(r) => ({ 'data-row-id': r.voucherId })}
    loading={isLoading}
    empty={{ title: 'No vouchers in this period', hint: 'Press V to enter one' }}
    onRowActivate={(r) => nav.go({ name: 'voucher-entry', voucherId: r.voucherId })}
    trailing={(r) => r.kind === 'sales' && <button onClick={() => pdf(r.voucherId)}>PDF</button>}
    exportOptions={{ title: 'Day book', periodLabel: `${toDisplayDate(from)} to ${toDisplayDate(to)}` }}
    toolbarStart={<ScopeSelect />}   // screen-specific controls live in the toolbar
  />
</Panel>
```

Useful props (all optional except `columns` and `rows`):

- **Activation.** `onRowActivate` fires on Enter and on click, or on double-click when
  `activateOn="dblclick"`. Rows where `isRowActivatable` returns false get no pointer cursor and
  ignore Enter and clicks. They keep the amber keyboard bar, so navigation still shows.
- **Detail rows.** `renderDetail` and its related props are covered in the next section.
- **Action cells.** `leading` and `trailing` render a cell before or after the data columns.
  Clicks inside them never activate the row.
- **Footer.** `totals` defaults to `'auto'`, which shows the footer when any visible column has
  an `aggregate`. `totalsLabel` sets the label. `renderFooter(ctx)` replaces the footer with your
  own `<tr className="total-row">` rows, for something like "Closing balance".
- **Toolbar.** `toolbar={false}` hides it. `toolbarFeatures={{ groupBy: false, density: false }}`
  turns off individual features. `toolbarStart` and `toolbarEnd` add screen-specific controls.
- **Size.** `maxHeight` defaults to `calc(100vh - 220px)`. The header sticks inside this scroll
  area. `maxHeight="none"` lets the table grow with the page, which also turns virtualisation off.
- **Virtualisation.** `virtualize` defaults to `'auto'`, which windows the body once there are
  more than 150 items. `true` forces it on and `false` forces it off.
- **Keyboard.** `keyboard={false}` opts out of keyboard navigation.
- **External control.** `controller` takes the result of `useTableView(...)` when the screen
  needs to read or set the view itself.

### Expandable detail rows

Use these for a party row that opens onto its bills, a voucher onto its lines, or a stock item
onto its batches.

```tsx
<DataTable
  columns={COLUMNS}
  rows={parties}
  rowKey={(p) => p.ledgerId}              // expanded state is keyed by rowKey, so it survives sorting
  renderDetail={(p) => <BillsList bills={p.bills} />}
  isRowExpandable={(p) => p.bills.length > 0}
  // uncontrolled: defaultExpanded={[firstId]}
  // controlled:   expanded={openSet} onExpandedChange={setOpenSet}
/>
```

- A chevron column (`aria-expanded`, `aria-controls`) appears before the data columns. Pressing
  → expands the active row and ← collapses it. The same keys open and close a group header.
- The detail renders as a following `<tr class="dt-detail">` with one cell spanning every column.
  Its content wraps and can be any height. It is not a navigation stop: ↑/↓ skip over it.
- **Virtualisation still works.** Each rendered detail row reports its height (measured on
  render, then via ResizeObserver). Unmeasured details use `detailHeightEstimate` (default 120px).
  - The table keeps an offset index of per-item heights (`buildRowLayout` in
    `lib/table/virtual.ts`). The spacer rows, the rendered window, `aria-rowcount` and
    `aria-rowindex` all come from it.
  - PageUp and PageDown move by one viewport of height, so an expanded row takes up part of a
    page.
  - When a newly measured detail moves the row the keyboard just scrolled to, the table scrolls
    again until the user scrolls by hand.
- Details aren't exported. PDF and CSV export the rows only.

### Exporting the current view

The toolbar's PDF and CSV buttons call `printReport` and `csvReport` from
`lib/reportExport.ts`. Each export contains the visible columns in their current order, the
current filters and quick filter, the sort, group header rows with subtotals, and the totals
row. Every row in a group is exported, including rows in collapsed groups. To build your own
export, use the pure helper:

```ts
const ex = buildTableExport(buildTableModel(rows, COLUMNS, view, { quick }))
// ex.columns / ex.rows → printReport; ex.header / ex.csvRows → csvReport
```

**PDF row cap.** `report:pdf` accepts at most `PDF_ROW_LIMIT` (5,000) rows. When the current
view has more, the PDF never drops rows silently:

- It keeps the first rows plus the totals row. The totals still cover every row.
- It says so in the PDF footer and in a warning toast, for example: *"PDF shows the first 4,999
  of 6,000 lines … Export CSV for every line."*
- The helper is `capExportForPdf` in `lib/table/export.ts`. CSV is never capped.

## 3. Keyboard, focus and modals

Navigation reuses `useKeyNav` from `components/ui.tsx`, using its opt-in `options` argument:

| Key                      | Action                                                      |
|--------------------------|-------------------------------------------------------------|
| ↑ / ↓                    | Move the active row (the amber bar).                        |
| PageUp / PageDown        | Move by one viewport (measured in px, so expanded rows count). |
| Home / End               | Jump to the first or last row.                              |
| Enter                    | Activate the active row. On a group header, toggle it.      |
| → / ←                    | Expand / collapse the active row's detail or group.         |

The active row scrolls into view even when it sits outside the rendered window. The table
scrolls arithmetically to that position and the row renders immediately.

Because it is the same hook, the existing rules carry over unchanged:

- Only the topmost list responds. With several tables on a screen, the table you last clicked
  or tabbed into becomes the topmost: a pointerdown or focus anywhere inside it claims the
  keyboard (`useKeyNav`'s `claim` option). Before any interaction, the most recently mounted
  table has it.
- Keys typed into inputs are ignored.
- Everything is suspended while any `Modal` is open (`isAnyModalOpen`).
- Navigation also pauses while one of the table's own popovers (filter, columns, views) is open.

Esc inside a popover closes it and doesn't reach the screen's Esc-to-go-back handler.

Mouse controls:

- Click a header to sort. Shift-click adds a secondary sort.
- The funnel button in a header opens that column's filter.
- Drag a header to reorder columns. This uses pointer events, not HTML5 drag-and-drop. The
  dragged header dims, an amber rule marks the drop edge, and a drag never triggers a sort.
  Movement under 5px counts as a click. The column chooser also has ↑/↓ buttons.
- Drag the right edge of a header to resize. The edge is also focusable: ←/→ resizes by 16px and
  a double-click resets the width.

## 4. Persistence (`useTableView`)

- Views are stored in localStorage under `total-tableview-<company-slug>-<viewId>`, as
  `{ v: 1, current, active, saved[] }`. They are display preferences and never go to the company
  database.
- A view holds:
  - the column order, hidden columns and widths
  - the sort keys and column filters
  - the group-by column and density
- The quick-filter text and collapsed groups are transient and are not saved.
- Stored state is parsed defensively:
  - corrupt JSON or a different schema version falls back to the defaults
  - unknown column ids are dropped
  - columns added since a view was saved appear at their declared position with their default
    visibility
  - filters that no longer fit their column's kind are discarded
- The saved views menu offers: save current as…, switch, rename, delete, and reset to default.
  A `•` after the view name means the current view differs from the saved one.

### Migrating a screen off `useReportConfig`

Pass `legacyReportKey` with the screen's old report key. If the screen has no table view
stored yet, the old `total-reportcfg-<slug>-<key>` booleans seed the hidden columns. The legacy
key is read only, never deleted. If the old toggle keys don't match the new column ids, pass
`legacyIdMap`. One old key may drive several columns, as in
`{ movement: ['movementDr', 'movementCr'] }`. After that, delete the `COLUMNS` / `useReportConfig`
/ `ReportConfigButton` trio from the screen: the toolbar's column chooser replaces it.

## 5. Styling notes

- The table renders `<table class="ledger-table data-table">`, so it keeps the hand-ruled
  ledger look. The `.data-table` rules in `app.css` add a fixed layout, single-line cells
  (ellipsis, with a title tooltip on long text), a sticky header, and fixed row heights of 33px
  (comfortable) or 27px (compact).
- Data rows have a fixed height, which is what makes virtualisation exact. Keep custom cells to
  one line, and put anything taller in `renderDetail`, which is measured.
- The active row uses the existing `.kbar-row[data-active]` inset box-shadow bar on the first
  `<td>`, never `tr::before`.
- Use theme token utilities only (`bg-panel2`, `text-muted`, `border-line`, `text-amber`, …).

## Known limitations

- Detail rows aren't exported, and a detail row can't contain another table that claims the
  keyboard independently. A table nested in a detail is just one more table on the screen.
- When a detail row's height first gets measured, Chromium's scroll anchoring keeps the visible
  rows still while you scroll. The scrollbar thumb can shift slightly as estimates turn into
  measurements.
- `printReport` (used directly, outside DataTable) still refuses more than 5,000 rows with a
  toast. DataTable's own PDF export trims and labels instead.
