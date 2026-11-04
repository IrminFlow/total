// Phase 1 triage: no credit days and no due date on the bill = no due date, never late on the
// simple screens (the Outstandings engine's own ageing is unchanged).
import { describe, expect, it } from 'vitest'
import { dueDateOf, lateDays } from './late'
import { owedSummary } from './home'
import { owedRows } from './reports'

const party = (bills: { pending: number; ageDays: number; dueDate: string | null; overdueDays: number; voucherId?: number | null }[]) => ({
  ledgerId: 1, name: 'Ramesh', pending: bills.reduce((s, b) => s + b.pending, 0), buckets: [0, 0, 0, 0] as [number, number, number, number],
  bills: bills.map((b, i) => ({ voucherId: i + 1, number: String(i + 1), date: '2026-10-01', amount: b.pending, ...b }))
})

describe('lateDays', () => {
  it('a bill without a due date is never late; one with a due date keeps the engine’s days', () => {
    expect(lateDays({ voucherId: 7, date: '2026-10-01', dueDate: null, overdueDays: 13 })).toBe(0)
    expect(lateDays({ voucherId: 7, date: '2026-09-01', dueDate: '2026-10-01', overdueDays: 13 })).toBe(13)
    expect(lateDays({ voucherId: 7, date: '2026-10-01', dueDate: '2026-10-20', overdueDays: 0 })).toBe(0)
  })
  // Review: an opening balance / opening bill (no voucher) without a due date is due on its own
  // date (WP 8.7), so it can be late — and reminded.
  it('an opening without a due date is due on its date: late by the engine’s days', () => {
    const opening = { voucherId: null, date: '2024-08-26', dueDate: null, overdueDays: 353 }
    expect(lateDays(opening)).toBe(353)
    expect(dueDateOf(opening)).toBe('2024-08-26')
    expect(dueDateOf({ voucherId: 3, date: '2024-08-26', dueDate: null })).toBeNull()
    expect(dueDateOf({ voucherId: null, date: '2024-08-26', dueDate: '2024-09-25' })).toBe('2024-09-25')
    const s = owedSummary([party([{ voucherId: null, pending: 500_000, ageDays: 353, dueDate: null, overdueDays: 353 }])], '2025-08-14')
    expect([s.overdue, s.overdueBills]).toEqual([500_000, 1])
  })
  it('Home and Reports count only bills past a due date', () => {
    const p = party([
      { pending: 1_000, ageDays: 13, dueDate: null, overdueDays: 13 },
      { pending: 500, ageDays: 40, dueDate: '2026-10-01', overdueDays: 13 }
    ])
    const s = owedSummary([p], '2026-10-14')
    expect(s.overdue).toBe(500)
    expect(s.overdueBills).toBe(1)
    expect(owedRows([p])[0]!.overdue).toBe(500)
  })
})
