// useKeyNav — the ↑↓↵ amber-bar registry (components/ui.tsx): movement, clamping, Enter,
// input-target suppression, and the topmost-list-wins stack.
import { describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useKeyNav } from '../components/ui'

function press(key: string, target?: HTMLElement): void {
  const ev = new KeyboardEvent('keydown', { key, bubbles: true })
  act(() => {
    ;(target ?? window).dispatchEvent(ev)
  })
}

describe('useKeyNav', () => {
  it('moves with ArrowDown/ArrowUp and clamps at both ends', () => {
    const { result, unmount } = renderHook(() => useKeyNav(3, () => {}))
    expect(result.current.active).toBe(0)
    press('ArrowUp')
    expect(result.current.active).toBe(0) // clamped at the top
    press('ArrowDown')
    press('ArrowDown')
    expect(result.current.active).toBe(2)
    press('ArrowDown')
    expect(result.current.active).toBe(2) // clamped at the bottom
    unmount()
  })

  it('fires onEnter with the active index', () => {
    const onEnter = vi.fn()
    const { unmount } = renderHook(() => useKeyNav(3, onEnter))
    press('ArrowDown')
    press('Enter')
    expect(onEnter).toHaveBeenCalledTimes(1)
    expect(onEnter).toHaveBeenCalledWith(1)
    unmount()
  })

  it('never fires onEnter on an empty list', () => {
    const onEnter = vi.fn()
    const { unmount } = renderHook(() => useKeyNav(0, onEnter))
    press('Enter')
    expect(onEnter).not.toHaveBeenCalled()
    unmount()
  })

  it('clamps active when the list shrinks under it', () => {
    const { result, rerender, unmount } = renderHook(({ count }) => useKeyNav(count, () => {}), {
      initialProps: { count: 5 }
    })
    press('ArrowDown')
    press('ArrowDown')
    press('ArrowDown')
    expect(result.current.active).toBe(3)
    rerender({ count: 2 })
    expect(result.current.active).toBe(1)
    unmount()
  })

  it('ignores keys typed into inputs', () => {
    const onEnter = vi.fn()
    const { result, unmount } = renderHook(() => useKeyNav(3, onEnter))
    const input = document.createElement('input')
    document.body.appendChild(input)
    press('ArrowDown', input)
    press('Enter', input)
    expect(result.current.active).toBe(0)
    expect(onEnter).not.toHaveBeenCalled()
    input.remove()
    unmount()
  })

  it('only the topmost mounted list responds; the one below resumes when it unmounts', () => {
    const under = renderHook(() => useKeyNav(3, () => {}))
    const over = renderHook(() => useKeyNav(3, () => {}))
    press('ArrowDown')
    expect(over.result.current.active).toBe(1)
    expect(under.result.current.active).toBe(0)

    over.unmount()
    press('ArrowDown')
    expect(under.result.current.active).toBe(1)
    under.unmount()
  })

  it('a disabled list never joins the stack', () => {
    const bottom = renderHook(() => useKeyNav(3, () => {}))
    const disabled = renderHook(() => useKeyNav(3, () => {}, false))
    press('ArrowDown')
    expect(disabled.result.current.active).toBe(0)
    expect(bottom.result.current.active).toBe(1)
    disabled.unmount()
    bottom.unmount()
  })
})
