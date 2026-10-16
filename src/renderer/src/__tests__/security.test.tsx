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
import { LockScreen } from '../components/LockScreen'
import { useLockReason } from '../lib/sessionLock'
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
  view = { encrypted: false, keyFile: false, usersExist: true, autoLockMinutes: null, autoLockChoices: [1, 5, 10, 15, 30, 60], lastCheck: null, remembered: false, rememberPending: false }
  invoke.mockImplementation(async (channel: string, payload: Record<string, unknown>) => {
    switch (channel) {
      case 'security:get': return { ok: true, data: view }
      case 'security:remember:forget':
        view = { ...view, remembered: false }
        return { ok: true, data: view }
      case 'company:remembered': return { ok: true, data: view.remembered ? ['sharma'] : [] }
      case 'company:forgetRemembered':
        view = { ...view, remembered: false }
        return { ok: true, data: null }
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
      case 'session:unlock':
        if (view.encrypted && !payload?.passphrase) return { ok: false, error: 'Type it', code: 'passphrase_required', field: 'passphrase' }
        if (view.encrypted && payload.passphrase !== 'mango season') return { ok: false, error: 'That passphrase is not right', code: 'wrong_passphrase', field: 'passphrase' }
        return { ok: true, data: { locked: false } }
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

  it('a business without people can lock the screen too — said to be a privacy screen', async () => {
    view = { ...view, usersExist: false }
    renderUi(<SecuritySettings />)
    await waitFor(() => expect(screen.getByTestId('security-needs-people').textContent).toContain('privacy screen'))
    expect(screen.getByTestId('select-autolock')).toBeTruthy()
    expect(screen.getByTestId('btn-lock-now')).toBeTruthy()
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

describe('the lock screen of a business without people (PR #112 follow-up)', () => {
  const lockAs = (kind: 'privacy' | 'passphrase', mode: 'simple' | 'accountant'): void =>
    act(() => {
      useSession.setState({ locked: true, user: null, ui: { mode } })
      useLockReason.getState().set('manual', kind)
    })
  afterEach(() => act(() => useLockReason.getState().set(null)))

  for (const mode of ['simple', 'accountant'] as const) {
    it(`${mode}: a privacy screen says anyone can unlock it, and Unlock just resumes`, async () => {
      lockAs('privacy', mode)
      renderUi(<LockScreen />)
      expect(screen.getByTestId('lock-privacy-note').textContent).toMatch(/anyone can unlock this/i)
      expect(screen.queryByTestId('input-unlock-passphrase')).toBeNull()
      expect(screen.queryByTestId('input-pin')).toBeNull()
      fireEvent.click(screen.getByTestId('btn-unlock'))
      await waitFor(() => expect(useSession.getState().locked).toBe(false))
      expect(calls('session:unlock')).toEqual([{}])
      if (mode === 'simple') expect(bannedWordsIn(visible())).toEqual([])
    })

    it(`${mode}: with the passphrase lock on it asks for the passphrase; a wrong one is refused and cleared`, async () => {
      view = { ...view, encrypted: true, usersExist: false }
      lockAs('passphrase', mode)
      renderUi(<LockScreen />)
      const input = screen.getByTestId('input-unlock-passphrase') as HTMLInputElement
      expect((screen.getByTestId('btn-unlock') as HTMLButtonElement).disabled).toBe(true)
      fireEvent.change(input, { target: { value: 'wrong one' } })
      fireEvent.click(screen.getByTestId('btn-unlock'))
      await waitFor(() => expect(screen.getByTestId('lock-unlock-error').textContent).toContain('That passphrase is not right'))
      expect(input.value).toBe('')
      expect(useSession.getState().locked).toBe(true)
      fireEvent.change(input, { target: { value: 'mango season' } })
      fireEvent.click(screen.getByTestId('btn-unlock'))
      await waitFor(() => expect(useSession.getState().locked).toBe(false))
      expect(calls('session:unlock').at(-1)).toEqual({ passphrase: 'mango season' })
    })
  }

  it('a reload while locked asks company:current what the lock is', async () => {
    invoke.mockImplementation(async (channel: string) =>
      channel === 'company:current' ? { ok: true, data: { slug: 'sharma', info, locked: true, lockKind: 'privacy', ui: { mode: 'simple' } } } : { ok: true, data: [] }
    )
    act(() => useSession.setState({ locked: true, user: null, ui: { mode: 'simple' } }))
    renderUi(<LockScreen />)
    await waitFor(() => expect(screen.getByTestId('lock-privacy-note')).toBeTruthy())
  })

  it('⌘L in a business without people locks to the privacy screen (no "add a PIN first" toast)', async () => {
    invoke.mockImplementation(async (channel: string) => (channel === 'session:lock' ? { ok: true, data: { locked: true, kind: 'privacy' } } : { ok: true, data: null }))
    function Host(): null {
      useSessionLock()
      return null
    }
    renderUi(<Host />)
    fireEvent.keyDown(window, { key: 'l', metaKey: true })
    await waitFor(() => expect(useSession.getState().locked).toBe(true))
    expect(useLockReason.getState().kind).toBe('privacy')
  })
})

describe('deleting a business locked with a passphrase (WP 7.2 review)', () => {
  it('the delete dialog asks for the passphrase, then the owner PIN, and sends both', async () => {
    const { CompanySelect } = await import('../screens/CompanySelect')
    const deletes: Record<string, unknown>[] = []
    invoke.mockImplementation(async (channel: string, payload: Record<string, unknown>) => {
      if (channel === 'company:list') return { ok: true, data: { companies: [{ slug: 'locked-co', name: 'Locked Co', stateCode: '27', gstin: null, lastOpenedAt: null }] } }
      if (channel === 'company:delete') {
        deletes.push(payload)
        if (!payload.passphrase) return { ok: false, error: 'This business is locked with a passphrase — type it to open the books', code: 'passphrase_required', field: 'passphrase' }
        if (!payload.pin) return { ok: false, error: 'This company is protected — an owner PIN is required to delete it' }
        return { ok: true, data: null }
      }
      return { ok: false, error: `unmocked ${channel}` }
    })
    renderUi(<CompanySelect />)
    await waitFor(() => expect(screen.getByTestId('btn-company-delete-locked-co')).toBeTruthy())
    fireEvent.click(screen.getByTestId('btn-company-delete-locked-co'))
    fireEvent.change(screen.getByPlaceholderText('Locked Co'), { target: { value: 'Locked Co' } })
    fireEvent.click(screen.getByText('Delete company'))
    await waitFor(() => expect(screen.getByTestId('input-delete-passphrase')).toBeTruthy())
    expect((screen.getByText('Delete company').closest('button') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByTestId('input-delete-passphrase'), { target: { value: 'monsoon ledger 77' } })
    fireEvent.click(screen.getByText('Delete company'))
    await waitFor(() => expect(screen.getByPlaceholderText('PIN')).toBeTruthy())
    fireEvent.change(screen.getByPlaceholderText('PIN'), { target: { value: '4321' } })
    fireEvent.click(screen.getByText('Delete company'))
    await waitFor(() => expect(deletes).toHaveLength(3))
    expect(deletes[2]).toEqual({ slug: 'locked-co', confirmName: 'Locked Co', pin: '4321', passphrase: 'monsoon ledger 77' })
  })
})

describe('remember on this computer', () => {
  it('the prompt offers it unticked; ticking it sends remember with the passphrase; a notice is said above', async () => {
    const onSubmit = vi.fn(async () => {})
    renderUi(<PassphrasePrompt name="Sharma Traders" notice="It was forgotten." onSubmit={onSubmit} onCancel={() => {}} />)
    expect(screen.getByTestId('passphrase-notice').textContent).toBe('It was forgotten.')
    const box = screen.getByTestId('check-passphrase-remember') as HTMLInputElement
    expect(box.checked).toBe(false)
    expect(visible()).toContain('Anyone who can sign in to this computer')
    fireEvent.change(screen.getByTestId('input-passphrase'), { target: { value: 'mango season' } })
    fireEvent.click(screen.getByTestId('btn-passphrase-open'))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('mango season', false))
    fireEvent.click(box)
    fireEvent.change(screen.getByTestId('input-passphrase'), { target: { value: 'mango season' } })
    fireEvent.click(screen.getByTestId('btn-passphrase-open'))
    await waitFor(() => expect(onSubmit).toHaveBeenLastCalledWith('mango season', true))
    expect(bannedWordsIn(visible())).toEqual([])
  })

  it('the picker: a ticked open sends remember; a remembered business shows Forget; a stale key brings the prompt back with a note', async () => {
    const { CompanySelect } = await import('../screens/CompanySelect')
    const opens: Record<string, unknown>[] = []
    let rememberedSlugs: string[] = []
    let stale = false
    invoke.mockImplementation(async (channel: string, payload: Record<string, unknown>) => {
      if (channel === 'company:list') return { ok: true, data: { companies: [{ slug: 'locked-co', name: 'Locked Co', stateCode: '27', gstin: null, lastOpenedAt: null }] } }
      if (channel === 'company:remembered') return { ok: true, data: rememberedSlugs }
      if (channel === 'company:forgetRemembered') {
        rememberedSlugs = []
        return { ok: true, data: null }
      }
      if (channel === 'company:open') {
        opens.push(payload)
        if (!payload.passphrase) {
          return stale
            ? { ok: false, error: 'stale', code: 'remembered_key_stale', field: 'passphrase' }
            : { ok: false, error: 'Type it', code: 'passphrase_required', field: 'passphrase' }
        }
        if (payload.remember) rememberedSlugs = ['locked-co']
        return { ok: true, data: { slug: 'locked-co', info, integrity: { ok: true, quickCheck: 'ok', unbalancedVoucherIds: [] }, locked: false, ui: { mode: 'simple' }, encrypted: true, openedWith: 'passphrase', remember: 'saved' } }
      }
      return { ok: true, data: null }
    })
    renderUi(<CompanySelect />)
    await waitFor(() => expect(screen.getByText('Locked Co')).toBeTruthy())
    expect(screen.queryByTestId('company-remembered-locked-co')).toBeNull()
    fireEvent.click(screen.getByText('Locked Co'))
    await waitFor(() => expect(screen.getByTestId('passphrase-prompt')).toBeTruthy())
    fireEvent.click(screen.getByTestId('check-passphrase-remember'))
    fireEvent.change(screen.getByTestId('input-passphrase'), { target: { value: 'mango season' } })
    fireEvent.click(screen.getByTestId('btn-passphrase-open'))
    await waitFor(() => expect(opens).toHaveLength(2))
    expect(opens[1]).toEqual({ slug: 'locked-co', passphrase: 'mango season', remember: true })
    await waitFor(() => expect(screen.getByTestId('company-remembered-locked-co').textContent).toContain('Remembered on this computer'))
    fireEvent.click(screen.getByTestId('btn-company-forget-locked-co'))
    await waitFor(() => expect(screen.queryByTestId('company-remembered-locked-co')).toBeNull())
    expect(calls('company:forgetRemembered')).toEqual([{ slug: 'locked-co' }])
    stale = true
    fireEvent.click(screen.getByText('Locked Co'))
    await waitFor(() => expect(screen.getByTestId('passphrase-notice').textContent).toContain('no longer opens'))
  })

  it('Lock and safety: "Remembered on this computer" with Forget (owner); not remembered says how', async () => {
    view = { ...view, encrypted: true, keyFile: true, usersExist: false, remembered: true }
    renderUi(<SecuritySettings />)
    await waitFor(() => expect(screen.getByTestId('security-remember').getAttribute('data-remembered')).toBe('on'))
    expect(screen.getByTestId('security-remember-text').textContent).toContain('anyone who can sign in to this computer')
    fireEvent.click(screen.getByTestId('btn-security-forget'))
    await waitFor(() => expect(screen.getByTestId('security-remember').getAttribute('data-remembered')).toBe('off'))
    expect(calls('security:remember:forget')).toHaveLength(1)
    expect(screen.queryByTestId('btn-security-forget')).toBeNull()
    expect(screen.getByTestId('security-remember-text').textContent).toContain('Remember on this computer')
    expect(bannedWordsIn(visible())).toEqual([])
  })

  it('Lock and safety: a plaintext business shows no remember card', async () => {
    renderUi(<SecuritySettings />)
    await waitFor(() => expect(screen.getByTestId('security-passphrase')).toBeTruthy())
    expect(screen.queryByTestId('security-remember')).toBeNull()
  })

  for (const mode of ['simple', 'accountant'] as const) {
    it(`${mode}: the screen lock's passphrase prompt offers Forget while remembered`, async () => {
      view = { ...view, encrypted: true, usersExist: false, remembered: true }
      act(() => {
        useSession.setState({ locked: true, user: null, ui: { mode } })
        useLockReason.getState().set('manual', 'passphrase')
      })
      try {
        renderUi(<LockScreen />)
        await waitFor(() => expect(screen.getByTestId('lock-remembered')).toBeTruthy())
        fireEvent.click(screen.getByTestId('btn-lock-forget'))
        await waitFor(() => expect(screen.queryByTestId('lock-remembered')).toBeNull())
        expect(calls('company:forgetRemembered')).toEqual([{ slug: 'sharma' }])
      } finally {
        act(() => useLockReason.getState().set(null))
      }
    })
  }
})
