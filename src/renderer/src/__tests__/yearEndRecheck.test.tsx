// Guided re-close panel on the Year-end screen: preview table, corrected lines, Repair (owner).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { CloseRepairPreview } from '@shared/yearEnd'
import { YearEndRecheck } from '../screens/YearEndRecheck'
import { DialogHost } from '../components/dialogs'
import { useSession } from '../state/stores'

const invoke = vi.fn()
const FP = 'a'.repeat(64)

const needs: CloseRepairPreview = {
  fingerprint: FP,
  lockDate: '2026-03-31',
  years: [
    {
      fyStartYear: 2024, label: '2024-25', voucherId: 70, voucherNumber: '12', date: '2025-03-31', residual: -500_000,
      needsRepair: true, blocked: null, netProfit: 2_500_000,
      diffs: [
        { ledgerId: 3, name: 'Sales', transfer: false, stored: 3_000_000, expected: 3_500_000 },
        { ledgerId: 9, name: 'Retained Earnings', transfer: true, stored: -2_000_000, expected: -2_500_000 }
      ],
      corrected: [
        { ledgerId: 4, name: 'Rent', drCr: 'cr', amount: 1_000_000 },
        { ledgerId: 3, name: 'Sales', drCr: 'dr', amount: 3_500_000 },
        { ledgerId: 9, name: 'Retained Earnings', drCr: 'cr', amount: 2_500_000 }
      ]
    },
    {
      fyStartYear: 2025, label: '2025-26', voucherId: 80, voucherNumber: '20', date: '2026-03-31', residual: 0,
      needsRepair: false, blocked: null, netProfit: 500_000, diffs: [], corrected: []
    }
  ]
}
let state: CloseRepairPreview

beforeEach(() => {
  state = needs
  useSession.setState({ user: null })
  invoke.mockImplementation(async (channel: string) => {
    switch (channel) {
      case 'yearEnd:repairPreview': return { ok: true, data: state }
      case 'yearEnd:repair':
        state = { ...needs, fingerprint: 'b'.repeat(64), years: needs.years.map((y) => ({ ...y, needsRepair: false, residual: 0, diffs: [], corrected: [] })) }
        return { ok: true, data: { repaired: [{ fyStartYear: 2024, oldVoucherId: 70, voucherId: 99, netProfit: 2_500_000, residual: -500_000 }], lockDate: '2026-03-31' } }
      default: return { ok: false, error: `unmocked ${channel}` }
    }
  })
  window.total = { platform: 'test', invoke }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderUi(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <YearEndRecheck />
      <DialogHost />
    </QueryClientProvider>
  )
}

describe('Check earlier closes', () => {
  it('fetches nothing until asked, then lists the years and the corrected lines', async () => {
    renderUi()
    expect(invoke).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('btn-year-end-recheck'))
    const lines = await screen.findByTestId('year-end-recheck-fy-2024')
    expect(lines.textContent).toContain('was not carried to')
    expect(lines.textContent).toContain('Retained Earnings')
    expect(screen.getByTestId('btn-year-end-repair').textContent).toBe('Repair FY 2024-25')
  })

  it('Repair confirms in plain words and sends the fingerprint it was shown', async () => {
    renderUi()
    fireEvent.click(screen.getByTestId('btn-year-end-recheck'))
    fireEvent.click(await screen.findByTestId('btn-year-end-repair'))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('FY 2024-25 to the Bin and post corrected ones on the same day')
    expect(dialog.textContent).toContain('stay locked up to')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Repair' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('yearEnd:repair', { fingerprint: FP }))
    await screen.findByTestId('year-end-recheck-ok')
  })

  it('an accountant sees the check but cannot repair; a viewer sees no panel', async () => {
    useSession.setState({ user: { id: 2, name: 'Acc', role: 'accountant' } })
    renderUi()
    fireEvent.click(screen.getByTestId('btn-year-end-recheck'))
    expect((await screen.findByTestId('btn-year-end-repair')).hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('Only the owner can repair a closed year.')).toBeTruthy()
    cleanup()
    useSession.setState({ user: { id: 3, name: 'View', role: 'viewer' } })
    renderUi()
    expect(screen.queryByTestId('year-end-recheck')).toBeNull()
  })
})
