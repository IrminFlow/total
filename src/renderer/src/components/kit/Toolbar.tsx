import type { ReactNode } from 'react'

/**
 * A row of controls above content (filters on the left, actions on the right). Wraps on narrow
 * windows. `bordered` draws the rule used at the top of a Panel (the DataTable toolbar look).
 */
export function Toolbar({
  children,
  label,
  bordered = false,
  className = '',
  testId
}: {
  children: ReactNode
  /** Accessible name — a toolbar with several controls should say what it controls. */
  label?: string
  bordered?: boolean
  className?: string
  testId?: string
}): React.JSX.Element {
  return (
    <div
      role="toolbar"
      aria-label={label}
      data-testid={testId}
      className={`flex flex-wrap items-center gap-2 ${bordered ? 'border-b border-line px-3 py-2' : ''} ${className}`}
    >
      {children}
    </div>
  )
}

/** Pushes the following toolbar items to the right edge. */
export function ToolbarSpacer(): React.JSX.Element {
  return <span aria-hidden="true" className="flex-1" />
}
