// WP 10.2 review: the shared Popover opens above its anchor only when it would run past the
// window's bottom — anchored by its bottom edge then, so content that grows after it is placed
// grows upward (away from the anchor) — and is placed exactly as before otherwise.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { Popover } from '../components/table/Popover'

function Harness({ top }: { top: number }): React.JSX.Element {
  const ref = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button
        ref={(el) => {
          ref.current = el
          if (el) el.getBoundingClientRect = () => ({ top, bottom: top + 20, left: 100, right: 160, width: 60, height: 20, x: 100, y: top, toJSON: () => ({}) }) as DOMRect
        }}
      >
        anchor
      </button>
      <Popover anchor={ref} onClose={() => {}} label="p" testId="pop">
        <p>body</p>
      </Popover>
    </>
  )
}

describe('Popover placement', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })
  const tall = (): void => {
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(200)
    Object.defineProperty(window, 'innerHeight', { value: 768, configurable: true })
  }

  it('fits below: placed under the anchor exactly as before (top = anchor bottom + 4)', () => {
    tall()
    render(<Harness top={100} />)
    const el = screen.getByTestId('pop')
    expect(el.style.top).toBe('124px')
    expect(el.style.bottom).toBe('')
    expect(el.style.left).toBe('100px')
  })

  it('would run past the bottom: opens above, held by its bottom edge 4px over the anchor', () => {
    tall()
    render(<Harness top={700} />)
    const el = screen.getByTestId('pop')
    expect(el.style.top).toBe('')
    expect(el.style.bottom).toBe(`${768 - (700 - 4)}px`)
  })

  it('no room above either: stays below', () => {
    tall()
    Object.defineProperty(window, 'innerHeight', { value: 300, configurable: true })
    render(<Harness top={150} />)
    expect(screen.getByTestId('pop').style.top).toBe('174px')
  })
})
