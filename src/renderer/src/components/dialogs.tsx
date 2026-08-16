import { useState } from 'react'
import { Button, Modal, TextInput } from './ui'
import { useDialogs, type ConfirmOptions, type PromptOptions } from '../lib/dialogs'

/** window.confirm replacement — a small Modal with Cancel / confirm buttons. */
export function ConfirmModal({
  title,
  message,
  confirmLabel = 'OK',
  cancelLabel = 'Cancel',
  danger = false,
  onResult
}: ConfirmOptions & { onResult: (ok: boolean) => void }): React.JSX.Element {
  return (
    <Modal title={title} onClose={() => onResult(false)}>
      <p className="text-detail text-ink">{message}</p>
      <div className="mt-5 flex justify-end gap-2">
        <Button data-testid="confirm-cancel" onClick={() => onResult(false)}>
          {cancelLabel}
        </Button>
        <Button variant={danger ? 'danger' : 'primary'} data-testid="confirm-ok" autoFocus onClick={() => onResult(true)}>
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  )
}

/** window.prompt replacement — a Modal with one text field; resolves null on cancel/dismiss. */
export function PromptModal({
  title,
  message,
  initial = '',
  placeholder,
  confirmLabel = 'OK',
  onResult
}: PromptOptions & { onResult: (value: string | null) => void }): React.JSX.Element {
  const [value, setValue] = useState(initial)
  return (
    <Modal title={title} onClose={() => onResult(null)}>
      {message && <p className="mb-3 text-detail text-ink">{message}</p>}
      <TextInput
        autoFocus
        data-testid="prompt-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onFocus={(e) => e.target.select()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onResult(value)
        }}
        placeholder={placeholder}
      />
      <div className="mt-5 flex justify-end gap-2">
        <Button data-testid="prompt-cancel" onClick={() => onResult(null)}>
          Cancel
        </Button>
        <Button variant="primary" data-testid="prompt-ok" onClick={() => onResult(value)}>
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  )
}

/** Renders the frontmost queued confirm/prompt request — mounted once in App.tsx. */
export function DialogHost(): React.JSX.Element | null {
  const { queue, settle } = useDialogs()
  const req = queue[0]
  if (!req) return null
  if (req.kind === 'confirm') {
    return <ConfirmModal key={req.id} {...req} onResult={(ok) => settle(req.id, ok)} />
  }
  return <PromptModal key={req.id} {...req} onResult={(value) => settle(req.id, value)} />
}
