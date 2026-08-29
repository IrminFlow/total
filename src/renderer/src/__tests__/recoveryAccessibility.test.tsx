import React, { useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { Modal } from '../components/ui'
import { useNav } from '../state/stores'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('overlay and screen recovery', () => {
  it('moves focus into a modal and restores it to the opener on close', async () => {
    function Harness(): React.JSX.Element {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button onClick={() => setOpen(true)}>Open dialog</button>
          {open && (
            <Modal title="Focus test" onClose={() => setOpen(false)}>
              <input aria-label="First field" />
            </Modal>
          )}
        </>
      )
    }

    render(<Harness />)
    const opener = screen.getByRole('button', { name: 'Open dialog' })
    opener.focus()
    fireEvent.click(opener)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Close')))

    fireEvent.click(screen.getByLabelText('Close'))
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })

  it('reports a render crash, shows a usable fallback, and navigates back', async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, data: null })
    Object.defineProperty(window, 'total', { value: { invoke }, configurable: true })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    useNav.setState({ stack: [{ name: 'gateway' }, { name: 'daybook' }], forward: [] })

    function Broken(): React.JSX.Element {
      throw new Error('renderer recovery test')
    }

    render(
      <ErrorBoundary screen="daybook">
        <Broken />
      </ErrorBoundary>
    )

    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeTruthy()
    expect(screen.getByText('renderer recovery test')).toBeTruthy()
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('log:renderer', expect.objectContaining({
      message: 'renderer recovery test',
      screen: 'daybook'
    })))

    fireEvent.click(screen.getByRole('button', { name: 'Go back' }))
    await waitFor(() => expect(useNav.getState().stack).toEqual([{ name: 'gateway' }]))
  })
})
