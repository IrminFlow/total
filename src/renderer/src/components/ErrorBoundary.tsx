import { Component, type ErrorInfo, type ReactNode } from 'react'
import { api } from '../lib/client'
import { useNav } from '../state/stores'
import { Button, Panel } from './ui'

interface Props {
  children: ReactNode
  /** Current screen name, sent with the crash report and shown for context. */
  screen?: string
}

interface State {
  error: Error | null
  componentStack: string | null
}

/**
 * Catches render errors in the wrapped screen, reports them to the main-process
 * log (never the raw payload — just message/stack/componentStack/screen), and
 * shows a recoverable fallback instead of a blank app.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? null })
    api.log
      .renderer({
        message: error.message,
        stack: error.stack,
        componentStack: info.componentStack ?? undefined,
        screen: this.props.screen
      })
      .catch(() => {
        // Logging must never compound the crash.
      })
  }

  private handleGoBack = (): void => {
    this.setState({ error: null, componentStack: null })
    useNav.getState().back()
  }

  private handleCopyDetails = (): void => {
    const { error, componentStack } = this.state
    const details = [error?.message, error?.stack, componentStack].filter(Boolean).join('\n\n')
    void navigator.clipboard.writeText(details).catch(() => {
      // Clipboard access can be denied — nothing more we can do here.
    })
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <Panel className="m-6 p-6">
        <h2 className="font-serif text-heading font-semibold tracking-tight text-cr">Something went wrong</h2>
        <p className="mt-2 text-body text-muted">
          This screen hit an unexpected error. Nothing you haven't saved was touched — go back and try again.
        </p>
        <p className="mt-3 rounded-md border border-line bg-panel2 px-2.5 py-1.5 font-mono text-small text-muted">
          {error.message}
        </p>
        <div className="mt-4 flex gap-2">
          <Button variant="primary" onClick={this.handleGoBack}>
            Go back
          </Button>
          <Button onClick={this.handleCopyDetails}>Copy details</Button>
        </div>
      </Panel>
    )
  }
}
