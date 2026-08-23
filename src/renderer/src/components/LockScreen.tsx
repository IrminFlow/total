import { useState } from 'react'
import { useIsFetching, useQuery } from '@tanstack/react-query'
import { api, type LoginName } from '../lib/client'
import { useNav, useSession, useToasts } from '../state/stores'
import { Button, TextInput, useKeyNav } from './ui'
import { SupportLink } from './SupportLink'

/** Full-viewport PIN lock, shown whenever a company has users but no one has signed in yet
 *  (see App.tsx: `slug && locked`). Pick a user, type their PIN, Enter (or the button) submits. */
export function LockScreen(): React.JSX.Element {
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
        <h1 className="text-center font-serif text-[28px] font-semibold tracking-tight">Locked</h1>
        <p className="mt-1 mb-8 text-center text-[13px] text-muted">Choose a user and enter your PIN</p>

        <div className="overflow-hidden rounded-xl border border-line bg-panel">
          {list.length === 0 && (
            <p className="px-6 py-10 text-center text-[13.5px] text-muted">No users found for this company.</p>
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
                <p className="text-[14.5px] font-medium">{u.name}</p>
                <p className="mt-0.5 text-[11px] text-muted capitalize">{u.role}</p>
              </div>
              {u.id === selectedId && <span className="text-[11.5px] text-muted">Selected</span>}
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
            {error && <p className="text-center text-[12px] text-cr">{error}</p>}
            <Button variant="primary" data-testid="btn-unlock" disabled={busy || !pin} onClick={() => void submit()}>
              {busy ? 'Checking…' : `Unlock as ${selected.name}`}
            </Button>
          </div>
        )}

        <div className="mt-6 flex justify-center">
          <button
            data-testid="btn-lock-switch-company"
            className="rounded-md px-3 py-1.5 text-[12.5px] text-muted hover:bg-panel2 hover:text-ink"
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

        <p className="mt-4 text-center text-[11px] text-muted/70">
          PINs are a convenience lock — for at-rest protection use Settings → Encrypted export.
        </p>

        <div className="mt-6 text-center">
          <SupportLink />
        </div>
      </div>
    </div>
  )
}
