// Owner-only settings in a company WITHOUT users: main lets every channel through when there is
// no session user (ipc.ts role gate), so the period lock, encrypted export / restore and "Delete
// forever" in the bin must be offered then too — `isOwnerOrNoUsers` (lib/roles.ts). A viewer
// never sees them; an owner does.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { CompanyInfo } from '@shared/domain'
import type { SessionUser } from '../lib/client'
import { canWriteOrNoUsers, isOwnerOrNoUsers } from '../lib/roles'
import { useSession } from '../state/stores'
import { AboutSection } from '../screens/settings/AboutSection'
import { BackupsSection } from '../screens/settings/BackupsSection'
import { BinSection } from '../screens/settings/BinSection'

const invoke = vi.fn()
const info: CompanyInfo = { name: 'Lock Co', stateCode: '27', gstin: null, gstRegistrationType: 'unregistered', address: '', booksFrom: 2026, email: null, phone: null, pan: null, tan: null }
const OWNER: SessionUser = { id: 1, name: 'Asha', role: 'owner' }
const ACCOUNTANT: SessionUser = { id: 2, name: 'Ravi', role: 'accountant' }
const VIEWER: SessionUser = { id: 3, name: 'Vik', role: 'viewer' }

function renderUi(ui: React.ReactElement): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}
const asUser = (user: SessionUser | null): void => {
  act(() => {
    useSession.setState({ info, slug: 'lock-co', ui: { mode: 'accountant' }, user })
  })
}

beforeEach(() => {
  invoke.mockImplementation(async (channel: string) => {
    switch (channel) {
      case 'app:info': return { ok: true, data: { version: '0.11.0', electron: '1', node: '1', chrome: '1', dataRoot: '/tmp' } }
      case 'company:lock:get': return { ok: true, data: { date: null } }
      case 'backup:list': return { ok: true, data: [{ file: 'b1.db', sizeBytes: 1024, mtime: Date.parse('2026-10-10T10:00:00Z'), tag: 'manual' }] }
      case 'voucher:bin': return { ok: true, data: [{ id: 7, date: '2026-10-01', number: '1', voucherType: 'Journal', account: 'Cash', amount: 10_000, deletedAt: '2026-10-02 10:00:00', undoGroupId: null, undoGroupSize: null }] }
      case 'attachments:config': return { ok: true, data: null }
      default: return { ok: true, data: null }
    }
  })
  window.total = { platform: 'test', invoke }
})
afterEach(() => {
  cleanup()
  invoke.mockReset()
})

describe('isOwnerOrNoUsers / canWriteOrNoUsers', () => {
  it('lets a company without users through, an owner through, and nobody else', () => {
    expect(isOwnerOrNoUsers(null)).toBe(true)
    expect(isOwnerOrNoUsers(undefined)).toBe(true)
    expect(isOwnerOrNoUsers(OWNER)).toBe(true)
    expect(isOwnerOrNoUsers(ACCOUNTANT)).toBe(false)
    expect(isOwnerOrNoUsers(VIEWER)).toBe(false)
    expect(canWriteOrNoUsers(null)).toBe(true)
    expect(canWriteOrNoUsers(ACCOUNTANT)).toBe(true)
    expect(canWriteOrNoUsers(VIEWER)).toBe(false)
  })
})

describe('period lock (About)', () => {
  it.each([
    ['no users', null, true],
    ['owner', OWNER, true],
    ['viewer', VIEWER, false]
  ] as const)('%s → editable: %s', async (_label, user, editable) => {
    asUser(user)
    renderUi(<AboutSection />)
    await waitFor(() => expect(screen.getByText('No lock — every period is still open to editing.')).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Change…' }) != null).toBe(editable)
    expect(screen.queryByText('Only owners can change this') != null).toBe(!editable)
  })
})

describe('backups', () => {
  it.each([
    ['no users', null, true],
    ['owner', OWNER, true],
    ['viewer', VIEWER, false]
  ] as const)('%s → export / restore: %s', async (_label, user, owner) => {
    asUser(user)
    renderUi(<BackupsSection />)
    await waitFor(() => expect(screen.getByText('b1.db')).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Export encrypted…' }) != null).toBe(owner)
    expect(screen.queryByRole('button', { name: 'Restore…' }) != null).toBe(owner)
    expect(screen.queryByRole('button', { name: 'Back up now' }) != null).toBe(user?.role !== 'viewer')
  })
})

describe('bin', () => {
  it.each([
    ['no users', null, true],
    ['owner', OWNER, true],
    ['viewer', VIEWER, false]
  ] as const)('%s → delete forever: %s', async (_label, user, owner) => {
    asUser(user)
    renderUi(<BinSection />)
    await waitFor(() => expect(screen.getByText('Cash')).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Delete forever' }) != null).toBe(owner)
    expect(screen.queryByRole('button', { name: 'Restore' }) != null).toBe(user?.role !== 'viewer')
  })
})
