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

describe('useTableNav — Space folds the selected row (A17)', () => {
  beforeEach(() => __resetLayersForTest())

  /** Returns whether the default was prevented, i.e. whether the page would have scrolled. */
  const pressSpace = (): boolean => {
    const e = new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true })
    act(() => {
      window.dispatchEvent(e)
    })
    return e.defaultPrevented
  }

  it('toggles the selected row, and swallows the page scroll', () => {
    const onToggle = vi.fn()
    renderHook(() => useTableNav(ROWS, { onToggle }))
    press('ArrowDown')
    const prevented = pressSpace()
    expect(onToggle).toHaveBeenCalledWith(ROWS[1], 1)
    expect(prevented, 'Space must not scroll the report out from under the reader').toBe(true)
  })

  it('leaves Space alone on a table with nothing to fold', () => {
    renderHook(() => useTableNav(ROWS, { onEnter: vi.fn() }))
    expect(pressSpace()).toBe(false)
  })

  it('never fires while the caret is in a field', () => {
    const onToggle = vi.fn()
    renderHook(() => useTableNav(ROWS, { onToggle }))
    const input = document.createElement('input')
    document.body.appendChild(input)
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true }))
    })
    expect(onToggle).not.toHaveBeenCalled()
    input.remove()
  })

  it('defers to a focused button, which the browser activates with Space itself', () => {
    const onToggle = vi.fn()
    renderHook(() => useTableNav(ROWS, { onToggle }))
    // The statement trees on the Balance Sheet and P&L are nested buttons; without this guard a
    // single Space would fold a tree row AND a table row.
    const button = document.createElement('button')
    document.body.appendChild(button)
    button.focus()
    expect(pressSpace()).toBe(false)
    expect(onToggle).not.toHaveBeenCalled()
    button.remove()
  })

  it('ignores a modified Space, which belongs to the browser', () => {
    const onToggle = vi.fn()
    renderHook(() => useTableNav(ROWS, { onToggle }))
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: ' ',
          code: 'Space',
          metaKey: true,
          bubbles: true,
          cancelable: true
        })
      )
    })
    expect(onToggle).not.toHaveBeenCalled()
  })
})
