import { describe, expect, it } from 'vitest'
import { morningDigestText } from '../lib/morningDigest'

describe('morning digest', () => {
  it('produces a complete local plain-text handoff', () => {
    const text = morningDigestText({
      date: '24-Aug-2026', company: 'Jindal Traders', cashAndBank: 125_050,
      overdueReceivables: 88_000, overduePayables: 42_500, exceptionCount: 3,
      deadlineCount: 2, recurringDue: 4, tasksDue: 1
    })
    expect(text).toContain('Jindal Traders morning brief for 24-Aug-2026')
    expect(text).toContain('Overdue receivables: ₹880.00')
    expect(text).toContain('Book exceptions: 3')
    expect(text).toContain('Scheduled work due: 5 (4 recurring, 1 tasks)')
  })
})
