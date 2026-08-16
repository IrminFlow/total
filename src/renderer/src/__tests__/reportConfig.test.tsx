// useReportConfig — F12 column visibility: defaults, toggling, localStorage persistence
// per company slug, and re-load when the company changes.
import { beforeEach, describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useReportConfig, type ReportColumn } from '../lib/reportConfig'
import { useSession } from '../state/stores'

const COLUMNS: ReportColumn[] = [
  { key: 'debit', label: 'Debit', defaultOn: true },
  { key: 'credit', label: 'Credit', defaultOn: true },
  { key: 'narration', label: 'Narration', defaultOn: false }
]

describe('useReportConfig', () => {
  beforeEach(() => {
    localStorage.clear()
    act(() => {
      useSession.setState({ slug: 'alpha-co' })
    })
  })

  it('starts from the defaultOn flags', () => {
    const { result } = renderHook(() => useReportConfig('tb', COLUMNS))
    expect(result.current.visible).toEqual({ debit: true, credit: true, narration: false })
  })

  it('toggles and persists to a slug+report-scoped key', () => {
    const { result } = renderHook(() => useReportConfig('tb', COLUMNS))
    act(() => result.current.toggle('narration'))
    expect(result.current.visible.narration).toBe(true)
    const stored = JSON.parse(localStorage.getItem('total-reportcfg-alpha-co-tb') ?? '{}')
    expect(stored.narration).toBe(true)
  })

  it('re-reads persisted choices on a fresh mount', () => {
    const first = renderHook(() => useReportConfig('tb', COLUMNS))
    act(() => first.result.current.toggle('debit'))
    first.unmount()
    const second = renderHook(() => useReportConfig('tb', COLUMNS))
    expect(second.result.current.visible.debit).toBe(false)
  })

  it('a different company does not inherit the previous company’s choices', () => {
    const first = renderHook(() => useReportConfig('tb', COLUMNS))
    act(() => first.result.current.toggle('debit'))
    first.unmount()

    act(() => {
      useSession.setState({ slug: 'beta-co' })
    })
    const second = renderHook(() => useReportConfig('tb', COLUMNS))
    expect(second.result.current.visible.debit).toBe(true) // back to defaults
  })

  it('reports stay separate', () => {
    const tb = renderHook(() => useReportConfig('tb', COLUMNS))
    act(() => tb.result.current.toggle('credit'))
    const pl = renderHook(() => useReportConfig('pl', COLUMNS))
    expect(pl.result.current.visible.credit).toBe(true)
  })
})
