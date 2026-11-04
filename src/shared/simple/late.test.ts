// Phase 1 triage: no credit days and no due date on the bill = no due date, never late on the
// simple screens (the Outstandings engine's own ageing is unchanged).
import { describe, expect, it } from 'vitest'
import { lateDays } from './late'
import { owedSummary } from './home'
import { owedRows } from './reports'

const party = (bills: { pending: number; ageDays: number; dueDate: string | null; overdueDays: number }[]) => ({
  ledgerId: 1, name: 'Ramesh', pending: bills.reduce((s, b) => s + b.pending, 0), buckets: [0, 0, 0, 0] as [number, number, number, number],
  bills: bills.map((b, i) => ({ voucherId: i + 1, number: String(i + 1), date: '2026-10-01', amount: b.pending, ...b }))
})

describe('lateDays', () => {
  it('a bill without a due date is never late; one with a due date keeps the engine’s days', () => {
    expect(lateDays({ dueDate: null, overdueDays: 13 })).toBe(0)
    expect(lateDays({ dueDate: '2026-10-01', overdueDays: 13 })).toBe(13)
    expect(lateDays({ dueDate: '2026-10-20', overdueDays: 0 })).toBe(0)
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
