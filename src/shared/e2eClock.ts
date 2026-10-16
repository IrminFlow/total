/**
 * WP 7.4 follow-up: a shifted clock for scripted runs. `TOTAL_E2E_TODAY=YYYY-MM-DD` (honoured by
 * main only together with TOTAL_DATA_DIR in an UNPACKAGED build — `e2eTodayFromEnv`) makes the
 * app believe today is that day: `Date.now()` and `new Date()` move by a fixed offset (the time
 * of day and the clock's ticking are kept, so timers, animations and durations are unchanged).
 * Main installs it before anything else; the renderer gets the day through the preload and
 * installs it before the app's first module runs. Never on a real user's books.
 */

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

/** The day to fake, or null: only a well-formed date, a scratch data dir and an unpackaged build. */
export function e2eTodayFromEnv(env: Record<string, string | undefined>, isPackaged: boolean): string | null {
  const today = env.TOTAL_E2E_TODAY
  if (!today || !ISO_DAY.test(today) || isPackaged || !env.TOTAL_DATA_DIR) return null
  return today
}

/** Milliseconds to add to the real clock so that the LOCAL date becomes `today` (same time of day). */
export function e2eClockOffset(today: string, now: Date): number {
  const target = new Date(now.getTime())
  target.setFullYear(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, Number(today.slice(8, 10)))
  return target.getTime() - now.getTime()
}

let installed = false

/** Replace the global Date with one shifted to `today`. Idempotent; a null day does nothing. */
export function installE2eClock(today: string | null | undefined): void {
  if (!today || !ISO_DAY.test(today) || installed) return
  installed = true
  const RealDate = Date
  const offset = e2eClockOffset(today, new RealDate())
  const realNow = RealDate.now.bind(RealDate)
  class ShiftedDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(realNow() + offset)
      else super(...(args as [string | number | Date]))
    }
    static now(): number {
      return realNow() + offset
    }
  }
  ;(globalThis as { Date: DateConstructor }).Date = ShiftedDate as unknown as DateConstructor
}
