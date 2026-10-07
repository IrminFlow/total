import { useRef, useState, type ReactNode } from 'react'
import { Popover, PopoverButton } from '../table/Popover'

/**
 * Kit-level names for the table platform's anchored Popover (portals into the topmost dialog,
 * Esc closes it first, outside-click closes it) — use these in screens instead of importing from
 * components/table.
 */
export { Popover, PopoverButton }

export interface MenuItem {
  label: string
  onSelect: () => void
  /** Rendered in danger red ("Delete…"). */
  danger?: boolean
  disabled?: boolean
  testId?: string
  /** Right-aligned hint, e.g. a shortcut. */
  hint?: string
}

/**
 * A button that opens a menu of actions (role="menu"): ↑/↓ move between items, Enter/Space
 * picks, Esc closes and returns focus to the button.
 */
export function MenuButton({
  label,
  children,
  items,
  align = 'right',
  width = 220,
  testId,
  className
}: {
  /** Accessible name of the trigger. */
  label: string
  /** Trigger content (defaults to the label). */
  children?: ReactNode
  items: MenuItem[]
  align?: 'left' | 'right'
  width?: number
  testId?: string
  className?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <PopoverButton
      label={label}
      popoverLabel={label}
      open={open}
      setOpen={setOpen}
      align={align}
      width={width}
      testId={testId}
      className={className}
      render={(close) => <MenuList items={items} close={close} testId={testId} />}
    >
      {children ?? label}
    </PopoverButton>
  )
}

function MenuList({ items, close, testId }: { items: MenuItem[]; close: () => void; testId?: string }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const move = (dir: 1 | -1): void => {
    const els = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? [])
    if (els.length === 0) return
    const i = els.indexOf(document.activeElement as HTMLButtonElement)
    els[(i + dir + els.length) % els.length]?.focus()
  }
  return (
    <div
      ref={ref}
      role="menu"
      data-testid={testId && `${testId}-menu`}
      className="-m-2 flex flex-col"
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          e.stopPropagation()
          move(e.key === 'ArrowDown' ? 1 : -1)
        }
      }}
    >
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          role="menuitem"
          disabled={it.disabled}
          data-testid={it.testId}
          onClick={() => {
            close()
            it.onSelect()
          }}
          className={`flex items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-left text-detail hover:bg-panel2 focus-visible:bg-panel2 disabled:opacity-40 ${
            it.danger ? 'text-danger' : 'text-ink'
          }`}
        >
          {it.label}
          {it.hint && <span className="text-small text-muted">{it.hint}</span>}
        </button>
      ))}
    </div>
  )
}
