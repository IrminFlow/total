import { requestExplain, useAiAffordances, type ExplainInput } from '../../lib/explain'

/**
 * "Explain this" (WP 5.2): a small AI action on a money figure. It asks the assistant to explain
 * the figure from its source (screen, ids, period) — a tool-backed breakdown, never arithmetic by
 * the model. Renders nothing while the assistant is off. `figure` may be a function, read at click
 * time (so a tile can describe what it shows without re-rendering).
 *
 * Kept out of the Tab order by default (`focusable`): it sits on every money cell of a table, and
 * a Tab stop per cell would bury the table's own controls. Clicks never reach the row or tile
 * underneath (row activation / tile drill).
 */
export function ExplainButton({
  figure,
  className = '',
  focusable = false,
  testId = 'btn-explain'
}: {
  figure: ExplainInput | (() => ExplainInput | null)
  className?: string
  focusable?: boolean
  testId?: string
}): React.JSX.Element | null {
  const on = useAiAffordances()
  if (!on) return null
  const label = typeof figure === 'function' ? 'Explain this figure' : `Explain ${figure.label}${figure.column ? ` — ${figure.column}` : ''}`
  return (
    <button
      type="button"
      data-testid={testId}
      data-explain=""
      tabIndex={focusable ? 0 : -1}
      title="Explain this (AI)"
      aria-label={label}
      className={`t-explain inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-sm border border-amber/50 bg-raised px-0.5 font-sans text-micro leading-none font-semibold text-amber hover:bg-amberbar/20 focus-visible:opacity-100 ${className}`}
      onClick={(e) => {
        e.stopPropagation()
        e.preventDefault()
        const f = typeof figure === 'function' ? figure() : figure
        if (f) requestExplain(f)
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') e.stopPropagation()
      }}
    >
      AI
    </button>
  )
}
