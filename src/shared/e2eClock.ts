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

let offsetMs: number | null = null

/** The shift in force (ms added to the real clock), or null — the normal case: no shift. */
export function e2eClockOffsetMs(): number | null {
  return offsetMs
}

/** A file's time (stat mtimeMs, always the REAL clock) on the app's clock: compared with Date.now()
 *  / today (backup age, stale locks, sweeps), it must move with the shift. Unchanged without one. */
export function fileTimeMs(mtimeMs: number): number {
  return offsetMs == null ? mtimeMs : mtimeMs + offsetMs
}

/** Replace the global Date with one shifted to `today`. Idempotent; a null day does nothing.
 *  A plain function (not a subclass) whose prototype IS Date.prototype, so `x instanceof Date`
 *  still holds for every date (structured-clone copies, libraries holding the real Date), and
 *  `Date()` called without `new` still returns the (shifted) string. */
export function installE2eClock(today: string | null | undefined): void {
  if (!today || !ISO_DAY.test(today) || offsetMs != null) return
  const RealDate = Date
  const offset = e2eClockOffset(today, new RealDate())
  offsetMs = offset
  const realNow = RealDate.now.bind(RealDate)
  function ShiftedDate(this: unknown, ...args: unknown[]): unknown {
    if (!new.target) return new RealDate(realNow() + offset).toString()
    return Reflect.construct(RealDate, args.length === 0 ? [realNow() + offset] : args, new.target)
  }
  Object.setPrototypeOf(ShiftedDate, RealDate)
  ShiftedDate.prototype = RealDate.prototype
  ;(ShiftedDate as unknown as { now: () => number }).now = () => realNow() + offset
  ;(globalThis as { Date: DateConstructor }).Date = ShiftedDate as unknown as DateConstructor
}
