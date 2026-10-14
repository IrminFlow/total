// Update consent: the notice (available -> Download now / Later / Skip; ready -> Restart / Install on
// quit), pushed by main, in all three languages; and the "Check for updates automatically" toggle in
// the simple Settings and the accountant About.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { UpdateNotice as Notice, UpdatesView } from '@shared/updates'
import { UpdateNotice } from '../simple/UpdateNotice'
import { UpdatesSetting } from '../simple/UpdatesSetting'
import { AboutSection } from '../screens/settings/AboutSection'
import { LANGUAGE_KEY } from '../lib/i18n'
import { useSession } from '../state/stores'
import { CATALOGUES } from '@shared/i18n'

const invoke = vi.fn()
let view: UpdatesView
let push: ((n: unknown) => void) | null = null

const wrap = (ui: ReactNode): ReactNode => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>
)

beforeEach(() => {
  localStorage.clear()
  view = { settings: { autoCheck: true, skippedVersion: null }, notice: null, current: '0.12.0' }
  push = null
  invoke.mockReset()
  invoke.mockImplementation(async (channel: string, payload?: { autoCheck?: boolean; action?: string }) => {
    switch (channel) {
      case 'app:updates:get':
        return { ok: true, data: view }
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
