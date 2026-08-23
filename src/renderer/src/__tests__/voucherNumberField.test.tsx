// useVoucherNumberField (screens/VoucherEntry.tsx) — the editable No. field that tracks
// voucher:nextNumber until the user touches it. window.total is mocked; react-query provides
// the fetch machinery exactly as in the app.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useVoucherNumberField } from '../screens/VoucherEntry'

const invoke = vi.fn()

function wrapper({ children }: { children: ReactNode }): React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

beforeEach(() => {
  invoke.mockImplementation(async (channel: string, payload?: unknown) => {
    if (channel === 'voucher:nextNumber') {
      const p = payload as { voucherTypeId: number; date: string }
      return { ok: true, data: { number: `${p.voucherTypeId}-${p.date.slice(0, 4)}-42` } }
    }
    return { ok: false, error: `unmocked channel ${channel}` }
  })
  window.total = { platform: 'test', invoke, on: () => () => {} }
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useVoucherNumberField', () => {
  it('shows the loading placeholder, then the fetched number; placeholder never reaches the payload', () => {
    const { result } = renderHook(() => useVoucherNumberField(7, '2026-08-16'), { wrapper })
    expect(result.current.value).toBe('…')
    expect(result.current.forPayload).toBe('') // '…' must never be posted
    return waitFor(() => {
      expect(result.current.value).toBe('7-2026-42')
      expect(result.current.forPayload).toBe('7-2026-42')
    })
  })

  it('stops tracking the suggestion once touched', async () => {
    const { result } = renderHook(() => useVoucherNumberField(7, '2026-08-16'), { wrapper })
    await waitFor(() => expect(result.current.value).toBe('7-2026-42'))
    act(() => result.current.onChange('CUSTOM-1'))
    expect(result.current.value).toBe('CUSTOM-1')
    expect(result.current.forPayload).toBe('CUSTOM-1')
  })

  it('a type/date change is a new numbering context — touched resets, suggestion re-syncs', async () => {
    const { result, rerender } = renderHook(({ typeId, date }) => useVoucherNumberField(typeId, date), {
      wrapper,
      initialProps: { typeId: 7, date: '2026-08-16' }
    })
    await waitFor(() => expect(result.current.value).toBe('7-2026-42'))
    act(() => result.current.onChange('CUSTOM-1'))
    rerender({ typeId: 9, date: '2026-08-16' })
    await waitFor(() => expect(result.current.value).toBe('9-2026-42'))
  })

  it('reset() (after a save) resumes tracking the advanced suggestion', async () => {
    const { result } = renderHook(() => useVoucherNumberField(7, '2026-08-16'), { wrapper })
    await waitFor(() => expect(result.current.value).toBe('7-2026-42'))
    act(() => result.current.onChange('CUSTOM-1'))
    act(() => result.current.reset())
    await waitFor(() => expect(result.current.value).toBe('7-2026-42'))
  })

  it('trims whitespace for the payload (blank = auto-assign)', async () => {
    const { result } = renderHook(() => useVoucherNumberField(7, '2026-08-16'), { wrapper })
    await waitFor(() => expect(result.current.value).toBe('7-2026-42'))
    act(() => result.current.onChange('   '))
    expect(result.current.forPayload).toBe('')
  })
})
