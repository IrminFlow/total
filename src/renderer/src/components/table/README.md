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
  `activateOn="dblclick"`. `isRowActivatable` marks rows that do nothing.
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

## 3. Keyboard, focus and modals

Navigation reuses `useKeyNav` from `components/ui.tsx`, using its opt-in `options` argument:

| Key                      | Action                                                      |
|--------------------------|-------------------------------------------------------------|
| ↑ / ↓                    | Move the active row (the amber bar).                        |
| PageUp / PageDown        | Move by one viewport.                                       |
| Home / End               | Jump to the first or last row.                              |
| Enter                    | Activate the active row. On a group header, toggle it.      |

The active row scrolls into view even when it sits outside the rendered window. The table
scrolls arithmetically to that position and the row renders immediately.

Because it is the same hook, the existing rules carry over unchanged:

- Only the topmost mounted list responds.
- Keys typed into inputs are ignored.
- Everything is suspended while any `Modal` is open (`isAnyModalOpen`).
- Navigation also pauses while one of the table's own popovers (filter, columns, views) is open.

Esc inside a popover closes it and doesn't reach the screen's Esc-to-go-back handler.

Mouse controls:

- Click a header to sort. Shift-click adds a secondary sort.
- The ⌕ button in a header opens that column's filter.
- Drag a header to reorder columns. The column chooser also has ↑/↓ buttons.
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
- Fixed row heights are what make virtualisation exact. Keep custom cells to one line.
- The active row uses the existing `.kbar-row[data-active]` inset box-shadow bar on the first
  `<td>`, never `tr::before`.
- Use theme token utilities only (`bg-panel2`, `text-muted`, `border-line`, `text-amber`, …).

## Known limitations

- Rows have a fixed height, so there are no expandable detail rows yet. For something like
  Outstandings' bill breakdown, render the details elsewhere (a drawer or modal) or keep a
  bespoke table for now.
- One table per screen should own the keyboard. With several tables on screen (such as
  Exceptions' sections), the most recently mounted one responds, which is the usual
  `useKeyNav` stack rule.
- When `printReport` is given more than 5,000 rows it refuses and shows a toast. CSV export has
  no limit.
