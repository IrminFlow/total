// Feature cleanup: cost centres, cheque books + PDC + bulk payment files,
// interest on overdue bills, the fixed-asset register, the trade cycle and payroll statutory are
// hidden for a company that has none of their data (`unused` on config:features:get) — no sidebar
// entry, no Features card, no tab — and shown exactly as before for one that has.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useNav, useSession } from '../state/stores'
import { Shell } from '../components/Shell'
import { FeaturesSection } from '../screens/settings/FeaturesSection'
import { SimpleFeatures } from '../simple/SimpleFeatures'
import { DEFAULT_FEATURES, HIDEABLE_FEATURES, type CompanyFeatures, type HideableFeature } from '@shared/features'

const invoke = vi.fn()
let unused: HideableFeature[] = []
let stored: CompanyFeatures = { ...DEFAULT_FEATURES, orders: true }

function renderUi(ui: React.ReactElement): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

beforeEach(() => {
  localStorage.clear()
  unused = []
  stored = { ...DEFAULT_FEATURES, orders: true }
  invoke.mockReset()
  invoke.mockImplementation(async (channel: string, payload: unknown) => {
    if (channel === 'config:features:get') return { ok: true, data: { ...stored, unused } }
    if (channel === 'config:features:set') {
      stored = payload as CompanyFeatures
      return { ok: true, data: stored }
    }
    return { ok: false, error: `unmocked channel ${channel}` }
  })
  window.total = { platform: 'test', invoke } as unknown as typeof window.total
  act(() => {
    useSession.setState({
      slug: 'acct-co',
      info: { name: 'Acct Co', stateCode: '27', gstin: null, gstRegistrationType: 'regular', address: '', booksFrom: 2026, email: null, phone: null, pan: null, tan: null } as never,
      from: '2026-04-01',
      to: '2027-03-31',
      locked: false,
      user: null
    })
    useNav.setState({ stack: [{ name: 'gateway' }] })
  })
})
afterEach(() => cleanup())

const HIDDEN_NAV = ['nav-cost-centres', 'nav-fixed-assets', 'nav-pending-challans', 'nav-quotations']

async function shell(): Promise<void> {
  renderUi(
    <Shell onOpenPalette={() => {}}>
      <div />
    </Shell>
  )
  await waitFor(() => expect(invoke.mock.calls.some((c) => c[0] === 'config:features:get')).toBe(true))
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20))
  })
}

describe('hidden until used', () => {
  it('a company with the data keeps every entry', async () => {
    await shell()
    for (const id of HIDDEN_NAV) expect(document.querySelector(`[data-testid="${id}"]`), id).not.toBeNull()
  })

  it('a company with none of the data has no entry for them; the rest of the sidebar is unchanged', async () => {
    unused = [...HIDEABLE_FEATURES]
    await shell()
    for (const id of HIDDEN_NAV) expect(document.querySelector(`[data-testid="${id}"]`), id).toBeNull()
    for (const id of ['nav-trial-balance', 'nav-banking', 'nav-receivables', 'nav-cash-forecast', 'nav-payroll']) expect(document.querySelector(`[data-testid="${id}"]`), id).not.toBeNull()
  })

  it('Settings → Features leaves out the cards of hidden features only', async () => {
    unused = ['costCentres', 'tradeCycle']
    renderUi(<FeaturesSection />)
    await screen.findByTestId('feature-card-inventory')
    await waitFor(() => expect(screen.queryByTestId('feature-card-costCentres')).toBeNull())
    expect(screen.queryByTestId('feature-card-orders')).toBeNull()
    for (const k of ['tds', 'tcs', 'payroll', 'billWise']) expect(screen.getByTestId(`feature-card-${k}`)).toBeTruthy()
  })

  it('More features: the door back — collapsed, lists the hidden ones; Turn on shows its sidebar entry with no data', async () => {
    unused = [...HIDEABLE_FEATURES]
    renderUi(<FeaturesSection />)
    const toggle = await screen.findByTestId('btn-features-more')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    for (const h of ['costCentres', 'cheques', 'interest', 'fixedAssets', 'tradeCycle', 'payrollStatutory']) expect(screen.getByTestId(`feature-more-card-${h}`).dataset.on, h).toBe('false')
    expect(screen.queryByTestId('feature-more-card-forex')).toBeNull()
    fireEvent.click(screen.getByTestId('btn-feature-more-fixedAssets'))
    await waitFor(() => expect(stored.turnedOn).toEqual(['fixedAssets']))
    await waitFor(() => expect(screen.getByTestId('feature-more-card-fixedAssets').dataset.on).toBe('true'))
    cleanup()
    await shell()
    expect(document.querySelector('[data-testid="nav-fixed-assets"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="nav-cost-centres"]')).toBeNull()
  })

  it('a flag feature turned on joins the main list; turning it off there hides it again', async () => {
    unused = [...HIDEABLE_FEATURES]
    stored = { ...DEFAULT_FEATURES, costCentres: false }
    renderUi(<FeaturesSection />)
    fireEvent.click(await screen.findByTestId('btn-features-more'))
    fireEvent.click(screen.getByTestId('btn-feature-more-costCentres'))
    await waitFor(() => expect(stored).toMatchObject({ costCentres: true, turnedOn: ['costCentres'] }))
    await waitFor(() => expect(screen.getByTestId('feature-card-costCentres').dataset.on).toBe('true'))
    expect(screen.queryByTestId('feature-more-card-costCentres')).toBeNull()
    fireEvent.click(screen.getByTestId('btn-feature-costCentres'))
    await waitFor(() => expect(stored).toMatchObject({ costCentres: false, turnedOn: [] }))
    await waitFor(() => expect(screen.queryByTestId('feature-card-costCentres')).toBeNull())
  })

  it('simple mode has the same collapsed list', async () => {
    unused = ['cheques', 'interest']
    renderUi(<SimpleFeatures />)
    fireEvent.click(await screen.findByTestId('btn-features-more'))
    expect(screen.getByTestId('feature-more-card-cheques')).toBeTruthy()
    expect(screen.getByTestId('feature-more-card-interest')).toBeTruthy()
    expect(screen.queryByTestId('feature-more-card-fixedAssets')).toBeNull()
  })
})
