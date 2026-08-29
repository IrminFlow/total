import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { EntryValidationStatus } from './EntryValidationStatus'

const issues = ['Choose the buyer ledger', 'Add at least one item line']
const guidance = ['Choose the party ledger', 'Add an item with quantity and rate']

function AttemptHarness(): React.JSX.Element {
  const [attempted, setAttempted] = useState(false)
  return (
    <>
      <EntryValidationStatus issues={issues} revealIssues={attempted} guidance={guidance} />
      <button onClick={() => setAttempted(true)}>Save voucher</button>
    </>
  )
}

afterEach(cleanup)

describe('EntryValidationStatus', () => {
  it('shows neutral completion guidance for an untouched form', () => {
    render(<EntryValidationStatus issues={issues} revealIssues={false} guidance={guidance} />)

    expect(screen.getByRole('status').textContent).toContain('Complete the entry')
    expect(screen.getByText('Choose the party ledger')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText('Before saving')).toBeNull()
    expect(screen.queryByText('Choose the buyer ledger')).toBeNull()
  })

  it('reveals the exact blockers after a submit attempt', () => {
    render(<AttemptHarness />)

    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Save voucher' }))

    expect(screen.getByRole('alert').textContent).toContain('Before saving')
    expect(screen.getByRole('alert').textContent).toContain('Choose the buyer ledger')
    expect(screen.getByRole('alert').textContent).toContain('Add at least one item line')
    expect(screen.queryByText('Complete the entry')).toBeNull()
  })

  it('shows a quiet ready state when no blockers remain', () => {
    render(<EntryValidationStatus issues={[]} revealIssues guidance={guidance} />)

    expect(screen.getByRole('status').textContent).toContain('Ready to post')
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
