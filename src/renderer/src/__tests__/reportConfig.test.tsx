// useReportConfig — F12 column visibility: defaults, toggling, localStorage persistence
// per company slug, and re-load when the company changes.
import { beforeEach, describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useReportConfig, useSavedReportViews, type ReportColumn } from '../lib/reportConfig'
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

describe('useSavedReportViews', () => {
  beforeEach(() => {
    localStorage.clear()
    act(() => useSession.setState({ slug: 'alpha-co' }))
  })

  it('saves, replaces case-insensitive names, and removes a report state', () => {
    const { result } = renderHook(() => useSavedReportViews<{ from: string; compare: boolean }>('pnl'))
    act(() => result.current.save('Owner monthly', { from: '2026-04-01', compare: false }))
    expect(result.current.views).toHaveLength(1)
    act(() => result.current.save('owner MONTHLY', { from: '2026-05-01', compare: true }))
    expect(result.current.views).toHaveLength(1)
    expect(result.current.views[0]?.value).toEqual({ from: '2026-05-01', compare: true })
    act(() => result.current.remove('owner MONTHLY'))
    expect(result.current.views).toEqual([])
  })

  it('isolates saved views by company and report', () => {
    const alpha = renderHook(() => useSavedReportViews<{ asOn: string }>('balance-sheet'))
    act(() => alpha.result.current.save('Year end', { asOn: '2026-03-31' }))
    alpha.unmount()
    act(() => useSession.setState({ slug: 'beta-co' }))
    const beta = renderHook(() => useSavedReportViews<{ asOn: string }>('balance-sheet'))
    expect(beta.result.current.views).toEqual([])
  })
})
