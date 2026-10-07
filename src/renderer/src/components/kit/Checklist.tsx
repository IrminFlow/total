import type { ReactNode } from 'react'

export interface ChecklistItem {
  id: string
  label: string
  hint?: string
  done: boolean
  /** Not applicable — shown ticked and muted. */
  skipped?: boolean
}

const COLS = { 1: '', 2: 'md:grid-cols-2', 3: 'md:grid-cols-2 xl:grid-cols-3' } as const

/**
 * A setup checklist: title + progress, then one row per step. With `onOpen` every unfinished row
 * is a button that goes to where the step is done. Pure presentation — feed it
 * `deriveOnboarding(...)` / `onboardingFromDashSetup(...)` steps (src/shared/onboarding.ts).
 *
 * Testids: `<testId>` on the section, `<testId>-progress`, and `<itemTestId>-<id>` on each row
 * (default itemTestId = testId) carrying data-done.
 */
export function Checklist({
  title = 'Getting started',
  items,
  onOpen,
  hideDone = false,
  columns = 1,
  bare = false,
  footer,
  testId = 'onboarding-checklist',
  itemTestId
}: {
  title?: string
  items: readonly ChecklistItem[]
  /** Called with the step id when an unfinished row is activated (navigate to where it's done). */
  onOpen?: (id: string) => void
  /** Collapse finished steps out of the list (the progress line still counts them). */
  hideDone?: boolean
  /** Lay the rows out in up to three columns on wide windows. */
  columns?: 1 | 2 | 3
  /** No panel chrome — for use inside a card that already has a border and a title row. */
  bare?: boolean
  footer?: ReactNode
  testId?: string
  itemTestId?: string
}): React.JSX.Element {
  const done = items.filter((i) => i.done).length
  const pct = items.length ? Math.round((done / items.length) * 100) : 100
  const shown = hideDone ? items.filter((i) => !i.done) : items
  const rowPrefix = itemTestId ?? testId

  const rowBody = (item: ChecklistItem): ReactNode => (
    <>
      <span
        aria-hidden="true"
        className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-micro ${
          item.done ? 'border-success bg-success-soft text-success' : 'border-line-strong text-transparent'
        }`}
      >
        ✓
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-detail ${item.skipped ? 'text-muted' : item.done ? 'text-muted line-through decoration-line-strong' : 'text-ink'}`}>
          {item.label}
          <span className="sr-only">{item.done ? (item.skipped ? ' (not needed)' : ' (done)') : ' (to do)'}</span>
        </span>
        {item.hint && (!item.done || item.skipped) && <span className="block truncate text-hint text-muted">{item.hint}</span>}
      </span>
    </>
  )

  return (
    <section
      data-testid={testId}
      aria-label={title}
      className={bare ? '' : 'rounded-lg border border-line bg-panel p-panel shadow-elev-1'}
    >
      {/* Bare: the enclosing card's title row already says "n/m done". */}
      {!bare && (
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="font-serif text-title font-semibold">{title}</h2>
          <span className="num text-small text-muted" data-testid={`${testId}-progress`}>
            {done} of {items.length} done
          </span>
        </div>
      )}
      <div
        role="progressbar"
        aria-label={`${title} progress`}
        aria-valuemin={0}
        aria-valuemax={items.length}
        aria-valuenow={done}
        className={`mt-2 h-1.5 overflow-hidden rounded-full bg-panel2 ${bare ? 'mx-4' : ''}`}
      >
        <div className="h-full rounded-full bg-amberbar" style={{ width: `${pct}%` }} />
      </div>
      <ul className={`mt-2 grid grid-cols-1 ${COLS[columns]}`}>
        {shown.map((item) => (
          <li key={item.id} className="min-w-0">
            {onOpen && !item.done ? (
              <button
                type="button"
                data-testid={`${rowPrefix}-${item.id}`}
                data-done={item.done}
                onClick={() => onOpen(item.id)}
                className="flex h-full w-full items-start gap-3 border-b border-line/50 px-4 py-1.5 text-left hover:bg-panel2 focus-visible:bg-panel2"
              >
                {rowBody(item)}
              </button>
            ) : (
              <div data-testid={`${rowPrefix}-${item.id}`} data-done={item.done} className="flex h-full items-start gap-3 border-b border-line/50 px-4 py-1.5">
                {rowBody(item)}
              </div>
            )}
          </li>
        ))}
      </ul>
      {footer && <div className="mt-2">{footer}</div>}
    </section>
  )
}
