import type { ReactNode } from 'react'

// ---------- loading ----------

/** Inline spinner. `label` is its accessible name (null = decorative, e.g. inside a busy Button). */
export function Spinner({ className = '', label = 'Loading' }: { className?: string; label?: string | null }): React.JSX.Element {
  return (
    <span
      role={label ? 'status' : undefined}
      aria-label={label ?? undefined}
      aria-hidden={label ? undefined : true}
      className={`inline-block h-4 w-4 animate-spin rounded-full border-2 border-line border-t-amber ${className}`}
    />
  )
}

/** One shimmering placeholder bar — size it with className (h-4 w-1/2 …). */
export function Skeleton({ className = '' }: { className?: string }): React.JSX.Element {
  return <span aria-hidden="true" className={`block animate-pulse rounded bg-panel2 ${className}`} />
}

/** Placeholder rows while a list/report query is in flight — drop inside a Panel. */
export function SkeletonRows({ rows = 8, className = '' }: { rows?: number; className?: string }): React.JSX.Element {
  return (
    <div aria-hidden="true" data-testid="skeleton-rows" className={`flex flex-col gap-2.5 p-4 ${className}`}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={`h-4 ${i % 3 === 0 ? 'w-2/3' : i % 3 === 1 ? 'w-full' : 'w-5/6'}`} />
      ))}
    </div>
  )
}

/** Placeholder for a row of StatTiles. */
export function SkeletonTiles({ count = 4 }: { count?: number }): React.JSX.Element {
  return (
    <div aria-hidden="true" className="grid gap-3" style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="rounded-lg border border-line bg-panel p-panel">
          <Skeleton className="h-3 w-1/2" />
          <Skeleton className="mt-2 h-5 w-2/3" />
        </div>
      ))}
    </div>
  )
}

// ---------- empty ----------

/**
 * The one "nothing here" state: a title, an optional hint and action. `compact` for use inside a
 * small panel or a table body; the default is the roomy page/panel version.
 */
export function EmptyState({
  title,
  hint,
  action,
  icon,
  compact = false,
  testId
}: {
  title: string
  hint?: ReactNode
  action?: ReactNode
  icon?: ReactNode
  compact?: boolean
  testId?: string
}): React.JSX.Element {
  return (
    <div data-testid={testId} className={`flex flex-col items-center justify-center text-center ${compact ? 'py-8' : 'py-16'}`}>
      {icon && (
        <div aria-hidden="true" className="mb-3 text-muted">
          {icon}
        </div>
      )}
      <p className={`${compact ? 'text-detail' : 'text-lead'} text-muted`}>{title}</p>
      {hint && <p className="mt-1 text-body-sm text-muted">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

// ---------- banner ----------

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

const BANNER_TONES: Record<Exclude<Tone, 'neutral'>, string> = {
  info: 'border-info/40 bg-info-soft',
  success: 'border-success/40 bg-success-soft',
  warning: 'border-warning/50 bg-warning-soft',
  danger: 'border-danger/50 bg-danger-soft'
}
const BANNER_TITLE: Record<Exclude<Tone, 'neutral'>, string> = {
  info: 'text-info',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger'
}

/**
 * A full-width message strip above content: info / success / warning / danger, with an optional
 * title, action (a Button) and dismiss. Danger and warning announce as alerts; info as status.
 */
export function Banner({
  tone = 'info',
  title,
  children,
  action,
  onDismiss,
  className = '',
  testId
}: {
  tone?: Exclude<Tone, 'neutral'>
  title?: ReactNode
  children?: ReactNode
  action?: ReactNode
  onDismiss?: () => void
  className?: string
  testId?: string
}): React.JSX.Element {
  return (
    <div
      role={tone === 'danger' || tone === 'warning' ? 'alert' : 'status'}
      data-testid={testId}
      data-tone={tone}
      className={`flex items-start gap-3 rounded-lg border px-4 py-2.5 text-body-sm text-ink ${BANNER_TONES[tone]} ${className}`}
    >
      <div className="min-w-0 flex-1">
        {title && <p className={`font-semibold ${BANNER_TITLE[tone]}`}>{title}</p>}
        {children && <div className={title ? 'mt-0.5' : ''}>{children}</div>}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
      {onDismiss && (
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="shrink-0 self-center rounded px-1 text-muted hover:text-ink"
        >
          ✕
        </button>
      )}
    </div>
  )
}
