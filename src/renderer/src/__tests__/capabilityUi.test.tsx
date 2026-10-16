// WP 7.2 (PR #112 follow-up): the UI follows the signed-in user's capability flags. A flag the
// owner set to false hides the export buttons (DataTable toolbar, Options drawer, books export,
// CA pack), disables an editor's Save with a plain reason, and keeps the AI settings read-only;
// owners and users WITHOUT flags see exactly what they saw before.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useSession } from '../state/stores'
import type { SessionUser } from '../lib/client'
import { capabilityRefused, canManageAi } from '../lib/capabilities'
import { DataTable, defineColumns } from '../components/table'
import { PostButton } from '../components/PostButton'
import { BooksExportScreen } from '../screens/BooksExport'
import { useCanSave, useCanWrite } from '../simple/ViewerNote'

interface Row { id: number; name: string; amount: number }
const ROWS: Row[] = [{ id: 1, name: 'Cash', amount: 100_00 }]
const COLUMNS = defineColumns<Row>([
  { id: 'name', header: 'Name', kind: 'text', value: (r) => r.name },
  { id: 'amount', header: 'Amount', kind: 'money', value: (r) => r.amount, aggregate: 'sum' }
])

const user = (role: SessionUser['role'], capabilities: SessionUser['capabilities'] = null): SessionUser => ({ id: 2, name: 'Asha', role, capabilities })
const signIn = (u: SessionUser | null): void => act(() => useSession.setState({ slug: 'sharma', user: u }))

function renderUi(ui: React.ReactElement): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

beforeEach(() => {
  window.total = { platform: 'test', invoke: vi.fn(async () => ({ ok: true, data: null })) }
})
afterEach(() => {
  cleanup()
  act(() => useSession.setState({ slug: null, user: null }))
})

describe('capabilityRefused / canManageAi', () => {
  it('only a flag set to false refuses; owners and unflagged users never', () => {
    expect(capabilityRefused(null, 'canExport')).toBe(false)
    expect(capabilityRefused(user('viewer'), 'canPost')).toBe(false)
    expect(capabilityRefused(user('accountant', { canExport: false }), 'canExport')).toBe(true)
    expect(capabilityRefused(user('accountant', { canExport: false }), 'canPost')).toBe(false)
    expect(capabilityRefused(user('owner', { canExport: false }), 'canExport')).toBe(false)
    expect(canManageAi(null)).toBe(true)
    expect(canManageAi(user('owner'))).toBe(true)
    expect(canManageAi(user('accountant'))).toBe(false)
    expect(canManageAi(user('accountant', { canManageAi: true }))).toBe(true)
  })
})

describe('export buttons', () => {
  const table = (): React.ReactElement => <DataTable rows={ROWS} columns={COLUMNS} testId="caps" exportOptions={{ title: 'Caps', periodLabel: 'today', filename: 'caps' }} />

  it('the DataTable keeps PDF / CSV / Excel for an unflagged user and an owner', () => {
    for (const u of [null, user('viewer'), user('accountant'), user('owner')]) {
      signIn(u)
      renderUi(table())
      expect(screen.queryByTestId('caps-table-csv'), u?.role ?? 'no users').not.toBeNull()
      expect(screen.queryByTestId('caps-table-pdf')).not.toBeNull()
      cleanup()
    }
  })

  it('…and drops them when the owner refused export', () => {
    signIn(user('accountant', { canExport: false }))
    renderUi(table())
    expect(screen.queryByTestId('caps-table-csv')).toBeNull()
    expect(screen.queryByTestId('caps-table-pdf')).toBeNull()
    expect(screen.queryByTestId('caps-table-xlsx')).toBeNull()
  })

  it('books export is disabled with the plain reason', () => {
    signIn(user('accountant', { canExport: false }))
    renderUi(<BooksExportScreen />)
    const btn = screen.getByTestId('btn-export-books') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(btn.parentElement?.getAttribute('title')).toBe('Your sign-in can’t export — ask the owner')
    cleanup()
    signIn(user('accountant'))
    renderUi(<BooksExportScreen />)
    expect((screen.getByTestId('btn-export-books') as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('Save in the editors (canPost)', () => {
  it('PostButton is a plain Button unless the owner refused posting', () => {
    signIn(user('accountant'))
    render(<PostButton data-testid="save">Save</PostButton>)
    const ok = screen.getByTestId('save') as HTMLButtonElement
    expect(ok.disabled).toBe(false)
    expect(ok.hasAttribute('data-post-refused')).toBe(false)
    cleanup()
    signIn(user('accountant', { canPost: false }))
    render(<PostButton data-testid="save">Save</PostButton>)
    const no = screen.getByTestId('save') as HTMLButtonElement
    expect(no.disabled).toBe(true)
    expect(no.parentElement?.getAttribute('title')).toBe('Your sign-in can’t save entries — ask the owner')
  })

  it('useCanSave (simple screens) reads canPost; no flag = the role as before; backups stay role-only', () => {
    const cases: [SessionUser | null, boolean, boolean][] = [
      [null, true, true],
      [user('viewer'), false, false],
      [user('accountant'), true, true],
      [user('viewer', { canPost: true }), true, false],
      [user('accountant', { canPost: false }), false, true]
    ]
    for (const [u, save, write] of cases) {
      signIn(u)
      expect(renderHook(() => useCanSave()).result.current, JSON.stringify(u)).toBe(save)
      expect(renderHook(() => useCanWrite()).result.current, JSON.stringify(u)).toBe(write)
    }
  })
})
