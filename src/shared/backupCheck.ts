// WP 7.2 — the automatic restore check of a backup (services/backupVerify.ts), as the renderer sees it.

export interface BackupCheckSteps {
  opens: boolean
  quickCheck: boolean
  migrations: { found: number; expected: number; ok: boolean } | null
  auditChain: { ok: boolean; rows: number } | null
  balanced: { ok: boolean; debit: number; credit: number } | null
  /** The business details row is there (it is a Total company file). */
  company: boolean
}

export interface BackupCheck {
  file: string
  tag: string
  encrypted: boolean
  /** ISO timestamp. */
  checkedAt: string
  ok: boolean
  steps: BackupCheckSteps
  /** Why it failed (null when ok). */
  error: string | null
}

/** Whole days between an ISO timestamp and now (never negative). */
export function daysAgo(iso: string, now = Date.now()): number {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return 0
  return Math.max(0, Math.floor((now - t) / 86_400_000))
}
