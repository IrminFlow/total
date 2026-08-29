/**
 * How long a PIN is refused after repeated wrong guesses (roadmap #264).
 *
 * The old rule was flat: five failures, thirty seconds, forever. Flat is the wrong shape — a
 * fat-fingered owner and a script trying ten thousand PINs both wait the same thirty seconds,
 * and the second one can afford it. A four-digit PIN is 10,000 guesses; at a flat 30s per five
 * attempts that is under seventeen hours of unattended looping. Doubling the wait to an hourly
 * ceiling puts the same search past a year, while costing an honest typo half a minute once.
 *
 * Pure arithmetic, no imports, so both the throttle (main) and the lock screen (renderer) can
 * state the same number.
 */

/** Failures tolerated before any wait at all — a typo should not cost anyone thirty seconds. */
export const FREE_ATTEMPTS = 4

/** The first wait, doubling per failure after that. */
export const BASE_LOCKOUT_MS = 30_000

/**
 * Ceiling on the wait. An hour is long enough that brute force is hopeless and short enough that
 * the owner of the books is never locked out of them for a working day — there is no password
 * reset here, and a permanent lockout would be indistinguishable from losing the company.
 */
export const MAX_LOCKOUT_MS = 60 * 60 * 1000

/**
 * Milliseconds to refuse login for after `consecutiveFails` consecutive wrong PINs.
 * 0 for the first FREE_ATTEMPTS; then 30s, 60s, 120s … capped at MAX_LOCKOUT_MS.
 */
export function lockoutMsFor(consecutiveFails: number): number {
  if (!Number.isFinite(consecutiveFails) || consecutiveFails <= FREE_ATTEMPTS) return 0
  const doublings = consecutiveFails - FREE_ATTEMPTS - 1
  // Clamping the exponent rather than relying on Math.min afterwards: 2 ** 10000 is Infinity,
  // and Infinity * 30000 compared against the cap would still be Infinity in some engines.
  const capped = Math.min(doublings, 32)
  return Math.min(MAX_LOCKOUT_MS, BASE_LOCKOUT_MS * 2 ** capped)
}

/** Human wait, rounded up — "wait 2 minutes" is a promise the throttle can keep, "wait 90s" isn't. */
export function lockoutLabel(ms: number): string {
  if (ms <= 0) return 'now'
  const seconds = Math.ceil(ms / 1000)
  if (seconds < 60) return `${seconds} seconds`
  const minutes = Math.ceil(seconds / 60)
  return minutes === 1 ? '1 minute' : `${minutes} minutes`
}

/** The message every PIN surface shows, so a brute-forcer learns nothing from which one it hit. */
export function lockoutMessage(ms: number): string {
  return `Too many attempts — wait ${lockoutLabel(ms)}`
}
