import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { toDisplayDate } from '@shared/dates'
import { usePeriodPicker, useSession } from '../state/stores'
import { Button, Checkbox, DrawerSection } from './ui'
import { Segmented } from './kit/Segmented'
import { useOptionsDrawer } from './kit/PageHeader'
import { tableActions } from './table/tableActions'

/**
 * Per-screen options (the PageHeader Options drawer, F12). A display preference like the sidebar
 * sections and table views — localStorage under `total-screenopts-<company-slug>-<screen>`, never
 * the company database. Every change is saved straight away, so the drawer's choices are the
 * screen's defaults next time; "Reset to defaults" restores the screen's declared defaults.
 *
 * Stored values are merged defensively: only keys the screen declares, with the same type, are
 * read back (a renamed or retyped option falls back to its default).
 */
export function screenOptionsKey(slug: string | null, screen: string): string {
  return `total-screenopts-${slug ?? 'nocompany'}-${screen}`
}

export function parseScreenOptions<T extends Record<string, unknown>>(raw: string | null, defaults: T, allowed?: Partial<Record<keyof T, readonly unknown[]>>): T {
  if (!raw) return defaults
  let o: unknown
  try {
    o = JSON.parse(raw)
  } catch {
    return defaults
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return defaults
  const out = { ...defaults }
  for (const k of Object.keys(defaults) as (keyof T)[]) {
    const v = (o as Record<string, unknown>)[k as string]
    if (v === undefined || typeof v !== typeof defaults[k]) continue
    const values = allowed?.[k]
    if (values && !values.includes(v)) continue
    out[k] = v as T[keyof T]
  }
  return out
}

export interface ScreenOptionsController<T> {
  options: T
  set: <K extends keyof T>(key: K, value: T[K]) => void
  reset: () => void
  isDefault: boolean
}

export function useScreenOptions<T extends Record<string, unknown>>(
  screen: string,
  defaults: T,
  /** Allowed values per key (for string unions), so a stale stored value can't leak in. */
  allowed?: Partial<Record<keyof T, readonly unknown[]>>
): ScreenOptionsController<T> {
  const slug = useSession((s) => s.slug)
  const key = screenOptionsKey(slug, screen)
  const defaultsSig = JSON.stringify(defaults)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableDefaults = useMemo(() => defaults, [defaultsSig])
  const load = useCallback((): T => {
    let raw: string | null = null
    try {
      raw = localStorage.getItem(key)
    } catch {
      /* ignore */
    }
    return parseScreenOptions(raw, stableDefaults, allowed)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, stableDefaults])
  const [options, setOptions] = useState<T>(load)
  // Each company keeps its own screen options.
  useEffect(() => setOptions(load()), [load])

  const write = (next: T): void => {
    try {
      localStorage.setItem(key, JSON.stringify(next))
    } catch {
      /* quota / private mode — still applies for this session */
    }
  }
  return {
    options,
    set: (k, v) =>
      setOptions((cur) => {
        const next = { ...cur, [k]: v }
        write(next)
        return next
      }),
    reset: () => {
      try {
        localStorage.removeItem(key)
      } catch {
        /* ignore */
      }
      setOptions(stableDefaults)
    },
    isDefault: JSON.stringify(options) === defaultsSig
  }
}

// ---------- drawer building blocks ----------

/** "Period": the working period (or as-on date) with a Change… button (the header's modal). */
export function OptionsPeriod({ asOn = false, note }: { asOn?: boolean; note?: ReactNode }): React.JSX.Element {
  const { from, to } = useSession()
  const openPicker = usePeriodPicker((s) => s.setOpen)
  return (
    <DrawerSection title="Period" testId="options-period">
      <div className="flex items-center justify-between gap-3">
        <span className="num text-detail text-ink">{asOn ? `as on ${toDisplayDate(to)}` : `${toDisplayDate(from)} → ${toDisplayDate(to)}`}</span>
        <Button size="sm" data-testid="options-change-period" onClick={() => openPicker(true)}>
          Change…
        </Button>
      </div>
      <p className="text-hint text-muted">{note ?? 'The working period is shared by every screen (also in the header).'}</p>
    </DrawerSection>
  )
}

/** A checkbox option row. */
export function OptionToggle({
  label,
  hint,
  checked,
  onChange,
  testId
}: {
  label: string
  hint?: ReactNode
  checked: boolean
  onChange: (v: boolean) => void
  testId?: string
}): React.JSX.Element {
  return <Checkbox label={label} hint={hint} checked={checked} onChange={onChange} testId={testId} />
}

/** A one-of-N option row (label above a Segmented control). */
export function OptionChoice<T extends string>({
  label,
  value,
  options,
  onChange,
  testId
}: {
  label: string
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (v: T) => void
  testId?: string
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-detail text-ink">{label}</span>
      <div>
        <Segmented label={label} options={options} value={value} onChange={onChange} testId={testId} size="sm" />
      </div>
    </div>
  )
}

/**
 * "Table": opens the main table's column chooser (closing the drawer first, since the chooser is
 * anchored to the table's toolbar) and its PDF / CSV export of the current view.
 */
export function OptionsTable({
  area,
  label = 'Table',
  exportable = true,
  extra
}: {
  /** The DataTable's testId area. */
  area: string
  label?: string
  exportable?: boolean
  extra?: ReactNode
}): React.JSX.Element {
  const drawer = useOptionsDrawer()
  return (
    <DrawerSection title={label} testId={`options-table-${area}`}>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          icon="⚙"
          data-testid={`options-${area}-columns`}
          onClick={() => {
            drawer.close()
            // After the drawer has unmounted (and handed focus back), open the anchored chooser.
            setTimeout(() => tableActions(area)?.openColumns(), 0)
          }}
        >
          Choose columns…
        </Button>
        {exportable && (
          <>
            <Button size="sm" variant="ghost" data-testid={`options-${area}-pdf`} onClick={() => tableActions(area)?.exportPdf?.()}>
              Export PDF
            </Button>
            <Button size="sm" variant="ghost" data-testid={`options-${area}-csv`} onClick={() => tableActions(area)?.exportCsv?.()}>
              Export CSV
            </Button>
          </>
        )}
      </div>
      {extra}
      <p className="text-hint text-muted">Sort, filter, group and density live in the table toolbar and saved views.</p>
    </DrawerSection>
  )
}

/** "Export": screen-specific export buttons (reports that aren't a DataTable). */
export function OptionsExport({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <DrawerSection title="Export" testId="options-export">
      <div className="flex flex-wrap gap-2">{children}</div>
    </DrawerSection>
  )
}
