import { useRef } from 'react'
import { tid } from '../../lib/testids'

export interface TabItem<T extends string = string> {
  id: T
  label: string
  /** Small count/badge after the label ("Unmatched 3"). */
  count?: number
}

/**
 * The one tab component (TabBar) — every tabbed screen uses it: Masters, Settings, Payroll,
 * Outstandings, Registers, Ledger statement, Banking, Search.
 *
 * ARIA tabs: role="tablist" / role="tab" with aria-selected and a roving tabindex. ←/→ (↑/↓ when
 * vertical) move focus between tabs, Home/End jump, Enter/Space activates — manual activation, so
 * arrowing past tabs that navigate (Masters, Settings push the nav stack) doesn't load each one.
 *
 * Testids follow lib/testids.ts: `tab-<screen>-<tab>`, where `screen` is the registry screen name
 * VERBATIM and `tab` is the tab id verbatim (e.g. tab-masters-ledgers, tab-settings-backups).
 */
export function TabBar<T extends string>({
  screen,
  tabs,
  active,
  onSelect,
  vertical = false,
  label,
  className = ''
}: {
  /** Registry screen name from lib/screens.ts — becomes the testid's <area> segment. */
  screen: string
  tabs: readonly TabItem<T>[]
  active: T
  onSelect: (id: T) => void
  /** Sidebar-style vertical stack (Settings) instead of the horizontal row (Masters). */
  vertical?: boolean
  /** Accessible name of the tab list (default: "<screen> sections"). */
  label?: string
  className?: string
}): React.JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)
  const focusTab = (i: number): void => {
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    if (!buttons || buttons.length === 0) return
    buttons[(i + buttons.length) % buttons.length]?.focus()
  }
  const onKeyDown = (e: React.KeyboardEvent, i: number): void => {
    const next = vertical ? 'ArrowDown' : 'ArrowRight'
    const prev = vertical ? 'ArrowUp' : 'ArrowLeft'
    if (e.key === next) focusTab(i + 1)
    else if (e.key === prev) focusTab(i - 1)
    else if (e.key === 'Home') focusTab(0)
    else if (e.key === 'End') focusTab(tabs.length - 1)
    else return
    // Keep the arrow away from the screen's list navigation (useKeyNav listens on window).
    e.preventDefault()
    e.stopPropagation()
  }
  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={label ?? `${screen.replace(/-/g, ' ')} sections`}
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      className={`flex ${vertical ? 'flex-col gap-0.5' : 'flex-wrap items-center gap-1'} ${className}`}
    >
      {tabs.map((t, i) => {
        const selected = active === t.id
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            data-testid={tid('tab', screen, t.id)}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(t.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={`rounded-md px-3 py-1.5 text-detail whitespace-nowrap transition-colors ${vertical ? 'px-2.5 text-left' : ''} ${
              selected ? 'bg-amberbar/15 font-medium text-amber' : 'text-muted hover:bg-panel2 hover:text-ink'
            }`}
          >
            {t.label}
            {t.count != null && <span className="num ml-1.5 text-small text-muted">{t.count}</span>}
          </button>
        )
      })}
    </div>
  )
}

/** Alias — `Tabs` reads better in new code; it is the same component. */
export const Tabs = TabBar
