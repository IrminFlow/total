import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { InteractiveReportRow } from '../components/ui'

describe('InteractiveReportRow', () => {
  it('is focusable and activates with pointer, Enter and Space', () => {
    const onActivate = vi.fn()
    render(
      <table>
        <tbody>
          <InteractiveReportRow aria-label="Open August 2026" onActivate={onActivate}>
            <td>August 2026</td>
          </InteractiveReportRow>
        </tbody>
      </table>,
    )

    const row = screen.getByRole('button', { name: 'Open August 2026' })
    expect(row.getAttribute('tabindex')).toBe('0')
    fireEvent.click(row)
    fireEvent.keyDown(row, { key: 'Enter' })
    fireEvent.keyDown(row, { key: ' ' })
    expect(onActivate).toHaveBeenCalledTimes(3)
  })

  it('leaves controls inside the row independent', () => {
    const onActivate = vi.fn()
    const onEdit = vi.fn()
    render(
      <table>
        <tbody>
          <InteractiveReportRow aria-label="Open record" onActivate={onActivate}>
            <td><button type="button" onClick={onEdit}>Edit</button></td>
          </InteractiveReportRow>
        </tbody>
      </table>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(onEdit).toHaveBeenCalledOnce()
    expect(onActivate).not.toHaveBeenCalled()
  })
})
