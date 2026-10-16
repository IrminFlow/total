// to-do §4 (shots-86 / PR #111): the simple sidebar's "Back up now" was shown to a viewer, whose
// backup main refuses (backup:run is accountant+). A viewer now reads a plain note there instead;
// an owner / accountant (or a company without sign-ins) keeps the button.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DEFAULT_FEATURES } from '@shared/features'
import { useNav, useSession } from '../state/stores'
import { SimpleSidebar } from '../simple/SimpleSidebar'

const invoke = vi.fn()

function renderSidebar(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <SimpleSidebar />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  invoke.mockImplementation(async (channel: string) => (channel === 'config:features:get' ? { ok: true, data: DEFAULT_FEATURES } : { ok: true, data: [] }))
  window.total = { platform: 'test', invoke } as unknown as typeof window.total
  act(() => {
    useSession.setState({ slug: 'sharma', ui: { mode: 'simple' }, workingDate: '2026-10-13', user: null } as never)
    useNav.setState({ stack: [{ name: 'gateway' }] })
  })
})
afterEach(() => {
  cleanup()
  invoke.mockReset()
  act(() => useSession.setState({ user: null }))
})

describe('the simple sidebar’s "Back up now"', () => {
  it('a viewer: no button, the plain note in its place', () => {
    act(() => useSession.setState({ user: { id: 2, name: 'Vee', role: 'viewer' } as never }))
    renderSidebar()
    expect(screen.queryByTestId('btn-backup-now')).toBeNull()
    expect(screen.getByTestId('viewer-backup-note').textContent).toBe('Your sign-in can’t take backups. Ask the owner.')
  })

  it.each([null, 'accountant', 'owner'] as const)('%s: the button stays', (role) => {
    if (role) act(() => useSession.setState({ user: { id: 1, name: 'Asha', role } as never }))
    renderSidebar()
    expect(screen.getByTestId('btn-backup-now')).toBeTruthy()
    expect(screen.queryByTestId('viewer-backup-note')).toBeNull()
  })
})
