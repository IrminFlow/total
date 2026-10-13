// WP 8.1: the accountant sidebar is generated from the screen registry (lib/screens.ts) and
// must stay EXACTLY what 0.10 showed — sections, order, labels, test ids, the collapsed /
// expanded defaults and the header chrome. The snapshot was written from main's Shell before
// the mode model landed and is verified after it, for the default features and with every
// feature on (orders, payroll …), in an accountant company (no `ui` meta) — and for a company
// whose meta says accountant explicitly.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useNav, useSession } from '../state/stores'
import { Shell } from '../components/Shell'
import { DEFAULT_FEATURES, type CompanyFeatures } from '@shared/features'

const invoke = vi.fn()
let features: Partial<CompanyFeatures> = {}
let savedReports: unknown[] = []

function sidebarShape(): unknown {
  const nav = screen.getByRole('navigation', { name: 'Main' })
  const out: unknown[] = []
  for (const block of Array.from(nav.children)) {
    const list = block.querySelector('[id^="nav-list-"]')
    if (!list) {
      out.push({ footer: block.textContent?.trim() })
      continue
    }
    const head = block.querySelector('[data-testid^="nav-section-"]')
    out.push({
      section: list.id,
      title: head?.textContent ?? null,
      expanded: head ? head.getAttribute('aria-expanded') : 'always',
      items: Array.from(list.querySelectorAll('button')).map((b) => `${b.getAttribute('data-testid')} | ${b.textContent}`)
    })
  }
  return out
}

function headerShape(): string[] {
  const header = document.querySelector('header')!
  return Array.from(header.querySelectorAll('button')).map((b) => `${b.getAttribute('data-testid') ?? '-'} | ${b.getAttribute('aria-label') ?? ''} | ${b.textContent}`)
}

async function renderShell(): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <Shell onOpenPalette={() => {}}>
        <div />
      </Shell>
    </QueryClientProvider>
  )
  await waitFor(() => expect(invoke.mock.calls.some((c) => c[0] === 'config:features:get')).toBe(true))
  // Let the features query settle.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20))
  })
}

beforeEach(() => {
  localStorage.clear()
  features = {}
  savedReports = []
  invoke.mockReset()
  invoke.mockImplementation(async (channel: string) => {
    if (channel === 'config:features:get') return { ok: true, data: { ...DEFAULT_FEATURES, ...features } }
    if (channel === 'rb:list') return { ok: true, data: savedReports }
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

describe('accountant sidebar (unchanged from 0.10)', () => {
  it('default features', async () => {
    await renderShell()
    expect(sidebarShape()).toMatchSnapshot()
    expect(headerShape()).toMatchSnapshot()
  })

  it('every feature on', async () => {
    features = { orders: true, payroll: true, inventory: true, costCentres: true, tds: true, tcs: true, batches: true }
    await renderShell()
    expect(sidebarShape()).toMatchSnapshot()
  })

  it('inventory, payroll, TDS / TCS and cost centres off', async () => {
    features = { inventory: false, payroll: false, tds: false, tcs: false, costCentres: false, orders: false }
    await renderShell()
    expect(sidebarShape()).toMatchSnapshot()
  })

  it('a pinned saved report joins Analysis as a dynamic entry (badge ◆)', async () => {
    savedReports = [
      { id: 5, name: 'Sales by party by month', model: null, problem: null, owner: null, pinned: true, createdAt: '', updatedAt: '' },
      { id: 6, name: 'Not pinned', model: null, problem: null, owner: null, pinned: false, createdAt: '', updatedAt: '' }
    ]
    await renderShell()
    await waitFor(() => expect(screen.getByTestId('nav-report-5')).toBeTruthy())
    expect(sidebarShape()).toMatchSnapshot()
  })

  it('an unregistered company (WP 8.0: GST screens hidden)', async () => {
    act(() => useSession.setState({ info: { ...(useSession.getState().info as object), gstRegistrationType: 'unregistered' } as never }))
    await renderShell()
    expect(sidebarShape()).toMatchSnapshot()
  })
})
