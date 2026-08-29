# Total v5 design system

## Design read

Total is a dense desktop accounting product for Indian business owners, bookkeepers and
accountants. The visual language must communicate precision, control and local ownership. It
should feel native to serious financial work, not like a generic SaaS dashboard.

- Redesign mode: full visual overhaul with workflow and information architecture preservation.
- Design variance: 4/10. Clear hierarchy with measured asymmetry.
- Motion intensity: 2/10. State feedback only; no decorative motion.
- Visual density: 8/10. Compact tables and forms with deliberate breathing room around decisions.
- Foundation: the existing React 19, Tailwind 4 and semantic component kit.
- Accent: one amber cursor/action color. Red and green remain accounting semantics, not accents.
- Shape rule: 6px controls, 10px structural surfaces, full circles only for semantic status.

## Existing-state audit

### Brand tokens

- IBM Plex Sans, Serif and Mono are already self-hosted and load without a network dependency.
- Amber selection is the strongest recognizable interaction and must remain.
- Red mnemonic letters are functional shortcut indicators and must remain distinct from errors.
- Ledger double rules and tabular figures provide useful accounting character.
- Light and dark themes already use semantic CSS variables.

### Information architecture

- The left navigation exposes more than 30 screens grouped by Books, Analysis, Banking, Payroll,
  GST and System.
- The top bar carries company identity, working period, theme, command palette, copilot and lock.
- Gateway, Action Centre, Voucher Entry and reports form the primary daily path.
- Command K, single-letter Gateway shortcuts, Alt shortcuts and function keys are core muscle memory.

### Strengths to preserve

- Dense, fast tables with mono figures and exact drill-down.
- Full keyboard operation, focus rings and amber row cursor.
- One visual system shared by reports, forms and settings.
- Real loading, empty and failure states in core workflows.
- Light/dark parity and deterministic screenshot coverage.

### Problems to retire

- The sidebar is visually flat and gives every destination equal weight.
- Company identity, pin action and global actions compete in one narrow top row.
- Serif screen headings sometimes wrap awkwardly and conflict with dense form tabs.
- Many surfaces use the same border, radius and shadow regardless of hierarchy.
- All-caps micro-labels are overused in navigation, fields, cards and tables.
- Buttons lack consistent pressed feedback and several text actions have weak hit areas.
- The Gateway uses many same-shaped metric boxes, weakening priority.
- Validation often appears as a transient toast instead of persistent inline guidance.
- Status is sometimes communicated by color alone.
- Long navigation requires excessive scrolling and makes screen discovery harder.

## Product-shell specification

### Navigation rail

- Width: 216px expanded, with a later 56px compact mode.
- Brand/company switcher at the top, daily destinations immediately below.
- Pinned screens are user-controlled and visually separated from the full directory.
- Section labels use sentence case and lower contrast, not spaced all-caps.
- Active screen gets an amber inset bar plus surface change and stronger text.
- Mnemonic letters remain red and never become generic icon decoration.
- System actions remain anchored at the bottom.

### Top command bar

- Height: 52px, one desktop line.
- Left: current screen title and optional breadcrumb context.
- Right: working period, search/command, copilot, account and lock.
- Pin becomes a proper icon action beside the title with an accessible label.
- Theme selection moves to Settings after a discoverability transition period.

### Content canvas

- Default maximum content width: 1180px for forms and analysis, unconstrained for large reports.
- Default horizontal inset: 24px; compact screens may use 16px.
- Screen title uses IBM Plex Sans 600 at 22px. Serif is reserved for company identity, statement
  totals and selected editorial moments rather than every heading.
- Primary actions live in a sticky action row when a workflow can extend below the viewport.

## Component rules

### Surfaces

- Canvas: low-contrast neutral.
- Raised surface: menus, modals and selected task panels only.
- Grouped surface: forms and report controls, separated from tables by spacing rather than shadows.
- Data rows: a single divider between rows; no boxed cells unless the data requires a grid.

### Inputs

- Labels sit above controls in sentence case.
- Default height: 32px for dense grids, 36px for standalone forms.
- Focus uses amber outline and border without layout shift.
- Errors render directly below the field and also appear in a consolidated preflight.
- Placeholder contrast remains readable but clearly subordinate to entered text.

### Buttons

- Primary: amber fill, dark label, one per decision group.
- Secondary: neutral surface and border.
- Tertiary: text action with a minimum 28px hit area.
- Destructive: red text/tint and a confirmation that names the affected record.
- Pressed state translates 1px down. Disabled controls explain why through nearby text or tooltip.

### Tables

- Mono, tabular figures for amounts, dates, quantities and identifiers.
- Sticky headers for viewport-length reports.
- Right-aligned numeric columns and stable column widths.
- Hover and keyboard cursor states remain distinguishable.
- Total rows keep the ledger double rule.
- Empty tables explain how records enter the report and offer the relevant action when safe.

### Status

- Use text plus shape/icon; color never carries meaning alone.
- Amber: attention or pending review.
- Red: blocking error, overdue or destructive action.
- Green: balanced, reconciled, filed or complete.
- Blue: informational link or external/reference state.

### Motion

- 120-180ms transitions for hover, focus, panel expansion and state changes.
- Transform and opacity only.
- No automatic movement, parallax, marquee or scroll hijacking inside the desktop app.
- Respect reduced-motion preference globally.

## Screen direction

### Gateway

- Replace the uniform metric-card row with a financial position strip and one dominant daily action.
- Keep the compliance calendar visible without scrolling on a common laptop viewport.
- Separate daily work from the full screen directory.

### Action Centre

- Rank work by urgency, value and due date.
- Use two-column grouped lists at wide widths and a single column below 900px.
- Every row explains why it needs attention and where the click leads.

### Voucher Entry

- Keep voucher type shortcuts in a single horizontal switcher.
- Give debit/credit balance and validation a persistent place.
- Keep the primary save action visible for long entries.
- Use inline details rather than opening modal windows for simple secondary fields.

### Reports

- Introduce one shared report header with period, comparison, saved view, export and provenance.
- Keep control density compact and preserve full-width data tables.
- Totals and comparison deltas must drill to their source vouchers.

### Settings

- Group by Company, Accounting, Automation, Data & privacy, Users and About.
- Surface current state and risk before controls.
- Keep provider keys and credentials masked with explicit replace/clear actions.

## Accessibility and verification

- All workflows remain keyboard-completable.
- Focus order follows the visible layout and every icon action has an accessible name.
- Body text and controls meet WCAG AA in both themes.
- The app must remain usable at 125% and 150% text scaling.
- Loading skeletons match final geometry; errors are contextual; empty states offer a next action.
- Visual QA covers 1280x800 and 1440x900 in light and dark themes.
- Existing data-testid hooks and shortcut behavior remain stable unless a migration test documents a
  deliberate change.
