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
  className = '',
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
  const moveFocus = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number,
  ): void => {
    const previousKey = vertical ? 'ArrowUp' : 'ArrowLeft'
    const nextKey = vertical ? 'ArrowDown' : 'ArrowRight'
    let next = index
    if (event.key === previousKey)
      next = (index - 1 + tabs.length) % tabs.length
    else if (event.key === nextKey) next = (index + 1) % tabs.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = tabs.length - 1
    else return
    event.preventDefault()
    const target = tabs[next]
    if (!target) return
    onSelect(target.id)
    const buttons =
      event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
        '[role="tab"]',
      )
    requestAnimationFrame(() => buttons?.[next]?.focus())
  }

  return (
    <div
      role="tablist"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      className={`flex ${vertical ? 'flex-col gap-0.5' : 'items-center gap-1'} ${className}`}
    >
      {tabs.map((t, index) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          data-testid={tid('tab', screen, t.id)}
          aria-selected={active === t.id}
          tabIndex={active === t.id ? 0 : -1}
          onClick={() => onSelect(t.id)}
          onKeyDown={(event) => moveFocus(event, index)}
          className={`rounded-md px-3 py-1.5 text-[13px] transition-colors ${vertical ? 'px-2.5 text-left' : ''} ${
            active === t.id
              ? 'bg-amber/15 font-medium text-amber'
              : 'text-muted hover:bg-panel2 hover:text-ink'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}
