// Update consent: the notice (available -> Download now / Later / Skip; ready -> Restart / Install on
// quit), pushed by main, in all three languages; and the "Check for updates automatically" toggle in
// the simple Settings and the accountant About.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { UpdateNotice as Notice, UpdatesView } from '@shared/updates'
import { UpdateNotice, resetUpdateNoticeSession } from '../simple/UpdateNotice'
import { UpdatesSetting } from '../simple/UpdatesSetting'
import { AboutSection } from '../screens/settings/AboutSection'
import { LANGUAGE_KEY } from '../lib/i18n'
import { useSession } from '../state/stores'
import { CATALOGUES } from '@shared/i18n'
import { DialogHost } from '../components/dialogs'

const invoke = vi.fn()
let view: UpdatesView
let push: ((n: unknown) => void) | null = null
let gate: { allowed: boolean; reason: string } | null = null

const wrap = (ui: ReactNode): ReactNode => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>
)

beforeEach(() => {
  localStorage.clear()
  resetUpdateNoticeSession()
  view = { settings: { autoCheck: true, skippedVersion: null }, notice: null, current: '0.12.0' }
  push = null
  gate = null
  invoke.mockReset()
  invoke.mockImplementation(async (channel: string, payload?: { autoCheck?: boolean; action?: string }) => {
    switch (channel) {
      case 'app:updates:get':
        return { ok: true, data: view }
      case 'app:updates:canSet':
        return gate ? { ok: true, data: gate } : { ok: false, error: 'unmocked' }
      case 'app:updates:set':
        view = { ...view, settings: { ...view.settings, autoCheck: payload!.autoCheck! } }
        return { ok: true, data: view }
      case 'app:updates:act':
        return { ok: true, data: view }
      case 'app:checkUpdates':
        return { ok: true, data: { status: 'up-to-date', current: '0.12.0' } }
      case 'app:info':
        return { ok: true, data: { version: '0.12.0', platform: 'darwin' } }
      case 'company:lockGet':
        return { ok: true, data: { date: null } }
      default:
        return { ok: false, error: `unmocked ${channel}` }
    }
  })
  window.total = { platform: 'test', invoke, onAiEvent: () => () => undefined, onUpdateEvent: (l: (n: unknown) => void) => ((push = l), () => (push = null)) } as never
  act(() => useSession.setState({ slug: null, user: null }))
})
afterEach(() => cleanup())

const available: Notice = { phase: 'available', version: '0.13.0', via: 'engine' }

describe('update notice', () => {
  it('shows nothing until main reports an update', async () => {
    render(wrap(<UpdateNotice />))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('app:updates:get', undefined))
    expect(screen.queryByTestId('update-notice')).toBeNull()
  })

  it('available: asks first; Download now and Skip this version go to main; Later only hides it', async () => {
    view.notice = available
    render(wrap(<UpdateNotice />))
    expect(await screen.findByText('Total 0.13.0 is available.')).toBeTruthy()
    fireEvent.click(screen.getByTestId('btn-update-download'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('app:updates:act', { action: 'download' }))
    fireEvent.click(screen.getByTestId('btn-update-skip'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('app:updates:act', { action: 'skip' }))
    invoke.mockClear()
    fireEvent.click(screen.getByTestId('btn-update-later'))
    expect(screen.queryByTestId('update-notice')).toBeNull()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('follows what main pushes: downloading, then ready with Restart to update / Install when I quit', async () => {
    render(wrap(<UpdateNotice />))
    await waitFor(() => expect(push).not.toBeNull())
    act(() => push!({ ...available, phase: 'downloading' }))
    expect(screen.getByTestId('update-downloading').textContent).toBe('Downloading Total 0.13.0…')
    act(() => push!({ ...available, phase: 'ready' }))
    expect(screen.getByText('Total 0.13.0 is ready.')).toBeTruthy()
    fireEvent.click(screen.getByTestId('btn-update-restart'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('app:updates:act', { action: 'install' }))
    fireEvent.click(screen.getByTestId('btn-update-onquit'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('app:updates:act', { action: 'installOnQuit' }))
    act(() => push!(null))
    expect(screen.queryByTestId('update-notice')).toBeNull()
  })

  it('"Later" holds for the session even when the notice is mounted again (opening a company swaps the layout)', async () => {
    view.notice = available
    const first = render(wrap(<UpdateNotice />))
    fireEvent.click(await screen.findByTestId('btn-update-later'))
    first.unmount()
    render(wrap(<UpdateNotice />))
    await waitFor(() => expect(invoke.mock.calls.filter((c) => c[0] === 'app:updates:get')).toHaveLength(2))
    expect(screen.queryByTestId('update-notice')).toBeNull()
    // A newer version is news again.
    act(() => push!({ ...available, version: '0.14.0' }))
    expect(screen.getByTestId('update-notice')).toBeTruthy()
  })

  it('a download in progress can be hidden', async () => {
    view.notice = { ...available, phase: 'downloading' }
    render(wrap(<UpdateNotice />))
    fireEvent.click(await screen.findByTestId('btn-update-later'))
    expect(screen.queryByTestId('update-notice')).toBeNull()
  })

  it('a non-owner where the business has users gets the news, "Later" and "ask the owner" — no buttons main would refuse', async () => {
    act(() => useSession.setState({ slug: 'a', user: { id: 2, name: 'Ravi', role: 'accountant' } }))
    view.notice = available
    render(wrap(<UpdateNotice />))
    expect(await screen.findByTestId('update-ask-owner')).toBeTruthy()
    expect(screen.queryByTestId('btn-update-download')).toBeNull()
    expect(screen.queryByTestId('btn-update-skip')).toBeNull()
    act(() => push!({ ...available, phase: 'ready' }))
    expect(screen.queryByTestId('btn-update-restart')).toBeNull()
    expect(screen.queryByTestId('btn-update-onquit')).toBeNull()
    expect(screen.getByTestId('btn-update-later')).toBeTruthy()
  })

  it.each(['hi', 'hinglish'] as const)('speaks %s, with no English fallback', async (lang) => {
    localStorage.setItem(LANGUAGE_KEY, lang)
    view.notice = available
    render(wrap(<UpdateNotice />))
    const cat = CATALOGUES[lang]
    expect(await screen.findByText(cat['simple.updates.available']!.replace('{version}', '0.13.0'))).toBeTruthy()
    expect(screen.getByTestId('btn-update-download').textContent).toBe(cat['simple.updates.download'])
    expect(screen.getByTestId('btn-update-skip').textContent).toBe(cat['simple.updates.skip'])
    expect(cat['simple.updates.download']).not.toBe(CATALOGUES.en['simple.updates.download'])
  })
})

describe('Check for updates automatically', () => {
  it('simple settings: the box shows the stored value, saves a change, and Check now asks main', async () => {
    render(wrap(<UpdatesSetting />))
    const box = (await screen.findByTestId('chk-update-auto')) as HTMLInputElement
    await waitFor(() => expect(box.disabled).toBe(false))
    expect(box.checked).toBe(true)
    fireEvent.click(box)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('app:updates:set', { autoCheck: false }))
    await waitFor(() => expect((screen.getByTestId('chk-update-auto') as HTMLInputElement).checked).toBe(false))
    fireEvent.click(screen.getByTestId('btn-update-check'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('app:checkUpdates', undefined))
  })

  it('simple settings: a non-owner sees it read-only', async () => {
    act(() => useSession.setState({ slug: 'a', user: { id: 2, name: 'Ravi', role: 'accountant' } }))
    render(wrap(<UpdatesSetting />))
    const box = (await screen.findByTestId('chk-update-auto')) as HTMLInputElement
    expect(box.disabled).toBe(true)
    expect(screen.getByText(CATALOGUES.en['simple.updates.ownerOnly']!)).toBeTruthy()
  })

  it('accountant About carries the same toggle', async () => {
    render(wrap(<AboutSection />))
    const box = (await screen.findByTestId('chk-update-auto')) as HTMLInputElement
    await waitFor(() => expect(box.disabled).toBe(false))
    fireEvent.click(box)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('app:updates:set', { autoCheck: false }))
    expect(screen.getByText('Check for updates automatically')).toBeTruthy()
  })
})

describe('who may change the update setting (the AI-key rule, asked before the click)', () => {
  it('no sign-ins anywhere: the simple toggle asks first, then sends confirmNoUsers; Cancel sends nothing', async () => {
    gate = { allowed: true, reason: 'needs_confirmation' }
    render(wrap(<><UpdatesSetting /><DialogHost /></>))
    const box = (await screen.findByTestId('chk-update-auto')) as HTMLInputElement
    await waitFor(() => expect(box.disabled).toBe(false))
    expect(screen.getByText(CATALOGUES.en['simple.updates.noSignIns']!)).toBeTruthy()
    fireEvent.click(box)
    fireEvent.click(await screen.findByText(CATALOGUES.en['simple.updates.confirmButton']!))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('app:updates:set', { autoCheck: false, confirmNoUsers: true }))
    invoke.mockClear()
    fireEvent.click(screen.getByTestId('chk-update-auto'))
    fireEvent.click(await screen.findByText('Cancel'))
    await act(async () => {})
    expect(invoke).not.toHaveBeenCalledWith('app:updates:set', expect.anything())
  })

  it('another company has users: the toggle is disabled and says why, before any click', async () => {
    gate = { allowed: false, reason: 'other_company_has_users' }
    render(wrap(<UpdatesSetting />))
    expect(await screen.findByText(CATALOGUES.en['simple.updates.otherCompany']!)).toBeTruthy()
    expect((screen.getByTestId('chk-update-auto') as HTMLInputElement).disabled).toBe(true)
  })

  it('the notice asks to confirm before Download now and shows no buttons when another company has users', async () => {
    gate = { allowed: true, reason: 'needs_confirmation' }
    view.notice = available
    const first = render(wrap(<><UpdateNotice /><DialogHost /></>))
    fireEvent.click(await screen.findByTestId('btn-update-download'))
    fireEvent.click(await screen.findByText(CATALOGUES.en['simple.updates.confirmButton']!))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('app:updates:act', { action: 'download', confirmNoUsers: true }))
    first.unmount()
    gate = { allowed: false, reason: 'other_company_has_users' }
    render(wrap(<UpdateNotice />))
    expect(await screen.findByText(CATALOGUES.en['simple.updates.otherCompany']!)).toBeTruthy()
    expect(screen.queryByTestId('btn-update-download')).toBeNull()
  })

  it('company-select screen (no company, no sign-in): main asks for the confirmation the verdict did not foresee -> ask, then retry', async () => {
    // canSet unreadable / not answered yet: the local fallback allows the click; main refuses with the confirm code.
    let refused = 0
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel: string, payload?: { action?: string; confirmNoUsers?: boolean }) => {
      if (channel === 'app:updates:act' && !payload?.confirmNoUsers) {
        refused++
        return { ok: false, error: 'Confirm to continue.', code: 'updates_confirm_no_users' }
      }
      return base(channel, payload)
    })
    view.notice = available
    render(wrap(<><UpdateNotice /><DialogHost /></>))
    fireEvent.click(await screen.findByTestId('btn-update-download'))
    fireEvent.click(await screen.findByText(CATALOGUES.en['simple.updates.confirmButton']!))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('app:updates:act', { action: 'download', confirmNoUsers: true }))
    expect(refused).toBe(1)
    // Cancel: nothing more is sent.
    invoke.mockClear()
    fireEvent.click(screen.getByTestId('btn-update-skip'))
    fireEvent.click(await screen.findByText('Cancel'))
    await act(async () => {})
    expect(invoke).not.toHaveBeenCalledWith('app:updates:act', { action: 'skip', confirmNoUsers: true })
  })

  it('accountant About: confirms in plain English, and explains when another company has users', async () => {
    gate = { allowed: true, reason: 'needs_confirmation' }
    const first = render(wrap(<><AboutSection /><DialogHost /></>))
    const box = (await screen.findByTestId('chk-update-auto')) as HTMLInputElement
    await waitFor(() => expect(box.disabled).toBe(false))
    fireEvent.click(box)
    fireEvent.click(await screen.findByText('Continue'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('app:updates:set', { autoCheck: false, confirmNoUsers: true }))
    first.unmount()
    gate = { allowed: false, reason: 'other_company_has_users' }
    render(wrap(<AboutSection />))
    expect(await screen.findByText(/Another company on this computer has users/)).toBeTruthy()
  })
})
