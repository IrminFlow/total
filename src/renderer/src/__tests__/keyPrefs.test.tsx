import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useTableNav } from '../components/ui'
import { __resetLayersForTest } from '../lib/keyboard'
import { applyKeyboardOnly, useKeyPrefs, useRecentScreens, type Screen } from '../state/stores'

const press = (key: string): void => {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

const ROWS = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]

describe('vim keys on lists', () => {
  beforeEach(() => {
    __resetLayersForTest()
    useKeyPrefs.setState({ vimKeys: false })
  })
  afterEach(() => {
    useKeyPrefs.setState({ vimKeys: false })
    vi.useRealTimers()
  })

  it('leaves G alone while the preference is off — it is the Gateway accelerator', () => {
    const { result } = renderHook(() => useTableNav(ROWS))
    press('ArrowDown')
    press('G')
    // Not consumed by the list, so the nav layer beneath still gets it.
    expect(result.current.active).toBe(1)
  })

  it('G jumps to the last row once the preference is on', () => {
    useKeyPrefs.setState({ vimKeys: true })
    const { result } = renderHook(() => useTableNav(ROWS))
    press('G')
    expect(result.current.active).toBe(3)
  })

  it('gg jumps to the first row', () => {
    useKeyPrefs.setState({ vimKeys: true })
    const { result } = renderHook(() => useTableNav(ROWS))
    press('End')
    expect(result.current.active).toBe(3)
    press('g')
    // One g arms; it must not move anything on its own.
    expect(result.current.active).toBe(3)
    press('g')
    expect(result.current.active).toBe(0)
  })

  it('a lone g stops meaning anything after the chord window', () => {
    vi.useFakeTimers()
    useKeyPrefs.setState({ vimKeys: true })
    const { result } = renderHook(() => useTableNav(ROWS))
    press('End')
    press('g')
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    press('g')
    // The second g re-arms rather than completing a chord from two seconds ago.
    expect(result.current.active).toBe(3)
    press('g')
    expect(result.current.active).toBe(0)
  })
})

describe('keyboard-only mode', () => {
  afterEach(() => applyKeyboardOnly(false))

  it('marks the document so the CSS can stop hover revealing row actions', () => {
    applyKeyboardOnly(true)
    expect(document.documentElement.dataset.kbdOnly).toBe('true')
    applyKeyboardOnly(false)
    // Absent, not 'false': the stylesheet keys off the attribute existing at all.
    expect(document.documentElement.dataset.kbdOnly).toBeUndefined()
  })
})

describe('recent screens ring', () => {
  beforeEach(() => useRecentScreens.setState({ ring: [] }))

  const visit = (s: Screen): void => useRecentScreens.getState().visit(s)

  it('puts the current screen first, most recent first', () => {
    visit({ name: 'gateway' })
    visit({ name: 'daybook' })
    visit({ name: 'trial-balance' })
    expect(useRecentScreens.getState().ring.map((s) => s.name)).toEqual(['trial-balance', 'daybook', 'gateway'])
  })

  it('moves a revisited screen to the front rather than listing it twice', () => {
    visit({ name: 'gateway' })
    visit({ name: 'daybook' })
    visit({ name: 'gateway' })
    expect(useRecentScreens.getState().ring.map((s) => s.name)).toEqual(['gateway', 'daybook'])
  })

  it('ignores a repeat of the screen already on view', () => {
    visit({ name: 'daybook' })
    visit({ name: 'daybook', kind: 'sales' })
    expect(useRecentScreens.getState().ring).toHaveLength(1)
  })

  it('remembers at most eight', () => {
    const names: Screen['name'][] = [
      'gateway', 'daybook', 'masters', 'trial-balance', 'profit-loss',
      'balance-sheet', 'cash-flow', 'registers', 'outstandings', 'budgets'
    ]
    for (const name of names) visit({ name } as Screen)
    expect(useRecentScreens.getState().ring).toHaveLength(8)
    expect(useRecentScreens.getState().ring[0]!.name).toBe('budgets')
  })
})
