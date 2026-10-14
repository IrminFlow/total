import { useState } from 'react'
import { useIsFetching, useQuery } from '@tanstack/react-query'
import { api, IpcError, type LoginName } from '../lib/client'
import { useT } from '../lib/i18n'
import { useLockReason } from '../lib/sessionLock'
import { useNav, useSession, useToasts } from '../state/stores'
import { Button, TextInput } from '../components/ui'
import { errorEntry } from '@shared/errors'
import type { MessageKey } from '@shared/i18n'

/**
 * WP 7.2: the lock screen of a simple-mode business, in plain words — "Your books are locked",
 * tap your name, type your PIN. The same auth:login as the full app's lock screen
 * (components/LockScreen.tsx); main keeps every other call refused until it succeeds.
 */
const ROLE_LABEL: Record<LoginName['role'], MessageKey> = {
  owner: 'simple.roles.role.owner', // i18n-technical
  accountant: 'simple.roles.role.accountant', // i18n-technical
  viewer: 'simple.roles.role.viewer' // i18n-technical
}
const USERS_KEY = ['auth-users'] as const // i18n-technical

export function SimpleLockScreen(): React.JSX.Element {
  const t = useT()
  const say = (k: MessageKey): string => t(k) // i18n-technical: keys from ROLE_LABEL
  const { data: userList } = useQuery({ queryKey: USERS_KEY, queryFn: api.auth.users })
  const fetching = useIsFetching()
  const { setUser, setLocked, clearCompany } = useSession()
  const reason = useLockReason((s) => s.reason)
  const nav = useNav()
  const toast = useToasts()
  const list: LoginName[] = userList ?? []
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [pin, setPin] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const selected = list.find((u) => u.id === selectedId) ?? null

  const submit = async (): Promise<void> => {
    if (selected == null || !pin || busy) return
    setBusy(true)
    try {
      const result = await api.auth.login(selected.id, pin)
      setUser(result)
      useLockReason.getState().set(null)
      setLocked(false)
    } catch (err) {
      const entry = err instanceof IpcError && err.code ? errorEntry(err.code, err.field) : null
      setError(entry ? t(entry.key) : t('simple.lock.wrongPin')) // i18n-technical: the plain errors.* key of the code
      setPin('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      data-screen="lock"
      data-lock="simple"
      data-loading={fetching > 0 ? 'true' : 'false'}
      className="drag-region fixed inset-0 z-50 flex h-full flex-col items-center justify-center bg-canvas"
    >
      <div className="w-full max-w-sm [-webkit-app-region:no-drag]">
        <h1 className="text-center font-serif text-display font-semibold tracking-tight">{t('simple.lock.title')}</h1>
        <p className="mt-1 text-center text-detail text-muted">{t('simple.lock.pick')}</p>
        {reason === 'idle' && (
          <p className="mt-2 text-center text-small text-muted" data-testid="lock-idle">
            {t('simple.lock.idle')}
          </p>
        )}
        <div className="mt-6 overflow-hidden rounded-xl border border-line bg-panel">
          {list.length === 0 && <p className="px-6 py-10 text-center text-body text-muted">{t('simple.lock.none')}</p>}
          {list.map((u) => (
            <button
              key={u.id}
              type="button"
              className={`flex w-full cursor-pointer items-center justify-between border-b border-line/50 px-5 py-3.5 text-left last:border-b-0 ${u.id === selectedId ? 'bg-amberbar/15' : ''}`}
              onClick={() => {
                setSelectedId(u.id)
                setPin('')
                setError(null)
              }}
              data-testid={`lock-user-${u.id}`}
            >
              <span className="text-lead font-medium">{u.name}</span>
              <span className="text-caption text-muted">{say(ROLE_LABEL[u.role])}</span>
            </button>
          ))}
        </div>
        {selected && (
          <div className="mt-4 flex flex-col gap-2">
            <TextInput
              key={selected.id}
              autoFocus
              aria-label={t('simple.lock.pin')}
              data-testid="input-pin"
              type="password"
              inputMode="numeric"
              value={pin}
              onChange={(e) => {
                setPin(e.target.value.replace(/\D/g, '').slice(0, 12))
                setError(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit()
              }}
              placeholder={t('simple.lock.pin')}
              className="num text-center tracking-[0.4em]"
            />
            {error && (
              <p className="text-center text-small text-cr" role="alert">
                {error}
              </p>
            )}
            <Button variant="primary" data-testid="btn-unlock" disabled={busy || !pin} onClick={() => void submit()}>
              {busy ? t('simple.lock.checking') : t('simple.lock.open', { name: selected.name })}
            </Button>
          </div>
        )}
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
