import { useState } from 'react'
import { useIsFetching } from '@tanstack/react-query'
import { api, IpcError } from '../lib/client'
import { useT } from '../lib/i18n'
import { unlockNoPeople, useLockReason } from '../lib/sessionLock'
import { useNav, useSession, useToasts } from '../state/stores'
import { Button, TextInput } from '../components/ui'
import { errorEntry } from '@shared/errors'
import { RememberedForget } from './RememberedForget'

/**
 * WP 7.2 follow-up: the screen lock of a simple-mode business WITHOUT people (⌘L / its idle
 * minutes). With the passphrase lock on it asks for the passphrase (session:unlock, throttled
 * like opening); without it, it is a privacy screen and says so — anyone can unlock it.
 */
export function SimplePrivacyLock({ passphrase }: { passphrase: boolean }): React.JSX.Element {
  const t = useT()
  const fetching = useIsFetching()
  const reason = useLockReason((s) => s.reason)
  const { clearCompany } = useSession()
  const nav = useNav()
  const toast = useToasts()
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    if (busy || (passphrase && !value)) return
    setBusy(true)
    try {
      await unlockNoPeople(passphrase ? value : undefined)
    } catch (err) {
      const entry = err instanceof IpcError && err.code ? errorEntry(err.code, err.field) : null
      setError(entry ? t(entry.key) : t('errors.generic')) // i18n-technical: the plain errors.* key of the code
      setValue('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      data-screen="lock"
      data-lock="simple-privacy"
      data-loading={fetching > 0 ? 'true' : 'false'}
      className="drag-region fixed inset-0 z-50 flex h-full flex-col items-center justify-center bg-canvas"
    >
      <div className="w-full max-w-sm [-webkit-app-region:no-drag]">
        <h1 className="text-center font-serif text-display font-semibold tracking-tight">{t('simple.lock.privacy.title')}</h1>
        {reason === 'idle' && (
          <p className="mt-2 text-center text-small text-muted" data-testid="lock-idle">
            {t('simple.lock.idle')}
          </p>
        )}
        <p className="mt-2 text-center text-detail text-muted" data-testid="lock-privacy-note">
          {passphrase ? t('simple.lock.privacy.passphraseText') : t('simple.lock.privacy.text')}
        </p>
        <div className="mt-6 flex flex-col gap-2">
          {passphrase && (
            <TextInput
              autoFocus
              aria-label={t('simple.lock.privacy.passphrase')}
              data-testid="input-unlock-passphrase"
              type="password"
              value={value}
              onChange={(e) => {
                setValue(e.target.value)
                setError(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit()
              }}
              placeholder={t('simple.lock.privacy.passphrase')}
            />
          )}
          {error && (
            <p className="text-center text-small text-cr" role="alert" data-testid="lock-unlock-error">
              {error}
            </p>
          )}
          <Button variant="primary" autoFocus={!passphrase} data-testid="btn-unlock" disabled={busy || (passphrase && !value)} onClick={() => void submit()}>
            {busy ? t('simple.lock.checking') : t('simple.lock.privacy.unlock')}
          </Button>
          {passphrase && <RememberedForget />}
        </div>
        <div className="mt-6 flex justify-center">
          <button
            type="button"
            data-testid="btn-lock-switch-company"
            className="rounded-md px-3 py-1.5 text-body-sm text-muted hover:bg-panel2 hover:text-ink"
            onClick={async () => {
              try {
                await api.company.close()
                clearCompany()
                nav.home()
              } catch (err) {
                toast.push('error', (err as Error).message) // i18n-technical
              }
            }}
          >
            {t('simple.lock.otherBusiness')}
          </button>
        </div>
      </div>
    </div>
  )
}
