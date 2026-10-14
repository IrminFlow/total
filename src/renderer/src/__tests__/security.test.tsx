// WP 7.2 — the plain security screens: Lock and safety (passphrase on with the lost-passphrase
// warning and the "I understand" tick, the recovery copy, change / off, auto-lock minutes, the
// backup check), People & roles (plain switches → users:save with the flag), the passphrase
// prompt, the simple lock screen, ⌘L and main's lock event. No banned word on any of it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { CompanyInfo } from '@shared/domain'
import type { SecurityView } from '@shared/security'
import { bannedWordsIn } from '@shared/simple/bannedWords'
import { useNav, useSession } from '../state/stores'
import { SecuritySettings } from '../simple/SecuritySettings'
import { PeopleRoles } from '../simple/PeopleRoles'
import { PassphrasePrompt } from '../simple/PassphrasePrompt'
import { SimpleLockScreen } from '../simple/SimpleLockScreen'
import { useSessionLock } from '../lib/sessionLock'

const invoke = vi.fn()
const info: CompanyInfo = { name: 'Sharma Traders', stateCode: '27', gstin: null, gstRegistrationType: 'unregistered', address: '', booksFrom: 2026, email: null, phone: null, pan: null, tan: null }
let view: SecurityView
const calls = (ch: string): unknown[] => invoke.mock.calls.filter(([c]) => c === ch).map(([, p]) => p)
const visible = (): string => document.body.textContent ?? ''

function renderUi(ui: React.ReactElement): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

beforeEach(() => {
  view = { encrypted: false, keyFile: false, usersExist: true, autoLockMinutes: null, autoLockChoices: [1, 5, 10, 15, 30, 60], lastCheck: null }
  invoke.mockImplementation(async (channel: string, payload: Record<string, unknown>) => {
    switch (channel) {
      case 'security:get': return { ok: true, data: view }
      case 'security:passphrase:on':
        if (payload.passphrase !== payload.confirm) return { ok: false, error: 'differ', code: 'passphrase_mismatch', field: 'confirm' }
        view = { ...view, encrypted: true, keyFile: true }
        return { ok: true, data: { ...view, backupsConverted: 3, backupsFailed: [] } }
      case 'security:autoLock:set':
        view = { ...view, autoLockMinutes: payload.minutes as number | null }
        return { ok: true, data: view }
      case 'backup:exportEncrypted': return { ok: true, data: { path: '/x.totalbak' } }
      case 'backup:check':
        view = { ...view, lastCheck: { file: 'a.db', tag: 'manual', encrypted: false, checkedAt: new Date().toISOString(), ok: true, steps: { opens: true, quickCheck: true, migrations: null, auditChain: null, balanced: null, company: true }, error: null } }
        return { ok: true, data: view.lastCheck }
      case 'users:list':
        return { ok: true, data: [
          { id: 1, name: 'Owner', role: 'owner', active: true, createdAt: '', capabilities: null },
          { id: 2, name: 'Asha', role: 'accountant', active: true, createdAt: '', capabilities: null }
        ] }
      case 'users:save': return { ok: true, data: { id: 2, locked: false } }
      case 'auth:users': return { ok: true, data: [{ id: 2, name: 'Asha', role: 'accountant' }] }
      case 'auth:login': return payload.pin === '2222' ? { ok: true, data: { id: 2, name: 'Asha', role: 'accountant' } } : { ok: false, error: 'Wrong PIN' }
      case 'session:lock': return { ok: true, data: { locked: true } }
      default: return { ok: true, data: null }
    }
  })
  window.total = { platform: 'test', invoke }
  act(() => {
    useSession.setState({ info, slug: 'sharma', ui: { mode: 'simple' }, user: null, locked: false })
    useNav.setState({ stack: [{ name: 'simple-security' }] })
  })
})
afterEach(() => {
  cleanup()
  invoke.mockReset()
})

describe('Lock and safety', () => {
  it('locking needs the passphrase twice and the "I understand" tick; then offers the recovery copy', async () => {
    renderUi(<SecuritySettings />)
    await waitFor(() => expect(screen.getByTestId('security-warning').textContent).toContain('nobody'))
    const btn = screen.getByTestId('btn-security-lock-on') as HTMLButtonElement
    fireEvent.change(screen.getByTestId('input-new-passphrase'), { target: { value: 'mango season' } })
    fireEvent.change(screen.getByTestId('input-confirm-passphrase'), { target: { value: 'mango seasons' } })
    expect(btn.disabled).toBe(true)
    fireEvent.click(screen.getByTestId('check-passphrase-understood'))
    expect(btn.disabled).toBe(false)
    fireEvent.click(btn)
    await waitFor(() => expect(screen.getByTestId('security-error').textContent).toBe('The two passphrases are not the same.'))
    fireEvent.change(screen.getByTestId('input-confirm-passphrase'), { target: { value: 'mango season' } })
    fireEvent.click(screen.getByTestId('btn-security-lock-on'))
    await waitFor(() => expect(screen.getByTestId('security-locked-text')).toBeTruthy())
    expect(calls('security:passphrase:on')[1]).toEqual({ passphrase: 'mango season', confirm: 'mango season' })
    fireEvent.click(screen.getByTestId('btn-security-recovery'))
    await waitFor(() => expect(calls('backup:exportEncrypted')).toEqual([{ passphrase: 'mango season' }]))
    expect(bannedWordsIn(visible())).toEqual([])
  })

  it('auto-lock minutes and the backup check', async () => {
    renderUi(<SecuritySettings />)
    await waitFor(() => expect(screen.getByTestId('select-autolock')).toBeTruthy())
    fireEvent.change(screen.getByTestId('select-autolock'), { target: { value: '5' } })
    await waitFor(() => expect(calls('security:autoLock:set')).toEqual([{ minutes: 5 }]))
    expect(screen.getByTestId('security-backup-status').getAttribute('data-ok')).toBe('none')
    fireEvent.click(screen.getByTestId('btn-backup-check'))
    await waitFor(() => expect(screen.getByTestId('security-backup-status').textContent).toContain('checked today'))
    expect(bannedWordsIn(visible())).toEqual([])
  })

  it('a business without people says how to get a screen lock', async () => {
    view = { ...view, usersExist: false }
    renderUi(<SecuritySettings />)
    await waitFor(() => expect(screen.getByTestId('security-needs-people').textContent).toContain('PIN'))
    expect(screen.queryByTestId('select-autolock')).toBeNull()
  })
})

describe('People & roles', () => {
  it('shows plain switches (the owner has none) and saves a flag through users:save', async () => {
    act(() => useSession.setState({ user: { id: 1, name: 'Owner', role: 'owner' } }))
    renderUi(<PeopleRoles />)
    await waitFor(() => expect(screen.getByTestId('roles-user-2')).toBeTruthy())
    expect(screen.getByTestId('roles-user-1').textContent).toContain('Can do everything')
    const post = screen.getByTestId('roles-2-canPost') as HTMLInputElement
    expect(post.checked).toBe(true)
    fireEvent.click(post)
    await waitFor(() => expect(calls('users:save')).toEqual([{ data: { name: 'Asha', role: 'accountant', active: true, capabilities: { canPost: false } }, id: 2 }]))
    expect(bannedWordsIn(visible())).toEqual([])
  })
})

describe('opening a locked business and the lock screen', () => {
  it('the passphrase prompt shows the plain refusal and clears the field', async () => {
    const { IpcError } = await import('../lib/client')
    const onSubmit = vi.fn(async () => {
      throw new IpcError({ error: 'wrong', code: 'wrong_passphrase', field: 'passphrase' })
    })
    renderUi(<PassphrasePrompt name="Sharma Traders" onSubmit={onSubmit} onCancel={() => {}} />)
    fireEvent.change(screen.getByTestId('input-passphrase'), { target: { value: 'nope nope' } })
    fireEvent.click(screen.getByTestId('btn-passphrase-open'))
    await waitFor(() => expect(visible()).toContain('That passphrase is not right'))
    expect((screen.getByTestId('input-passphrase') as HTMLInputElement).value).toBe('')
  })

  it('the simple lock screen: tap a name, type the PIN, back in', async () => {
    act(() => useSession.setState({ locked: true }))
    renderUi(<SimpleLockScreen />)
    await waitFor(() => expect(screen.getByTestId('lock-user-2')).toBeTruthy())
    expect(visible()).toContain('Your books are locked')
    fireEvent.click(screen.getByTestId('lock-user-2'))
    fireEvent.change(screen.getByTestId('input-pin'), { target: { value: '1111' } })
    fireEvent.click(screen.getByTestId('btn-unlock'))
    await waitFor(() => expect(visible()).toContain('That PIN is not right'))
    fireEvent.change(screen.getByTestId('input-pin'), { target: { value: '2222' } })
    fireEvent.click(screen.getByTestId('btn-unlock'))
    await waitFor(() => expect(useSession.getState().locked).toBe(false))
    expect(bannedWordsIn(visible())).toEqual([])
  })

  it('⌘L asks main to lock and shows the PIN screen; main\'s lock event does too', async () => {
    let fire: ((e: { reason: 'manual' | 'idle' }) => void) | null = null
    window.total = { platform: 'test', invoke, onSessionLocked: (l) => ((fire = l), () => {}) }
    act(() => useSession.setState({ user: { id: 2, name: 'Asha', role: 'accountant' } }))
    function Host(): null {
      useSessionLock()
      return null
    }
    renderUi(<Host />)
    fireEvent.keyDown(window, { key: 'l', metaKey: true })
    await waitFor(() => expect(useSession.getState().locked).toBe(true))
    expect(calls('session:lock')).toHaveLength(1)
    act(() => useSession.setState({ locked: false, user: { id: 2, name: 'Asha', role: 'accountant' } }))
    act(() => fire!({ reason: 'idle' }))
    expect(useSession.getState().locked).toBe(true)
    expect(useSession.getState().user).toBeNull()
  })
})
