// WP 8.1: useMode / the per-screen "Accountant view" override (company + screen + user), the
// simple shell (≤ 10 sidebar entries, "Search ⌘K", the view toggle keeping the screen mounted),
// the section pages, and the owner-only mode switch in Settings → "How Total looks".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { useNav, useSession } from '../state/stores'
import { Shell } from '../components/Shell'
import { SimpleSection } from '../simple/SimpleSection'
import { ModeSetting } from '../simple/ModeSetting'
import { useMode, useScreenView, viewOverrideKey } from '../lib/mode'
import { DEFAULT_FEATURES } from '@shared/features'
import type { UiSettings } from '@shared/simple/uiMode'

const invoke = vi.fn()
const INFO = { name: 'Mode Co', stateCode: '27', gstin: null, gstRegistrationType: 'regular', address: '', booksFrom: 2026, email: null, phone: null, pan: null, tan: null }

function withClient(ui: React.JSX.Element): React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>
}

function setSession(ui: UiSettings, user: { id: number; name: string; role: 'owner' | 'accountant' | 'viewer' } | null = null): void {
  act(() => {
    useSession.setState({ slug: 'mode-co', info: INFO as never, from: '2026-04-01', to: '2027-03-31', locked: false, user: user as never, ui })
  })
}

/** A screen with local state — survives a view switch only if <main> stays mounted. */
function Counter(): React.JSX.Element {
  const [n, setN] = useState(0)
  return (
    <button type="button" data-testid="counter" onClick={() => setN(n + 1)}>
      {n}
    </button>
  )
}

beforeEach(() => {
  localStorage.clear()
  invoke.mockReset()
  invoke.mockImplementation(async (channel: string, payload?: unknown) => {
    if (channel === 'config:features:get') return { ok: true, data: DEFAULT_FEATURES }
    if (channel === 'rb:list') return { ok: true, data: [] }
    if (channel === 'ui:set') return { ok: true, data: { ...useSession.getState().ui, ...(payload as object) } }
    return { ok: false, error: `unmocked channel ${channel}` }
  })
  window.total = { platform: 'test', invoke } as unknown as typeof window.total
  act(() => useNav.setState({ stack: [{ name: 'daybook' }] }))
})
afterEach(() => cleanup())

describe('useMode and the per-screen override', () => {
  it('reads the company mode; the override is per company + screen + user', () => {
    setSession({ mode: 'simple' }, { id: 7, name: 'Asha', role: 'owner' })
    const { result } = renderHook(() => ({ mode: useMode(), day: useScreenView('daybook'), pl: useScreenView('profit-loss') }))
    expect(result.current.mode).toBe('simple')
    expect(result.current.day.view).toBe('simple')
    act(() => result.current.day.setAccountantView(true))
    expect(localStorage.getItem(viewOverrideKey('mode-co', 7, 'daybook'))).toBe('accountant')
    expect(result.current.day).toMatchObject({ view: 'accountant', override: true })
    expect(result.current.pl.view).toBe('simple')
    // Another user of the same company keeps their own choice.
    act(() => useSession.setState({ user: { id: 8, name: 'Ravi', role: 'accountant' } as never }))
    expect(result.current.day.view).toBe('simple')
    act(() => useSession.setState({ user: { id: 7, name: 'Asha', role: 'owner' } as never }))
    expect(result.current.day.view).toBe('accountant')
    act(() => result.current.day.setAccountantView(false))
    expect(localStorage.getItem(viewOverrideKey('mode-co', 7, 'daybook'))).toBeNull()
    expect(result.current.day.view).toBe('simple')
  })

  it('an accountant company ignores overrides; accountant-only screens never show simple', () => {
    setSession({ mode: 'accountant' })
    localStorage.setItem(viewOverrideKey('mode-co', null, 'daybook'), 'accountant')
    const { result } = renderHook(() => ({ day: useScreenView('daybook'), tb: useScreenView('trial-balance') }))
    expect(result.current.day.view).toBe('accountant')
    act(() => useSession.setState({ ui: { mode: 'simple' } }))
    expect(result.current.tb.view).toBe('accountant')
  })
})

describe('the simple shell', () => {
  it('≤ 10 sidebar entries, Search ⌘K; Accountant view keeps the screen mounted; Back to simple', async () => {
    setSession({ mode: 'simple' })
    render(withClient(<Shell onOpenPalette={() => {}}><Counter /></Shell>))
    const nav = await screen.findByTestId('simple-nav')
    const entries = nav.querySelectorAll('[data-testid^="simple-nav-"]')
    expect(entries.length).toBeLessThanOrEqual(10)
    expect(Array.from(entries).map((e) => e.textContent)).toEqual(['Home', 'Sell', 'Buy', 'Money', 'Stock', 'People', 'Reports', 'Taxes', 'Settings'])
    expect(screen.getByTestId('simple-nav-money').getAttribute('aria-current')).toBe('page')
    expect(screen.getByTestId('btn-search').textContent).toBe('Search ⌘K')
    expect(screen.queryByTestId('nav-gateway')).toBeNull()

    fireEvent.click(screen.getByTestId('counter'))
    fireEvent.click(screen.getByTestId('counter'))
    fireEvent.click(screen.getByTestId('btn-accountant-view'))
    // The full shell, same screen, same state.
    expect(await screen.findByTestId('nav-gateway')).toBeTruthy()
    expect(screen.queryByTestId('simple-nav')).toBeNull()
    expect(screen.getByTestId('counter').textContent).toBe('2')
    expect(useNav.getState().stack.at(-1)).toEqual({ name: 'daybook' })

    fireEvent.click(screen.getByTestId('btn-back-to-simple'))
    expect(await screen.findByTestId('simple-nav')).toBeTruthy()
    expect(screen.getByTestId('counter').textContent).toBe('2')
  })

  it('an accountant-only screen opens in the full shell; Back to simple goes to its section', async () => {
    setSession({ mode: 'simple' })
    act(() => useNav.setState({ stack: [{ name: 'trial-balance' }] }))
    render(withClient(<Shell onOpenPalette={() => {}}><div /></Shell>))
    expect(await screen.findByTestId('nav-gateway')).toBeTruthy()
    fireEvent.click(screen.getByTestId('btn-back-to-simple'))
    await waitFor(() => expect(useNav.getState().stack.at(-1)).toEqual({ name: 'simple-section', section: 'reports' }))
  })

  it('an accountant company shows no view toggle at all', async () => {
    setSession({ mode: 'accountant' })
    render(withClient(<Shell onOpenPalette={() => {}}><div /></Shell>))
    expect(await screen.findByTestId('nav-gateway')).toBeTruthy()
    expect(screen.queryByTestId('btn-accountant-view')).toBeNull()
    expect(screen.queryByTestId('btn-back-to-simple')).toBeNull()
  })

  it('a section page lists its plain-named entries; GST entries only while registered', async () => {
    setSession({ mode: 'simple' })
    render(withClient(<SimpleSection section="people" />))
    await waitFor(() => expect(screen.getByTestId('simple-entry-customers-suppliers').textContent).toContain('Customers and suppliers'))
    fireEvent.click(screen.getByTestId('simple-entry-customers-suppliers'))
    await waitFor(() => expect(useNav.getState().stack.at(-1)).toEqual({ name: 'masters', tab: 'ledgers', parties: true }))
    cleanup()
    render(withClient(<SimpleSection section="taxes" />))
    expect(await screen.findByTestId('simple-entry-gst-summary')).toBeTruthy()
    cleanup()
    act(() => useSession.setState({ info: { ...INFO, gstRegistrationType: 'unregistered' } as never }))
    render(withClient(<SimpleSection section="taxes" />))
    await waitFor(() => expect(screen.getByTestId('simple-entry-tds')).toBeTruthy())
    expect(screen.queryByTestId('simple-entry-gst-summary')).toBeNull()
  })
})

describe('Settings → How Total looks → mode', () => {
  it('the owner switches (ui:set) and the session follows', async () => {
    setSession({ mode: 'accountant' }, { id: 1, name: 'Owner', role: 'owner' })
    render(withClient(<ModeSetting />))
    expect(screen.getByTestId('btn-mode-accountant').getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByTestId('btn-mode-simple'))
    await waitFor(() => expect(useSession.getState().ui.mode).toBe('simple'))
    expect(invoke).toHaveBeenCalledWith('ui:set', { mode: 'simple' })
  })

  it('anyone but the owner sees it read-only', () => {
    setSession({ mode: 'accountant' }, { id: 2, name: 'Clerk', role: 'accountant' })
    render(withClient(<ModeSetting />))
    expect((screen.getByTestId('btn-mode-simple') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('Only the owner can change this.')).toBeTruthy()
    fireEvent.click(screen.getByTestId('btn-mode-simple'))
    expect(invoke).not.toHaveBeenCalledWith('ui:set', expect.anything())
  })
})
