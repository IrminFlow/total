import { useState } from 'react'
import { IpcError } from '../lib/client'
import { useT } from '../lib/i18n'
import { Button, Checkbox, Field, Modal, TextInput } from '../components/ui'
import { errorEntry } from '@shared/errors'

/**
 * WP 7.2: "This business is locked with a passphrase" — asked by the company picker when
 * company:open answers `passphrase_required` (both modes; plain words). The passphrase goes to
 * main once and is forgotten here as soon as the call returns.
 *
 * "Remember on this computer" (off by default, never pre-ticked): main keeps the DATA KEY — never
 * the passphrase — in the computer's secure storage, so the next open needs no passphrase. The
 * hint says what that means. `notice` is said above the box (a remembered key that stopped
 * working was forgotten).
 */
export function PassphrasePrompt({
  name,
  notice,
  onSubmit,
  onCancel
}: {
  name: string
  notice?: string
  /** Throws (IpcError) when the passphrase is refused. */
  onSubmit: (passphrase: string, remember: boolean) => Promise<void>
  onCancel: () => void
}): React.JSX.Element {
  const t = useT()
  const [pass, setPass] = useState('')
  const [remember, setRemember] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    if (!pass || busy) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit(pass, remember)
    } catch (err) {
      const entry = err instanceof IpcError && err.code ? errorEntry(err.code, err.field) : null
      setError(entry ? t(entry.key) : t('errors.generic')) // i18n-technical: the plain errors.* key of the code
      setPass('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={t('simple.passphrase.title', { name })} onClose={onCancel}>
      <div data-testid="passphrase-prompt">
        {notice && (
          <p className="mb-2 rounded-md bg-amberbar/15 px-3 py-2 text-detail text-ink" role="status" data-testid="passphrase-notice">
            {notice}
          </p>
        )}
        <p className="text-detail text-ink">{t('simple.passphrase.text')}</p>
        <div className="mt-3">
          <Field label={t('simple.passphrase.label')} error={error ?? undefined}>
            <TextInput
              autoFocus
              type="password"
              autoComplete="current-password"
              value={pass}
              onChange={(e) => {
                setPass(e.target.value)
                setError(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit()
              }}
              data-testid="input-passphrase"
            />
          </Field>
        </div>
        <div className="mt-3">
          <Checkbox
            label={t('simple.passphrase.remember')}
            hint={t('simple.passphrase.rememberHint')}
            checked={remember}
            onChange={setRemember}
            testId="check-passphrase-remember"
          />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={busy || !pass} onClick={() => void submit()} data-testid="btn-passphrase-open">
            {busy ? t('simple.passphrase.opening') : t('simple.passphrase.open')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
