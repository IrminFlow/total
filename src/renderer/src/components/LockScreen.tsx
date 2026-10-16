import { useState } from 'react'
import { useIsFetching, useQuery } from '@tanstack/react-query'
import { api, IpcError, type LoginName } from '../lib/client'
import { useNav, useSession, useToasts } from '../state/stores'
import { Button, TextInput, useKeyNav } from './ui'
import { SupportLink } from './SupportLink'
import { useMode } from '../lib/mode'
import { SimpleLockScreen } from '../simple/SimpleLockScreen'
import { unlockNoPeople, useLockReason } from '../lib/sessionLock'
import { SimplePrivacyLock } from '../simple/SimplePrivacyLock'

/** Full-viewport PIN lock, shown whenever a company has users but no one has signed in yet
 *  (see App.tsx: `slug && locked`) — and after ⌘L / the idle auto-lock (WP 7.2). A simple-mode
 *  company gets the plain-words lock screen (simple/SimpleLockScreen.tsx); the full app's is below. */
export function LockScreen(): React.JSX.Element {
  const simple = useMode() === 'simple'
  const noPeople = useNoPeopleLock()
  if (noPeople) return simple ? <SimplePrivacyLock passphrase={noPeople === 'passphrase'} /> : <PrivacyLockScreen passphrase={noPeople === 'passphrase'} />
  return simple ? <SimpleLockScreen /> : <AccountantLockScreen />
}

/** WP 7.2 follow-up: a business WITHOUT people locked with ⌘L / its idle minutes — 'passphrase'
 *  (its passphrase lock is on) or 'privacy' (anyone can unlock); null = the PIN screen. The lock
 *  event / session:lock say which; otherwise (a reload while locked) company:current does. */
function useNoPeopleLock(): 'passphrase' | 'privacy' | null {
  const told = useLockReason((s) => s.kind)
  const { data } = useQuery({ queryKey: ['lock-kind'], queryFn: api.company.current, enabled: told === null })
  const kind = told ?? data?.lockKind ?? null
  return kind === 'passphrase' || kind === 'privacy' ? kind : null
}

/** The full app's privacy lock (literal English, like the rest of the full app). */
function PrivacyLockScreen({ passphrase }: { passphrase: boolean }): React.JSX.Element {
  const fetching = useIsFetching()
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
      setError(err instanceof IpcError ? err.message : String(err))
      setValue('')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div
      data-screen="lock"
      data-lock="privacy"
      data-loading={fetching > 0 ? 'true' : 'false'}
      className="drag-region fixed inset-0 z-50 flex h-full flex-col items-center justify-center bg-canvas"
    >
      <div className="w-full max-w-sm">
        <h1 className="text-center font-serif text-display font-semibold tracking-tight">Locked</h1>
        <p className="mt-1 mb-6 text-center text-detail text-muted" data-testid="lock-privacy-note">
          {passphrase
            ? 'Type the passphrase of this business to unlock.'
            : 'A privacy screen: anyone can unlock this. Add people with PINs (Settings → Users) for a real lock.'}
        </p>
        <div className="flex flex-col gap-2">
          {passphrase && (
            <TextInput
              autoFocus
              aria-label="Passphrase"
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
              placeholder="Passphrase"
            />
          )}
          {error && (
            <p className="text-center text-small text-cr" role="alert" data-testid="lock-unlock-error">
              {error}
            </p>
          )}
          <Button variant="primary" autoFocus={!passphrase} data-testid="btn-unlock" disabled={busy || (passphrase && !value)} onClick={() => void submit()}>
            {busy ? 'Checking…' : 'Unlock'}
          </Button>
        </div>
        <div className="mt-6 flex justify-center">
          <button
            data-testid="btn-lock-switch-company"
            className="rounded-md px-3 py-1.5 text-body-sm text-muted hover:bg-panel2 hover:text-ink"
            onClick={async () => {
              try {
                await api.company.close()
                clearCompany()
                nav.home()
              } catch (err) {
                toast.push('error', (err as Error).message)
              }
            }}
          >
            ← Switch company
          </button>
        </div>
      </div>
    </div>
  )
}

function AccountantLockScreen(): React.JSX.Element {
  const { data: userList } = useQuery({ queryKey: ['auth-users'], queryFn: api.auth.users })
  const fetching = useIsFetching()
  const { setUser, setLocked, clearCompany } = useSession()
  const nav = useNav()
  const toast = useToasts()
  const list: LoginName[] = userList ?? []

  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [pin, setPin] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const selected = list.find((u) => u.id === selectedId) ?? null

  const pick = (u: LoginName): void => {
    setSelectedId(u.id)
    setPin('')
    setError(null)
  }

  const { active, setActive } = useKeyNav(list.length, (i) => {
    const u = list[i]
    if (u) pick(u)
  })

  const submit = async (): Promise<void> => {
    if (selected == null || !pin || busy) return
    setBusy(true)
    try {
      const result = await api.auth.login(selected.id, pin)
      setUser(result)
      useLockReason.getState().set(null)
      setLocked(false)
    } catch (err) {
      // Wrong PIN, or throttled — either way, reset the field so the next attempt starts clean.
      setError((err as Error).message)
      setPin('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      data-screen="lock"
      data-loading={fetching > 0 ? 'true' : 'false'}
      className="drag-region fixed inset-0 z-50 flex h-full flex-col items-center justify-center bg-canvas"
    >
      <div className="w-full max-w-sm">
        <h1 className="text-center font-serif text-display font-semibold tracking-tight">Locked</h1>
        <p className="mt-1 mb-8 text-center text-detail text-muted">Choose a user and enter your PIN</p>

        <div className="overflow-hidden rounded-xl border border-line bg-panel">
          {list.length === 0 && (
            <p className="px-6 py-10 text-center text-body text-muted">No users found for this company.</p>
          )}
          {list.map((u, i) => (
            <button
              key={u.id}
              type="button"
              data-active={i === active}
              className={`kbar-row flex w-full cursor-pointer items-center justify-between border-b border-line/50 px-5 py-3.5 text-left last:border-b-0 ${
                u.id === selectedId ? 'bg-amberbar/15' : ''
              }`}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(u)}
            >
              <div>
                <p className="text-lead font-medium">{u.name}</p>
                <p className="mt-0.5 text-caption text-muted capitalize">{u.role}</p>
              </div>
              {u.id === selectedId && <span className="text-hint text-muted">Selected</span>}
            </button>
          ))}
        </div>

        {selected && (
          <div className="mt-4 flex flex-col gap-2">
            <TextInput
              key={selected.id}
              autoFocus
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
              placeholder="PIN"
              className="num text-center tracking-[0.4em]"
            />
            {error && <p className="text-center text-small text-cr">{error}</p>}
            <Button variant="primary" data-testid="btn-unlock" disabled={busy || !pin} onClick={() => void submit()}>
              {busy ? 'Checking…' : `Unlock as ${selected.name}`}
            </Button>
          </div>
        )}

        <div className="mt-6 flex justify-center">
          <button
            data-testid="btn-lock-switch-company"
            className="rounded-md px-3 py-1.5 text-body-sm text-muted hover:bg-panel2 hover:text-ink"
            onClick={async () => {
              try {
                await api.company.close()
                clearCompany()
                nav.home()
              } catch (err) {
                toast.push('error', (err as Error).message)
              }
            }}
          >
            ← Switch company
          </button>
        </div>

        <p className="mt-4 text-center text-caption text-muted">
          PINs are a convenience lock — for at-rest protection use Settings → Encrypted export.
        </p>

        <div className="mt-6 text-center">
          <SupportLink />
        </div>
      </div>
    </div>
  )
}
