# Design-system kit (`components/kit`)

The building blocks every screen is made of. Import from `../components/ui` (which re-exports
the kit, so older imports keep working) or from `../components/kit` (which also has the
`Popover` / `MenuButton` pair).

The character to keep: a quiet, keyboard-first ledger tool. IBM Plex Sans / Serif / Mono, warm
off-white light theme, deep navy dark theme, the amber selection bar, green Dr / red Cr.

## Tokens (`app.css`)

All values are `--t-*` custom properties on `:root` / `[data-theme='dark']` /
`[data-density='compact']`, mapped into Tailwind through `@theme inline`. Use the utilities,
never raw values:

| Kind | Utilities | Notes |
|---|---|---|
| Surfaces | `bg-bg` `bg-panel` `bg-panel2` `bg-raised` `bg-scrim` | page → panel → header band/inset → popover/drawer/modal |
| Lines | `border-line` `border-line-strong` | |
| Text | `text-ink` `text-muted` `text-amber` `text-dr` `text-cr` `text-blue` `text-on-amber` | all ≥ 4.5:1 on every surface, both themes |
| Status | `text-success/warning/danger/info`, `bg-*-soft` | derived from dr / amber / cr / blue |
| Focus | `--t-focus` (the global `:focus-visible` outline), `--t-focus-ring` | ≥ 3:1 on bg and panel |
| Elevation | `shadow-elev-1` (panels) `-2` (popovers, toasts) `-3` (modal, drawer) | dark theme swaps shadows for borders |
| Radius | `rounded-sm/md/lg/xl` → 4 / 6 / 8 / 12 px | |
| Spacing | Tailwind's 4px scale, plus density-aware `p-page` `gap-section` `p-panel` `h-control` `h-control-sm` `px-control-x` | |
| Type | `text-micro` 10 · `label` 10.5 · `caption` 11 · `hint` 11.5 · `small` 12 · `body-sm` 12.5 · `detail` 13 · `body` 13.5 · `lead` 14.5 · `subtitle` 15 · `title` 16 · `brand` 17 · `heading` 19 · `display` 28 · `hero` 34 | a raw `text-[Npx]` fails `__tests__/typeScale.test.ts` |

Density (`comfortable` / `compact`, Settings → Appearance) sets `data-density` on `<html>`;
table row height, cell padding, control height and page/panel padding follow it. A DataTable
whose saved view picks a density sets its own `data-density`, which wins inside the table.

Motion: transitions use `--t-duration`; everything collapses to instant under
`prefers-reduced-motion` or Settings → Appearance → Reduce motion (`data-motion="reduce"`).

Contrast is checked on the token values by `__tests__/tokens.test.ts` and on screen by
`scripts/e2e/12-theme-a11y.mjs`.

## Page structure

### `Page` + `PageHeader`

```tsx
<Page width="standard">            {/* narrow | medium | standard (default) | wide */}
  <PageHeader
    title="Trial balance"
    period={`as on ${toDisplayDate(to)}`}   // mono, muted
    subtitle="…"                            // optional free text
    breadcrumb="Current Assets › Sundry Debtors"
    tabs={<TabBar … />}                     // primary views — always visible
    controls={<MonthSelect … />}            // always-visible selectors (period, bank account)
    secondary={<Button>Rules…</Button>}
    actions={<Button variant="primary">Export JSON</Button>}
    options={{ content: <…DrawerSections…/>, onReset }}   // adds Options button + F12
  />
  <Panel>…</Panel>
</Page>
```

The title is the page's `h1` (`data-testid="page-title"`). With `options`, an **Options** button
(`btn-<screen>-options`, also F12) opens a right `Drawer` (`options-<screen>`) with Reset /
Done in its footer. Per-screen option state lives in `useScreenOptions` (see
`components/ScreenOptions.tsx`).

### `Panel`, `SectionTitle`

`Panel` is the bordered card (`scroll={{ maxH }}` caps its height). `SectionTitle` is an `h2`
(or `as="h3"`) heading inside a page with an optional `right` slot.

## Controls

### `Button`, `IconButton`

```tsx
<Button variant="primary" onClick={save} loading={saving}>Save</Button>
<Button>Cancel</Button>                       {/* secondary (alias: variant="default") */}
<Button variant="ghost" size="sm" icon="⚙">Columns</Button>
<Button variant="danger" disabled disabledTitle="Owners only">Delete</Button>
<IconButton label="Close">✕</IconButton>
```

Variants: `primary` (one per view), `secondary`, `ghost`, `danger`. Sizes: `md` (control
height, follows density) and `sm` (toolbars). `loading` disables, sets `aria-busy` and shows a
spinner. `buttonClass(variant, size)` gives the class string for button-looking non-buttons.

### `Field`, `TextInput`, `Select`, `Textarea`, `Checkbox`

```tsx
<Field label="GSTIN" hint="15 characters" error={err} required>
  <TextInput value={v} onChange={…} />
</Field>
```

The caption is the control's accessible name; hint/error are linked with
`aria-describedby`, an error sets `aria-invalid` and announces. Outside a Field use
`<TextInput invalid />`. `inputCls` / `inputSmCls` style custom controls; `useFieldAria()` gives
a custom control inside a Field its aria props (AmountInput, DateInput use it).

### `TabBar` (alias `Tabs`)

```tsx
<TabBar screen="outstandings" tabs={[{ id: 'receivable', label: 'Receivables' }, …]} active={side} onSelect={setSide} />
```

ARIA tabs (`role="tablist"`, `aria-selected`, roving tabindex). ←/→ (↑/↓ with `vertical`) move
focus, Home/End jump, Enter/Space or click activates. Testids `tab-<screen>-<id>`. `count`
shows a number after the label.

### `Toolbar`, `ToolbarSpacer`

`<Toolbar label="Filters" bordered>…<ToolbarSpacer />…</Toolbar>` — a wrapping
`role="toolbar"` row; `bordered` is the rule at the top of a Panel.

## Overlays

### `Modal`

Centred dialog (`ui.tsx`), `dirty` asks before discarding. Shares the dialog-layer stack with
Drawer (`kit/layers.ts`): only the top layer gets Esc/Tab, focus is trapped and restored, keyboard
lists behind it pause.

### `Drawer`, `DrawerSection`

```tsx
{open && (
  <Drawer title="Options" subtitle="…" onClose={close} footer={<Button variant="primary" onClick={close}>Done</Button>}>
    <DrawerSection title="Display">…</DrawerSection>
  </Drawer>
)}
```

Right-side panel on a scrim. Esc closes the topmost layer only, so a Modal opened from a
Drawer closes first.

### `Popover`, `PopoverButton`, `MenuButton`

The table platform's anchored popover, exported under kit names. `MenuButton` is an action menu:

```tsx
<MenuButton label="Payslips" items={[{ label: 'Print all', onSelect: printAll }, { label: 'Delete run', onSelect: del, danger: true }]} />
```

`role="menu"`, ↑/↓ between items, Esc returns focus to the trigger.

## Status and data display

| Component | Use |
|---|---|
| `Badge tone="neutral\|info\|success\|warning\|danger\|amber"` | inline status label: Optional, PDC, Filed |
| `Chip onRemove / onClick selected` | applied filter pill, toggle token |
| `Banner tone title action onDismiss` | message strip above content; danger/warning are alerts |
| `StatTile label value delta deltaTone sparkline tone onClick` + `StatGrid` | headline figures (the sparkline slot takes WP 1.10b's chart components) |
| `Money paise signed` | ledger amount: mono, Dr green / Cr red, dash for zero |
| `EmptyState title hint action compact` | the one "nothing here" state |
| `Spinner`, `Skeleton`, `SkeletonRows`, `SkeletonTiles` | loading |
| `Kbd` | key cap |
| `Checklist items onOpen hideDone` | setup checklist; feed it `useOnboardingChecklist()` (lib/onboarding.ts) |

## Conventions

- Amounts right-aligned, mono (`num`), Dr/Cr coloured only when the sign matters (`signed`).
- The amber keyboard bar on table rows is an inset box-shadow on the first cell, never
  `tr::before`.
- Every control has a visible label or an `aria-label`; icon-only buttons use `IconButton`.
- Esc closes the top layer (popover → modal/drawer → screen back); Enter activates the focused
  control or the active row.
