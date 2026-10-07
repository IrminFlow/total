// Gateway building blocks: the card state helper, the per-card error boundary and DashCard (a
// titled card with loading / error / content). Headline tiles and status chips are the kit's
// StatTile and Badge (components/kit).
import { Component, type ErrorInfo, type ReactNode } from 'react'
import type { DashSection } from '@shared/dashboard'
import { api } from '../../lib/client'
import { Panel, Skeleton } from '../../components/ui'

/** A dashboard card's data: still loading, failed (query or section), or ready. */
export type CardState<T> = { state: 'loading' } | { state: 'error'; error: string } | { state: 'ready'; data: T }

export function cardState<T>(
  query: { isPending: boolean; error: Error | null },
  section: DashSection<T> | undefined
): CardState<T> {
  if (query.error) return { state: 'error', error: query.error.message }
  if (query.isPending || !section) return { state: 'loading' }
  return section.ok ? { state: 'ready', data: section.data } : { state: 'error', error: section.error }
}

/** Render errors stay inside the card that threw — the rest of the Gateway keeps working. */
export class CardBoundary extends Component<{ name: string; children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }
  componentDidCatch(error: Error, info: ErrorInfo): void {
    api.log
      .renderer({ message: error.message, stack: error.stack, componentStack: info.componentStack ?? undefined, screen: `gateway:${this.props.name}` })
      .catch(() => {})
  }
  render(): ReactNode {
    if (this.state.error) return <CardError message={this.state.error.message} />
    return this.props.children
  }
}

export function CardError({ message }: { message: string }): React.JSX.Element {
  return (
    <div role="alert" data-testid="card-error" className="px-4 py-3 text-small text-muted">
      <p className="text-cr">Couldn’t load this card.</p>
      <p className="mt-0.5 truncate font-mono text-caption" title={message}>
        {message}
      </p>
    </div>
  )
}

/** A titled dashboard card: header (title + optional action), then loading / error / content. */
export function DashCard<T>({
  title,
  testId,
  card,
  action,
  className = '',
  skeletonRows = 4,
  children
}: {
  title: string
  testId: string
  card: CardState<T>
  action?: ReactNode
  className?: string
  skeletonRows?: number
  children: (data: T) => ReactNode
}): React.JSX.Element {
  return (
    <section aria-label={title} data-testid={testId} data-state={card.state} className={`h-full min-w-0 ${className}`}>
      <Panel className="flex h-full flex-col">
        <header className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-4 py-2">
          <h2 className="text-caption font-semibold tracking-[0.08em] text-muted uppercase">{title}</h2>
          {action}
        </header>
        <div className="min-h-0 flex-1">
          <CardBoundary name={testId}>
            {card.state === 'loading' ? (
              <div aria-hidden="true" className="flex flex-col gap-2.5 p-4">
                {Array.from({ length: skeletonRows }, (_, i) => (
                  <Skeleton key={i} className={`h-3.5 ${i % 2 ? 'w-2/3' : 'w-full'}`} />
                ))}
              </div>
            ) : card.state === 'error' ? (
              <CardError message={card.error} />
            ) : (
              <Deferred render={() => children(card.data)} />
            )}
          </CardBoundary>
        </div>
      </Panel>
    </section>
  )
}

/** Calls `render` during ITS OWN render, so a throw lands inside the enclosing CardBoundary
 *  (evaluating the render prop in DashCard's body would throw above the boundary). */
function Deferred({ render }: { render: () => ReactNode }): React.JSX.Element {
  return <>{render()}</>
}

/** Small header link-button for a card ("Open register →"). */
export function CardLink({ onClick, children, testId }: { onClick: () => void; children: ReactNode; testId?: string }): React.JSX.Element {
  return (
    <button type="button" data-testid={testId} onClick={onClick} className="text-hint text-blue hover:underline focus-visible:underline focus-visible:outline-none">
      {children}
    </button>
  )
}
