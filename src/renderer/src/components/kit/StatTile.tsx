import type { ReactNode } from 'react'
import { Skeleton } from './Feedback'

/**
 * A headline figure: uppercase label, a large mono value, an optional delta / hint line and a
 * sparkline slot, then an optional footer line. `onClick` makes the whole tile a button (drill
 * into the figure; `openLabel` says where it goes). `loading` shows a skeleton, `error` an
 * "Unavailable" alert in place of the value. `tone` colours the value (dr / cr / amber); the
 * delta's tone is independent.
 *
 * With a testId the value carries id `<testId>-value` (the tile's aria-describedby), so drivers
 * can read the figure alone.
 */
export function StatTile({
  label,
  value,
  delta,
  deltaTone = 'neutral',
  hint,
  sparkline,
  reserveSparkline = false,
  footer,
  tone,
  size = 'md',
  loading = false,
  error,
  onClick,
  openLabel,
  testId,
  className = ''
}: {
  label: ReactNode
  value: ReactNode
  /** "+12% vs last month", "3 overdue"… */
  delta?: ReactNode
  deltaTone?: 'neutral' | 'up' | 'down' | 'success' | 'danger' | 'warning'
  hint?: ReactNode
  /** An inline SVG chart (components/charts Sparkline) — sits under the value. */
  sparkline?: ReactNode
  /** Keep the sparkline's height even while it is empty (loading / error), so a row of tiles lines up. */
  reserveSparkline?: boolean
  /** A muted line under the sparkline ("Cash 1.2L · Bank 3.4L"). */
  footer?: ReactNode
  tone?: 'dr' | 'cr' | 'amber'
  /** 'lg' for dashboard headline figures. */
  size?: 'md' | 'lg'
  loading?: boolean
  /** Replaces the value with "Unavailable" (the message is its tooltip). */
  error?: string | null
  onClick?: () => void
  /** Where a click goes, e.g. "Open Outstandings" — tooltip and part of the accessible name. */
  openLabel?: string
  testId?: string
  className?: string
}): React.JSX.Element {
  const deltaCls = {
    neutral: 'text-muted',
    up: 'text-success',
    success: 'text-success',
    down: 'text-danger',
    danger: 'text-danger',
    warning: 'text-warning'
  }[deltaTone]
  const valueCls = tone === 'dr' ? 'text-dr' : tone === 'cr' ? 'text-cr' : tone === 'amber' ? 'text-amber' : 'text-ink'
  const valueId = testId ? `${testId}-value` : undefined
  const ready = !loading && !error
  const body = (
    <>
      <span className="block truncate text-label font-semibold tracking-[0.08em] text-muted uppercase">{label}</span>
      <span id={valueId} className={`mt-1 block ${size === 'lg' ? 'min-h-[22px]' : ''}`}>
        {loading ? (
          <Skeleton className="mt-1 h-4 w-24" />
        ) : error ? (
          <span role="alert" className="text-small text-danger" title={error}>
            Unavailable
          </span>
        ) : (
          <span className={`num block truncate font-medium leading-tight ${size === 'lg' ? 'text-brand' : 'text-subtitle'} ${valueCls}`}>{value}</span>
        )}
      </span>
      {ready && (delta || hint) && (
        <span className="mt-0.5 flex items-baseline gap-2 text-hint">
          {delta && <span className={deltaCls}>{delta}</span>}
          {hint && <span className="text-muted">{hint}</span>}
        </span>
      )}
      {(sparkline || reserveSparkline) && <span className="mt-1 block h-7">{ready && sparkline}</span>}
      {footer !== undefined && <span className="mt-0.5 block truncate text-label text-muted">{ready && footer ? footer : ' '}</span>}
    </>
  )
  const cls = `block min-w-0 rounded-lg border border-line bg-panel text-left shadow-elev-1 ${
    size === 'lg' ? 'px-3.5 pt-2.5 pb-2' : 'p-panel'
  } ${className}`
  return onClick ? (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      title={openLabel}
      aria-label={openLabel ? `${typeof label === 'string' ? label : ''}. ${openLabel}` : undefined}
      aria-describedby={valueId}
      className={`${cls} flex h-full w-full flex-col transition-colors hover:border-amber/60 focus-visible:border-amber`}
    >
      {body}
    </button>
  ) : (
    <div data-testid={testId} className={cls}>
      {body}
    </div>
  )
}

/** A responsive row of StatTiles (2 → 4 columns). */
export function StatGrid({ children, className = '' }: { children: ReactNode; className?: string }): React.JSX.Element {
  return <div className={`grid grid-cols-2 gap-3 lg:grid-cols-4 ${className}`}>{children}</div>
}
