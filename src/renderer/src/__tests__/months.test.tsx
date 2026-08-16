// useMonths / useDefaultMonth (screens/GstReturns.tsx) — the GST month picker. Includes the
// regression for the `months.find(...)!` crash: useDefaultMonth must always hand back a key
// that exists in a non-empty list, and never throw on an empty one.
import { beforeEach, describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useDefaultMonth, useMonths } from '../screens/GstReturns'
import { useSession } from '../state/stores'
import { todayISO } from '@shared/dates'

describe('useMonths', () => {
  beforeEach(() => {
    act(() => {
      useSession.setState({ from: '2025-04-01', to: '2026-03-31' })
    })
  })

  it('spans the session period April→March', () => {
    const { result } = renderHook(() => useMonths())
    expect(result.current).toHaveLength(12)
    expect(result.current[0]).toEqual({
      key: '2025-04',
      label: 'April 2025',
      from: '2025-04-01',
      to: '2025-04-30',
      period: '042025'
    })
    expect(result.current[11]?.key).toBe('2026-03')
  })

  it('gets month-end right, February included', () => {
    const { result } = renderHook(() => useMonths())
    const feb = result.current.find((m) => m.key === '2026-02')
    expect(feb?.to).toBe('2026-02-28')
    const dec = result.current.find((m) => m.key === '2025-12')
    expect(dec?.to).toBe('2025-12-31')
  })

  it('handles a single-month period', () => {
    act(() => {
      useSession.setState({ from: '2025-07-01', to: '2025-07-31' })
    })
    const { result } = renderHook(() => useMonths())
    expect(result.current).toHaveLength(1)
    expect(result.current[0]?.period).toBe('072025')
  })
})

describe('useDefaultMonth', () => {
  it('picks the current month when the period contains it', () => {
    const current = todayISO().slice(0, 7)
    const [y, m] = current.split('-').map(Number) as [number, number]
    act(() => {
      useSession.setState({ from: `${y - 1}-04-01`, to: `${y}-${String(m).padStart(2, '0')}-28` })
    })
    const months = renderHook(() => useMonths())
    const picked = renderHook(() => useDefaultMonth(months.result.current))
    expect(picked.result.current[0]).toBe(current)
  })

  it('falls back to the LAST month when the current one is outside the period', () => {
    act(() => {
      useSession.setState({ from: '2023-04-01', to: '2024-03-31' })
    })
    const months = renderHook(() => useMonths())
    const picked = renderHook(() => useDefaultMonth(months.result.current))
    expect(picked.result.current[0]).toBe('2024-03')
  })

  it('a selection that stops existing snaps back to a valid key', () => {
    act(() => {
      useSession.setState({ from: '2023-04-01', to: '2024-03-31' })
    })
    const months = renderHook(() => useMonths())
    const picked = renderHook(({ list }) => useDefaultMonth(list), {
      initialProps: { list: months.result.current }
    })
    act(() => picked.result.current[1]('2023-06'))
    expect(picked.result.current[0]).toBe('2023-06')
    // The period narrows and 2023-06 vanishes → falls back instead of returning a dead key.
    act(() => {
      useSession.setState({ from: '2024-01-01', to: '2024-03-31' })
    })
    months.rerender()
    picked.rerender({ list: months.result.current })
    expect(picked.result.current[0]).toBe('2024-03')
  })

  it('does not crash on an empty months list (the `months.find(...)!` regression)', () => {
    const picked = renderHook(() => useDefaultMonth([]))
    // Whatever it returns must be a string key, not a throw.
    expect(typeof picked.result.current[0]).toBe('string')
  })
})
