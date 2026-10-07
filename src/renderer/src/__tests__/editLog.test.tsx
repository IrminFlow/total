// WP 3.8 — the edit-log report and the chain-verification banner against a mocked IPC bridge:
// rows with users / refs / field-level diffs, per-row hash status from audit:verify, the broken
// chain banner, filters sent to audit:list, server-side exports, and the owner-only retention
// settings in Settings → Audit trail.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { AuditRow, ChainVerification } from '../lib/client'
import { EditLogScreen, withStatus } from '../screens/EditLog'
import { AuditSection } from '../screens/settings/AuditSection'
import { SCREENS } from '../lib/screens'
import { useSession } from '../state/stores'

const invoke = vi.fn()
const calls: { channel: string; payload: unknown }[] = []

const ROWS: AuditRow[] = [
  {
    id: 12, entity: 'voucher', entityId: 40, action: 'update', at: '2026-10-07 04:30:00', atIso: '2026-10-07T10:00:00.000+05:30',
    beforeJson: JSON.stringify({ number: 'R-7', lines: [{ amount: 5000 }] }), afterJson: JSON.stringify({ number: 'R-7', lines: [{ amount: 6000 }] }),
    userName: 'Priya', userId: 1, appVersion: '0.7.0', clockSkewNote: null, rowHash: 'b'.repeat(64), ref: 'R-7'
  },
  {
    id: 11, entity: 'ledger', entityId: 9, action: 'create', at: '2026-10-07 04:29:00', atIso: '2026-10-07T09:59:00.000+05:30',
    beforeJson: null, afterJson: JSON.stringify({ name: 'Rent' }), userName: 'os:irmin', userId: null, appVersion: '0.7.0',
    clockSkewNote: 'System clock went backwards: …', rowHash: 'a'.repeat(64), ref: 'Rent'
  }
]

let verification: ChainVerification
const OK: ChainVerification = { ok: true, rows: 12, firstId: 1, headId: 12, headHash: 'b'.repeat(64), firstBreak: null, issues: [], prunedRows: 0 }
let settings = { keepDays: null as number | null, trailRequired: true }

beforeEach(() => {
  calls.length = 0
  verification = OK
  settings = { keepDays: null, trailRequired: true }
  useSession.setState({
    slug: 'test', from: '2026-04-01', to: '2027-03-31', workingDate: '2026-10-07', user: { id: 1, name: 'Priya', role: 'owner' },
    info: { name: 'T', stateCode: '27', gstin: null, gstRegistrationType: 'regular', address: '', booksFrom: 2026, email: null, phone: null, pan: null, tan: null }
  } as never)
  invoke.mockImplementation(async (channel: string, payload: unknown) => {
    calls.push({ channel, payload })
    switch (channel) {
      case 'audit:list': return { ok: true, data: { rows: ROWS, total: 2, users: ['Priya', 'os:irmin', 'system'] } }
      case 'audit:verify': return { ok: true, data: verification }
      case 'audit:exportCsv': return { ok: true, data: { path: '/x/edit-log.csv', rows: 2, verification } }
      case 'config:audit:get': return { ok: true, data: settings }
      case 'config:audit:required': {
        settings = { ...settings, trailRequired: (payload as { required: boolean }).required }
        return { ok: true, data: settings }
      }
      default: return { ok: false, error: `unmocked ${channel}` }
    }
  })
  window.total = { platform: 'test', invoke }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderUi(ui: React.ReactNode): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

describe('edit-log report', () => {
  it('is registered under System and refreshes the audit families', () => {
    expect(SCREENS.find((s) => s.name === 'audit-trail')).toMatchObject({ navSection: 'system', invalidates: ['audit', 'auditVerify'] })
  })

  it('shows date/time with offset, users (OS login spelled out), refs, actions and per-row hash status; expands field-level changes', async () => {
    renderUi(<EditLogScreen />)
    expect(await screen.findByText('Chain verified ✓')).toBeTruthy()
    const row = (await screen.findAllByRole('row')).find((r) => r.getAttribute('data-row-id') === '12')!
    expect(within(row).getByText('2026-10-07 10:00:00 +05:30')).toBeTruthy()
    expect(within(row).getByText('Priya')).toBeTruthy()
    expect(within(row).getByText('R-7')).toBeTruthy()
    expect(within(row).getByText('Verified')).toBeTruthy()
    const row11 = (await screen.findAllByRole('row')).find((r) => r.getAttribute('data-row-id') === '11')!
    expect(within(row11).getByText('irmin (OS login)')).toBeTruthy()
    expect(screen.getByLabelText('clock went backwards')).toBeTruthy()
    fireEvent.click(row)
    const detail = await screen.findByTestId('audit-detail-12')
    expect(within(detail).getByText('lines[0].amount')).toBeTruthy()
    expect(within(detail).getByText('5000')).toBeTruthy()
    expect(within(detail).getByText('6000')).toBeTruthy()
  })

  it('sends the filters (period, entity, action, user, voucher) to audit:list', async () => {
    renderUi(<EditLogScreen voucherId={40} />)
    await screen.findByText('Chain verified ✓')
    fireEvent.change(screen.getByTestId('input-edit-log-entity'), { target: { value: 'voucher' } })
    fireEvent.change(screen.getByTestId('input-edit-log-action'), { target: { value: 'update' } })
    fireEvent.change(screen.getByTestId('input-edit-log-user'), { target: { value: 'Priya' } })
    await waitFor(() =>
      expect(calls.filter((c) => c.channel === 'audit:list').at(-1)!.payload).toEqual({
        entity: 'voucher', action: 'update', user: 'Priya', voucherId: 40, from: '2026-04-01', to: '2027-03-31', page: 0, pageSize: 100
      })
    )
  })

  it('a broken chain shows the break row and marks the rows', async () => {
    verification = {
      ...OK, ok: false,
      firstBreak: { rowId: 11, kind: 'altered', message: 'Row 11 was changed after it was written' },
      issues: [{ rowId: 11, kind: 'altered', message: 'Row 11 was changed after it was written' }, { rowId: 12, kind: 'link_broken', message: 'Chain broken before row 12' }]
    }
    renderUi(<EditLogScreen />)
    expect(await screen.findByText('Chain broken at row 11')).toBeTruthy()
    expect(screen.getByTestId('audit-chain-status').getAttribute('data-ok')).toBe('false')
    await waitFor(() => expect(screen.getByTestId('audit-hash-11').textContent).toBe('Altered'))
    expect(screen.getByTestId('audit-hash-12').textContent).toBe('Chain broken')
    expect(withStatus(ROWS, verification).map((r) => r.status)).toEqual(['link_broken', 'altered'])
  })

  it('exports server-side with the same filters', async () => {
    renderUi(<EditLogScreen />)
    await screen.findByText('Chain verified ✓')
    fireEvent.click(screen.getByTestId('edit-log-csv'))
    await waitFor(() => expect(calls.some((c) => c.channel === 'audit:exportCsv')).toBe(true))
    expect(calls.find((c) => c.channel === 'audit:exportCsv')!.payload).toEqual({ from: '2026-04-01', to: '2027-03-31' })
  })
})

describe('Settings → Audit trail', () => {
  it('shows the banner, keeps-forever by default, and lets an owner turn the requirement off', async () => {
    renderUi(<AuditSection />)
    expect(await screen.findByText('Chain verified ✓')).toBeTruthy()
    expect((await screen.findByTestId('audit-retention-status')).textContent).toBe('Keep every entry forever.')
    const box = screen.getByTestId('input-audit-required') as HTMLInputElement
    expect(box.checked).toBe(true)
    expect(box.disabled).toBe(false)
    fireEvent.click(box)
    await waitFor(() => expect(calls.find((c) => c.channel === 'config:audit:required')?.payload).toEqual({ required: false }))
    expect(await screen.findByTestId('input-audit-keep-years')).toBeTruthy()
  })

  it('is read-only for a non-owner', async () => {
    useSession.setState({ user: { id: 2, name: 'Ravi', role: 'accountant' } } as never)
    renderUi(<AuditSection />)
    const box = (await screen.findByTestId('input-audit-required')) as HTMLInputElement
    expect(box.disabled).toBe(true)
    expect(screen.getByText('Only an owner can change retention.')).toBeTruthy()
  })
})
