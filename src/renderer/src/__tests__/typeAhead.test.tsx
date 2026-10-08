// TypeAhead (components/pickers.tsx): a pre-filled value stays highlighted wherever it sits in a
// long list (> 50 options), and ⌘↵ / Ctrl+↵ never picks the highlighted row — but keeps a name
// typed exactly and not yet picked, then lets the form's save shortcut through.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { TypeAhead, type PickerOption } from '../components/pickers'

const OPTIONS: PickerOption[] = Array.from({ length: 80 }, (_, i) => ({ id: i + 1, label: `Ledger ${String(i + 1).padStart(2, '0')}` }))

function Harness({ initial, onPick }: { initial: number | null; onPick: (id: number | null) => void }): React.JSX.Element {
  const [value, setValue] = useState<number | null>(initial)
  return (
    <TypeAhead
      options={OPTIONS}
      value={value}
      placeholder="Ledger"
      testId="picker"
      onPick={(id) => {
        setValue(id)
        onPick(id)
      }}
    />
  )
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('TypeAhead with more than 50 options', () => {
  it('highlights the current value even when it is option 70, and renders it', () => {
    const onPick = vi.fn()
    render(<Harness initial={70} onPick={onPick} />)
    const input = screen.getByTestId('picker') as HTMLInputElement
    expect(input.value).toBe('Ledger 70')
    fireEvent.focus(input)
    const active = screen.getAllByRole('option').find((o) => o.getAttribute('aria-selected') === 'true')!
    expect(active.textContent).toBe('Ledger 70')
    expect(input.getAttribute('aria-activedescendant')).toBe(active.id)
    // Plain Enter keeps the value (it picks the highlighted row, which IS the value)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onPick).toHaveBeenLastCalledWith(70)
  })

  it('⌘↵ does not pick the highlighted row', () => {
    const onPick = vi.fn()
    const save = vi.fn()
    window.addEventListener('keydown', save)
    render(<Harness initial={70} onPick={onPick} />)
    const input = screen.getByTestId('picker')
    fireEvent.focus(input)
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true })
    expect(onPick).not.toHaveBeenCalled()
    expect(save).toHaveBeenCalledTimes(1) // the form's shortcut still runs
    window.removeEventListener('keydown', save)
  })

  it('⌘↵ keeps a name typed exactly but not picked, then re-sends the save shortcut', () => {
    vi.useFakeTimers()
    const onPick = vi.fn()
    const save = vi.fn()
    window.addEventListener('keydown', save)
    render(<Harness initial={70} onPick={onPick} />)
    const input = screen.getByTestId('picker')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'ledger 75' } })
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
    expect(onPick).toHaveBeenLastCalledWith(75)
    expect(save).not.toHaveBeenCalled() // held back until the form has the value
    act(() => {
      vi.runAllTimers()
    })
    expect(save).toHaveBeenCalledTimes(1)
    expect((save.mock.calls[0]![0] as KeyboardEvent).ctrlKey).toBe(true)
    window.removeEventListener('keydown', save)
  })
})
