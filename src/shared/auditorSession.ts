/**
 * Auditor mode: a read-only session that ends by itself.
 *
 * What happens instead, today, in every small business in this market: the auditor is handed the
 * owner's PIN. It is not withdrawn afterwards, it is the same PIN used for approving payments,
 * and there is no record of which of the two people did what. Roles (#266) already answer "what
 * may this person do"; this answers the different question of "for how long", which is the part
 * nobody remembers to undo.
 *
 * The session is deliberately in memory only. An auditor session that survived a restart would
 * be a second way into the books that outlives the visit — the failure it exists to prevent. Quit
 * the app and it is gone, which is exactly the behaviour wanted.
 */

/** Durations offered. Anything longer is the audit taking place over days, and that is a login. */
export const AUDITOR_DURATIONS_HOURS = [1, 2, 4, 8] as const

export const AUDITOR_SESSION_NAME = 'Auditor'

export interface AuditorSession {
  /** ISO instant the session was opened. */
  startedAt: string
  /** ISO instant it stops working. */
  expiresAt: string
  /** Who let the auditor in — stamped on every audit row the session produces. */
  grantedBy: string | null
}

/** The instant a session started now would end. */
export function auditorExpiry(startedAtMs: number, hours: number): string {
  return new Date(startedAtMs + hours * 60 * 60 * 1000).toISOString()
}

export function auditorSessionExpired(session: AuditorSession, nowMs: number): boolean {
  return nowMs >= Date.parse(session.expiresAt)
}

/** Whole minutes left, floored, never negative — for the banner that counts down. */
export function auditorMinutesLeft(session: AuditorSession, nowMs: number): number {
  const ms = Date.parse(session.expiresAt) - nowMs
  return ms <= 0 ? 0 : Math.floor(ms / 60000)
}

/** '1 h 20 m left', '9 m left', 'ended'. */
export function auditorTimeLeftLabel(session: AuditorSession, nowMs: number): string {
  const minutes = auditorMinutesLeft(session, nowMs)
  if (minutes === 0) return 'ended'
  if (minutes < 60) return `${minutes} m left`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} m left`
}
