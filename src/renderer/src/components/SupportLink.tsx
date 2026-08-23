import { useState } from 'react'
import { Button, Modal } from './ui'

export const SUPPORT_EMAIL = 'total@irminflow.com'

/** Support contact shown on every screen — Shell sidebar, company select and lock screen.
 *  Clicking it opens a small dialog so users can copy the address or launch their mail app. */
export function SupportLink({ className = '' }: { className?: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        type="button"
        data-testid="link-support"
        title={`Email support (${SUPPORT_EMAIL})`}
        onClick={() => setOpen(true)}
        className={`text-left text-[12px] text-muted hover:text-ink ${className}`}
      >
        Support · {SUPPORT_EMAIL}
      </button>
      {open && <SupportModal onClose={() => setOpen(false)} />}
    </>
  )
}

function SupportModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  return (
    <Modal title="Get support" onClose={onClose}>
      <p className="text-[13px] text-muted">
        For support regarding Total, email us at{' '}
        <span className="num font-medium text-ink">{SUPPORT_EMAIL}</span>.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <code
          data-testid="support-email-copy"
          className="num flex-1 cursor-pointer rounded-md border border-line bg-panel2 px-2.5 py-1.5 text-[12.5px] text-ink"
          title="Click to copy"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(SUPPORT_EMAIL)
            } catch {
              // Clipboard can be blocked in some contexts — the address is visible above anyway.
            }
          }}
        >
          {SUPPORT_EMAIL}
        </code>
      </div>
      <p className="mt-1.5 text-[11px] text-muted/70">Click the address to copy it.</p>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>Close</Button>
        <Button
          variant="primary"
          data-testid="btn-open-mail"
          onClick={() => {
            window.open(`mailto:${SUPPORT_EMAIL}`)
            onClose()
          }}
        >
          Open in email app
        </Button>
      </div>
    </Modal>
  )
}
