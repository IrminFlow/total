import type { ReactNode } from 'react'
import type { Tone } from './Feedback'

export type BadgeTone = Tone | 'amber'

const BADGE: Record<BadgeTone, string> = {
  neutral: 'bg-panel2 text-muted border-line',
  info: 'bg-info-soft text-info border-info/30',
  success: 'bg-success-soft text-success border-success/30',
  warning: 'bg-warning-soft text-warning border-warning/40',
  danger: 'bg-danger-soft text-danger border-danger/40',
  amber: 'bg-amberbar/15 text-amber border-amberbar/40'
}

/**
 * A small status label inside a row or heading: "Optional", "PDC", "Filed", "Overdue".
 * Status variants map to the semantic tokens; the text always clears AA on its tint.
 */
export function Badge({
  tone = 'neutral',
  children,
  className = '',
  title,
  testId
}: {
  tone?: BadgeTone
  children: ReactNode
  className?: string
  title?: string
  testId?: string
}): React.JSX.Element {
  return (
    <span
      title={title}
      data-testid={testId}
      data-tone={tone}
      className={`inline-flex items-center rounded border px-1.5 py-px align-middle text-micro font-medium whitespace-nowrap ${BADGE[tone]} ${className}`}
    >
      {children}
    </span>
  )
}

/**
 * A rounded pill for an applied filter or a selectable token. With `onRemove` it gets a ✕ button
 * (named "Remove <label>"); with `onClick` the chip itself is a toggle button (`selected`).
 */
export function Chip({
  children,
  tone = 'amber',
  selected,
  onClick,
  onRemove,
  removeLabel,
  className = '',
  testId
}: {
  children: ReactNode
  tone?: BadgeTone
  selected?: boolean
  onClick?: () => void
  onRemove?: () => void
  /** Accessible name of the ✕ (default "Remove filter"). */
  removeLabel?: string
  className?: string
  testId?: string
}): React.JSX.Element {
  const toneCls = tone === 'amber' ? 'border-amberbar/50 bg-amberbar/10 text-ink' : BADGE[tone]
  const base = `inline-flex items-center gap-1.5 rounded-full border py-0.5 text-small ${onRemove ? 'pr-1 pl-2.5' : 'px-2.5'} ${toneCls} ${className}`
  if (onClick) {
    return (
      <button
        type="button"
        data-testid={testId}
        aria-pressed={selected}
        onClick={onClick}
        className={`${base} ${selected ? 'font-medium ring-1 ring-amberbar' : 'hover:border-amber/60'}`}
      >
        {children}
      </button>
    )
  }
  return (
    <span data-testid={testId} className={base}>
      {children}
      {onRemove && (
        <button
          type="button"
          aria-label={removeLabel ?? 'Remove filter'}
          onClick={onRemove}
          className="rounded-full px-1 text-muted hover:text-ink"
        >
          ✕
        </button>
      )}
    </span>
  )
}
