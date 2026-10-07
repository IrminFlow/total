import type { ReactNode } from 'react'

export interface ChecklistItem {
  id: string
  label: string
  hint?: string
  done: boolean
  /** Not applicable — shown ticked and muted. */
  skipped?: boolean
}

/**
 * A setup checklist: progress line, then one row per step with a tick or an action button. Pure
 * presentation — feed it `deriveOnboarding(...).steps` (src/shared/onboarding.ts) via
 * `useOnboardingChecklist` (lib/onboarding.ts). The Gateway (WP 1.10b) places it.
 */
export function Checklist({
  title = 'Getting started',
  items,
  onOpen,
  actionLabel = 'Open',
  hideDone = false,
  footer,
  testId = 'onboarding-checklist'
}: {
  title?: string
  items: readonly ChecklistItem[]
  /** Called with the step id when its action button is pressed (navigate to where it's done). */
  onOpen?: (id: string) => void
  actionLabel?: string
  /** Collapse finished steps out of the list (the progress line still counts them). */
  hideDone?: boolean
  footer?: ReactNode
  testId?: string
}): React.JSX.Element {
  const done = items.filter((i) => i.done).length
  const pct = items.length ? Math.round((done / items.length) * 100) : 100
  const shown = hideDone ? items.filter((i) => !i.done) : items
  return (
    <section data-testid={testId} aria-label={title} className="rounded-lg border border-line bg-panel p-panel shadow-elev-1">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-serif text-title font-semibold">{title}</h2>
        <span className="num text-small text-muted" data-testid={`${testId}-progress`}>
          {done} of {items.length} done
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={`${title} progress`}
        aria-valuemin={0}
        aria-valuemax={items.length}
        aria-valuenow={done}
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-panel2"
      >
        <div className="h-full rounded-full bg-amberbar" style={{ width: `${pct}%` }} />
      </div>
      <ul className="mt-3 flex flex-col">
        {shown.map((item) => (
          <li
            key={item.id}
            data-testid={`${testId}-${item.id}`}
            data-done={item.done}
            className="flex items-start gap-3 border-t border-line/60 py-2 first:border-t-0"
          >
            <span
              aria-hidden="true"
              className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-micro ${
                item.done ? 'border-success bg-success-soft text-success' : 'border-line-strong text-transparent'
              }`}
            >
              ✓
            </span>
            <span className="min-w-0 flex-1">
              <span className={`block text-detail ${item.done ? 'text-muted line-through decoration-line-strong' : 'text-ink'}`}>
                {item.label}
                <span className="sr-only">{item.done ? (item.skipped ? ' (not needed)' : ' (done)') : ' (to do)'}</span>
              </span>
              {item.hint && !item.done && <span className="block text-hint text-muted">{item.hint}</span>}
            </span>
            {!item.done && onOpen && (
              <button
                type="button"
                data-testid={`${testId}-${item.id}-open`}
                onClick={() => onOpen(item.id)}
                className="shrink-0 rounded-md px-2 py-0.5 text-small text-blue hover:underline"
                aria-label={`${actionLabel}: ${item.label}`}
              >
                {actionLabel}
              </button>
            )}
          </li>
        ))}
      </ul>
      {footer && <div className="mt-2">{footer}</div>}
    </section>
  )
}
