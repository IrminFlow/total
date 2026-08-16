/**
 * Pure, dependency-free helpers for the crash/error logger. No Electron, no Node
 * builtins — this file must be safely importable under plain vitest.
 */

export type LogLevel = 'info' | 'warn' | 'error'

/**
 * Serializes one JSONL log line: {"ts","level","event","v",...data} + "\n".
 * Error instances anywhere in `data` become {message, stack}. Circular structures
 * are detected via a WeakSet and replaced with '[Circular]' rather than throwing;
 * any other stringify failure falls back to a best-effort String() line.
 */
export function formatLine(
  now: Date,
  level: LogLevel,
  event: string,
  version: string,
  data?: Record<string, unknown>
): string {
  const record = { ts: now.toISOString(), level, event, v: version, ...(data ?? {}) }
  const seen = new WeakSet<object>()
  const replacer = (_key: string, value: unknown): unknown => {
    if (value instanceof Error) {
      return { message: value.message, stack: value.stack }
    }
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[Circular]'
      seen.add(value)
    }
    return value
  }
  try {
    return JSON.stringify(record, replacer) + '\n'
  } catch {
    return JSON.stringify({ ts: record.ts, level, event, v: version, data: String(data) }) + '\n'
  }
}

const LOG_NAME_RE = /^total-(\d{4}-\d{2}-\d{2})\.log$/

/**
 * True when `name` is a `total-YYYY-MM-DD.log` file whose date is strictly older
 * than `keepDays` days before `today` (YYYY-MM-DD). Non-matching names and the
 * boundary day (exactly `keepDays` old) are not expired.
 */
export function isExpiredLogName(name: string, today: string, keepDays: number): boolean {
  const m = LOG_NAME_RE.exec(name)
  if (!m) return false
  const fileDate = new Date(`${m[1]}T00:00:00.000Z`)
  const cutoff = new Date(`${today}T00:00:00.000Z`)
  cutoff.setUTCDate(cutoff.getUTCDate() - keepDays)
  return fileDate.getTime() < cutoff.getTime()
}
