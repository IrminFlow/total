// Banking → Cheques → "Fill the register from earlier entries" (to-do §4 upgrade check): the
// preview lists what will be recorded and what is skipped, unticking narrows the run, the
// "outside any book" box re-asks the preview, and only the owner (or a company without users)
// can apply.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ChequeBackfillPreview, ChequeBackfillRow } from '../lib/bankingClient'
import { useSession } from '../state/stores'
import { ChequeBackfillModal } from '../screens/banking/ChequesTab'

const invoke = vi.fn()
const calls = (channel: string): unknown[] => invoke.mock.calls.filter((c) => c[0] === channel).map((c) => c[1])

const row = (voucherId: number, number: string, o: Partial<ChequeBackfillRow> = {}): ChequeBackfillRow => ({
  key: `${voucherId}-5`, voucherId, voucherNumber: `P${voucherId}`, date: '2026-05-02', bankLedgerId: 5, bankLedgerName: 'HDFC Bank', number, leaf: Number(number),
  bookId: 1, bookName: 'Book 1', source: 'instrument', found: number, payee: 'Acme Traders', amount: 100_000, conflict: null, ...o
})
const PREVIEW: ChequeBackfillPreview = {
  rows: [row(11, '000457'), row(12, '000458', { source: 'narration' })],
  conflicts: [row(13, '000459', { conflict: { reason: 'in_register', status: 'cancelled', otherVoucherId: null, otherVoucherNumber: null } })],
  outsideBooks: 2
}

function renderModal(onFilled = vi.fn()): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <ChequeBackfillModal bankLedgerId={5} bankName="HDFC Bank" onClose={() => {}} onFilled={onFilled} />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  invoke.mockReset()
  invoke.mockImplementation(async (channel: string, payload?: { includeOutside?: boolean; voucherIds?: number[] }) => {
    if (channel === 'cheques:backfillPreview') return { ok: true, data: payload?.includeOutside ? { ...PREVIEW, rows: [...PREVIEW.rows, row(14, '900123', { bookId: null, bookName: null })] } : PREVIEW }
    if (channel === 'cheques:backfill') return { ok: true, data: { filled: payload?.voucherIds?.length ?? 0, conflicts: 1, rows: [] } }
    return { ok: false, error: `unmocked channel ${channel}` }
  })
  window.total = { platform: 'test', invoke }
  act(() => useSession.setState({ slug: 'bank-co', user: null }))
})
afterEach(() => cleanup())

describe('cheque register backfill panel', () => {
  it('lists the cheques to record and the skipped ones; unticking one leaves it out of the run', async () => {
    const onFilled = vi.fn()
    renderModal(onFilled)
    await screen.findByText('000457')
    expect(screen.getByText('000458')).toBeTruthy()
    expect(screen.getByText(/Already in the register as a blank leaf \(cancelled\)/)).toBeTruthy()
    expect(screen.getByTestId('cheque-backfill-outside-count').textContent).toMatch(/2 payments carry numbers outside every cheque book/)
    const apply = screen.getByTestId('btn-cheque-backfill-apply')
    expect(apply.textContent).toBe('Record 2 cheques')
    fireEvent.click(screen.getByTestId('input-cheque-backfill-12-5'))
    expect(apply.textContent).toBe('Record 1 cheque')
    fireEvent.click(apply)
    await waitFor(() => expect(onFilled).toHaveBeenCalled())
    expect(calls('cheques:backfill')).toEqual([{ bankLedgerId: 5, includeOutside: false, voucherIds: [11] }])
  })

  it('"outside any book" asks the preview again with the flag and sends it with the apply', async () => {
    renderModal()
    await screen.findByText('000457')
    fireEvent.click(screen.getByTestId('input-cheque-backfill-outside'))
    await screen.findByText('900123')
    expect(calls('cheques:backfillPreview').at(-1)).toEqual({ bankLedgerId: 5, includeOutside: true })
    expect(screen.queryByTestId('cheque-backfill-outside-count')).toBeNull()
    fireEvent.click(screen.getByTestId('btn-cheque-backfill-apply'))
    await waitFor(() => expect(calls('cheques:backfill')).toEqual([{ bankLedgerId: 5, includeOutside: true, voucherIds: [11, 12, 14] }]))
  })

  it('an accountant sees the preview but only the owner can record', async () => {
    act(() => useSession.setState({ user: { id: 2, name: 'Asha', role: 'accountant' } as never }))
    renderModal()
    await screen.findByText('000457')
    expect((screen.getByTestId('btn-cheque-backfill-apply') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('cheque-backfill-owner-only').textContent).toMatch(/Only the owner/)
  })
})
