// WP 8.3: the setup wizard — steps in order, each refusing to go on with the problem under its
// field, GSTIN / filing asked only when they apply, "not sure" explained, the start date in plain
// words, and the payload `simple:setup` receives. The first-run company-select IS the wizard, with
// the accountant ways in (full form, sample data in the full app) on the same screen.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SetupWizard } from '../simple/SetupWizard'
import { CompanySelect } from '../screens/CompanySelect'
import { useNav, useSession } from '../state/stores'
import type { SimpleSetupInput } from '@shared/simple/setup'

const TODAY = '2026-10-13'
const invoke = vi.fn()

function withClient(ui: React.JSX.Element): React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>
}

const click = (id: string): void => {
  fireEvent.click(screen.getByTestId(id))
}
const next = (): void => click('setup-next')
const step = (): string | null => screen.getByTestId('setup-wizard').getAttribute('data-step')

function renderWizard(onFinish = vi.fn(async () => {})): { onFinish: typeof onFinish; onFullForm: () => void; onSample: () => void } {
  const onFullForm = vi.fn()
  const onSample = vi.fn()
  render(withClient(<SetupWizard today={TODAY} onFinish={onFinish} onSample={onSample} onSampleFull={vi.fn()} onFullForm={onFullForm} onImportBackup={vi.fn()} />))
  return { onFinish, onFullForm, onSample }
}

beforeEach(() => {
  localStorage.clear()
  invoke.mockReset()
  window.total = { platform: 'test', invoke } as unknown as typeof window.total
})
afterEach(() => cleanup())

describe('setup wizard', () => {
  it('an unregistered kirana: every step checks itself, then one payload with no GST', async () => {
    const { onFinish } = renderWizard()
    expect(step()).toBe('business')
    expect(screen.getByTestId('setup-step-label').textContent).toBe('Step 1 of 6')
    // The state list runs in code order (01 first).
    const options = [...(screen.getByTestId('setup-state') as HTMLSelectElement).options].map((o) => o.value)
    expect(options.slice(0, 3)).toEqual(['01', '02', '03'])
    next()
    expect(step()).toBe('business')
    expect(screen.getByText('Type the name of your business.')).toBeTruthy()
    fireEvent.change(screen.getByTestId('setup-name'), { target: { value: 'Ramesh Kirana' } })
    expect(screen.queryByText('Type the name of your business.')).toBeNull()
    next()
    expect(step()).toBe('type')
    next()
    expect(screen.getByTestId('setup-choice-error').textContent).toBe('Pick the kind of business closest to yours.')
    click('setup-type-retail')
    next()
    expect(step()).toBe('gst')
    next()
    expect(screen.getByTestId('setup-choice-error').textContent).toMatch(/Not sure/)
    click('setup-gst-no')
    expect(screen.queryByTestId('setup-gstin')).toBeNull()
    next()
    // Stock: a shop starts at "Yes" (its preset), the user can change it.
    expect(step()).toBe('stock')
    expect(screen.getByTestId('setup-stock-yes').getAttribute('aria-checked')).toBe('true')
    next()
    expect(step()).toBe('start')
    expect(screen.getByTestId('setup-start-fy').textContent).toContain('Start of this financial year (1 Apr 2026)')
    expect(screen.getByTestId('setup-start-today').textContent).toContain('13 Oct 2026')
    next()
    expect(screen.getByTestId('setup-choice-error').textContent).toBe('Choose one.')
    click('setup-fresh-new')
    next()
    expect(step()).toBe('tally')
    expect(screen.getByTestId('setup-summary').textContent).toContain('Shop (kirana / retail)')
    click('setup-finish')
    await waitFor(() => expect(onFinish).toHaveBeenCalledTimes(1))
    const [payload, opts] = onFinish.mock.calls[0]! as unknown as [SimpleSetupInput, { tally: boolean }]
    expect(payload).toEqual({
      name: 'Ramesh Kirana', stateCode: '27', businessType: 'retail', gst: 'no', gstin: null, filing: null,
      stock: true, startDate: '2026-04-01', fresh: true, mode: 'simple', fromTally: false
    })
    expect(opts).toEqual({ tally: false })
  })

  it('regular GST asks for the GSTIN (checked against the state) and the filing frequency; Tally and the full app can be chosen', async () => {
    const { onFinish } = renderWizard()
    fireEvent.change(screen.getByTestId('setup-name'), { target: { value: 'Asha Design' } })
    next()
    click('setup-type-services')
    next()
    click('setup-gst-regular')
    next()
    expect(screen.getByText('Type your GSTIN, or choose “Not sure” and add it later.')).toBeTruthy()
    expect(screen.getByText('Choose how often you file GST returns.')).toBeTruthy()
    fireEvent.change(screen.getByTestId('setup-gstin'), { target: { value: '29AAPFU0939F1ZV' } })
    click('setup-filing-quarterly')
    next()
    expect(screen.getByText(/This doesn’t look like a GSTIN|another state/)).toBeTruthy()
    fireEvent.change(screen.getByTestId('setup-gstin'), { target: { value: '27aapfu0939f1zv' } })
    next()
    expect(step()).toBe('stock')
    // Services start at "No" stock.
    expect(screen.getByTestId('setup-stock-no').getAttribute('aria-checked')).toBe('true')
    next()
    click('setup-start-earlier')
    click('setup-fresh-continuing')
    next()
    expect(screen.getByText('Pick the first day to record.')).toBeTruthy()
    fireEvent.change(screen.getByTestId('setup-start-date'), { target: { value: '01-07-2025' } })
    fireEvent.blur(screen.getByTestId('setup-start-date'))
    next()
    expect(step()).toBe('tally')
    click('setup-tally-yes')
    click('setup-accountant-mode')
    click('setup-finish')
    await waitFor(() => expect(onFinish).toHaveBeenCalledTimes(1))
    const [payload, opts] = onFinish.mock.calls[0]! as unknown as [SimpleSetupInput, { tally: boolean }]
    expect(payload).toMatchObject({ businessType: 'services', gst: 'regular', gstin: '27AAPFU0939F1ZV', filing: 'quarterly', stock: false, startDate: '2025-07-01', fresh: false, mode: 'accountant', fromTally: true })
    expect(opts).toEqual({ tally: true })
  })

  it('"not sure" is explained and asks for nothing more; Back keeps the answers', () => {
    renderWizard()
    fireEvent.change(screen.getByTestId('setup-name'), { target: { value: 'X' } })
    next()
    click('setup-type-other')
    next()
    click('setup-gst-not_sure')
    expect(screen.getByTestId('setup-not-sure-note').textContent).toMatch(/change this later/)
    next()
    expect(step()).toBe('stock')
    click('setup-back')
    expect(step()).toBe('gst')
    expect(screen.getByTestId('setup-gst-not_sure').getAttribute('aria-checked')).toBe('true')
  })

  it('a failed create shows the reason and lets the user try again', async () => {
    const onFinish = vi.fn(async () => {
      throw new Error('disk full')
    })
    renderWizard(onFinish)
    fireEvent.change(screen.getByTestId('setup-name'), { target: { value: 'X' } })
    next()
    click('setup-type-other')
    next()
    click('setup-gst-no')
    next()
    next()
    click('setup-fresh-new')
    next()
    click('setup-finish')
    await waitFor(() => expect(screen.getByTestId('setup-failure').textContent).toContain('disk full'))
    expect((screen.getByTestId('setup-finish') as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('company-select', () => {
  it('first run shows the wizard, with the full form and sample data in the full app on the same screen', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'company:list') return { ok: true, data: { companies: [] } }
      if (channel === 'company:createDemo') return { ok: true, data: { slug: 'demo-traders' } }
      if (channel === 'company:open') return { ok: true, data: { slug: 'demo-traders', info: { name: 'Demo Traders' }, integrity: { ok: true }, locked: false, ui: { mode: 'simple' } } }
      return { ok: false, error: `unmocked ${channel}` }
    })
    act(() => useNav.setState({ stack: [{ name: 'gateway' }] }))
    render(withClient(<CompanySelect />))
    await waitFor(() => expect(screen.getByTestId('setup-wizard')).toBeTruthy())
    expect(screen.getByTestId('btn-company-create')).toBeTruthy()
    expect(screen.getByTestId('btn-company-demo-full')).toBeTruthy()
    click('btn-company-demo')
    await waitFor(() => expect(useSession.getState().slug).toBe('demo-traders'))
    expect(invoke.mock.calls.find((c) => c[0] === 'company:createDemo')![1]).toEqual({ mode: 'simple' })
    expect(useSession.getState().ui.mode).toBe('simple')
  })

  it('the full form is still there for accountants', async () => {
    invoke.mockImplementation(async (channel: string) => (channel === 'company:list' ? { ok: true, data: { companies: [] } } : { ok: false, error: 'x' }))
    render(withClient(<CompanySelect />))
    await waitFor(() => expect(screen.getByTestId('setup-wizard')).toBeTruthy())
    click('btn-company-create')
    await waitFor(() => expect(screen.getByTestId('input-company-name')).toBeTruthy())
  })
})

describe('simple Settings → Features (WP 8.3 review)', () => {
  it('"Turn on" cards in plain words — no banned word — and a click saves at once', async () => {
    const { SimpleFeatures } = await import('../simple/SimpleFeatures')
    const { bannedWordsIn } = await import('@shared/simple/bannedWords')
    const { presetFeatures } = await import('@shared/simple/presets')
    let stored = presetFeatures('retail', true)
    invoke.mockImplementation(async (channel: string, payload?: unknown) => {
      if (channel === 'config:features:get') return { ok: true, data: stored }
      if (channel === 'config:features:set') {
        stored = payload as typeof stored
        return { ok: true, data: stored }
      }
      return { ok: false, error: `unmocked ${channel}` }
    })
    act(() => useSession.setState({ user: null }))
    render(withClient(<SimpleFeatures />))
    await waitFor(() => expect(screen.getByTestId('feature-card-tds').getAttribute('data-on')).toBe('false'))
    expect(bannedWordsIn(screen.getByTestId('simple-features').textContent ?? '')).toEqual([])
    expect(screen.getByTestId('feature-card-tds').textContent).toContain('Your CA will tell you')
    click('btn-feature-payroll')
    await waitFor(() => expect(screen.getByTestId('feature-card-payroll').getAttribute('data-on')).toBe('true'))
    expect(stored.payroll).toBe(true)
    // Making goods needs stock: turning it on in a company without stock turns stock on too.
    stored = { ...stored, inventory: false, manufacturing: false }
    cleanup()
    render(withClient(<SimpleFeatures />))
    await waitFor(() => expect(screen.getByTestId('feature-card-inventory').getAttribute('data-on')).toBe('false'))
    click('btn-feature-manufacturing')
    await waitFor(() => expect(stored).toMatchObject({ manufacturing: true, inventory: true }))
  })
})
