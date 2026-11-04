// Phase 1 triage (to-do §4 simple mode): a bill with NO due date — the party has no days to pay
// and none was given on the bill — is never "late" on the simple screens (Home, People, the sales /
// purchase lists, Money's bill ticks, Reports' who owes, Ask Total). The Outstandings engine still
// ages such a bill from its own date (shared/outstanding.ts: the accountant's ageing buckets are
// unchanged); the simple screens read the lateness through this one rule.
export function lateDays(b: { dueDate: string | null; overdueDays: number }): number {
  return b.dueDate == null ? 0 : b.overdueDays
}
