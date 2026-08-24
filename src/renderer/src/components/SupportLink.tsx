import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { Button, Field, Modal, Spinner, TextInput, inputCls } from './ui'

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
  const [message, setMessage] = useState('')
  const [email, setEmail] = useState('')
  const [attach, setAttach] = useState(true)
  const [copied, setCopied] = useState<'address' | 'report' | null>(null)
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const { data: diagnostics, isLoading } = useQuery({
    queryKey: ['diagnostics'],
    queryFn: api.log.diagnostics,
    // Fetched as soon as the dialog opens, because the whole point is that the user can read the
    // attachment before deciding. Diagnostics gathered are still diagnostics that go nowhere
    // until they press send.
    enabled: true
  })

  const report = diagnostics ? reportText(diagnostics) : ''

  const copy = async (text: string, what: 'address' | 'report'): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(what)
    } catch {
      // Clipboard can be blocked in some contexts — the text is on screen anyway.
    }
  }

  const send = async (): Promise<void> => {
    setSending(true)
    setSendError(null)
    try {
      // The report string is passed through rather than rebuilt in main: what was on screen and
      // what leaves the machine have to be the same characters, and this is the only way to be
      // sure of that.
      await api.support.send({ message: message.trim(), email: email.trim(), log: attach ? report : '' })
      setSent(true)
    } catch (err) {
      setSendError((err as Error).message)
    } finally {
      setSending(false)
    }
  }

  if (sent) {
    return (
      <Modal title="Thank you" onClose={onClose}>
        <p data-testid="support-sent" className="text-detail text-ink">
          Sent. Somebody reads these.
        </p>
        <p className="mt-1 text-body-sm text-muted">
          {email.trim()
            ? `If there is a question, it will come to ${email.trim()}.`
            : `You left no address, so this one is one-way — write to ${SUPPORT_EMAIL} if you want a reply.`}
        </p>
        <div className="mt-5 flex justify-end">
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        </div>
      </Modal>
    )
  }

  return (
    <Modal title="Get support" onClose={onClose} wide>
      <Field label="What happened?" hint="What you were doing, and what the app did instead.">
        <textarea
          data-testid="input-support-message"
          className={`${inputCls} min-h-28 resize-y`}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="I was posting a sales invoice and the total came out wrong…"
        />
      </Field>

      <div className="mt-3">
        <Field label="Your email" hint="Only so somebody can write back. Leave it blank if you would rather not.">
          <TextInput
            data-testid="input-support-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
        </Field>
      </div>

      {/* Total has no telemetry. This dialog is the only path by which anything about a run
          reaches us, it is entirely manual, and it is shown in full first. */}
      <div className="mt-5 border-t border-line pt-4">
        <label className="flex items-center gap-2 text-body-sm text-ink">
          <input
            type="checkbox"
            data-testid="check-attach-diagnostics"
            checked={attach}
            onChange={(e) => setAttach(e.target.checked)}
          />
          Attach diagnostics — the app version and a log of recent activity
        </label>
        <p className="mt-1 text-body-sm text-muted">
          It never contains your ledgers, parties or amounts. This is exactly what would be sent,
          character for character — read it before you send it.
        </p>
        {attach &&
          (isLoading || !diagnostics ? (
            <div className="mt-2 flex items-center gap-2 text-body-sm text-muted">
              <Spinner /> Gathering diagnostics…
            </div>
          ) : (
            <>
              <pre
                data-testid="diagnostics-report"
                className="num mt-2 max-h-56 overflow-auto rounded-md border border-line bg-panel2 p-3 text-caption leading-relaxed whitespace-pre-wrap text-ink"
              >
                {report}
              </pre>
              <div className="mt-2 flex items-center gap-2">
                <Button data-testid="btn-copy-report" onClick={() => void copy(report, 'report')}>
                  {copied === 'report' ? 'Copied' : 'Copy report'}
                </Button>
                <Button onClick={() => void api.log.reveal()}>Show log files</Button>
              </div>
            </>
          ))}
      </div>

      {sendError && (
        <p role="alert" data-testid="support-send-error" className="mt-4 text-body-sm text-cr">
          {sendError}
        </p>
      )}

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
        <button
          type="button"
          data-testid="support-email-copy"
          className="num text-body-sm text-muted hover:text-ink"
          title="Click to copy"
          onClick={() => void copy(SUPPORT_EMAIL, 'address')}
        >
          {copied === 'address' ? 'Copied.' : `Or write to ${SUPPORT_EMAIL}`}
        </button>
        <div className="flex gap-2">
          <Button
            data-testid="btn-open-mail"
            onClick={() => {
              // Kept as the fallback for a machine with no connection: the same text, carried by
              // hand. Sending has to work when the network does not.
              const body = `${message}${attach && report ? `\n\n---\n${report}` : ''}`
              window.open(
                `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Total support')}&body=${encodeURIComponent(body)}`
              )
            }}
          >
            Open in email app
          </Button>
          <Button
            variant="primary"
            data-testid="btn-support-send"
            disabled={sending || message.trim().length < 5}
            onClick={() => void send()}
          >
            {sending ? 'Sending…' : 'Send'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
