// Phase 1 triage (to-do §4 simple mode): an ORDINARY bill with NO due date — the party has no days
// to pay and none was given on the bill — is never "late" on the simple screens (Home, People, the
// sales / purchase lists, Money's bill ticks, Reports' who owes, Ask Total); People says "no due date
// set". An OPENING balance or opening bill (no voucher: `voucherId` null) without a due date is due
// on its own date — the books-begin day / the date typed on the opening bill, as WP 8.7 dates it —
// so it can be late and reminded (review). The Outstandings engine still ages every bill from its
// due date else its own date (shared/outstanding.ts: the accountant's ageing buckets are unchanged);
// the simple screens read the lateness through these two rules.

interface BillDates { voucherId: number | null; date: string; dueDate: string | null }

/** The bill's due date as the simple screens read it: its own, else (an opening) its date, else none. */
export function dueDateOf(b: BillDates): string | null {
  return b.dueDate ?? (b.voucherId == null ? b.date : null)
}

/** Days late on the simple screens: the engine's overdue days, except an ordinary bill without a due date (0). */
export function lateDays(b: BillDates & { overdueDays: number }): number {
  return dueDateOf(b) == null ? 0 : b.overdueDays
}
