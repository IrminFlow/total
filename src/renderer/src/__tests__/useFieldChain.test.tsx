import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { useRef } from 'react'
import { useFieldChain } from '../lib/useFieldChain'

function Form({
  onAccept,
  extra
}: {
  onAccept?: () => void
  extra?: React.ReactNode
}): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const chain = useFieldChain(root, { onAccept })
  return (
    <div ref={root} {...chain.containerProps}>
      <input data-testid="a" />
      <input data-testid="b" />
      {extra}
      <button data-testid="save">Save</button>
    </div>
  )
}

const enter = (el: Element, init: Record<string, unknown> = {}): void => {
  fireEvent.keyDown(el, { key: 'Enter', ...init })
}

describe('useFieldChain', () => {
  it('Enter moves to the next field', () => {
    const { getByTestId } = render(<Form />)
    const a = getByTestId('a')
    a.focus()
    enter(a)
    expect(document.activeElement).toBe(getByTestId('b'))
  })

  it('Enter on the last field asks to accept instead of wrapping', () => {
    const onAccept = vi.fn()
    const { getByTestId } = render(<Form onAccept={onAccept} />)
    const b = getByTestId('b')
    b.focus()
    enter(b)
    expect(onAccept).toHaveBeenCalledTimes(1)
  })

  it('skips buttons, so Enter never walks onto Save', () => {
    const onAccept = vi.fn()
    const { getByTestId } = render(<Form onAccept={onAccept} />)
    const b = getByTestId('b')
    b.focus()
    enter(b)
    expect(document.activeElement).not.toBe(getByTestId('save'))
    expect(onAccept).toHaveBeenCalled()
  })

  it('a button that opts in with data-chain joins the chain', () => {
    const { getByTestId } = render(
      <Form extra={<button data-testid="toggle" data-chain="drcr" />} />
    )
    const b = getByTestId('b')
    b.focus()
    enter(b)
    expect(document.activeElement).toBe(getByTestId('toggle'))
  })

  it('ignores an Enter another handler already claimed', () => {
    const { getByTestId } = render(<Form />)
    const a = getByTestId('a')
    a.focus()
    // What a type-ahead does when Enter picks a match: preventDefault before the event reaches
    // the container. `defaultPrevented` is not settable through fireEvent's init, so dispatch a
    // real already-prevented event.
    const evt = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    evt.preventDefault()
    a.dispatchEvent(evt)
    expect(document.activeElement).toBe(a)
  })

  it('leaves Cmd/Ctrl+Enter alone — that is save, not advance', () => {
    const onAccept = vi.fn()
    const { getByTestId } = render(<Form onAccept={onAccept} />)
    const a = getByTestId('a')
    a.focus()
    enter(a, { metaKey: true })
    expect(document.activeElement).toBe(a)
    enter(a, { ctrlKey: true })
    expect(document.activeElement).toBe(a)
    expect(onAccept).not.toHaveBeenCalled()
  })

  it('skips hidden and disabled fields', () => {
    const { getByTestId } = render(
      <Form
        extra={
          <>
            <input data-testid="hidden" style={{ display: 'none' }} />
            <input data-testid="disabled" disabled />
            <input data-testid="c" />
          </>
        }
      />
    )
    const b = getByTestId('b')
    b.focus()
    enter(b)
    expect(document.activeElement).toBe(getByTestId('c'))
  })

  it('a field can opt out with data-chain="skip"', () => {
    const { getByTestId } = render(
      <Form
        extra={
          <>
            <input data-testid="readonly" data-chain="skip" />
            <input data-testid="c" />
          </>
        }
      />
    )
    const b = getByTestId('b')
    b.focus()
    enter(b)
    expect(document.activeElement).toBe(getByTestId('c'))
  })

  it('Enter inside a textarea inserts a newline rather than advancing', () => {
    const { getByTestId } = render(<Form extra={<textarea data-testid="notes" />} />)
    const notes = getByTestId('notes')
    notes.focus()
    enter(notes)
    expect(document.activeElement).toBe(notes)
  })
})
