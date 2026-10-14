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
import { refreshUiFromMain, useMode, useScreenView, viewOverrideKey } from '../lib/mode'
import { RegistersScreen } from '../screens/Registers'
import { Settings } from '../screens/Settings'
import { screenOptionsKey } from '../components/ScreenOptions'
import { DEFAULT_FEATURES } from '@shared/features'
import type { UiSettings } from '@shared/simple/uiMode'

const invoke = vi.fn()
let currentUi: UiSettings | undefined
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
    if (channel === 'ui:mode:set') return { ok: true, data: { ...useSession.getState().ui, ...(payload as object) } }
    if (channel === 'company:current') return { ok: true, data: currentUi === undefined ? null : { slug: 'mode-co', info: INFO, locked: false, ui: currentUi } }
    return { ok: false, error: `unmocked channel ${channel}` }
  })
  window.total = { platform: 'test', invoke } as unknown as typeof window.total
  currentUi = undefined
  act(() => useNav.setState({ stack: [{ name: 'gateway' }] }))
})
afterEach(() => cleanup())

describe('useMode and the per-screen override', () => {
  it('reads the company mode; the override is per company + screen + user', () => {
    setSession({ mode: 'simple' }, { id: 7, name: 'Asha', role: 'owner' })
    const { result } = renderHook(() => ({ mode: useMode(), day: useScreenView('gateway'), pl: useScreenView('simple-looks') }))
    expect(result.current.mode).toBe('simple')
    expect(result.current.day.view).toBe('simple')
    act(() => result.current.day.setAccountantView(true))
    expect(localStorage.getItem(viewOverrideKey('mode-co', 7, 'gateway'))).toBe('accountant')
    expect(result.current.day).toMatchObject({ view: 'accountant', override: true })
    expect(result.current.pl.view).toBe('simple')
    // Another user of the same company keeps their own choice.
    act(() => useSession.setState({ user: { id: 8, name: 'Ravi', role: 'accountant' } as never }))
    expect(result.current.day.view).toBe('simple')
    act(() => useSession.setState({ user: { id: 7, name: 'Asha', role: 'owner' } as never }))
    expect(result.current.day.view).toBe('accountant')
    act(() => result.current.day.setAccountantView(false))
    expect(localStorage.getItem(viewOverrideKey('mode-co', 7, 'gateway'))).toBeNull()
    expect(result.current.day.view).toBe('simple')
  })

  it('an accountant company shows everything in the full app; screens without a simple flow never show simple', () => {
    setSession({ mode: 'accountant' })
    const { result } = renderHook(() => ({ home: useScreenView('gateway'), day: useScreenView('daybook'), tb: useScreenView('trial-balance') }))
    expect(result.current.home.view).toBe('accountant')
    act(() => useSession.setState({ ui: { mode: 'simple' } }))
    expect(result.current.home.view).toBe('simple')
    expect(result.current.day.view).toBe('accountant')
    expect(result.current.tb.view).toBe('accountant')
  })

  it('refreshUiFromMain: a restored simple backup flips the session; a pre-8.1 one brings accountant back', async () => {
    setSession({ mode: 'accountant' })
    currentUi = { mode: 'simple' }
    await act(async () => refreshUiFromMain())
    expect(useSession.getState().ui).toEqual({ mode: 'simple' })
    currentUi = { mode: 'accountant' } // main's answer for a backup without the ui key
    await act(async () => refreshUiFromMain())
    expect(useSession.getState().ui).toEqual({ mode: 'accountant' })
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
    expect(screen.getByTestId('simple-nav-home').getAttribute('aria-current')).toBe('page')
    expect(screen.getByTestId('btn-search').textContent).toBe('Search ⌘K')
    expect(screen.getByTestId('btn-assistant').textContent).toBe('Ask Total ⌘J') // WP 10.1: the simple header's button opens Ask Total
    expect(screen.queryByTestId('nav-gateway')).toBeNull()

    fireEvent.click(screen.getByTestId('counter'))
    fireEvent.click(screen.getByTestId('counter'))
    fireEvent.click(screen.getByTestId('btn-accountant-view'))
    // The full shell, same screen, same state.
    expect(await screen.findByTestId('nav-gateway')).toBeTruthy()
    expect(screen.queryByTestId('simple-nav')).toBeNull()
    expect(screen.getByTestId('counter').textContent).toBe('2')
    expect(useNav.getState().stack.at(-1)).toEqual({ name: 'gateway' })

    fireEvent.click(screen.getByTestId('btn-back-to-simple'))
    expect(await screen.findByTestId('simple-nav')).toBeTruthy()
    expect(screen.getByTestId('counter').textContent).toBe('2')
  })

  it('a screen without its simple flow yet opens in the full shell; Back to simple goes to its section', async () => {
    setSession({ mode: 'simple' })
    act(() => useNav.setState({ stack: [{ name: 'daybook' }] }))
    render(withClient(<Shell onOpenPalette={() => {}}><div /></Shell>))
    expect(await screen.findByTestId('nav-gateway')).toBeTruthy()
    expect(screen.queryByTestId('btn-accountant-view')).toBeNull()
    fireEvent.click(screen.getByTestId('btn-back-to-simple'))
    await waitFor(() => expect(useNav.getState().stack.at(-1)).toEqual({ name: 'simple-section', section: 'money' }))
  })

  it('simple-only screens (How Total looks) stay in the simple shell with no Accountant view', async () => {
    setSession({ mode: 'simple' })
    act(() => useNav.setState({ stack: [{ name: 'simple-looks' }] }))
    render(withClient(<Shell onOpenPalette={() => {}}><div /></Shell>))
    expect(await screen.findByTestId('simple-nav')).toBeTruthy()
    expect(screen.getByTestId('simple-nav-settings').getAttribute('aria-current')).toBe('page')
    expect(screen.queryByTestId('btn-accountant-view')).toBeNull()
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
    // WP 9.8: People's entries are the simple People screen; Money → All entries is still the full app.
    render(withClient(<SimpleSection section="people" />))
    await waitFor(() => expect(screen.getByTestId('simple-entry-customers-suppliers').textContent).toContain('Customers and suppliers'))
    expect(screen.getByTestId('simple-entry-customers-suppliers').textContent).not.toContain('Full app')
    cleanup()
    render(withClient(<SimpleSection section="money" />))
    await waitFor(() => expect(screen.getByTestId('simple-entry-all-entries').textContent).toContain('Full app'))
    fireEvent.click(screen.getByTestId('simple-entry-all-entries'))
    await waitFor(() => expect(useNav.getState().stack.at(-1)).toEqual({ name: 'daybook' }))
    cleanup()
    render(withClient(<SimpleSection section="taxes" />))
    expect(await screen.findByTestId('simple-entry-gst-summary')).toBeTruthy()
    cleanup()
    act(() => useSession.setState({ info: { ...INFO, gstRegistrationType: 'unregistered' } as never }))
    render(withClient(<SimpleSection section="taxes" />))
    await waitFor(() => expect(screen.getByTestId('simple-entry-tds')).toBeTruthy())
    expect(screen.queryByTestId('simple-entry-gst-summary')).toBeNull()
    expect(screen.getByTestId('simple-taxes-unregistered')).toBeTruthy()
  })

  it('composition: no GSTR-1 / 3B / 2B entries, the composition note instead; nothing GST while details load', async () => {
    setSession({ mode: 'simple' })
    act(() => useSession.setState({ info: { ...INFO, gstRegistrationType: 'composition' } as never }))
    render(withClient(<SimpleSection section="taxes" />))
    await waitFor(() => expect(screen.getByTestId('simple-taxes-composition').textContent).toContain('CMP-08'))
    for (const id of ['gst-summary', 'gst-sales', 'check-supplier-bills']) expect(screen.queryByTestId(`simple-entry-${id}`)).toBeNull()
    // WP 9.9: the card opens Taxes (the CMP-08 / GSTR-4 dates).
    fireEvent.click(screen.getByTestId('simple-taxes-composition-open'))
    await waitFor(() => expect(useNav.getState().stack.at(-1)).toEqual({ name: 'simple-taxes' }))
    cleanup()
    render(withClient(<SimpleSection section="reports" />))
    await waitFor(() => expect(screen.getByTestId('simple-entry-how-am-i-doing')).toBeTruthy())
    expect(screen.queryByTestId('simple-entry-gst-summary-report')).toBeNull()
    cleanup()
    act(() => useSession.setState({ info: null }))
    render(withClient(<SimpleSection section="taxes" />))
    await waitFor(() => expect(screen.getByTestId('simple-entry-tds')).toBeTruthy())
    expect(screen.queryByTestId('simple-entry-gst-summary')).toBeNull()
  })

  it('the simple Settings list: seven entries (WP 8.7: day one) and Advanced (the full Settings)', async () => {
    setSession({ mode: 'simple' })
    render(withClient(<SimpleSection section="settings" />))
    await waitFor(() => expect(screen.getByTestId('simple-entry-advanced')).toBeTruthy())
    const ids = Array.from(document.querySelectorAll('[data-testid^="simple-entry-"]')).map((e) => e.getAttribute('data-testid'))
    expect(ids).toEqual(['business', 'openings', 'bills-printing', 'backups', 'people-roles', 'features', 'looks', 'advanced'].map((i) => `simple-entry-${i}`))
    fireEvent.click(screen.getByTestId('simple-entry-advanced'))
    await waitFor(() => expect(useNav.getState().stack.at(-1)).toEqual({ name: 'settings' }))
  })

  it('Settings calls the company tab "Business details" in a simple company', () => {
    setSession({ mode: 'simple' })
    render(withClient(<Settings tab="appearance" />))
    expect(screen.getByTestId('tab-settings-company').textContent).toBe('Business details')
    cleanup()
    setSession({ mode: 'accountant' })
    render(withClient(<Settings tab="appearance" />))
    expect(screen.getByTestId('tab-settings-company').textContent).toBe('Company details')
  })
})

describe('Registers honours a requested tab (Purchase list)', () => {
  it('opens the purchase register whatever was viewed last, and remembers it', async () => {
    setSession({ mode: 'simple' })
    localStorage.setItem(screenOptionsKey('mode-co', 'registers'), JSON.stringify({ tab: 'items' }))
    render(withClient(<RegistersScreen tab="purchase" />))
    await waitFor(() => expect(screen.getByTestId('tab-registers-purchase').getAttribute('aria-selected')).toBe('true'))
    cleanup()
    render(withClient(<RegistersScreen />))
    await waitFor(() => expect(screen.getByTestId('tab-registers-purchase').getAttribute('aria-selected')).toBe('true'))
  })
})

describe('Settings → How Total looks → mode', () => {
  it('the owner switches (ui:mode:set) and the session follows', async () => {
    setSession({ mode: 'accountant' }, { id: 1, name: 'Owner', role: 'owner' })
    act(() => useNav.setState({ stack: [{ name: 'gateway' }, { name: 'settings', tab: 'appearance' }] }))
    render(withClient(<ModeSetting />))
    expect(screen.getByTestId('btn-mode-accountant').getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByTestId('btn-mode-simple'))
    await waitFor(() => expect(useSession.getState().ui.mode).toBe('simple'))
    expect(invoke).toHaveBeenCalledWith('ui:mode:set', { mode: 'simple' })
    // From the full Settings it lands on the same control in the simple shell.
    await waitFor(() => expect(useNav.getState().stack.at(-1)).toEqual({ name: 'simple-looks' }))
  })

  it('anyone but the owner sees it read-only', () => {
    setSession({ mode: 'accountant' }, { id: 2, name: 'Clerk', role: 'accountant' })
    render(withClient(<ModeSetting />))
    expect((screen.getByTestId('btn-mode-simple') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('Only the owner can change this.')).toBeTruthy()
    fireEvent.click(screen.getByTestId('btn-mode-simple'))
    expect(invoke).not.toHaveBeenCalledWith('ui:mode:set', expect.anything())
  })
})
