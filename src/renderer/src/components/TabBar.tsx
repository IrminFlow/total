import { tid } from '../lib/testids'

export interface TabItem<T extends string = string> {
  id: T
  label: string
}

/**
 * The one tab bar (v0.3 lane S2) — unified active style for every tabbed screen
 * (Masters, Settings, Payroll, Outstandings, Registers).
 *
 * Testids follow lib/testids.ts: `tab-<screen>-<tab>`, where `screen` is the registry
 * screen name VERBATIM and `tab` is the tab id verbatim (e.g. tab-masters-ledgers,
 * tab-settings-backups, tab-masters-stock-groups).
 */
export function TabBar<T extends string>({
  screen,
  tabs,
  active,
  onSelect,
  vertical = false,
  className = ''
}: {
  /** Registry screen name from lib/screens.ts — becomes the testid's <area> segment. */
  screen: string
  tabs: readonly TabItem<T>[]
  active: T
  onSelect: (id: T) => void
  /** Sidebar-style vertical stack (Settings) instead of the horizontal row (Masters). */
  vertical?: boolean
  className?: string
}): React.JSX.Element {
  return (
    <nav className={`flex ${vertical ? 'flex-col gap-0.5' : 'items-center gap-1'} ${className}`}>
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          data-testid={tid('tab', screen, t.id)}
          aria-current={active === t.id ? 'page' : undefined}
          onClick={() => onSelect(t.id)}
          className={`rounded-md px-3 py-1.5 text-detail transition-colors ${vertical ? 'px-2.5 text-left' : ''} ${
            active === t.id ? 'bg-amber/15 font-medium text-amber' : 'text-muted hover:bg-panel2 hover:text-ink'
          }`}
        >
          {t.label}
        </button>
      ))}
    </nav>
  )
}
