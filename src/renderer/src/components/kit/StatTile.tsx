import type { ReactNode } from 'react'

/**
 * A headline figure: uppercase label, a large mono value, an optional delta and sparkline slot.
 * `onClick` makes the whole tile a button (drill into the figure). `tone` colours the value
 * (e.g. 'dr' / 'cr' for a signed balance); the delta's tone is independent.
 */
export function StatTile({
  label,
  value,
  delta,
  deltaTone = 'neutral',
  hint,
  sparkline,
  tone,
  onClick,
  testId,
  className = ''
}: {
  label: ReactNode
  value: ReactNode
  /** "+12% vs last month", "3 overdue"… */
  delta?: ReactNode
  deltaTone?: 'neutral' | 'up' | 'down' | 'success' | 'danger' | 'warning'
  hint?: ReactNode
  /** An inline SVG chart (WP 1.10b's components/charts Sparkline) — sits under the value. */
  sparkline?: ReactNode
  tone?: 'dr' | 'cr' | 'amber'
  onClick?: () => void
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
  const body = (
    <>
      <span className="block text-label font-semibold tracking-[0.08em] text-muted uppercase">{label}</span>
      <span className={`num mt-1 block text-subtitle font-medium ${valueCls}`}>{value}</span>
      {(delta || hint) && (
        <span className="mt-0.5 flex items-baseline gap-2 text-hint">
          {delta && <span className={deltaCls}>{delta}</span>}
          {hint && <span className="text-muted">{hint}</span>}
        </span>
      )}
      {sparkline && <span className="mt-2 block">{sparkline}</span>}
    </>
  )
  const cls = `block rounded-lg border border-line bg-panel p-panel text-left shadow-elev-1 ${className}`
  return onClick ? (
    <button type="button" data-testid={testId} onClick={onClick} className={`${cls} w-full transition-colors hover:border-amber/60`}>
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
