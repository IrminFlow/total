import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useTableNav } from '../components/ui'
import { __resetLayersForTest } from '../lib/keyboard'

const press = (key: string): void => {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

const ROWS = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

describe('useTableNav', () => {
  beforeEach(() => __resetLayersForTest())

  it('emits the markup the amber bar and the E2E harness depend on', () => {
    const { result } = renderHook(() => useTableNav(ROWS, { rowId: (r) => r.id }))
    const first = result.current.rowProps(0, ROWS[0]!)
    expect(first.className).toContain('kbar-row')
    expect(first['data-active']).toBe(true)
    expect(first['data-row-id']).toBe('a')
    expect(result.current.rowProps(1, ROWS[1]!)['data-active']).toBe(false)
  })

  it('moves the selection with the arrow keys', () => {
    const { result } = renderHook(() => useTableNav(ROWS, { rowId: (r) => r.id }))
    press('ArrowDown')
    expect(result.current.active).toBe(1)
    expect(result.current.rowProps(1, ROWS[1]!)['data-active']).toBe(true)
    press('ArrowUp')
    expect(result.current.active).toBe(0)
  })

  it('jumps to the ends with Home and End', () => {
    const { result } = renderHook(() => useTableNav(ROWS))
    press('End')
    expect(result.current.active).toBe(2)
    press('Home')
    expect(result.current.active).toBe(0)
  })

  it('opens the selected row on Enter, passing the row itself', () => {
    const onEnter = vi.fn()
    const { result } = renderHook(() => useTableNav(ROWS, { onEnter }))
    press('ArrowDown')
    press('Enter')
    expect(onEnter).toHaveBeenCalledTimes(1)
    expect(onEnter).toHaveBeenCalledWith(ROWS[1], 1)
    expect(result.current.active).toBe(1)
  })

  it('marks rows clickable only when there is somewhere to go', () => {
    const { result: withEnter } = renderHook(() => useTableNav(ROWS, { onEnter: vi.fn() }))
    expect(withEnter.current.rowProps(0, ROWS[0]!).className).toContain('cursor-pointer')
    expect(withEnter.current.rowProps(0, ROWS[0]!).onClick).toBeTypeOf('function')

    const { result: plain } = renderHook(() => useTableNav(ROWS))
    expect(plain.current.rowProps(0, ROWS[0]!).className).not.toContain('cursor-pointer')
    expect(plain.current.rowProps(0, ROWS[0]!).onClick).toBeUndefined()
  })

  it('hovering a row moves the selection to it', () => {
    const { result } = renderHook(() => useTableNav(ROWS))
    act(() => result.current.rowProps(2, ROWS[2]!).onMouseEnter())
    expect(result.current.active).toBe(2)
  })

  it('a disabled table ignores the keyboard', () => {
    const { result } = renderHook(() => useTableNav(ROWS, { enabled: false }))
    press('ArrowDown')
    expect(result.current.active).toBe(0)
  })

  it('never fires Enter on an empty table', () => {
    const onEnter = vi.fn()
    renderHook(() => useTableNav([], { onEnter }))
    press('Enter')
    expect(onEnter).not.toHaveBeenCalled()
  })
})
