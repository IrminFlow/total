import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ValidationSummary } from '../components/ui'

describe('ValidationSummary', () => {
  it('stays out of the DOM when the form is postable', () => {
    const { container } = render(<ValidationSummary issues={[]} />)
    expect(container.innerHTML).toBe('')
  })

  it('shows every blocker together in an accessible alert', () => {
    render(<ValidationSummary issues={['Choose the supplier ledger', 'Add at least one item line']} />)
    expect(screen.getByRole('alert')).not.toBeNull()
    expect(screen.getByText('Choose the supplier ledger')).not.toBeNull()
    expect(screen.getByText('Add at least one item line')).not.toBeNull()
  })
})
