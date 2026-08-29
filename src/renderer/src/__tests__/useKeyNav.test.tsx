// useKeyNav — the ↑↓↵ accent-bar registry (components/ui.tsx): movement, clamping, Enter,
// input-target suppression, and the topmost-list-wins stack.
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, renderHook } from '@testing-library/react'
import { useKeyNav } from '../components/ui'
import { useAnnouncer } from '../state/stores'

function press(key: string, target?: HTMLElement): void {
  const ev = new KeyboardEvent('keydown', { key, bubbles: true })
  act(() => {
    ;(target ?? window).dispatchEvent(ev)
  })
}

/**
 * A real table wired to the hook — rows carry the `.kbar-row` + `data-active` convention that
 * the announcement reads back out. A static fixture would not do: the whole point is that the
 * DOM the hook inspects is the DOM the selection actually moved in.
 */
function Table({ rows }: { rows: string[][] }): React.JSX.Element {
  const { active, setActive } = useKeyNav(rows.length, () => {})
  return (
    <table>
      <tbody>
        {rows.map((cells, i) => (
          <tr key={i} className="kbar-row" data-active={i === active} onMouseEnter={() => setActive(i)}>
            {cells.map((c) => (
              <td key={c}>{c}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
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

  // #275 — moving the accent bar changes nothing in the accessibility tree, so the row has to be
  // spoken into a live region or the whole list is silent to a screen reader.
  it('announces the row it lands on, with its position', () => {
    useAnnouncer.setState({ message: '' })
    render(<Table rows={[['24-Apr-26', 'Sales/0007', 'Acme Traders'], ['25-Apr-26', 'Sales/0008', 'Bharat Steel']]} />)
    press('ArrowDown')
    expect(useAnnouncer.getState().message).toBe('Row 2 of 2: 25-Apr-26, Sales/0008, Bharat Steel')
  })

  it('stays silent when the pointer moves the selection', () => {
    useAnnouncer.setState({ message: '' })
    const { getAllByRole } = render(<Table rows={[['a'], ['b']]} />)
    fireEvent.mouseEnter(getAllByRole('row')[1]!)
    expect(useAnnouncer.getState().message).toBe('')
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
