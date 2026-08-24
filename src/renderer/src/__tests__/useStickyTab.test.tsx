import { describe, expect, it, beforeEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useStickyTab } from '../lib/useStickyTab'

const TABS = ['one', 'two', 'three'] as const

describe('useStickyTab', () => {
  beforeEach(() => localStorage.clear())

  it('starts on the fallback when nothing is stored', () => {
    const { result } = renderHook(() => useStickyTab('demo', TABS, 'one'))
    expect(result.current[0]).toBe('one')
  })

  it('remembers a selection across a remount', () => {
    const first = renderHook(() => useStickyTab('demo', TABS, 'one'))
    act(() => first.result.current[1]('three'))
    expect(first.result.current[0]).toBe('three')

    const second = renderHook(() => useStickyTab('demo', TABS, 'one'))
    expect(second.result.current[0]).toBe('three')
  })

  it('keeps each screen’s tab separate', () => {
    const a = renderHook(() => useStickyTab('screen-a', TABS, 'one'))
    act(() => a.result.current[1]('two'))
    const b = renderHook(() => useStickyTab('screen-b', TABS, 'one'))
    expect(b.result.current[0]).toBe('one')
  })

  it('falls back when the stored tab no longer exists', () => {
    // A tab renamed or removed by an update must not leave the screen showing nothing.
    localStorage.setItem('total-tab-demo', 'a-tab-that-was-removed')
    const { result } = renderHook(() => useStickyTab('demo', TABS, 'two'))
    expect(result.current[0]).toBe('two')
  })

  it('survives a localStorage that throws', () => {
    // A locked-down or full localStorage must not take the screen down with it.
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    try {
      const { result } = renderHook(() => useStickyTab('demo', TABS, 'one'))
      expect(result.current[0]).toBe('one')
      act(() => result.current[1]('two'))
      // The click still lands even though the preference cannot be saved.
      expect(result.current[0]).toBe('two')
    } finally {
      getItem.mockRestore()
      setItem.mockRestore()
    }
  })
})
