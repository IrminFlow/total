/**
 * Audit-trail retention (WP 3.8). Pure date maths for the retention job in
 * src/main/services/audit.ts; sources and the full rule set are cited there.
 *
 * Companies Act 2013 s.128(5): books of account (and, per the ICAI Implementation Guide on rule
 * 11(g), para 19, the audit trail) for "not less than eight financial years immediately
 * preceding a financial year" must be preserved. So at any moment the oldest date that must be
 * kept is 1 April of (current FY start year − 8): the current year plus the eight before it.
 * GST (CGST Act s.36, 72 months from the annual-return due date) and income-tax retention are
 * shorter, so the Companies Act floor covers them.
 */

/** Financial years that must be kept before the current one (s.128(5)). */
export const STATUTORY_RETENTION_FYS = 8

/** Smallest retention window the setting accepts, in days (8 years). The FY floor below still
 *  applies on top of it. */
export const MIN_AUDIT_KEEP_DAYS = 2922

/** 'YYYY-MM-DD' — rows on or after this date may never be pruned, whatever the setting. */
export function statutoryRetentionFloor(today: string): string {
  const y = Number(today.slice(0, 4))
  const m = Number(today.slice(5, 7))
  const fyStart = m >= 4 ? y : y - 1
  return `${fyStart - STATUTORY_RETENTION_FYS}-04-01`
}

/** Prune cutoff date ('YYYY-MM-DD', exclusive): the earlier of today − keepDays and the floor. */
export function auditPruneCutoff(today: string, keepDays: number): string {
  const t = new Date(`${today}T00:00:00Z`)
  t.setUTCDate(t.getUTCDate() - keepDays)
  const byDays = t.toISOString().slice(0, 10)
  const floor = statutoryRetentionFloor(today)
  return byDays < floor ? byDays : floor
}
