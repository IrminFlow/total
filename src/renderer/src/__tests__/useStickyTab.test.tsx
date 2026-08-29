import { describe, expect, it, beforeEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useStickyFlag, useStickyTab } from '../lib/useStickyTab'

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

describe('useStickyFlag', () => {
  beforeEach(() => localStorage.clear())

  it('starts at the default when nothing is stored', () => {
    expect(renderHook(() => useStickyFlag('hide-zeros', true)).result.current[0]).toBe(true)
    expect(renderHook(() => useStickyFlag('other', false)).result.current[0]).toBe(false)
  })

  it('remembers false, which is distinct from unset', () => {
    // Storing a boolean as a string makes "off" and "never chosen" easy to conflate; they are
    // different, because the default can be true.
    const first = renderHook(() => useStickyFlag('hide-zeros', true))
    act(() => first.result.current[1](false))
    const second = renderHook(() => useStickyFlag('hide-zeros', true))
    expect(second.result.current[0]).toBe(false)
  })

  it('remembers true against a false default', () => {
    const first = renderHook(() => useStickyFlag('show-extra', false))
    act(() => first.result.current[1](true))
    expect(renderHook(() => useStickyFlag('show-extra', false)).result.current[0]).toBe(true)
  })

  it('does not collide with a tab of the same name', () => {
    const tab = renderHook(() => useStickyTab('thing', ['one', 'two'] as const, 'one'))
    act(() => tab.result.current[1]('two'))
    expect(renderHook(() => useStickyFlag('thing', false)).result.current[0]).toBe(false)
  })
})
