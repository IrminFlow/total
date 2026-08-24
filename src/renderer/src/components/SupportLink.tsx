import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { Button, Modal, Spinner } from './ui'

export const SUPPORT_EMAIL = 'total@irminflow.com'

/**
 * Support contact, shown wherever the user might be stuck: the app's top bar, the company
 * selector and the lock screen. Clicking it opens a dialog to copy the address, review
 * diagnostics, or launch a mail app.
 *
 * Two shapes. `pill` matches the other top-bar controls; `inline` is the plain line used on the
 * screens that have no top bar. The address itself is hidden below `lg` in the pill, because the
 * target machine for this app is a 1366px laptop and an address that pushes the ⌘K button off the
 * edge helps nobody — the label, the tooltip and the dialog all still carry it.
 */
export function SupportLink({
  className = '',
  variant = 'inline'
}: {
  className?: string
  variant?: 'inline' | 'pill'
}): React.JSX.Element {
  const [open, setOpen] = useState(false)

  const base =
    variant === 'pill'
      ? 'rounded-md border border-line bg-panel2 px-2.5 py-1 text-small text-muted hover:border-amber/60 hover:text-ink'
      : 'text-left text-small text-muted hover:text-ink'

  return (
    <>
      <button
        type="button"
        data-testid="link-support"
        title={`Email support (${SUPPORT_EMAIL})`}
        onClick={() => setOpen(true)}
        className={`${base} ${className}`}
      >
        {variant === 'pill' ? (
          <>
            Support<span className="num hidden lg:inline"> · {SUPPORT_EMAIL}</span>
          </>
        ) : (
          <>Support · {SUPPORT_EMAIL}</>
        )}
      </button>
      {open && <SupportModal onClose={() => setOpen(false)} />}
    </>
  )
}

/**
 * Builds the report text. Deliberately assembled in the renderer from data the user can see, so
 * what the dialog displays and what the mail app receives are the same string — there is no
 * second, richer payload sent behind the preview.
 */
function reportText(d: {
  version: string
  platform: string
  electron: string
  companyOpen: boolean
  lines: string[]
}): string {
  return [
    `Total ${d.version}`,
    `Platform ${d.platform} · Electron ${d.electron}`,
    `Company open: ${d.companyOpen ? 'yes' : 'no'}`,
    '',
    'Recent activity (most recent last):',
    ...d.lines
  ].join('\n')
}

function SupportModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [showDiagnostics, setShowDiagnostics] = useState(false)
  const [copied, setCopied] = useState<'address' | 'report' | null>(null)
  const { data: diagnostics, isLoading } = useQuery({
    queryKey: ['diagnostics'],
    queryFn: api.log.diagnostics,
    // Only fetched once the user asks to see it — no diagnostics are gathered otherwise.
    enabled: showDiagnostics
  })

  const copy = async (text: string, what: 'address' | 'report'): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(what)
    } catch {
      // Clipboard can be blocked in some contexts — the text is on screen anyway.
    }
  }

  return (
    <Modal title="Get support" onClose={onClose} wide>
      <p className="text-detail text-muted">
        For support regarding Total, email us at{' '}
        <span className="num font-medium text-ink">{SUPPORT_EMAIL}</span>.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <code
          data-testid="support-email-copy"
          className="num flex-1 cursor-pointer rounded-md border border-line bg-panel2 px-2.5 py-1.5 text-body-sm text-ink"
          title="Click to copy"
          onClick={() => void copy(SUPPORT_EMAIL, 'address')}
        >
          {SUPPORT_EMAIL}
        </code>
      </div>
      <p className="mt-1.5 text-caption text-muted/70">
        {copied === 'address' ? 'Copied.' : 'Click the address to copy it.'}
      </p>

      {/* Nothing is gathered, shown or sent until the user asks. Total has no telemetry: this is
          the only path by which anything about a run reaches us, and it is entirely manual. */}
      <div className="mt-5 border-t border-line pt-4">
        {!showDiagnostics ? (
          <div className="flex items-center justify-between gap-4">
            <p className="text-body-sm text-muted">
              Reporting a problem? You can attach a diagnostics report — the app version and a log
              of recent activity. It never contains your ledgers, parties or amounts.
            </p>
            <Button data-testid="btn-show-diagnostics" onClick={() => setShowDiagnostics(true)}>
              Show me
            </Button>
          </div>
        ) : isLoading || !diagnostics ? (
          <div className="flex items-center gap-2 text-body-sm text-muted">
            <Spinner /> Gathering diagnostics…
          </div>
        ) : (
          <>
            <p className="mb-2 text-body-sm text-muted">
              This is exactly what would be sent — nothing else. Read it before you share it.
            </p>
            <pre
              data-testid="diagnostics-report"
              className="num max-h-56 overflow-auto rounded-md border border-line bg-panel2 p-3 text-caption leading-relaxed whitespace-pre-wrap text-ink"
            >
              {reportText(diagnostics)}
            </pre>
            <div className="mt-2 flex items-center gap-2">
              <Button data-testid="btn-copy-report" onClick={() => void copy(reportText(diagnostics), 'report')}>
                {copied === 'report' ? 'Copied' : 'Copy report'}
              </Button>
              <Button onClick={() => void api.log.reveal()}>Show log files</Button>
            </div>
          </>
        )}
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>Close</Button>
        <Button
          variant="primary"
          data-testid="btn-open-mail"
          onClick={() => {
            const body = diagnostics ? `\n\n---\n${reportText(diagnostics)}` : ''
            window.open(
              `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Total support')}&body=${encodeURIComponent(body)}`
            )
            onClose()
          }}
        >
          Open in email app
        </Button>
      </div>
    </Modal>
  )
}
