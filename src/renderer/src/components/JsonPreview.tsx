import { useMemo, useState } from 'react'
import { Button, Modal } from './ui'
import { useToasts } from '../state/stores'

/**
 * Show the exact bytes that will be uploaded, before uploading them.
 *
 * Every export in the app writes `JSON.stringify(value, null, 2)`, and this renders the same
 * string — so what is on screen is the file, character for character, not a rendering of it. That
 * matters: the whole trust argument for an offline filing tool is that you can see what it is
 * about to do, and a "preview" that reformats or summarises quietly gives that up.
 *
 * Deliberately not virtualised or truncated. A GSTR-1 for a busy month is a few hundred KB of
 * text, a <pre> handles that fine, and a preview that hides the middle of the payload is not a
 * preview. The size is stated up front so nobody is surprised by what they opened.
 */
export function JsonPreview({
  value,
  title,
  label = 'View JSON',
  filename,
  testId = 'json-preview'
}: {
  value: unknown
  title: string
  label?: string
  /** Shown as the name the file will take, when the caller knows it. */
  filename?: string
  testId?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="ghost" data-testid={`btn-${testId}`} onClick={() => setOpen(true)} disabled={value == null}>
        {label}
      </Button>
      {open && <JsonModal value={value} title={title} filename={filename} testId={testId} onClose={() => setOpen(false)} />}
    </>
  )
}

function JsonModal({
  value,
  title,
  filename,
  testId,
  onClose
}: {
  value: unknown
  title: string
  filename?: string
  testId: string
  onClose: () => void
}): React.JSX.Element {
  const toast = useToasts()
  // The same serialisation every export path uses, so this is the file rather than a view of it.
  const text = useMemo(() => JSON.stringify(value, null, 2), [value])
  const kb = Math.max(1, Math.round(new TextEncoder().encode(text).length / 1024))

  return (
    <Modal title={title} onClose={onClose} wide>
      <div className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between text-body-sm text-muted">
          <span>
            {kb} KB{filename ? ` · ${filename}` : ''} — exactly what gets written, byte for byte.
          </span>
          <Button
            data-testid={`btn-${testId}-copy`}
            onClick={() => {
              void navigator.clipboard
                .writeText(text)
                .then(() => toast.push('success', 'JSON copied'))
                .catch(() => toast.push('error', 'Could not copy to the clipboard'))
            }}
          >
            Copy
          </Button>
        </div>
        <pre
          data-testid={testId}
          className="max-h-[60vh] overflow-auto rounded-md border border-line bg-panel2 p-3 font-mono text-hint leading-relaxed select-text"
        >
          {text}
        </pre>
      </div>
    </Modal>
  )
}
